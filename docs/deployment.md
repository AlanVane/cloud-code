# Deploying to Cloudflare

> [English](deployment.md) | [简体中文](deployment.zh-CN.md)

`pnpm deploy` runs `wrangler deploy`: it builds the container image remotely,
uploads the Worker, and creates the Durable Object and container bindings. This
page lists what has to exist **before** the first deploy and what to verify
after it.

## 1. Secrets

Set these with `pnpm exec wrangler secret put <NAME>` (or the dashboard). The
repository never contains working values.

| Name                   | Required             | Why                                                                                                                                                        |
| ---------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SERVER_PASSWORD`      | yes in production    | Worker gate; empty means the Worker is **open** to anyone                                                                                                  |
| `SERVER_USERNAME`      | yes in production    | Basic Auth user for the gate                                                                                                                               |
| `OPENCODE_PASSWORD`    | **yes for v2**       | Container API password; falls back to `SERVER_PASSWORD`. If both are empty, `opencode serve` generates an ephemeral password and every `/api/*` call fails |
| `S3_ENDPOINT`          | only for persistence | All four `S3_*` values must be set together                                                                                                                |
| `S3_ACCESS_KEY_ID`     | only for persistence |                                                                                                                                                            |
| `S3_SECRET_ACCESS_KEY` | only for persistence |                                                                                                                                                            |
| `S3_BUCKET`            | only for persistence |                                                                                                                                                            |
| `S3_PREFIX`            | only for persistence | Use a **fresh** prefix when switching OpenCode majors                                                                                                      |

```bash
pnpm exec wrangler secret put SERVER_USERNAME
pnpm exec wrangler secret put SERVER_PASSWORD
pnpm exec wrangler secret put OPENCODE_PASSWORD
# persistence only:
for k in S3_ENDPOINT S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY S3_BUCKET S3_PREFIX; do
  pnpm exec wrangler secret put "$k"
done
```

Do **not** set `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` unless they point at an
address the container can actually reach. `http://127.0.0.1:...` resolves to the
container itself and breaks both the image build and OpenCode's outbound calls.

`wrangler.jsonc` sets `keep_vars: true`, so dashboard variables survive deploys.

`pnpm secrets:sync` reads `OPENCODE_API_KEY` from `.dev.vars` and uploads it with
`wrangler secret bulk`. It only ever reads that one key, so local-only values
such as `HTTP_PROXY` never leave the machine. `pnpm deploy:sync` runs it before
`pnpm deploy`; the very first deploy has no Worker yet, so run it once after
that deploy instead.

## 2. Choose the OpenCode major

```jsonc
"containers": [{ "image_vars": { "OPENCODE_MAJOR": "2" } }]
```

The major is baked into the image, so changing it requires a redeploy. v1 and v2
use different data layouts (v2 stores SQLite at
`$XDG_DATA_HOME/opencode/opencode.db`), which is why the S3 prefix has to change
with the major.

## 3. Deploy

```bash
pnpm deploy
```

The first deploy is the slow one: Cloudflare builds the image from `Dockerfile`,
which installs `apt` packages plus the pinned OpenCode release.

Current resource shape, from `wrangler.jsonc`:

| Setting               | Value                                      |
| --------------------- | ------------------------------------------ |
| Worker placement      | `aws:us-west-2`                            |
| Container constraints | `wnam`                                     |
| Instance              | 1 vCPU, 4096 MiB, 8 GB disk                |
| Instances             | `max_instances: 1`                         |
| Idle sleep            | `sleepAfter = '10m'` in `src/container.ts` |

## 4. Smoke test

```bash
W=https://<your-worker>.workers.dev
U=user:password            # SERVER_USERNAME:SERVER_PASSWORD

curl -su "$U" -w '\n%{http_code}\n' "$W/api/info"     # 200, {"version":"2.x.y",...}
curl -su "$U" -o /dev/null -w '%{http_code} %{content_type}\n' "$W/"   # 200 text/html
curl -su "$U" -o /dev/null -w '%{http_code}\n' "$W/api/health"         # 404 on v2
curl -s  -o /dev/null -w '%{http_code}\n' "$W/api/info"                # 401 without credentials
timeout 5 curl -sN -u "$U" "$W/api/event" | head -3                    # SSE frames
```

`/api/info` returning `200` proves the Worker injects `opencode:<password>`
into container requests; without it v2 answers `401`.

To confirm the activity-timeout renewal, stream logs while creating a session:

```bash
pnpm exec wrangler tail          # terminal A
curl -su "$U" -H 'content-type: application/json' \
  -d '{"title":"smoke"}' "$W/api/session"
# expect in the tail: Renewed container activity timeout
```

## 5. Monitoring

v2 has **no** `/api/health`. Point health checks at `/api/info` and send the
Basic Auth header, or put the Worker behind Cloudflare Access and check `/`.

## 6. Rollback to v1

1. Set `image_vars.OPENCODE_MAJOR` to `"1"` in `wrangler.jsonc`.
2. Point `S3_PREFIX` back to the v1 prefix (never mount a v2-populated
   directory into v1).
3. `pnpm deploy`.

No v1 code path was removed, so the rollback is a config change plus a rebuild.

## 7. Common failures

| Symptom                                                | Cause                                                                                           |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Container exits at boot, log `[ERROR] S3 mount failed` | Wrong or incomplete `S3_*`; the entrypoint exits when the mount fails                           |
| `/api/*` returns `401` through the Worker              | `OPENCODE_PASSWORD` and `SERVER_PASSWORD` are both empty, so v2 generated an ephemeral password |
| Health check suddenly fails after the v2 switch        | Still probing `/api/health`, which is `404` on v2                                               |
| Data looks empty after switching majors                | `S3_PREFIX` was reused across majors                                                            |

See [Local end-to-end check](local-e2e.md) to exercise the same paths without
deploying.
