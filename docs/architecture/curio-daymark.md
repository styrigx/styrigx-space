# 奇趣（curio）与日刻（daymark）

| 项 | 值 |
|---|---|
| 文档编号 | SGX-ARCH-012 |
| 版本 | 2.1 |
| 日期 | 2026-11-24 |
| 状态 | 现行 |
| 取代 | `docs/curio/STRUCTURE.md`、`docs/daymark/STRUCTURE.md` |

## 1. 范围

两个带数据的子站：页面在 `space/web/` 的 Hugo 站里，数据接口同在一个 Worker `styrigx-atlas-core`（2026-11-14 由原 `styrigx-curio-core`、`styrigx-daymark-core` 合并进 atlas-core）。两站结构相同，本文合并描述，差异分列。

| | 奇趣 | 日刻 |
|---|---|---|
| 地址 | `https://styrigx.com/curio/`，中文 `/curio/zh/` | `https://styrigx.com/daymark/`，中文 `/daymark/zh/` |
| 接口 | `styrigx.com/curio/api/*` → `styrigx-atlas-core` | `styrigx.com/daymark/api/*` → `styrigx-atlas-core` |
| Worker 代码 | `workers/atlas-core/src/curio/` | `workers/atlas-core/src/daymark/` |
| 数据 | D1 `styrigx-atlas-core`；R2 `styrigx-atlas-core`（两站共用） | D1 `styrigx-atlas-core`（两站共用） |
| 测试 | `tests/curio/`、`tests/workers/atlas-core/curio*.test.mjs` | `tests/daymark/`、`tests/workers/atlas-core/daymark*.test.mjs` |

## 2. 页面

| 位置 | 奇趣 | 日刻 |
|---|---|---|
| 内容 | `content/curio/`：首页 `_index`（发现）+ `404`（中文 `<名>.zh.md`）；设备、电影子页奇趣重组 PR 3（2026-11-23）删了，`/curio/devices/`、`/curio/movies/` 直接 404、不跳；游戏、音乐已拆成独立子站 `/games/`、`/music/`（`content/games/`、`content/music/`） | `content/daymark/`：首页 |
| 模板 | `layouts/curio/`（`baseof`、`section`、`notfound`、`section.curiositemap.xml`）+ `layouts/partials/curio/` | `layouts/daymark/` + `layouts/partials/daymark/` |
| 脚本 | `assets/curio/js/`：`curio.js`（发现）、`curio-list.js`（奇趣重组 PR 3 删了 `curio-home.js`、`curio-items.js`、`curio-movies.js`；游戏脚本在 `assets/games/js/`，音乐在 `assets/music/js/`） | `assets/daymark/js/daymark.js`（余响 · 拾录 · 百味三栏、记一句、日期条） |
| 继承主站外观 | `assets/curio/js/sgx/`（`ui-inherit-run.js`、`topbar-host.js`；`shell-accent.js` 随自定义主题色 2026-11-12 删除） | `assets/daymark/js/sgx/` |
| 字符串表 | `data/curio/i18n/` | `data/daymark/i18n/` |

2.1 两站都 MUST 使用主站的共享外壳（顶栏、导航面板、调色板 token、`ui-cookie-read.js`、`lang-boot.js`），MUST NOT 复制。样式表 `@import` 主站 `assets/common/css/*.css`。

2.2 CSS 类名前缀：奇趣 `cu-`，日刻 `dm-`；`bk-` 是沿用的共用弹层组件。

## 3. 接口

3.1 两站的接口各在 `workers/atlas-core/src/<站>/routes.js` 登记，与同目录 `api/` 一一对应（单测核对）；`_` 开头的是接口共用模块。

| 奇趣 `/curio/api/*` | 鉴权 |
|---|---|
| `links` | GET 公开（访客只有公开条目，账号已登录读全部）；写：进站 + 同源 + 账号会话 + `curio.write`（`items`、`movies`、`photo` 奇趣重组 PR 3 删了，不留别名；游戏走 `/games/api/*`） |
| `music`、`music-cover` | GET 公开：歌单 / 封面只有元数据，不含任何音频地址；`POST /api/music` 管理：进站 + 账号会话 + `curio.write` |
| `music-play`、`music-stream` | 听：要进站（签播放令牌、取音频，no-store） |
| `music-upload` | 进站 + 账号会话 + `curio.write` |
| `icon` | GET 公开 |
| `preview`、`import`、`export` | 要进站（网页预览、书签导入导出；导入另要账号复验） |

| 日刻 `/daymark/api/*` | 鉴权 |
|---|---|
| `today` | GET 公开（CORS 只给 `https://styrigx.com`）；PUT 设为今日：同源 + 账号会话 + `daymark.write` |
| `days` | GET 公开：往前几天的「今日一句」（只读 `daily_pick`，最多 31 天） |
| `quotes`、`collections` | GET 公开（未登录账号只有公开句子）；写：进站 + 同源 + 账号会话 + `daymark.write` |

3.2 访问档（v5 S3）：每站的 `src/<站>/routes.js` 有自己的 `ROUTE_ACCESS`（方法 + 路径精确匹配，表里没有的一律要进站，fail closed；单测对整张表快照）。要进站的接口经服务绑定 `SPACE`（`SpaceVerifier.conclusion()`）问站点核心，没有进站会话 401；写操作再看账号结论里的作用域。公开读不拒绝，只在要私密行 / `canManage` 时问结论（组权限 v1.1 起经公用 `src/common/visibility.js` 的 `visibility()`，分别问 action `private` = `<产品>-use`、`manage` = `<产品>-manage`；ADR-0007）。

3.3 搜索索引：写接口成功后重建、每小时兜底（2026-11-10 起由 styrigx-status 的 41 分 Cron 经服务绑定 `JOB_ATLAS` 调 atlas-core 的 `HourlyJob`，先奇趣后日刻），写 KV `KV_SEARCH_INDEX` 的 `site:curio` / `site:daymark`（内容没变不写；私密条目标 `private`）。

3.4 奇趣另有 RPC 入口 `CurioReader`（atlas-core `src/curio/rpc/reader.js`），给 `styrigx-ai` 做只读固定查询（专辑曲目；最近电影 `recentMovies` 随电影在奇趣重组 PR 3 删了），模型不写 SQL。日刻另有 `DaymarkReader`（atlas-core `src/rpc/daymark-reader.js`，R-35）：问句带「今天 + 日刻」时给 `styrigx-ai` 今日一句（只出公开句子，同 `GET /daymark/api/today`）。

3.5 奇趣图片响应 `private, no-cache` + ETag + `Vary: Cookie`，304 排在会话与可见性检查之后。

## 4. 迁移

4.1 迁移文件 `NNNN_snake_case.sql`，已上线的文件 MUST NOT 改名、重新编号或修改；只进不退，新迁移 MUST 兼容旧代码（部署回滚不回滚 D1）。

4.2 现有迁移（`workers/atlas-core/migrations/`）：`0001_curio`、`0002_daymark`，只有结构，等于原两个 Worker 各自旧迁移跑完的结果（数据 2026-11-14 从旧库拷入；`daily_pick.set_by` 取 `'auto'` 或 `'grant'`）。旧迁移随旧目录删除（见 git 历史）；首批种子留在 `docs/ops/curio-seed.sql`、`docs/ops/daymark-seed.sql`，只给空库用，MUST NOT 放进 `migrations/`。

## 5. 部署

由 `.github/workflows/deploy.yml` 的 `deploy-atlas-core` 部署，排在 `deploy-space-core` 之后（服务绑定 `SPACE` 要它先在）。见 SGX-OPS-001。
