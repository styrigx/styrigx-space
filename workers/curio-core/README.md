# styrigx-curio-core

奇趣（`/curio/`）的接口 Worker：收藏的存、读、导入导出、网站小图标缓存、设备照片 / 游戏封面。2026-11-02 从 styrigx-atlas 仓库的 `sites/curio/workers/core/` 原样搬来（PR1 搬运）；合并 PR3 加了主域名路由（见「路由」）。

## 职责

- `/curio/api/*` 的全部数据接口；页面是静态文件（`space/web/` 下的 `<目录>/curio/`，和主站同一个 Hugo 站），会话检查在主站鉴权网关。
- 写接口成功后重建全站搜索索引里本站那一条（KV `site:curio`），Cron 每小时兜底；每天一轮清扫 R2 里没人引用的照片。

## 入口

```
src/index.js         部署入口：只再导出 app.js 的 default 和 rpc/reader.js 的 CurioReader（2026-11）
src/app.js           接口 + Cron：先问网关结论（SPACE.conclusion）→ 按路由表分发；scheduled（搜索索引 + 照片清扫）
src/reader.js        只读固定查询（recentMovies / music，参数化），给 styrigx-ai 的服务绑定 RPC CurioReader（src/rpc/reader.js）用
src/routes.js        路由表（去掉 /curio 前缀后的 /api/*）
src/api/*.js         一个接口一个文件；_ 开头的是接口共用的内部模块（会话、存储、写操作、图片、书签导入导出、网页预览）
src/search-index.js  KV site:curio 的索引
src/photo-sweep.js   R2 photos/ 清扫
```

2026-11 起入口按 `workers/README.md` 的骨架拆成 `index.js`（接线）+ `app.js`（逻辑），单测 import `app.js` / `reader.js`（`cloudflare:workers` 只在 Workers 里有）。

## 路由

`styrigx.com/curio/api/*`（`wrangler.toml`，合并 PR3 起）。比网关的 `styrigx.com/*` 更具体，接口请求直接落到本 Worker；`space/scripts/check-worker-routes.mjs` 核对它登记了、且不抢网关的页面。
旧图志域名下的过渡期旧路由已于 P4-3 PR-1 删除。
部署：本仓库 `.github/workflows/deploy.yml` 的 `deploy-curio-core`（D1 迁移 + 部署），在网关之前。

## 绑定

- D1 `styrigx-curio-core`：`D1_FINDS`（links、cats、imports）、`D1_DEVICES`（devices）、`D1_GAMES`（games），同一个库。
- R2 `styrigx-curio-core`：`R2_PHOTOS`（icons/、imports/、photos/）。
- 服务绑定 `SPACE` → `styrigx-space-core` 的 `SpaceVerifier`（`conclusion()`：网关验门，再问账号 Worker，回结论）。
- KV `KV_SEARCH_INDEX`（`styrigx-space-gateway`，2026-11 前是 `styrigx-search-index`；只写 `site:curio`）。
- Cron `23 * * * *`。

## 鉴权（P2-2，方案 3.4 R14、4.6）

每个 `/curio/api/*` 请求只问网关一次 `SPACE.conclusion(cookie, clientContext, { reauth })`，结论放 `context.data.conclusion`（`src/api/_auth.js`）；
`POST /curio/api/import` 这一问带 `reauth: true`（`src/app.js` 的 `REAUTH_ROUTES`）。

| 接口 | 进门 | 账号会话 | 作用域 | 账号复验 |
|---|---|---|---|---|
| `GET /api/links`、`/api/items`、`/api/icon`、`/api/photo` | 是 | 有则含私密 | — | — |
| `GET /api/export`（含私密） | 是 | 是 | — | — |
| `POST /api/links`、`POST /api/items`、`POST` / `DELETE /api/photo`、`GET /api/preview` | 是 | 是 | `curio.write` | — |
| `POST /api/import` | 是 | 是 | `curio.write` | 是 |
| `GET /api/access`（首页私人入口用，只回布尔）、`GET /api/movies` | 是 | 有则 `canWrite` | — | — |
| `POST /api/movies`、`POST` / `DELETE /api/photo?kind=movie` | 是 | 是 | `curio.write` | — |
| `GET` / `POST /api/music`、`POST /api/music-upload`、`POST /api/music-play`、`GET /api/music-cover`（私人音乐，仅本人） | 是 | 是 | `curio.write` | — |
| `GET` / `HEAD /api/music-stream?t=&id=`（播放短链） | 是 | — | — | —（认 D1 `music_tokens` 里的随机令牌，10 分钟，支持 Range） |

- 错误码：没进门 `401 unauthorized`；没账号会话 `401 account`；没作用域 `403 scope`（带 `scope` 字段）；要复验没复验 `401 reauth`；非同源 `403 origin`。
- 读接口回 `canWrite`（有 `curio.write`）、`showPrivate`（账号会话有效）两个布尔，代替以前的等级字段（P2-2）。
- 网关绑定缺失 / 出错 → 500（不回 401，免得前端当成锁定去刷新）。

## 奇趣拆页（P4-3）：电影、私人音乐

- 绑定（同库同桶，各绑一个名字）：`D1_MOVIES`、`D1_MUSIC` → D1 `styrigx-curio-core`；`R2_MUSIC` → R2 `styrigx-curio-core`（`music/<专辑>/…`）。迁移 `0004_movies_music.sql`（deploy.yml 的 `d1 migrations apply styrigx-curio-core --remote` 会跑）。
- 电影：进门可读，写要 `curio.write`；海报走 `/api/photo?kind=movie`（`photos/movie/…`，参与照片清扫）。
- 音乐：读写都要账号会话 + `curio.write`；音频单文件 ≤ 95 MB（浏览器直传，要 Content-Length）、封面 ≤ 3 MB；播放令牌 = `crypto.getRandomValues` 32 字节，存 D1，10 分钟，不用 HMAC、不要 secret。
- 电影、音乐不进全站搜索索引 / AI 召回（`search-index.js` 不读这些表、写它们不触发重建），页面 noindex、不进 `/curio/sitemap.xml`。

## 钥匙

不持任何钥匙（音乐短链也不用）；`workers_dev = false`、`preview_urls = false`。

## 数据与迁移

`migrations/`（D1 `styrigx-curio-core`）。`0002_seed.sql` 由 `space/scripts/curio/gen-seed-sql.mjs` 从 `space/scripts/curio/data/seed.json` 生成（`--check` 核对）。已上线的迁移不改名、不重新编号。单测在 `tests/workers/curio-core/`。PR3 之前线上部署仍由 styrigx-atlas 仓库负责。
