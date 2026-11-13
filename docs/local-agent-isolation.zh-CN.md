# 本地启动后的 Agent 隔离边界

## 结论

**在本机运行 `pnpm start`，可以得到一个运行在本机 Docker 中的 OpenCode 环境。**
前提是 Docker 正常运行、镜像构建成功，并且首次请求后容器成功启动。
它不是直接在 Arch Linux 宿主机上运行 OpenCode，也不需要先部署到 Cloudflare。

但它是容器隔离的执行环境，**不是一个可以放心交给任意不可信代码的绝对安全沙箱**。

## 启动链路

[`package.json`](../package.json) 中，`pnpm start` 和 `pnpm dev` 都执行 `wrangler dev`：

```text
pnpm start
  → wrangler dev
  → 本地 Worker / Durable Object
  → 本地 Docker 容器
  → 容器内的 OpenCode 和工具执行
```

Wrangler 构建项目的 [`Dockerfile`](../Dockerfile)，然后按需启动本地容器。
因此只看到 `http://localhost:8787` 就绪，不代表 OpenCode 已经成功启动；首次通过鉴权的请求会触发容器启动。
这符合 Cloudflare 官方的[本地开发机制](https://developers.cloudflare.com/containers/guides/local-dev/)。

镜像构建、模型 API 和配置的外部服务仍可能需要网络；“本地运行”不等于“完全离线”。

## 隔离了什么

| 方面     | 当前本地模式的行为                                                         |
| -------- | -------------------------------------------------------------------------- |
| 文件系统 | Agent 默认操作容器里的文件，不是整个 Arch 宿主机文件系统                   |
| 工具链   | 使用镜像中的 Debian 系环境、Node.js、Python 等，而不是宿主机的 Arch 工具链 |
| 进程     | Agent 启动的命令运行在容器中；安装软件和修改系统文件主要影响容器环境       |
| 计算资源 | CPU、内存和磁盘资源仍由本机提供，不是借用了 Cloudflare 的云端算力          |

原生 Linux 上的 Docker 通常共享宿主机内核，因此这些边界不等于虚拟机级隔离。
实际安全性还取决于权限、挂载、网络和 Docker 配置。

## 不会自动拿到当前宿主机项目

当前项目没有配置把启动命令所在的宿主机目录自动挂载为 Agent 的工作目录。
OpenCode 的默认项目目录是容器内的：

```text
/root/s3/workspace/project
```

因此，在某个项目目录执行 `pnpm start`，不代表 Agent 就能读取或修改那个目录的宿主机文件。
若要处理自己的代码，需要另外把代码放进容器，例如克隆已推送的仓库，或显式设计目录挂载与同步。

**一旦把宿主机目录以可写方式挂进去，Agent 就能修改挂载范围内的真实文件。**
挂载整个 home、SSH 凭据或 Docker socket，会显著削弱隔离；容器不能保护你主动交给它的权限。

## 三个必须注意的边界

### 1. 传入容器的凭据仍然可被 Agent 使用

[`src/container.ts`](../src/container.ts) 会把 Worker 环境中所有字符串型绑定传入容器。
例如通过 `.dev.vars` 配置的模型密钥、S3 凭据和密码，可能出现在容器环境中。
这不等于自动暴露宿主机的所有环境变量，但也不能把已传入的密钥当作与 Agent 隔离。

当前预置配置还使用 `"permission": "allow"`
（[`config/opencode/opencode.json`](../config/opencode/opencode.json)），不能依赖逐次人工审批来兜底。

### 2. 网络和远程数据不是可随意破坏的副本

容器中的程序仍可访问网络。若配置了真实 S3/R2 存储，挂载后操作的就是那份真实远程数据，
不会因为从 `pnpm start` 启动就自动变成测试副本。

建议本地实验使用单独的测试 bucket 和最小权限凭据，不要直接交给 Agent 生产数据的访问权限。
仅改变挂载路径或对象前缀，不代表凭据权限也被限制在该范围内。

### 3. 本地持久化和常驻运行需要单独考虑

S3 配置不完整时，启动脚本使用容器内的普通目录；不能指望容器删除或重建后保留其中的数据。
S3 配置完整时则尝试挂载，失败会导致启动退出。Linux 上还需满足相应的 FUSE 和网络要求。

Wrangler 开发会话结束时，其关联的容器应被停止；本机休眠或关机后，也不能继续执行任务。
因此，本地模式提供了独立的执行环境，但不提供独立于本机的在线能力。

## 怎么确认容器真的启动了

启动 `pnpm start`，访问终端显示的本地地址并完成鉴权后，另开终端执行：

```bash
docker ps --format 'table {{.ID}}\t{{.Image}}\t{{.Names}}'
```

选择对应 OpenCode 镜像的容器；Wrangler 也可能启动网络辅助容器，不要把它们混为一谈。
如需检查宿主机目录挂载和关键权限，将下面的 `<container-id>` 替换为实际 ID：

```bash
docker inspect <container-id> --format '{{json .Mounts}}'
docker inspect <container-id> --format '{{json .HostConfig.Privileged}}'
docker inspect <container-id> --format '{{json .HostConfig.CapAdd}}'
```

这些信息能帮助核对实际边界，但不能单独证明容器已经安全。
完整的启动准备、API 检查与故障排查见[本地端到端检查](local-e2e.zh-CN.md)。

## 对使用方式的建议

如果你的核心诉求是：

> 保留本机算力，同时让 Agent 在独立环境中执行命令，减少对 Arch 日常环境的影响。

那么这个项目的本地模式已经能提供基本能力，不需要先部署到 Cloudflare。
优先限制传入的凭据和可写目录，并确认工作成果如何保存与导出。

单纯跨设备访问仍可通过受保护的远程连接操作本机；隧道不会让休眠的机器继续计算。
只有希望本机关机或休眠后任务仍能执行，才需要另一台常开主机或云端执行环境。
相关取舍见 [Cloudflare 托管 OpenCode 的价值评估](cloudflare-value-assessment.zh-CN.md)。
