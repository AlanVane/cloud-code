# 部署到 Cloudflare

> [English](deployment.md) | [简体中文](deployment.zh-CN.md)

`pnpm deploy` 执行 `wrangler deploy`：远程构建容器镜像、上传 Worker、创建
Durable Object 与容器绑定。本文列出**首次部署前**必须准备好的东西，以及部署后要验证
的内容。

## 1. Secrets

用 `pnpm exec wrangler secret put <NAME>`（或 Dashboard）设置。仓库里没有任何可用
的真实值。

| 名称                   | 是否必需     | 作用                                                                                                                           |
| ---------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `SERVER_PASSWORD`      | 生产环境必需 | Worker 入口认证；为空表示**完全开放**                                                                                          |
| `SERVER_USERNAME`      | 生产环境必需 | 入口认证的用户名                                                                                                               |
| `OPENCODE_PASSWORD`    | **v2 必需**  | 容器 API 密码；未设置时回退到 `SERVER_PASSWORD`。两者都为空时 `opencode serve` 会生成随机密码，Worker 的 `/api/*` 请求全部失败 |
| `S3_ENDPOINT`          | 仅需持久化时 | 四个 `S3_*` 必须同时设置                                                                                                       |
| `S3_ACCESS_KEY_ID`     | 仅需持久化时 |                                                                                                                                |
| `S3_SECRET_ACCESS_KEY` | 仅需持久化时 |                                                                                                                                |
| `S3_BUCKET`            | 仅需持久化时 |                                                                                                                                |
| `S3_PREFIX`            | 仅需持久化时 | 切换 OpenCode 大版本时必须用**新前缀**                                                                                         |

```bash
pnpm exec wrangler secret put SERVER_USERNAME
pnpm exec wrangler secret put SERVER_PASSWORD
pnpm exec wrangler secret put OPENCODE_PASSWORD
# 仅需要持久化时：
for k in S3_ENDPOINT S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY S3_BUCKET S3_PREFIX; do
  pnpm exec wrangler secret put "$k"
done
```

**不要**设置 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`，除非它们指向容器真能访问的
地址。`http://127.0.0.1:...` 在容器里指向容器自身，会同时破坏构建和 OpenCode 的出网
调用。

`wrangler.jsonc` 里 `keep_vars: true`，Dashboard 上的变量不会因部署而丢失。

`pnpm secrets:sync` 从 `.dev.vars` 读取 `OPENCODE_API_KEY`，用 `wrangler secret bulk`
上传。它只读这一个键，`HTTP_PROXY` 之类的本地值不会离开本机。`pnpm deploy:sync` 会在
`pnpm deploy` 之前先执行它；首次部署时 Worker 还不存在，所以请在首次部署完成后再跑一次。

## 2. 选择 OpenCode 大版本

```jsonc
"containers": [{ "image_vars": { "OPENCODE_MAJOR": "2" } }]
```

大版本是烤进镜像的，改动后必须重新部署。v1 与 v2 的数据布局不同（v2 的 SQLite 位于
`$XDG_DATA_HOME/opencode/opencode.db`），所以切换大版本必须同时换 S3 前缀。

## 3. 部署

```bash
pnpm deploy
```

首次部署最慢：Cloudflare 会按 `Dockerfile` 构建镜像（apt 依赖 + 固定版本的 OpenCode）。

当前资源配置（来自 `wrangler.jsonc`）：

| 项目             | 值                                         |
| ---------------- | ------------------------------------------ |
| Worker placement | `aws:us-west-2`                            |
| 容器限制         | `wnam`                                     |
| 实例规格         | 1 vCPU / 4096 MiB / 8 GB 磁盘              |
| 实例数           | `max_instances: 1`                         |
| 空闲休眠         | `src/container.ts` 中 `sleepAfter = '10m'` |

## 4. 冒烟测试

```bash
W=https://<你的-worker>.workers.dev
U=user:password            # SERVER_USERNAME:SERVER_PASSWORD

curl -su "$U" -w '\n%{http_code}\n' "$W/api/info"     # 200，{"version":"2.x.y",...}
curl -su "$U" -o /dev/null -w '%{http_code} %{content_type}\n' "$W/"   # 200 text/html
curl -su "$U" -o /dev/null -w '%{http_code}\n' "$W/api/health"         # v2 为 404
curl -s  -o /dev/null -w '%{http_code}\n' "$W/api/info"                # 无凭据为 401
timeout 5 curl -sN -u "$U" "$W/api/event" | head -3                    # SSE 帧
```

`/api/info` 返回 `200` 就证明 Worker 成功注入了 `opencode:<password>`；否则 v2 会回
`401`。

想确认 activity 续期，在创建会话的同时看日志：

```bash
pnpm exec wrangler tail          # 终端 A
curl -su "$U" -H 'content-type: application/json' \
  -d '{"title":"smoke"}' "$W/api/session"
# 终端 A 应出现：Renewed container activity timeout
```

## 5. 监控

v2 **没有** `/api/health`。把健康检查改到 `/api/info` 并带上 Basic Auth 头，或者把
Worker 放到 [Cloudflare Access](cloudflare-access.zh-CN.md) 后面再检查 `/`。

## 6. 回滚到 v1

1. 把 `wrangler.jsonc` 的 `image_vars.OPENCODE_MAJOR` 改成 `"1"`。
2. 把 `S3_PREFIX` 指回 v1 的前缀（不要把跑过 v2 的目录挂给 v1）。
3. `pnpm deploy`。

代码库没有删除任何 v1 路径，所以回滚就是改配置 + 重新构建。

## 7. 常见故障

| 现象                                           | 原因                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| 容器启动即退出，日志 `[ERROR] S3 mount failed` | `S3_*` 有误或不完整；entrypoint 在挂载失败时直接退出               |
| 经 Worker 访问 `/api/*` 返回 `401`             | `OPENCODE_PASSWORD` 与 `SERVER_PASSWORD` 都为空，v2 生成了随机密码 |
| 切到 v2 后健康检查突然失败                     | 还在探测 `/api/health`，v2 上是 `404`                              |
| 切换大版本后数据像是空的                       | `S3_PREFIX` 被两个大版本复用                                       |

不部署也想验证同样的链路，见[本地端到端验证](local-e2e.zh-CN.md)。
