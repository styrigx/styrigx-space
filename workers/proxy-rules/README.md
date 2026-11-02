# styrigx-proxy-rules

## 职责

规则集加速反代：只放行 [MetaCubeX/meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat) `meta` 分支下 `geo/geosite`、`geo/geoip` 的规则集文件（`.mrs` `.yaml` `.list`），其他路径一律 404，不当开放代理用。上游先 jsDelivr、再 raw.githubusercontent，每个上游等响应头最多 8 秒；边缘缓存 24 小时。响应头全部重建：只带 Content-Type、Cache-Control、ETag、Last-Modified、CORS 和本 Worker 的诊断头（`X-Proxy-Rules-*`），上游的 CSP、HSTS、Set-Cookie 等一律不透传。不验会话。

## 入口

`src/index.js`（`wrangler.toml` 的 `main`）：只有 `default.fetch`，逻辑和白名单都在这一个文件里。

## 路由

自定义域名 `proxy-rules.styrigx.com`（`wrangler.toml` 的 `routes`，`custom_domain = true`），不过网关。

| 路径 | 方法 | 结果 |
|---|---|---|
| `/`、`/healthz` | 任意 | 200 `styrigx-proxy-rules ok`（styrigx-status 每分钟测 `/healthz`） |
| `/MetaCubeX/meta-rules-dat/meta/geo/<geosite\|geoip>/<名字>.<mrs\|yaml\|list>` | GET、HEAD | 命中缓存直接回；否则依次试上游，都不行回 404 / 502 |
| 其他 | GET、HEAD | 404 |
| 任意 | 其他方法 | 405 |

## 绑定

没有任何绑定（没有 KV、D1、服务绑定）。缓存用的是边缘默认缓存 `caches.default`。

## 钥匙

没有。

## 数据与迁移

没有存储，没有 `migrations/`。部署：`.github/workflows/deploy.yml` 的 `deploy-proxy-rules-worker`，独立部署，不等也不挡网关和 Pages。测试：`tests/workers/proxy-rules/`。
