# Protect the Worker with Cloudflare Access

> [English](cloudflare-access.md) | [简体中文](cloudflare-access.zh-CN.md)

Status: recommended for production. The in-Worker Basic Auth gate (`SERVER_PASSWORD`)
is still fine for local development, but it uses the browser-native credentials dialog,
cannot be logged out of, and cannot be revoked per person.

Cloudflare Access sits in front of the Worker at the edge: unauthenticated requests
never reach your code, and approved users sign in through a hosted login page
(one-time email PIN, GitHub, Google, or any SAML/OIDC IdP) that supports MFA,
per-user revocation, and audit logs. Access is free for up to 50 users.

Enabling Access requires no changes to this repository's code.

## Prerequisites

- A Cloudflare account with Zero Trust enabled (Dashboard → **Zero Trust**; complete
  the one-time team-domain setup).
- Permission to manage both Workers and Access applications on that account.
- At least one login method: the built-in **One-time PIN** (email code) works without
  any IdP configuration; add GitHub/Google/SAML under **Zero Trust → Integrations →
  Identity providers** if you prefer SSO.

## Choose the application scope

| Scope                                 | Covers                                                                                                     | Setup                                                 | WebSocket                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------- |
| **Worker-level** (recommended here)   | The Worker on every route: `workers.dev`, preview URLs, deployment URLs, and any Custom Domain added later | Dashboard, no DNS changes                             | **Not supported** — upgrade requests get `403` |
| **Hostname-based**                    | Only the exact hostname or path you enter                                                                  | Needs the hostname to belong to a zone on the account | Supported                                      |
| Account-level ("Protect all Workers") | Every Worker in the account                                                                                | Dashboard                                             | Not supported                                  |

Worker-level Access is the best fit for this project. It protects the `workers.dev` URL
and any future Custom Domain in one step, and the current UI talks to the container
over HTTP + SSE rather than WebSockets.

OpenCode's binary does contain WebSocket code. If a feature you rely on (for example a
terminal or live sync channel) uses WebSockets in practice, switch to a hostname-based
application on a Custom Domain instead — do not stay on Worker-level Access and lose
that feature.

## Option A: Worker-level Access (no custom domain)

1. Dashboard → **Workers & Pages** → select `cloud-code`.
2. Open the **Access** tab → **Protect this Worker behind Access**.
3. Traffic scope: **All traffic** (production and previews).
4. Authentication policy:
   - Personal use: choose **Cloudflare account** (allows members of your Cloudflare
     account).
   - Company domain: choose **Email domain** and enter your own domain. **Never** enter
     a public mailbox domain such as `gmail.com` — that allows every address on that
     domain.
   - Specific email addresses: apply the rule first, then open **Zero Trust → Access
     controls → Applications**, edit the generated `cloud-code` application, and change
     the policy rule to **Emails**.
