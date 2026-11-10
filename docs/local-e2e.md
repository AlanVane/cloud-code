# Local End-to-End Check (OpenCode v2)

> [English](local-e2e.md) | [简体中文](local-e2e.zh-CN.md)

Verifies the whole path in one go: Worker → Durable Object → container → OpenCode
v2, including the pieces that `tsc` and `wrangler deploy --dry-run` cannot cover —
the `opencode:<password>` header injection, the `/api/event` probe and the
activity-timeout renewal.

Run this before deploying a new `OPENCODE_VERSION_V2` or changing
`src/container.ts`.

## Prerequisites

| Requirement                          | Check                                                    |
| ------------------------------------ | -------------------------------------------------------- |
| Docker with container networking     | `docker info` succeeds                                   |
| `xt_socket` kernel module (Linux)    | `ls /lib/modules/$(uname -r)/kernel/net/*/xt_socket.ko*` |
| pnpm 12.18.0                         | `pnpm --version`                                         |
| Outbound network for the image build | `curl -I https://opencode.ai`                            |

`wrangler dev` starts an egress interceptor container that needs `iptables`
NAT rules, so Docker Desktop (macOS/Windows) or a Linux host with the module
loaded is required. See [Troubleshooting](#troubleshooting).

## 0. Prepare `.dev.vars`

If the file does not exist yet, start from the committed template:

```bash
cp .dev.vars.example .dev.vars
```

Then keep only these keys for the test, because the container exits when S3 is
partially configured and a bogus endpoint is unreachable, and proxy variables
pointing at `127.0.0.1` do not resolve inside the container:

```
SERVER_USERNAME=agili
SERVER_PASSWORD=cloud-code
OPENCODE_PASSWORD=cloud-code
```

```bash
cp .dev.vars /tmp/dev.vars.bak
```

## 1. Start the dev server

```bash
pnpm install
pnpm dev            # leave running; first run also builds the image
```

Wait for both lines:

```
⎔ Container image(s) ready
[wrangler:info] Ready on http://localhost:8787
```

## 2. Boot the container

Containers start lazily, so the first request pays the boot cost (~30–60 s):

```bash
curl -s -u agili:cloud-code http://localhost:8787/api/info
```

## 3. API assertions

| Request                                   | Expected                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `curl -su agili:cloud-code $W/api/info`   | `200` `{"version":"2.x.y",...}`                                         |
| `curl -su agili:cloud-code $W/`           | `200 text/html`                                                         |
| `curl -su agili:cloud-code $W/api/health` | `404` (v2 has no health endpoint)                                       |
| `curl -s $W/api/info`                     | `401` (Worker gate)                                                     |
| `curl -su agili:cloud-code $W/api/event`  | SSE, first frame `data: {"id":...,"type":"server.connected","data":{}}` |

`/api/info` returning `200` is the key signal: v2 rejects unauthenticated
`/api/*`, so the Worker's header injection must be working.

```bash
W=http://localhost:8787
curl -su agili:cloud-code "$W/api/info";            echo
curl -su agili:cloud-code -o /dev/null -w '%{http_code} %{content_type}\n' "$W/"
curl -su agili:cloud-code -o /dev/null -w '%{http_code}\n' "$W/api/health"
curl -s  -o /dev/null -w '%{http_code}\n' "$W/api/info"
timeout 5 curl -sN -u agili:cloud-code "$W/api/event" | head -3
```

## 4. Activity renewal

The SSE watcher must renew `sleepAfter` on session events.

```bash
# terminal A: keep the stream open
timeout 15 curl -sN -u agili:cloud-code "$W/api/event"

# terminal B: create a session (emits `session.created` on v2)
curl -su agili:cloud-code -H 'content-type: application/json' \
  -d '{"title":"e2e"}' "$W/api/session"
```

Terminal with `pnpm dev` should log:

```
Renewed container activity timeout
```

## 5. Clean up

```bash
# stop pnpm dev with Ctrl-C in its terminal
cp /tmp/dev.vars.bak .dev.vars
```

## Troubleshooting

| Symptom                                                                                                                            | Cause                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `Container failed to start`, interceptor log has `iptables ... RULE_APPEND failed` and `Extension socket revision 0 not supported` | `xt_socket` missing or no `NET_ADMIN`; use Docker Desktop or a host with the module loaded |
| `Container failed to start`, interceptor log has `lookup host.docker.internal ... no such host`                                    | Docker Desktop integration disabled; the name is normally injected automatically           |
| Container exits immediately, log `[ERROR] S3 mount failed`                                                                         | `S3_*` still set in `.dev.vars`; remove them for the test                                  |
| `/api/info` returns `401` through the Worker                                                                                       | `OPENCODE_PASSWORD` / `SERVER_PASSWORD` empty, so the Worker sends no credentials          |

Logs to check:

```bash
docker ps -a --format '{{.Names}}\t{{.Status}}' | grep workerd
docker logs <container-id>
```

## Optional: v1 regression

```jsonc
// wrangler.jsonc
"image_vars": { "OPENCODE_MAJOR": "1" }
```

Then `pnpm dev` again and expect `/api/health` to return
`{"healthy":true}` and `/global/event` to stream SSE. Rebuild is required
because the major is baked into the image.
