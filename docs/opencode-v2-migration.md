# OpenCode v2 Container Support

> [English](opencode-v2-migration.md) | [简体中文](opencode-v2-migration.zh-CN.md)

Status: **implemented and validated locally**. The codebase supports both OpenCode
majors in a single image layout: `wrangler.jsonc` currently defaults to v2
(`image_vars.OPENCODE_MAJOR = "2"`), while a plain `docker build` without build args
defaults to v1 (`ARG OPENCODE_MAJOR=1`).

## Goal

Run OpenCode v2 (`opencode serve`) inside the container while keeping the v1
(`opencode web`) path working and switchable via a single build argument.

## Measured differences (v1.19.5 vs v2.2.5)

| Area            | v1 (`1.19.5`)                                              | v2 (`2.2.5`)                                                                 |
| --------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Start command   | `opencode web --port 2633 --hostname 0.0.0.0`              | `opencode serve --hostname 0.0.0.0 --port 2633` (no `web` command)           |
| Event endpoint  | `/global/event` ( SSE ); `/api/event` also returns 200 SSE | `/api/event` ( SSE ); `/global/event` returns 200 `text/html` (SPA fallback) |
| Event frame     | `{"payload":{"id","type",...}}` (or top-level `type`)      | `{"id","type","data"}` (`type` is at the top level)                          |
| Health endpoint | `/api/health` → `{"healthy":true}`                         | `/api/health` → **404**; `/api/info` → `{version,pid,urls,...}`              |
| API auth        | none                                                       | `/api/*` requires Basic (`opencode:<password>`); `/` is public               |
| Activity events | `session.updated`                                          | `session.created`, `session.execution.started`, `session.renamed`            |
| Password        | n/a                                                        | `OPENCODE_PASSWORD`; if unset, the server generates a random one             |
| Installer       | `https://opencode.ai/install`                              | `https://opencode.ai/v2/install` (v1 installer refuses 2.x)                  |

Both installers accept `--version` and `--no-modify-path` and install to
`$HOME/.opencode/bin/opencode`.

## Implementation

### 1. `Dockerfile`

- `ARG OPENCODE_MAJOR=1`, plus one pinned release per major
  (`OPENCODE_VERSION_V1=1.19.5`, `OPENCODE_VERSION_V2=2.2.5`).
- The install step selects the installer URL and version from `OPENCODE_MAJOR`
  (`/v2/install` for `2`, `/install` otherwise).
- `/entrypoint.sh` detects the installed major at runtime (`opencode --version`) and
  starts `opencode serve` or `opencode web` accordingly, so one entrypoint script
  covers both images.
- If v2 starts without `OPENCODE_PASSWORD`, the entrypoint logs a warning because
  `opencode serve` then generates an ephemeral password that the Worker cannot know.

### 2. `src/container.ts`

- `openEventStream()` tries `/api/event` first and `/global/event` second, requiring a
  `text/event-stream` response header because v2 answers unknown paths with the SPA
  HTML (`200 text/html`). The first matching response stream is returned directly to
  the SSE reader.
- Requests to the container include `Authorization: Basic base64("opencode:" + opencodePassword)`
  whenever `opencodePassword` is available, because v2 rejects unauthenticated
  `/api/*` requests (including `/api/event`).
- Event type is resolved as `event.type ?? event.data?.type ?? event.payload?.type`.
  v2.2.5 places `type` at the top level of the SSE JSON frame rather than inside
  `data`; checking `event.type` first ensures activity renewal works on both majors.
- Activity timeout renewal triggers immediately on `session.updated` (v1) and
  `session.created`, `session.execution.started`, `session.renamed` (v2), and on a
  60-second throttle for `message.updated` / `message.part.updated` so long-running
  turns and subagent executions keep the container awake past `sleepAfter`.
- `withContainerAuthorization()` unconditionally sets (or replaces) the `Authorization`
  header on forwarded requests with the container credential. Whether the caller
  authenticated to the Worker via browser Basic Auth (`SERVER_PASSWORD`) or Cloudflare
  Access (no Basic header), the container always receives the `opencode:<password>`
  credential it expects.
- Password resolution: `const opencodePassword = containerEnv.OPENCODE_PASSWORD || containerEnv.SERVER_PASSWORD`.
  When at least one of the two variables is set, the resolved value is injected into
  the container via `envVars.OPENCODE_PASSWORD` so `opencode serve` uses a known
  password instead of generating a random one. If neither variable is set, no password
  is injected and v2 will generate an ephemeral password that breaks `/api/*` calls.

### 3. `src/sse.ts`

- `SSEEvent` includes top-level `type` alongside the optional `data` and `payload`
  fields.

### 4. `config/opencode/opencode.json`

- No change required. The v2 config schema still accepts the `"permission": "allow"`
  shorthand (`PermissionActionConfig` enum `ask | allow | deny`, deprecated but valid),
  so the same config file works for both majors.

### 5. `wrangler.jsonc`

- `containers[0].image_vars.OPENCODE_MAJOR` selects the major built by Wrangler
  (currently `"2"`). `image_vars` are passed as Docker `--build-arg` values.

## Validation

1. `docker build --build-arg OPENCODE_MAJOR=2` → `opencode --version` reports
   `v2.2.5` inside the image.
2. Direct container run: `curl -u opencode:$PW /api/info` returns `200`, `/api/event`
   streams SSE frames, and `/api/health` returns `404` as expected.
3. `pnpm dev` (`wrangler dev` with `image_vars.OPENCODE_MAJOR = "2"`):
   - `/api/info` returns `200` through the Worker (header injection works).
   - `/` returns `200 text/html` and browser Basic Auth works end-to-end when
     `SERVER_PASSWORD` is set.
   - `POST /api/session` returns `200` and the Worker logs
     `Renewed container activity timeout` on `session.created`.
   - `/api/event` streams SSE through the Worker.
4. v1 regression (`image_vars.OPENCODE_MAJOR = "1"`, rebuilt): `/api/health` returns
   `{"healthy":true}`, `/` returns `200`, and the SSE watcher renews on session
   activity.
5. `pnpm lint` and `tsc --noEmit` pass; `pnpm fmt:check` passes on all modified files
   (only the pre-existing `AGENTS.md` formatting diff remains).

## Caveats

- **At least one password variable is required on v2.** Set `OPENCODE_PASSWORD` (or
  `SERVER_PASSWORD`, which it falls back to). If both are empty, `opencode serve`
  generates a random password on boot and the Worker cannot authenticate to `/api/*`.
- **v1 and v2 S3 data directories are incompatible.** v2 uses a different storage layout
  (SQLite under `$XDG_DATA_HOME/opencode/opencode.db`). Point `S3_PREFIX` at a fresh
  prefix (or use a new bucket) when switching majors.
- **No `/api/health` on v2.** External monitors must check `/api/info` instead.
- **v2 event names may evolve.** Re-verify `ACTIVITY_EVENTS` in `src/container.ts` when
  bumping `OPENCODE_VERSION_V2`.
- **Restricted build networks.** On hosts behind an outbound proxy, pass
  `HTTP_PROXY` / `HTTPS_PROXY` build args (or `docker build --network host`), otherwise
  `apt` or the OpenCode installer download may fail.

## Rollback to v1

1. Set `containers[0].image_vars.OPENCODE_MAJOR` to `"1"` in `wrangler.jsonc`.
2. Point `S3_PREFIX` back to a v1 data prefix (or a clean prefix) — do not mount a
   v2-populated directory into v1.
3. Rebuild and redeploy. No v1 code paths were removed.
