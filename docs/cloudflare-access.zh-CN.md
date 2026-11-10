# 用 Cloudflare Access 保护 Worker

> [English](cloudflare-access.md) | [简体中文](cloudflare-access.zh-CN.md)

状态：生产环境推荐方案。Worker 内置的 Basic Auth 网关（`SERVER_PASSWORD`）用于本地
开发依然合适，但它会弹出浏览器原生凭据框，无法主动登出，也无法按人撤销权限。

Cloudflare Access 部署在 Worker 前面的边缘层：未认证请求不会到达你的代码，已授权用户
通过托管登录页（邮箱一次性验证码、GitHub、Google 或任意 SAML/OIDC IdP）登录，支持
MFA、按用户撤销和审计日志。50 个用户以内免费。

启用 Access 无需修改本仓库代码。

## 前置条件

- 已启用 Zero Trust 的 Cloudflare 账号（Dashboard → **Zero Trust**，完成一次性的
  team domain 初始化）。
- 具备该账号下管理 Workers 与 Access 应用的权限。
- 准备至少一种登录方式：内置的 **One-time PIN**（邮箱验证码）开箱即用，无需配置 IdP；
  若需要 SSO，可在 **Zero Trust → Integrations → Identity providers** 添加
  GitHub/Google/SAML。

## 选择应用范围

| 范围                            | 覆盖对象                                                                                           | 配置方式                        | WebSocket                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------ |
| **Worker 级**（本项目推荐）     | 该 Worker 的所有路由：`workers.dev`、preview URL、deployment URL，以及之后绑定的任何 Custom Domain | Dashboard 操作，无需改 DNS      | **不支持** —— 升级请求返回 403 |
| **主机名级**                    | 仅你填写的那个主机名或路径                                                                         | 主机名必须属于账号下的某个 zone | 支持                           |
| 账号级（"Protect all Workers"） | 账号下所有 Worker                                                                                  | Dashboard 操作                  | 不支持                         |

本项目优先推荐 Worker 级 Access。它一步覆盖 `workers.dev` 与后续可能绑定的自定义域名；
而当前 UI 通过 HTTP + SSE 与容器通信，不依赖 WebSocket。

OpenCode 二进制里确实包含 WebSocket 代码。如果你依赖的功能（例如终端或实时同步通道）
实测用到了 WebSocket，请改用自定义域名上的主机名级应用——不要停留在 Worker 级 Access
而牺牲该功能。

## 方案 A：Worker 级 Access（无需自定义域名）

1. Dashboard → **Workers & Pages** → 选择 `cloud-code`。
2. 打开 **Access** 标签 → **Protect this Worker behind Access**。
3. 流量范围选 **All traffic**（同时覆盖生产与 preview）。
4. 认证策略：
   - 个人自用：选 **Cloudflare account**（允许当前 Cloudflare 账号成员登录）。
   - 公司域名：选 **Email domain** 并填你自己的域名。**切勿**填写 `gmail.com` 等公共
     邮箱域名——那会放行该域名下的所有邮箱。
   - 指定个人邮箱：先完成当前向导，再去 **Zero Trust → Access controls →
     Applications** 编辑自动生成的 `cloud-code` 应用，把策略规则改为 **Emails** 并填入
     具体邮箱地址。
