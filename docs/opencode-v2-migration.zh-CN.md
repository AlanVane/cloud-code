# 容器中的 OpenCode v2 支持

> [English](opencode-v2-migration.md) | [简体中文](opencode-v2-migration.zh-CN.md)

状态：**已实现并在本地验证**。代码库在同一套镜像结构下同时支持 OpenCode v1 与 v2：
`wrangler.jsonc` 当前默认构建 v2（`image_vars.OPENCODE_MAJOR = "2"`），而不带构建参数
直接执行 `docker build` 时默认构建 v1（`ARG OPENCODE_MAJOR=1`）。

## 目标

在容器内运行 OpenCode v2（`opencode serve`），同时保留 v1（`opencode web`）全链路可用，
仅通过一个构建参数即可切换大版本。

## 实测差异（v1.19.5 vs v2.2.5）

| 维度       | v1（`1.19.5`）                                      | v2（`2.2.5`）                                                         |
| ---------- | --------------------------------------------------- | --------------------------------------------------------------------- |
| 启动命令   | `opencode web --port 2633 --hostname 0.0.0.0`       | `opencode serve --hostname 0.0.0.0 --port 2633`（无 `web` 子命令）    |
| 事件流端点 | `/global/event`（SSE）；`/api/event` 也返回 200 SSE | `/api/event`（SSE）；`/global/event` 返回 200 `text/html`（SPA 回退） |
| 事件帧结构 | `{"payload":{"id","type",...}}`（或顶层 `type`）    | `{"id","type","data"}`（`type` 位于顶层）                             |
| 健康检查   | `/api/health` → `{"healthy":true}`                  | `/api/health` → **404**；`/api/info` → `{version,pid,urls,...}`       |
| API 认证   | 无                                                  | `/api/*` 需要 Basic（`opencode:<password>`）；`/` 公开访问            |
| 活跃事件   | `session.updated`                                   | `session.created`、`session.execution.started`、`session.renamed`     |
| 容器密码   | 不适用                                              | 读取 `OPENCODE_PASSWORD`；未设置时每次启动随机生成                    |
| 安装脚本   | `https://opencode.ai/install`                       | `https://opencode.ai/v2/install`（v1 安装脚本拒绝安装 2.x）           |

两个安装脚本均支持 `--version` 与 `--no-modify-path`，安装路径均为
`$HOME/.opencode/bin/opencode`。

## 实现说明

### 1. `Dockerfile`

- 定义 `ARG OPENCODE_MAJOR=1`，并为两个大版本分别锁定版本号
  （`OPENCODE_VERSION_V1=1.19.5`、`OPENCODE_VERSION_V2=2.2.5`）。
- 安装阶段根据 `OPENCODE_MAJOR` 选择安装脚本与版本（`2` 使用 `/v2/install`，其余使用
  `/install`）。
- `/entrypoint.sh` 在运行时通过 `opencode --version` 检测已安装的大版本，自动选择启动
  `opencode serve` 或 `opencode web`，一份脚本覆盖两种镜像。
- v2 启动时若未设置 `OPENCODE_PASSWORD`，entrypoint 会打印警告：此时 `opencode serve`
  会生成随机密码，Worker 将无法通过 `/api/*` 认证。

### 2. `src/container.ts`

- `openEventStream()` 依次尝试 `/api/event` 与 `/global/event`，并要求响应头包含
  `text/event-stream`（因为 v2 对未知路径会返回 `200 text/html` 的 SPA 页面）。第一个
  匹配的响应流会直接交给 SSE reader 消费。
- 只要解析到了容器密码，发往容器的请求都会带上
  `Authorization: Basic base64("opencode:" + opencodePassword)`，满足 v2 对 `/api/*`
  （含 `/api/event`）的认证要求。
- 事件类型按 `event.type ?? event.data?.type ?? event.payload?.type` 读取。v2.2.5 将
  `type` 放在 SSE JSON 帧的**顶层**而非 `data` 内；优先读取 `event.type` 可同时兼容两个
  大版本的活跃续期。
- 活跃超时续期（`renewActivityTimeout()`）对 v1 的 `session.updated` 与 v2 的
  `session.created`、`session.execution.started`、`session.renamed` 立即触发，并对流式事件
  `message.updated` / `message.part.updated` 按 60 秒节流触发，保证长耗时回合与后台子会话
  执行期间容器不会在 `sleepAfter` 到期后休眠回收。
