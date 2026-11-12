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

| 目标         | 做法                                                                                 |
| ------------ | ------------------------------------------------------------------------------------ |
| 升级插件     | 改 `docker/opencode-plugins/package.json`，重新生成 `package-lock.json`，重新构建    |
| 去掉插件     | 把 `image_vars.OPENCODE_MAJOR` 改成 `"1"`，或删除那段 `RUN` 与 entrypoint 的两个调用 |
| 换预设       | 编辑 `oh-my-opencode-slim.json`（镜像默认值或 S3 上的副本）                          |
| 不重建即禁用 | 在 `plugins` 数组里写 `"-oh-my-opencode-slim"` 并重新加载                            |

只手工删掉 `opencode.json` 里的插件路径是不够的：只要压缩包还在，下次启动 `register_plugin`
会重新加回去。带 `-` 前缀的条目则会被尊重——`register_plugin` 看到它就保持数组不动。

## 模型预设

内置文件里有两套预设，`preset` 决定用哪一套。

| 预设                  | orchestrator                  | oracle                      | explorer                          | designer                     | fixer                       | observer                      |
| --------------------- | ----------------------------- | --------------------------- | --------------------------------- | ---------------------------- | --------------------------- | ----------------------------- |
| `opencode-go`（默认） | `opencode/gpt-6.1-sol` (high) | `opencode-go/glm-5.3`       | `opencode-go/deepseek-v4.1-flash` | `opencode/gemini-3.8-flash`  | `opencode-go/mimo-v2.6-pro` | `opencode-go/mimo-v2.6-flash` |
| `openai`              | `openai/gpt-6-sol` (high)     | `openai/gpt-6-astra` (high) | `openai/gpt-6-luna` (low)         | `openai/gpt-6-luna` (medium) | `openai/gpt-6-luna` (high)  | `openai/gpt-6-luna` (low)     |

不写 `preset` 时所有 agent 都跟随会话模型：能用，但放弃了"强 orchestrator + 便宜 worker"的
成本结构。

如果要自己换预设，各角色的要求：

| Agent          | 需要                            | 建议档位       |
| -------------- | ------------------------------- | -------------- |
| `orchestrator` | 长上下文、稳定的工具调用        | 强，高档       |
| `oracle`       | 最强推理，只读                  | 最强，高档     |
| `explorer`     | 快、便宜、只读检索              | 便宜，低档     |
| `designer`     | **图片输入**（截图）            | 中等，中档     |
| `fixer`        | 多文件改写                      | 中档，高档     |
| `observer`     | 多模态，provider 不可用时可禁用 | 便宜的视觉模型 |

### 保存前先确认模型 ID

`model` 不做校验：写错不会降级，而是子会话创建失败。在容器里读模型目录：

```bash
curl -s -u "opencode:__PW__" http://127.0.0.1:2633/api/model \
| python3 -c 'import json,sys
for m in json.load(sys.stdin)["data"]:
    v = ",".join(x["id"] for x in (m.get("variants") or []))
    print(m["providerID"] + "/" + m["modelID"] + ("  #" + v if v else ""))'
```

`__PW__` 是容器 API 密码（`OPENCODE_PASSWORD`，未设置时回退 `SERVER_PASSWORD`）。变体是模型
特有的：只用 `#` 后打印出来的值；不确定就省略 `variant`，写错的变体会导致模型解析失败。

### 应用与验证

1. 编辑 `/root/s3/.opencode/config/opencode/oh-my-opencode-slim.json`（或项目级
   `.opencode/oh-my-opencode-slim.jsonc`，后者优先级更高）。
2. 校验：`python3 -m json.tool <文件> >/dev/null && echo OK`。
3. 重新加载：`curl -s -X POST -u "opencode:__PW__" http://127.0.0.1:2633/api/location/reload`。
4. 确认每个 agent 实际解析到的模型：

```bash
curl -s -u "opencode:__PW__" http://127.0.0.1:2633/api/agent \
| python3 -c 'import json,sys
for a in json.load(sys.stdin)["data"]:
    m = a.get("model") or {}
    print(a["id"], "->", m.get("providerID","?") + "/" + m.get("id","?"), m.get("variant",""))'
```

只改文件不会重新注册 agent，而且经 FUSE 的改动可能不触发 watcher，所以在看 `/api/agent`
之前一定先 reload。

## 回滚

删掉 `preset`（`presets` 可留可删）后 reload：新会话回到跟随会话模型。不需要重启容器或重建镜像。

要整体关掉，把 `image_vars.OPENCODE_MAJOR` 设回 `"1"`（v1 没有压缩包），或者保留 v2、用上面的
`-` 条目只禁用这个插件。

## 排错

| 现象                                | 原因                                                          | 处理                                                                                               |
| ----------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `/api/agent` 里没有 `orchestrator`  | 插件没加载                                                    | 看启动日志里有没有 `Registered OpenCode plugin`，以及 `/opt/opencode-plugins.tar.zst` 是否解压成功 |
| `Cannot find module 'jsdom'`        | 打包时省掉了 optional 依赖                                    | 不要用 `--omit=optional`；默认构建是保留的                                                         |
| `sg: group 'run' does not exist`    | `ast_grep_*` 退回到 `/usr/bin/sg`                             | 确认包里含 `@ast-grep/cli`（默认构建会带）                                                         |
| `PresetResolutionError`             | `preset` 名称或 `extends` 目标不存在                          | 对齐名称                                                                                           |
| `Model unavailable: provider/model` | provider 未连接，或 ID 写错                                   | 重新列模型并核对 ID                                                                                |
| 报某个 variant 的模型解析错误       | 该模型不提供这个变体                                          | 删掉 `variant`                                                                                     |
| agent 还是旧模型                    | 会话绑定的是旧快照                                            | 新建会话，或 reload                                                                                |
| 改了没反应                          | 改错文件（编辑了 `/opt/config-init` 或 `~/.config/opencode`） | 只改 `/root/s3/.opencode/config/opencode/oh-my-opencode-slim.json`                                 |

## 验证数据

```text
载荷              解压    磁盘     jsdom   @ast-grep/cli
full（默认）      1.4–1.8 s 229 MB  ok      ok
--omit=optional   0.8 s    95 MB   缺失    缺失
```

两种载荷都能在 `--network none` 的容器里加载插件，这点很关键：镜像只在构建期需要 registry。
解压后 `GET /api/agent` 会在内置 agent（`build`、`plan`、`compaction`、`title`、`summary`）
之外列出 OMS 的 agent 名单。