5. Session duration：24 小时是合理默认值。
6. 点击应用，然后按[生产环境关闭 Basic Auth 网关](#生产环境关闭-basic-auth-网关)完成收尾。

## 方案 B：主机名级 Access（自定义域名，支持 WebSocket）

1. 在 `wrangler.jsonc` 中绑定自定义域名，并同时关闭 `workers.dev` 和预览 URL：

   ```jsonc
   {
     "workers_dev": false,
     "preview_urls": false,
     "routes": [{ "pattern": "agent.example.com", "custom_domain": true }],
   }
   ```

2. **Zero Trust → Access controls → Applications → Create new application →
   Self-hosted and private → Add public hostname** → 填入 `agent.example.com`。
3. 复用方案 A 的 Allow 策略与会话时长。
4. 创建应用，然后按[生产环境关闭 Basic Auth 网关](#生产环境关闭-basic-auth-网关)完成收尾。

为什么两个开关都要关：主机名级应用**只保护** `agent.example.com` 这一个入口。只要
`workers_dev` 或 `preview_urls` 还开着，`*.workers.dev` 地址就能直接绕过 Access。另一种
做法是保留 Worker 级 Access 作为兜底——按 Access 优先级，`agent.example.com` 仍命中
主机名规则（支持 WebSocket），其余 Worker URL 则由 Worker 级规则兜底拦截。

## 生产环境关闭 Basic Auth 网关

完成方案 A 或方案 B 后紧接着执行本节。生产环境不要同时开启 Access 与
`SERVER_PASSWORD`，否则用户需要登录两次。

**顺序不能反。** `src/container.ts:23` 按 `OPENCODE_PASSWORD || SERVER_PASSWORD` 解析
OpenCode v2 容器密码。如果先删了 `SERVER_PASSWORD` 而没单独设置 `OPENCODE_PASSWORD`，
v2 容器在下次启动时会丢失已知密码并随机生成新密码，Worker 对 `/api/*` 的所有请求都会
返回 `401`。

```bash
# 1. 先单独设置容器 API 密码
pnpm exec wrangler secret put OPENCODE_PASSWORD

# 2. 再删除浏览器侧的 Basic Auth 网关密码
pnpm exec wrangler secret delete SERVER_PASSWORD
pnpm exec wrangler secret delete SERVER_USERNAME   # 可选
```

注意：

- 本仓库 `wrangler.jsonc` 配置了 `"keep_vars": true`。如果 `SERVER_PASSWORD` 当初是在
  Dashboard 里按明文 Variable（而非 Secret）添加的，`wrangler secret delete` 删不掉，
  需要去 **Workers & Pages → cloud-code → Settings → Variables and Secrets** 手动删除。
- 在本地 `.dev.vars` 中继续保留 `SERVER_USERNAME` 和 `SERVER_PASSWORD`，让 `pnpm dev`
  在本地仍有认证网关——Access 只在 Cloudflare 边缘生效，不会保护 `localhost:8787`。
- Secret 变更只在新容器实例启动时生效。执行完后等待 `sleepAfter`（`10m`）自然休眠，或
  删除当前容器实例让它带着 `OPENCODE_PASSWORD` 重启。

## 登出与会话过期

- **主动登出**：访问 `https://<你的-worker-域名>/cdn-cgi/access/logout` 或
  `https://<你的-team-名称>.cloudflareaccess.com/cdn-cgi/access/logout`，即可清除
  `CF_Authorization` Cookie。
- **使用中过期**：会话时长到期后，已经打开的 OpenCode 标签页不会自动跳转登录页，表现为
  后台 `/api/*` 与 `/api/event` 请求开始失败；刷新页面即可重新触发 Access 登录。

## 机器访问：Service Token

脚本、监控和 `curl` 不能再使用 `-u user:password`，需要改用 Service Token：

1. **Zero Trust → Access controls → Service credentials → Service Tokens → Create**。
2. 复制 Client ID 和 Client Secret（Secret 只显示一次）。
3. 打开对应的 Access 应用 → **Policies** → 新增一条策略：**Action 必须选
   `Service Auth`**（不要选 `Allow`，`Allow` 策略对非交互客户端仍会 302 到登录页），
   Include 规则勾选刚才创建的 Service Token。
4. 建议在该应用的 **Additional settings** 中开启 **401 Response for Service Auth
   policies**，这样 token 错误时返回 `401` 而不是 `302`，脚本更容易排错。

在所有请求上同时携带两个头（包括长连接的 SSE 请求）：

```bash
curl -H "CF-Access-Client-Id: $ACCESS_CLIENT_ID" \
     -H "CF-Access-Client-Secret: $ACCESS_CLIENT_SECRET" \
     https://cloud-code.<subdomain>.workers.dev/api/info
```

## 验证

```bash
# 未带凭据：预期 302 到 <team>.cloudflareaccess.com（开启了 Service Auth 401 则为 401）
curl -sI https://cloud-code.<subdomain>.workers.dev/

# 携带 Service Token：预期返回 200
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "CF-Access-Client-Id: $ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $ACCESS_CLIENT_SECRET" \
  https://cloud-code.<subdomain>.workers.dev/
```

再用浏览器无痕窗口打开 URL：应当看到 Cloudflare Access 登录页，而不是浏览器原生的
Basic Auth 弹窗。登录通过后，OpenCode UI 与 SSE 事件流均正常加载。

## 限制与注意事项

- **WebSocket** 在 Worker 级和账号级 Access 下会返回 `403`。需要 WebSocket 时请改用
  自定义域名上的主机名级应用。
- **本地开发不受保护。** `pnpm dev` 不经过 Access，请在 `.dev.vars` 中保留 Basic Auth。
- **登录页品牌定制有限**，只能改 logo、背景与标题文字
  （**Zero Trust → Settings → Custom pages**），完全自定义 HTML 需要 Enterprise 计划。
  如果登录页必须与 OpenCode UI 风格一致，替代方案是在 Worker 侧自建登录页 + 签名
  Cookie。
- **跨源调用**：同源浏览器访问开箱即用。若从其他域名跨域调用该 Worker，Access 默认会
  拦截不带凭据的 `OPTIONS` 预检请求，需要在 Access 应用中配置 **CORS settings**。
- **`ctx.access`** 可在 Worker 内读取已登录用户身份（邮箱、用户组），但本项目未使用；
  仅做访问控制无需解析 JWT。
- **Access 优先级**：主机名/路径规则最先匹配，其次 Worker 级，最后账号级。删除具体规则
  后，请求会退回到下一层范围更广的规则。

## 回滚

1. 先恢复 Worker 内置的 Basic Auth 网关，避免回滚期间裸奔：
   `pnpm exec wrangler secret put SERVER_PASSWORD`。
2. 再关闭 Access：
   - Worker 级：**Workers & Pages → cloud-code → Access → Disable Access**。
   - 主机名级：在 **Zero Trust → Access controls → Applications** 中删除对应应用。
