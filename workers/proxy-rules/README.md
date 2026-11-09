# styrigx-proxy-rules

## 职责

规则集加速反代：只放行登记过的来源里的规则集文件，其他路径一律 404，不当开放代理用。响应头全部重建：只带 Content-Type（按后缀）、Cache-Control、ETag、Last-Modified、CORS 和本 Worker 的诊断头（`X-Proxy-Rules-*`），上游的 CSP、HSTS、Set-Cookie 等一律不透传。不验会话、不发 cookie。每个上游等响应头最多 8 秒，超时换下一个。

| 来源 | 文件（`src/core/sources/`） | 放行的路径 | 上游顺序 | 边缘缓存 |
|---|---|---|---|---|
| [MetaCubeX/meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat) `meta` 分支 | `metacubex.js` | `geo/geosite`、`geo/geoip` 下的 `.mrs` `.yaml` `.list`（名字允许 `!` 等，如 `geolocation-!cn`） | jsDelivr → raw.githubusercontent | 24 小时（`stale-while-revalidate` 7 天） |
| [styrigx/mihomo-rules](https://github.com/styrigx/mihomo-rules) `dist` 分支（自有仓，机器人每天生成） | `own-repo.js` | `geosite`、`geoip` 下的 `.mrs` `.yaml`；名字只许 `[a-z0-9-]`（首尾不能是 `-`）；`manifest.json`、`.list`、大写、子目录都不放行 | raw.githubusercontent → jsDelivr（jsDelivr 的分支缓存会滞后） | 1 小时（`stale-while-revalidate` 1 天） |

MetaCubeX 的路径、上游顺序和缓存时长是现有客户端配置在用的，MUST 保持不变。

## 入口

`src/index.js`（`wrangler.toml` 的 `main`）只再导出 `src/app.js` 的默认 handler（只有 `fetch`）。按 `workers/README.md` 的骨架分文件：

```
src/
├─ index.js                 入口：只接线
├─ app.js                   默认 handler { fetch }
├─ router.js                路径登记表和分发（/、/healthz → 405 → 规则集来源 → 404）
├─ api/
│  ├─ healthz.js            健康检查
│  └─ rules.js              规则集：缓存 → 上游 → 写缓存
├─ core/
│  ├─ sources.js            来源登记表：按顺序问谁认这个路径
│  └─ sources/
│     ├─ metacubex.js       MetaCubeX 白名单 / 上游 / 缓存时长
│     └─ own-repo.js        styrigx/mihomo-rules 白名单 / 上游 / 缓存时长
└─ lib/
   ├─ upstream.js           依次试上游，单个超时 8 秒
   ├─ cache.js              caches.default，缓存键去掉 query
   ├─ response-headers.js   响应头重建
   ├─ content-type.js       按后缀给 Content-Type
   └─ http.js               纯文本响应
```

加新来源：在 `core/sources/` 加一个文件（导出 `id`、`allow`、`upstreams`、`cacheTtl`、`staleWhileRevalidate`），登记进 `core/sources.js` 的 `SOURCES`。加新接口（例如以后的订阅）：在 `api/` 加一个文件、在 `router.js` 登记路径，业务放 `core/`；不要塞进规则集白名单。

## 路由

自定义域名 `proxy-rules.styrigx.com`（`wrangler.toml` 的 `routes`，`custom_domain = true`），不过网关。

| 路径 | 方法 | 结果 |
|---|---|---|
| `/`、`/healthz` | 任意 | 200 `styrigx-proxy-rules ok`（styrigx-status 每分钟测 `/healthz`） |
| `/MetaCubeX/meta-rules-dat/meta/geo/<geosite\|geoip>/<名字>.<mrs\|yaml\|list>` | GET、HEAD | 命中缓存直接回；否则依次试上游，都不行回 404 / 502 |
| `/styrigx/mihomo-rules/dist/<geosite\|geoip>/<名字>.<mrs\|yaml>` | GET、HEAD | 同上 |
| 其他 | GET、HEAD | 404 |
| 任意（`/`、`/healthz` 除外） | 其他方法 | 405 |

HEAD 不读也不写缓存。

## 绑定

没有任何绑定（没有 KV、D1、服务绑定、变量）。缓存用的是边缘默认缓存 `caches.default`。

## 钥匙

没有。

## 数据与迁移

没有存储，没有 `migrations/`。部署：`.github/workflows/deploy.yml` 的 `deploy-proxy-rules-worker`，独立部署，不等也不挡网关和 Pages；部署后冒烟两个来源各测一个文件。测试：`tests/workers/proxy-rules/`（`proxy-rules.test.mjs` MetaCubeX、`own-repo.test.mjs` 自有仓、`layout.test.mjs` 目录结构）。
