# styrigx-auth-gateway

主站鉴权网关，也是主站全部后端代码所在。承接 `styrigx.com/api/*`、`/avatar/*` 和主站全部页面目录：先验会话，页面验完回源 Pages 取静态文件。Pages 本身只放静态文件（配置见 `web/wrangler.toml`）。

```
src/         部署入口（worker.js）、公网请求（index.js）、接口路由表（routes.js）、Secrets Store 取值（secrets.js）、子站门禁（subsites.js）、给其他 Worker 的验票 RPC（rpc.js + verifier.js）
functions/   middleware（会话、角色、锁屏）、接口（api/）、内核（_kernel/）、头像（avatar/）
migrations/  D1 建表
```

- 子站：`blog.styrigx.com`、`book.styrigx.com` 的页面路径也登记在 `wrangler.toml`，网关验会话（owner、visitor 都放行）后回源子站 Pages；未登录 302 到主站锁屏，`/api/session-check` 由网关直接回答。子站登记表在 `src/subsites.js`，新增子站要在那里加一项并登记路由。子站 Pages 不持任何钥匙。
- 给其他 Worker 验票：服务绑定 RPC `SessionVerifier`（`session(cookieHeader)` → `{ok, role}`；`appPass(cookieHeader, aud, scope)` → `{ok, appEpoch}`；`appEpoch(aud)` → `{ok, appEpoch}`）。调用方 wrangler.toml 写 `[[services]] binding = "AUTH"`、`service = "styrigx-auth-gateway"`、`entrypoint = "SessionVerifier"`，自己不持任何钥匙。只能经服务绑定调用，公网进不来。
- 6 个私密值 + 3 把公钥都在 Cloudflare Secrets Store；换钥只在后台改，不用改代码或重新部署（最多 60 秒生效）。
- 不开 `*.workers.dev`；只通过 `styrigx.com` 的路由访问。
- `functions/api/` 新增接口时，在 `src/routes.js` 登记一行（单测会检查）。
- 新增页面目录时，在 `wrangler.toml` 加一条路由（`scripts/check-worker-routes.mjs` 会检查）。静态资源不登记。
- 部署顺序：main 上先部署网关并冒烟检查线上，通过后才部署 Pages。
- 回滚：Pages 上已经没有后端代码，不能靠删路由回滚（删了页面就不验会话）；revert 对应提交重新部署。
- 预览（passkey-e2e）：CI 把本目录打包成 Pages 的 `_worker.js`，部署到 `passkey-e2e.styrigx-space.pages.dev`，连预览用的空 KV/D1；此时页面和默认头像读 `env.ASSETS`。