5. Session duration: 24 hours is a reasonable default.
6. Apply, then complete [Turn off the Basic Auth gate in production](#turn-off-the-basic-auth-gate-in-production).

## Option B: Hostname-based Access (custom domain, WebSocket-safe)

1. Add a Custom Domain to the Worker in `wrangler.jsonc` and disable both `workers.dev`
   and preview URLs:

   ```jsonc
   {
     "workers_dev": false,
     "preview_urls": false,
     "routes": [{ "pattern": "agent.example.com", "custom_domain": true }],
   }
   ```

2. **Zero Trust → Access controls → Applications → Create new application →
   Self-hosted and private → Add public hostname** → `agent.example.com`.
3. Reuse the same Allow policy and session duration as Option A.
4. Create the application, then complete
   [Turn off the Basic Auth gate in production](#turn-off-the-basic-auth-gate-in-production).

Why both flags matter: a hostname-based application protects **only**
`agent.example.com`. Leaving `workers_dev` or `preview_urls` enabled exposes
`*.workers.dev` URLs that bypass Access entirely. Alternatively, keep Worker-level
Access enabled as a fallback — under the Access hierarchy, the hostname rule still wins
on `agent.example.com` (with WebSocket support) while Worker-level Access covers every
other Worker URL.

## Turn off the Basic Auth gate in production

Do this immediately after enabling Option A or Option B. Access and `SERVER_PASSWORD`
must not both be active in production, otherwise visitors sign in twice.

**Order matters.** `src/container.ts:23` resolves the OpenCode v2 container password as
`OPENCODE_PASSWORD || SERVER_PASSWORD`. If you delete `SERVER_PASSWORD` before setting a
dedicated `OPENCODE_PASSWORD`, the v2 container loses its known password, generates a
random one on the next start, and the Worker fails every `/api/*` call with `401`.

```bash
# 1. Set a dedicated container API password first
pnpm exec wrangler secret put OPENCODE_PASSWORD

# 2. Then remove the browser Basic Auth gate
pnpm exec wrangler secret delete SERVER_PASSWORD
pnpm exec wrangler secret delete SERVER_USERNAME   # optional
```

Notes:

- `wrangler.jsonc` sets `"keep_vars": true`. If `SERVER_PASSWORD` was added as a
  plain-text Variable in the Dashboard instead of a Secret, `wrangler secret delete`
  will not remove it — delete it under **Workers & Pages → cloud-code → Settings →
  Variables and Secrets** in the Dashboard.
- Keep `SERVER_USERNAME` and `SERVER_PASSWORD` in `.dev.vars` so `pnpm dev` still has a
  gate locally. Access only runs at Cloudflare's edge and does not protect
  `localhost:8787`.
- Secret changes only reach the container when a new instance starts. Wait for
  `sleepAfter` (`10m`) or delete the running container instance so it restarts with
  `OPENCODE_PASSWORD`.

## Sign out and session expiry

- **Sign out:** visit `https://<your-worker-host>/cdn-cgi/access/logout` or
  `https://<your-team-name>.cloudflareaccess.com/cdn-cgi/access/logout` to clear the
  `CF_Authorization` cookie.
- **Expiry during a live session:** when the session duration elapses, an already-open
  OpenCode tab will not redirect on its own — background `/api/*` and `/api/event`
  requests start failing until you reload the page, which triggers the Access sign-in
  flow again.

## Machine access: Service Tokens

Scripts, monitors, and `curl` can no longer use `-u user:password`. Create a service
token instead:

1. **Zero Trust → Access controls → Service credentials → Service Tokens → Create**.
2. Copy the Client ID and Client Secret (the secret is shown only once).
3. Open your Access application → **Policies** → add a policy with Action set to
   **Service Auth** (not **Allow** — an Allow policy still redirects non-interactive
   clients to the login page) and an Include rule for that Service Token.
4. Recommended: under the application's **Additional settings**, enable **401 Response
   for Service Auth policies** so invalid tokens get a `401` instead of a `302`
   redirect.

Send both headers on every request, including long-lived SSE streams:

```bash
curl -H "CF-Access-Client-Id: $ACCESS_CLIENT_ID" \
     -H "CF-Access-Client-Secret: $ACCESS_CLIENT_SECRET" \
     https://cloud-code.<subdomain>.workers.dev/api/info
```

## Verification

```bash
# Unauthenticated: expect 302 to <team>.cloudflareaccess.com (or 401 if Service Auth 401 is enabled)
curl -sI https://cloud-code.<subdomain>.workers.dev/

# With a service token: expect 200
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "CF-Access-Client-Id: $ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $ACCESS_CLIENT_SECRET" \
  https://cloud-code.<subdomain>.workers.dev/
```

Then open the URL in a private window: you should see the Cloudflare Access login page,
not the browser Basic Auth dialog. After signing in, the OpenCode UI loads normally,
including SSE updates.

## Limitations and caveats

- **WebSockets** fail with `403` under Worker-level and account-level Access. Use a
  hostname-based application on a Custom Domain if you need them.
- **Local development is unprotected.** `pnpm dev` never touches Access; keep Basic
  Auth in `.dev.vars`.
- **Login page branding is limited** to logo, background, and header text
  (**Zero Trust → Settings → Custom pages**). Full custom HTML requires an Enterprise
  plan. If the login page must match the OpenCode UI style, a Worker-side login page
  with a signed cookie is the alternative.
- **Cross-origin callers:** same-origin browser use works out of the box. If another
  origin calls this Worker, Access intercepts unauthenticated `OPTIONS` preflights
  unless you configure **CORS settings** on the Access application.
- **`ctx.access`** is available inside the Worker for reading the signed-in user's
  identity (email, groups), but this project does not use it; enforcing access alone
  needs no JWT parsing.
- **Access hierarchy:** hostname/path rules apply first, then Worker-level, then
  account-level. Removing a specific rule falls back to the broader rule underneath.

## Rollback

1. Re-enable the in-Worker Basic Auth gate first so the Worker is never left open:
   `pnpm exec wrangler secret put SERVER_PASSWORD`.
2. Disable Access:
   - Worker-level: **Workers & Pages → cloud-code → Access → Disable Access**.
   - Hostname-based: delete the Access application in **Zero Trust → Access controls →
     Applications**.