- `withContainerAuthorization()` 在转发请求时会无条件写入（或覆盖）`Authorization` 头为
  容器凭据。无论浏览器侧是通过 Worker 的 Basic Auth（`SERVER_PASSWORD`）还是
  Cloudflare Access（不带 Basic 头）进入，容器收到的始终是它所需的
  `opencode:<password>` 凭据。
- 密码解析：`const opencodePassword = containerEnv.OPENCODE_PASSWORD || containerEnv.SERVER_PASSWORD`。
  只要这两个变量至少设置了一个，Worker 就会通过 `envVars.OPENCODE_PASSWORD` 将其注入
  容器，让 `opencode serve` 使用已知密码；若两个都没设置，则不会注入密码，v2 会随机生成
  密码并导致 `/api/*` 全部 401。

### 3. `src/sse.ts`

- `SSEEvent` 接口在可选的 `data`、`payload` 字段之外，增加了顶层 `type` 字段。

### 4. `config/opencode/opencode.json`

- 无需修改。v2 配置 schema 仍兼容 `"permission": "allow"` 简写（`PermissionActionConfig`
  枚举 `ask | allow | deny`，标记为 deprecated 但依然有效），同一份配置文件可用于两个
  大版本。

### 5. `wrangler.jsonc`

- `containers[0].image_vars.OPENCODE_MAJOR` 控制 Wrangler 构建的大版本（当前为 `"2"`）。
  `image_vars` 会在构建时作为 Docker `--build-arg` 传入。

## 验证记录

1. `docker build --build-arg OPENCODE_MAJOR=2`：镜像内 `opencode --version` 输出
   `v2.2.5`。
2. 直接运行容器：`curl -u opencode:$PW /api/info` 返回 `200`，`/api/event` 持续输出 SSE
   帧，`/api/health` 按预期返回 `404`。
3. `pnpm dev`（`wrangler dev`，`image_vars.OPENCODE_MAJOR = "2"`）：
   - 经 Worker 访问 `/api/info` 返回 `200`（请求头注入生效）。
   - `/` 返回 `200 text/html`；设置 `SERVER_PASSWORD` 后浏览器 Basic Auth 全链路正常。
   - `POST /api/session` 返回 `200`，Worker 在收到 `session.created` 时打印
     `Renewed container activity timeout`。
   - `/api/event` 经 Worker 正常转发 SSE 流。
4. v1 回归（`image_vars.OPENCODE_MAJOR = "1"` 重新构建）：`/api/health` 返回
   `{"healthy":true}`，`/` 返回 `200`，SSE 监听在会话活跃时正常续期。
5. `pnpm lint` 与 `tsc --noEmit` 通过；修改过的文件均通过 `oxfmt --check`（仅存留仓库
   原有的 `AGENTS.md` 格式差异）。

逐条可复制的本地验证步骤见 [本地端到端验证](local-e2e.zh-CN.md)。

## 注意事项

- **v2 必须至少设置一个密码变量。** 请配置 `OPENCODE_PASSWORD`（或配置
  `SERVER_PASSWORD` 由其回退）。若两者皆空，`opencode serve` 启动时会生成随机密码，
  Worker 将无法访问 `/api/*`。
- **v1 与 v2 的 S3 数据目录不兼容。** v2 使用不同的存储结构（数据保存在
  `$XDG_DATA_HOME/opencode/opencode.db` 的 SQLite 中）。切换大版本时请更换新的
  `S3_PREFIX`（或新 bucket）。
- **v2 没有 `/api/health`。** 外部健康检查请改用 `/api/info`。
- **v2 事件名可能随版本演进。** 升级 `OPENCODE_VERSION_V2` 时需复核
  `src/container.ts` 中的 `ACTIVITY_EVENTS`。
- **受限构建网络。** 在需要代理才能出网的主机上构建时，需传入 `HTTP_PROXY` /
  `HTTPS_PROXY` 构建参数（或使用 `docker build --network host`），否则 `apt` 或
  OpenCode 安装脚本下载会失败。

## 回滚到 v1

1. 将 `wrangler.jsonc` 中的 `containers[0].image_vars.OPENCODE_MAJOR` 改回 `"1"`。
2. 将 `S3_PREFIX` 指回 v1 的数据前缀（或全新的空前缀）——不要把跑过 v2 的目录挂给 v1。
3. 重新构建并部署。代码库未删除任何 v1 兼容路径。
