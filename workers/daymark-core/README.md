# styrigx-daymark-core

日刻（`/daymark/`）的接口 Worker：存句子、读句子、合集、今日一句。2026-11-02 从 styrigx-atlas 仓库的 `sites/daymark/workers/core/` 原样搬来（PR1 搬运），代码、路由、绑定都没改。

## 职责

- `/daymark/api/*` 的全部数据接口；页面是静态文件（`web/daymark/`），会话检查在主站鉴权网关。
- `/daymark/api/today` 公开（主站首页小组件和锁屏读，CORS 只放 `https://styrigx.com`）；其余接口要会话，写操作只许管理员。
- 写接口成功后重建全站搜索索引里本站那一条（KV `site:daymark`），Cron 每小时兜底。

## 入口

```
src/index.js         入口：先问网关会话（today 除外）→ 按路由表分发；scheduled（搜索索引）
src/routes.js        路由表（去掉 /daymark 前缀后的 /api/*）
src/api/*.js         一个接口一个文件；_ 开头的是接口共用的内部模块
src/search-index.js  KV site:daymark 的索引
```

还没按 `workers/README.md` 的骨架对齐（`main` 本来就是 `src/index.js`），对齐时机同第 3 节的小 Worker。

## 路由

`atlas.styrigx.com/daymark/api/*`（`wrangler.toml`）。主域名路由 `styrigx.com/daymark/api/*` 在合并 PR3 加。

## 绑定

- D1 `styrigx-daymark-core`：`D1_QUOTES`。
- 服务绑定 `AUTH` → `styrigx-auth-gateway` 的 `AuthVerifier`。
- KV `KV_SEARCH_INDEX`（`styrigx-search-index`，只写 `site:daymark`）。
- Cron `17 * * * *`。

## 钥匙

不持任何钥匙；`workers_dev = false`、`preview_urls = false`。

## 数据与迁移

`migrations/`（D1 `styrigx-daymark-core`）。`0003_seed_quotes.sql` 由 `scripts/daymark/gen-seed-sql.mjs` 生成（种子原文不进仓库）。已上线的迁移不改名、不重新编号。单测在 `tests/workers/daymark-core/`。PR3 之前线上部署仍由 styrigx-atlas 仓库负责。
