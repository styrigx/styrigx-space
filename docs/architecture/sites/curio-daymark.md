# 奇趣（curio）与日刻（daymark）

| 项 | 值 |
|---|---|
| 文档编号 | SGX-ARCH-012 |
| 版本 | 2.0 |
| 日期 | 2026-11-09 |
| 状态 | 现行 |
| 取代 | `docs/curio/STRUCTURE.md`、`docs/daymark/STRUCTURE.md` |

## 1. 范围

两个带数据的子站：页面在 `space/web/` 的 Hugo 站里，数据接口各有一个 Worker。两站结构相同，本文合并描述，差异分列。

| | 奇趣 | 日刻 |
|---|---|---|
| 地址 | `https://styrigx.com/curio/`，中文 `/curio/zh/` | `https://styrigx.com/daymark/`，中文 `/daymark/zh/` |
| 接口 | `styrigx.com/curio/api/*` → `styrigx-curio-core` | `styrigx.com/daymark/api/*` → `styrigx-daymark-core` |
| Worker 目录 | `workers/curio-core/` | `workers/daymark-core/` |
| 数据 | D1 `styrigx-curio-core`；R2 `styrigx-curio-core` | D1 `styrigx-daymark-core` |
| 测试 | `tests/curio/`、`tests/workers/curio-core/` | `tests/daymark/`、`tests/workers/daymark-core/` |
| 种子脚本 | `space/scripts/curio/gen-seed-sql.mjs`（`data/seed.json` → `migrations/0002_seed.sql`） | `space/scripts/daymark/gen-seed-sql.mjs`（→ `migrations/0003_seed_quotes.sql`） |

## 2. 页面

| 位置 | 奇趣 | 日刻 |
|---|---|---|
| 内容 | `content/curio/`：首页 + 五个子页 `finds`、`devices`、`games`、`movies`、`music`（中文 `<名>.zh.md`） | `content/daymark/`：首页 |
| 模板 | `layouts/curio/`（每个子页一个模板）+ `layouts/partials/curio/` | `layouts/daymark/` + `layouts/partials/daymark/` |
| 脚本 | `assets/curio/js/`：`curio-home.js`（首页，私人入口按 `/api/access` 显示）、`curio.js`（发现）、`curio-items.js`（设备 / 游戏）、`curio-list.js`、`curio-movies.js`、`curio-music.js` | `assets/daymark/js/daymark.js`（余响 · 拾录 · 百味三栏、记一句、日期条） |
| 继承主站外观 | `assets/curio/js/sgx/`（`ui-inherit-run.js`、`shell-accent.js`、`topbar-host.js`） | `assets/daymark/js/sgx/` |
| 进站复查 | `assets/curio/js/sgx-lock-sync.js` | `assets/daymark/js/sgx-lock-sync.js` |
| 字符串表 | `data/curio/i18n/` | `data/daymark/i18n/` |

2.1 两站都 MUST 使用主站的共享外壳（顶栏、导航面板、调色板 token、`ui-cookie-read.js`、`lang-boot.js`），MUST NOT 复制。样式表 `@import` 主站 `assets/css/shell/*.css`。

2.2 CSS 类名前缀：奇趣 `cu-`，日刻 `dm-`；`bk-` 是沿用的共用弹层组件。

## 3. 接口

3.1 两个 Worker 的接口在 `src/routes.js` 登记，与 `src/api/` 一一对应（单测核对）；`_` 开头的是接口共用模块。

| 奇趣 `/curio/api/*` | 鉴权 |
|---|---|
| `links`、`items`、`movies` | GET：进站即可读公开条目，账号已登录读全部；写：同源 + 账号会话 + `curio.write` |
| `music`、`music-cover`、`music-play`、`music-stream`、`music-upload` | 私人：账号会话 + `curio.write` |
| `photo`、`icon`、`preview`、`import`、`export` | 照片读写、图标缓存、网页预览、书签导入导出 |
| `access` | 私人入口的权限探针（只回布尔） |

| 日刻 `/daymark/api/*` | 鉴权 |
|---|---|
| `today` | GET 公开（CORS 只给 `https://styrigx.com`）；PUT 设为今日：同源 + 账号会话 + `daymark.write` |
| `days` | GET 进站即可：往前几天的「今日一句」（只读 `daily_pick`，最多 31 天） |
| `quotes`、`collections` | GET 进站即可（未登录账号只有公开句子）；写：同源 + 账号会话 + `daymark.write` |

3.2 除日刻 `/api/today` 的 GET 外，所有接口 MUST 先经服务绑定 `SPACE`（`SpaceVerifier.conclusion()`）问站点核心：没有进站会话即拒绝；写操作再看账号结论里的作用域。

3.3 搜索索引：写接口成功后重建、每小时 Cron 兜底，写 KV `KV_SEARCH_INDEX` 的 `site:curio` / `site:daymark`（内容没变不写；私密条目标 `private`）。

3.4 奇趣另有 RPC 入口 `CurioReader`（`src/rpc/reader.js`），给 `styrigx-ai` 做只读固定查询（最近电影、专辑曲目等），模型不写 SQL。

3.5 奇趣图片响应 `private, no-cache` + ETag + `Vary: Cookie`，304 排在会话与可见性检查之后。

## 4. 迁移

4.1 迁移文件 `NNNN_snake_case.sql`，已上线的文件 MUST NOT 改名、重新编号或修改；只进不退，新迁移 MUST 兼容旧代码（部署回滚不回滚 D1）。

4.2 现有迁移：奇趣 `0001_init` … `0004_movies_music`；日刻 `0001_init` … `0006_daily_pick_set_by_grant`（`daily_pick.set_by` 现在取 `'auto'` 或 `'grant'`）。

## 5. 部署

由 `.github/workflows/deploy.yml` 的 `deploy-curio-core`、`deploy-daymark-core` 部署，排在 `deploy-space-core` 之后（服务绑定 `SPACE` 要它先在）。见 SGX-OPS-001。
