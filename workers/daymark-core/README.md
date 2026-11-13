# styrigx-daymark-core

日刻（`/daymark/`）的接口 Worker：存句子、读句子、合集、今日一句。2026-11-02 从 styrigx-atlas 仓库的 `sites/daymark/workers/core/` 原样搬来（PR1 搬运）；合并 PR3 加了主域名路由（见「路由」）。

## 职责

- `/daymark/api/*` 的全部数据接口；页面是静态文件（`space/web/` 下的 `<目录>/daymark/`，和主站同一个 Hugo 站），会话检查在主站鉴权网关。
- `/daymark/api/today` 公开（主站首页小组件和锁屏读，CORS 只放 `https://styrigx.com`）；其余接口要进门，写操作要账号会话 + 作用域 `daymark.write`（见「鉴权」）。
- 写接口成功后重建全站搜索索引里本站那一条（KV `site:daymark`），每小时兜底（2026-11-10 起由 styrigx-status 的 Cron 经服务绑定 `JOB_DAYMARK` 调命名入口 `HourlyJob`，`rpc/hourly-job.js`；本 Worker 不自带 Cron）。

## 入口

```
src/index.js         入口：按访问档问网关（SPACE.admit，v6 会话；today 的读除外）→ 按路由表分发；scheduled（搜索索引）
src/routes.js        路由表（去掉 /daymark 前缀后的 /api/*）
src/api/*.js         一个接口一个文件；_ 开头的是接口共用的内部模块
src/search-index.js  KV site:daymark 的索引
```

还没按 `workers/README.md` 的骨架对齐（`main` 本来就是 `src/index.js`），对齐时机同第 3 节的小 Worker。

## 路由

`styrigx.com/daymark/api/*`（`wrangler.toml`，合并 PR3 起）。比网关的 `styrigx.com/*` 更具体，接口请求直接落到本 Worker；`space/scripts/check/check-worker-routes.mjs` 核对它登记了、且不抢网关的页面。
旧图志域名下的过渡期旧路由已于 P4-3 PR-1 删除。
部署：本仓库 `.github/workflows/deploy.yml` 的 `deploy-daymark-core`（D1 迁移 + 部署），在网关之前。

## 绑定

- D1 `styrigx-daymark-core`：`D1_QUOTES`。
- 服务绑定 `SPACE` → `styrigx-space-core` 的 `SpaceVerifier`（`admit()` / `auditRoot()`：原样转给账号 Worker 判 v6 会话 / 记 root 留痕）。
- KV `KV_SEARCH_INDEX`（`styrigx-space-core`，进站 v3 L2b 前是 `styrigx-space-gateway`；只写 `site:daymark`）。
- Cron `17 * * * *`。

## 鉴权（v6，ADR-0006；定稿 v5.3 §十二）

访问档在 `src/routes.js` 的 `ROUTE_ACCESS`；`entry` 档和写接口经网关 `SPACE.admit(cookie, method, path)` 问 v6 会话（`sgx-session`）够不够这条路由的档（档只在账号 Worker 路由表 `workers/account/src/core/route-access.js`：写 = `daymark-write`，删整个专题 = root）；
公开读要私密句子 / 随手一笔时问 action `private` 的档。旧的进站 / 账号结论（`SPACE.conclusion()`、作用域）随应用授权删除。

- 错误码：没有 v6 身份 `401 unauthorized`；有身份但档不够 `403 forbidden`；非同源 `403 origin`。
- 读接口回 `canWrite`、`showPrivate` 两个布尔（v6 action `private` 的档够就都为 true）。
- 网关没有 `admit` / 出错 → 当没有 v6 身份（fail closed）。

## 钥匙

不持任何钥匙；`workers_dev = false`、`preview_urls = false`。

## 数据与迁移

`migrations/`（D1 `styrigx-daymark-core`）。`0003_seed_quotes.sql` 由 `space/scripts/daymark/gen-seed-sql.mjs` 生成（种子原文不进仓库）。已上线的迁移不改名、不重新编号。单测在 `tests/workers/daymark-core/`。PR3 之前线上部署仍由 styrigx-atlas 仓库负责。
