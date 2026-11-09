# styrigx-daymark-core

日刻（`/daymark/`）的接口 Worker：存句子、读句子、合集、今日一句。2026-11-02 从 styrigx-atlas 仓库的 `sites/daymark/workers/core/` 原样搬来（PR1 搬运）；合并 PR3 加了主域名路由（见「路由」）。

## 职责

- `/daymark/api/*` 的全部数据接口；页面是静态文件（`space/web/` 下的 `<目录>/daymark/`，和主站同一个 Hugo 站），会话检查在主站鉴权网关。
- `/daymark/api/today` 公开（主站首页小组件和锁屏读，CORS 只放 `https://styrigx.com`）；其余接口要进门，写操作要账号会话 + 作用域 `daymark.write`（见「鉴权」）。
- 写接口成功后重建全站搜索索引里本站那一条（KV `site:daymark`），Cron 每小时兜底。

## 入口

```
src/index.js         入口：先问网关结论（SPACE.conclusion，today 的读除外）→ 按路由表分发；scheduled（搜索索引）
src/routes.js        路由表（去掉 /daymark 前缀后的 /api/*）
src/api/*.js         一个接口一个文件；_ 开头的是接口共用的内部模块
src/search-index.js  KV site:daymark 的索引
```

还没按 `workers/README.md` 的骨架对齐（`main` 本来就是 `src/index.js`），对齐时机同第 3 节的小 Worker。

## 路由

`styrigx.com/daymark/api/*`（`wrangler.toml`，合并 PR3 起）。比网关的 `styrigx.com/*` 更具体，接口请求直接落到本 Worker；`space/scripts/check-worker-routes.mjs` 核对它登记了、且不抢网关的页面。
旧图志域名下的过渡期旧路由已于 P4-3 PR-1 删除。
部署：本仓库 `.github/workflows/deploy.yml` 的 `deploy-daymark-core`（D1 迁移 + 部署），在网关之前。

## 绑定

- D1 `styrigx-daymark-core`：`D1_QUOTES`。
- 服务绑定 `SPACE` → `styrigx-space-core` 的 `SpaceVerifier`（`conclusion()`：网关验门，再问账号 Worker，回结论）。
- KV `KV_SEARCH_INDEX`（`styrigx-space-gateway`，2026-11 前是 `styrigx-search-index`；只写 `site:daymark`）。
- Cron `17 * * * *`。

## 鉴权（P2-2，方案 3.4 R14、4.6）

每个 `/daymark/api/*` 请求（`GET /api/today` 除外）只问网关一次 `SPACE.conclusion(cookie, clientContext, { reauth: false })`，结论放 `context.data.conclusion`（`src/api/_auth.js`）。

| 接口 | 进门 | 账号会话 | 作用域 |
|---|---|---|---|
| `GET /api/today` | 否（公开） | — | — |
| `GET /api/quotes`、`/api/collections` | 是 | 有则含私密句子和随手一笔 | — |
| `GET /api/days?from=&to=`（往前几天已记下的今日一句，只出公开句子，最多 31 天，不现挑不写库；日刻日期条 / 前后日卡） | 是 | — | — |
| `POST` / `PUT` / `DELETE /api/quotes`、`/api/collections`，`PUT /api/today` | 是 | 是 | `daymark.write` |

- 错误码：没进门 `401 unauthorized`；没账号会话 `401 account`；没作用域 `403 scope`（带 `scope` 字段）；非同源 `403 origin`。日刻没有要账号复验的接口。
- 读接口回 `canWrite`（有 `daymark.write`）、`showPrivate`（账号会话有效）两个布尔，代替以前的等级字段（P2-2）。
- 网关绑定缺失 / 出错 → 500（不回 401，免得前端当成锁定去刷新）。

## 钥匙

不持任何钥匙；`workers_dev = false`、`preview_urls = false`。

## 数据与迁移

`migrations/`（D1 `styrigx-daymark-core`）。`0003_seed_quotes.sql` 由 `space/scripts/daymark/gen-seed-sql.mjs` 生成（种子原文不进仓库）。已上线的迁移不改名、不重新编号。单测在 `tests/workers/daymark-core/`。PR3 之前线上部署仍由 styrigx-atlas 仓库负责。
