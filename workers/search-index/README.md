# styrigx-search-index

## 职责

全站搜索：按关键词在各站的索引里查，回标题、副标题、地址，不回正文。私密条目（`private`）只在有账号会话的请求时出现（P2-2 起由网关的账号结论头决定，不看锁屏角色）。

## 入口

`src/index.js`（`wrangler.toml` 的 `main`）：`default.fetch` 处理两个路径，读 KV、60 秒内存缓存；排序在 `src/rank.js`（`tokenize` / `score` / `search`）。

## 路由

没有公开地址（`workers_dev = false`、`preview_urls = false`、没有路由）。只经服务绑定进来：

| 路径 | 谁调 | 结果 |
|---|---|---|
| `GET /search?q=&lang=zh\|en&site=&limit=` | 网关 `styrigx-auth-gateway` 的服务绑定 `SEARCH`（浏览器请求 `/api/search`，网关先验锁屏会话、再问账号 Worker，有账号会话才写 `X-Styrigx-Account-Session: 1` 等结论头；P2-2 起不再写也不再读 `X-Sgx-Role`） | 200 `{ ok, q, hits }`；读不到索引 503 `{ ok:false, error:'index' }` |
| `GET /healthz` | `styrigx-status` 的服务绑定 `SEARCH`（每分钟） | 至少一个站的索引读得到 200 `{ ok, sites, missing }`；一个都没有 503 |
| 其他 | | 404；方法不对 405 |

## 绑定

| 绑定 | 类型 | 资源 |
|---|---|---|
| `KV_SEARCH_INDEX` | KV | `styrigx-search-index`，键 `site:space`、`site:blog`、`site:daymark`、`site:curio` |

## 钥匙

没有。

## 数据与迁移

没有 D1，没有 `migrations/`。`site:space` 由本仓库部署时写：`deploy-search-worker` 先用 `scripts/build-search-index.mjs` 从生产构建生成，再 `wrangler kv key put site:space`。另外三个站的键不在本仓库写。部署先于网关（网关的服务绑定 `SEARCH` 指向它）。测试：`tests/workers/search-index/`、`tests/workers/auth-gateway/search-api.test.mjs`（网关的门和转发）。
