# styrigx-auth-gateway

主站鉴权 Worker。承接 `styrigx.com/api/*`，代码直接复用 `functions/_middleware.js` 和 `functions/api/*`，不复制。

- 6 个私密值 + 3 把公钥都在 Cloudflare Secrets Store，名字与 Pages 一致；换钥只在后台改，不用改代码或重新部署（最多 60 秒生效）。
- KV / D1 与 Pages 项目 `styrigx-space` 绑定同一份，数据不搬家。
- 不开 `*.workers.dev`；只通过 `styrigx.com` 的路由访问。
- `functions/api/` 新增接口时，在 `src/routes.js` 登记一行（单测会检查）。

上线顺序：PR1 建好 → PR2 CI 部署 + 接 `/api/geo` 试水（本 PR）→ PR3 整体切 `/api/*` → 收尾删 Pages 上的私密变量。
