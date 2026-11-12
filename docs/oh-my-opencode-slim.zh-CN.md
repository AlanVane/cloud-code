# 容器内的 OpenCode 编排插件

> [English](oh-my-opencode-slim.md) | [简体中文](oh-my-opencode-slim.zh-CN.md)

v2 镜像内置 [`oh-my-opencode-slim`](https://www.npmjs.com/package/oh-my-opencode-slim)：一个
orchestrator，负责规划任务、在子会话里调度专职 agent（`oracle`、`explorer`、`designer`、
`fixer`、`observer`），并让主上下文保持精简。v1 镜像完全不受影响。

## 镜像里有什么

```text
构建期
  /opt/opencode-plugins.tar.zst        25 MB   zstd 压缩包，仅 v2
    └── node_modules/oh-my-opencode-slim        10 MB
    └── node_modules/…                         保留了 optional 依赖（见下）

运行期（每次启动）
  /opt/opencode-plugins/                229 MB  解压到实例磁盘
```

之所以是 25 MB 而不是 229 MB：Cloudflare 容器**每次启动都会从镜像重建磁盘**，把展开的目录
放进镜像只会让镜像白白变大。解压实测 **约 0.4 秒**（`zstd -dc | tar -xf`），落在实例本地盘，因此插件不占用
FUSE 挂载的 S3 工作区。镜像里因此安装了 `zstd`；用 gzip 时实测 1.0 秒、归档 38 MB。

`optionalDependencies` 是特意保留的：去掉它们会丢失 `jsdom`（`webfetch` 处理 HTML 会
失败）和 `@ast-grep/cli`（`ast_grep_*` 工具会失效）。

## entrypoint 做了什么

```text
setup_workspace
  └── 缺失时把 config/opencode/opencode.json、AGENTS.md、oh-my-opencode-slim.json
      复制到 $XDG_CONFIG_HOME/opencode
extract_plugins
  └── tar -xzf /opt/opencode-plugins.tgz -C /opt/opencode-plugins
register_plugin
  └── 把 /opt/opencode-plugins/node_modules/oh-my-opencode-slim 合并进全局
      opencode.json 的 `plugins` 数组
```

`register_plugin` 是幂等的，会保留你自己加的条目；如果配置文件不是合法 JSON，它只会告警
并保持文件原样。

## 配置

两个文件，两个归属：

| 文件                       | 归属     | 内容                                                                   |
| -------------------------- | -------- | ---------------------------------------------------------------------- |
| `opencode.json`            | OpenCode | `plugins`、`permission`、`autoupdate`                                  |
| `oh-my-opencode-slim.json` | 插件     | `preset`、`presets`、`disabled_agents`、`autoUpdate`、`tui`、`sidebar` |

两者都落在 `/root/s3/.opencode/config/opencode/`（走 S3，重启后仍在）。

内置预设是 `opencode-go`，所有 agent 固定到 `opencode` / `opencode-go` 的模型。直接改：

```bash
# 容器内
$EDITOR /root/s3/.opencode/config/opencode/oh-my-opencode-slim.json
```

删除该文件会在下次启动时从镜像重新生成；编辑过的内容不会被覆盖。

### 项目级覆盖

插件还会读取 `<项目>/.opencode/oh-my-opencode-slim.jsonc`，优先级高于上面的用户配置。已在
OpenCode 2.2.5 + 插件 3.0.7 上验证：项目文件把 `orchestrator` 设为 `gpt-6.1-sol`、
`disabled_agents: ["explorer"]`，即使全局配置写了相反的值，`/api/agent` 仍以项目配置为准。

### Provider 凭据

预设需要 `OPENCODE_API_KEY`（一个 key 同时覆盖 `opencode` 与 `opencode-go`）。Worker 会把
所有字符串环境变量转发给容器，`scripts/sync-dev-secrets.mjs` 可以用 `pnpm secrets:sync`
上传这个 key。见[部署到 Cloudflare](deployment.zh-CN.md)。

## 升级或移除

| 目标     | 做法                                                                                 |
| -------- | ------------------------------------------------------------------------------------ |
| 升级插件 | 改 `docker/opencode-plugins/package.json`，重新生成 `package-lock.json`，重新构建    |
| 去掉插件 | 把 `image_vars.OPENCODE_MAJOR` 改成 `"1"`，或删除那段 `RUN` 与 entrypoint 的两个调用 |
| 换预设   | 编辑 `oh-my-opencode-slim.json`（镜像默认值或 S3 上的副本）                          |

只手工删掉 `opencode.json` 里的插件路径是不够的：只要压缩包还在，下次启动 `register_plugin`
会重新加回去。

## 验证数据

```text
载荷              解压    磁盘     jsdom   @ast-grep/cli
full（默认）      1.4–1.8 s 229 MB  ok      ok
--omit=optional   0.8 s    95 MB   缺失    缺失
```

两种载荷都能在 `--network none` 的容器里加载插件，这点很关键：镜像只在构建期需要 registry。
解压后 `GET /api/agent` 会在内置 agent（`build`、`plan`、`compaction`、`title`、`summary`）
之外列出 OMS 的 agent 名单。
