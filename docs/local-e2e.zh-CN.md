# 本地端到端验证（OpenCode v2）

> [English](local-e2e.md) | [简体中文](local-e2e.zh-CN.md)

一次性验证完整链路：Worker → Durable Object → 容器 → OpenCode v2。重点覆盖
`tsc` 和 `wrangler deploy --dry-run` 验证不到的部分：`opencode:<password>` 认证注入、
`/api/event` 探测、以及 activity 超时续期。

升级 `OPENCODE_VERSION_V2` 或改动 `src/container.ts` 之后、部署之前跑一遍。

## 前置条件

| 要求                          | 检查方式                                                 |
| ----------------------------- | -------------------------------------------------------- |
| 可用的 Docker（含容器网络）   | `docker info` 正常                                       |
| `xt_socket` 内核模块（Linux） | `ls /lib/modules/$(uname -r)/kernel/net/*/xt_socket.ko*` |
| pnpm 12.18.0                  | `pnpm --version`                                         |
| 构建镜像需要出网              | `curl -I https://opencode.ai`                            |

`wrangler dev` 会启动一个 egress 拦截容器，它需要 `iptables` NAT 规则，因此需要
Docker Desktop（macOS / Windows），或者加载了该模块的 Linux 主机。见[常见问题](#常见问题)。

## 0. 准备 `.dev.vars`

如果还没有该文件，从仓库里的模板复制：

```bash
cp .dev.vars.example .dev.vars
```

测试期间只保留这三个键：S3 只配置一部分、且端点不可达时容器会直接退出；指向
`127.0.0.1` 的代理变量在容器里也解析不到。

```
SERVER_USERNAME=agili
SERVER_PASSWORD=cloud-code
OPENCODE_PASSWORD=cloud-code
```

```bash
cp .dev.vars /tmp/dev.vars.bak
```

## 1. 启动 dev server

```bash
pnpm install
pnpm dev            # 保持前台运行；首次运行会先构建镜像
```

看到下面两行再继续：

```
⎔ Container image(s) ready
[wrangler:info] Ready on http://localhost:8787
```

## 2. 触发容器启动

容器是懒启动的，第一次请求要等约 30–60 秒：

```bash
curl -s -u agili:cloud-code http://localhost:8787/api/info
```

## 3. 接口断言

| 请求                                      | 预期                                                             |
| ----------------------------------------- | ---------------------------------------------------------------- |
| `curl -su agili:cloud-code $W/api/info`   | `200` `{"version":"2.x.y",...}`                                  |
| `curl -su agili:cloud-code $W/`           | `200 text/html`                                                  |
| `curl -su agili:cloud-code $W/api/health` | `404`（v2 没有该端点）                                           |
| `curl -s $W/api/info`                     | `401`（Worker 入口认证）                                         |
| `curl -su agili:cloud-code $W/api/event`  | SSE，首帧 `data: {"id":...,"type":"server.connected","data":{}}` |

其中 `/api/info` 返回 `200` 是关键信号：v2 会拒绝未认证的 `/api/*`，能通就说明
Worker 的认证注入生效了。

```bash
W=http://localhost:8787
curl -su agili:cloud-code "$W/api/info";            echo
curl -su agili:cloud-code -o /dev/null -w '%{http_code} %{content_type}\n' "$W/"
curl -su agili:cloud-code -o /dev/null -w '%{http_code}\n' "$W/api/health"
curl -s  -o /dev/null -w '%{http_code}\n' "$W/api/info"
timeout 5 curl -sN -u agili:cloud-code "$W/api/event" | head -3
```

## 4. activity 续期

SSE watcher 必须在会话事件上续期 `sleepAfter`。

```bash
# 终端 A：保持事件流打开
timeout 15 curl -sN -u agili:cloud-code "$W/api/event"

# 终端 B：创建会话（v2 会发出 session.created）
curl -su agili:cloud-code -H 'content-type: application/json' \
  -d '{"title":"e2e"}' "$W/api/session"
```

`pnpm dev` 的终端应出现：

```
Renewed container activity timeout
```

## 5. 收尾

```bash
# 在 pnpm dev 的终端按 Ctrl-C
cp /tmp/dev.vars.bak .dev.vars
```

## 常见问题

| 现象                                                                                                                         | 原因                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `Container failed to start`，拦截器日志出现 `iptables ... RULE_APPEND failed` 和 `Extension socket revision 0 not supported` | 缺少 `xt_socket` 模块或没有 `NET_ADMIN`；换 Docker Desktop 或加载该模块的主机 |
| `Container failed to start`，拦截器日志出现 `lookup host.docker.internal ... no such host`                                   | Docker Desktop 集成未启用；该名字通常由 Docker 自动注入                       |
| 容器启动即退出，日志 `[ERROR] S3 mount failed`                                                                               | `.dev.vars` 里还留着 `S3_*`，测试时请移除                                     |
| 经 Worker 访问 `/api/info` 返回 `401`                                                                                        | `OPENCODE_PASSWORD` / `SERVER_PASSWORD` 为空，Worker 没有凭据可注入           |

排查用的日志：

```bash
docker ps -a --format '{{.Names}}\t{{.Status}}' | grep workerd
docker logs <container-id>
```

## 可选：v1 回归

```jsonc
// wrangler.jsonc
"image_vars": { "OPENCODE_MAJOR": "1" }
```

再跑一次 `pnpm dev`，预期 `/api/health` 返回 `{"healthy":true}`、`/global/event`
能正常输出 SSE。大版本是烤进镜像的，必须重新构建。
