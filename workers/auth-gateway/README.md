# styrigx-auth-gateway

主站鉴权 Worker。承接 `styrigx.com/api/*` 和主站全部页面目录的会话检查（页面验完回源 Pages），代码直接复用 `functions/_middleware.js` 和 `functions/api/*`，不复制。

- 6 个私密值 + 3 把公钥都在 Cloudflare Secrets Store，名字与 Pages 一致；换钥只在后台改，不用改代码或重新部署（最多 60 秒生效）。
- KV / D1 与 Pages 项目 `styrigx-space` 绑定同一份，数据不搬家。
- 不开 `*.workers.dev`；只通过 `styrigx.com` 的路由访问。
- `functions/api/` 新增接口时，在 `src/routes.js` 登记一行（单测会检查）。
- 新增页面目录时，在 `wrangler.toml` 加一条路由（`scripts/check-worker-routes.mjs` 会检查）。静态资源不登记。

上线经过：接 `/api/geo` 试水 → 整体切 `/api/*` → 接管页面会话检查（部署后自动冒烟检查，响应头 `X-SGX-Runtime: worker`）。

下一步：Pages 去掉 functions（`functions/`、`migrations/`、根 `wrangler.toml` 搬进本目录），预览测试改跑网关。
