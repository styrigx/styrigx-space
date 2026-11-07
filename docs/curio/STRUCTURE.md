# 奇趣（sites/curio/）结构

> 状态：现行 ｜ 最后更新：2026-11-06

奇趣原在图志仓库（styrigx-atlas），2026-11-02 并入本仓库；线上在 `https://styrigx.com/curio/`（英文 `/curio/en/`），接口在 `styrigx.com/curio/api/*`；旧图志域名的 301 已于 P4-3 PR-1 删除。
下面的目录树是并入前的布局，现在的位置（`atlas/web/curio/`、`workers/curio-core/`、`tests/curio/`、`atlas/scripts/curio/`）见仓库根 `STRUCTURE.md`。
仓库整体（三站合成一个 Pages、共用的 `root/`、CI）见仓库根 README。改页面只动 `atlas/web/curio/`，改接口只动 `workers/core/`。

```
sites/curio/
├─ atlas/web/curio/          网站本体（Hugo，baseURL https://styrigx.com/curio/），产物由仓库根 space/scripts/assemble.mjs 合进 public/curio/
├─ workers/
│  └─ core/      Worker styrigx-curio-core：收藏的存、读、导入导出、图标缓存
├─ data/         初始收藏 seed.json（迁自主站书签）
├─ atlas/scripts/curio/      生成脚本（种子迁移 SQL）、主站共享外壳同步
├─ tests/        全部测试，按测试对象分目录（e2e 对着仓库根合成的 public/）
├─ package.json  workspace 脚本（依赖在仓库根）
└─ STRUCTURE.md
```

## atlas/web/curio/

| 位置 | 是什么 |
|---|---|
| `hugo.yaml` | Hugo 配置（`params.version` 是版本号，README 徽章读它） |
| `layouts/_default/baseof.html` | 沉浸式 app 顶栏（九宫格 · 首页 发现 / 设备 / 游戏 分段滑块、其他页页名 · 右圆分享）、导航抽屉（主站共享外壳 `assets/sgx-shell/nav.json`）；没有页脚 |
| `layouts/index.html` | 首页（P4-3 奇趣拆页）：只有平铺入口（共享外壳 `sgx-shell-entries.html`）——发现 / 设备 / 游戏 / 电影 / 音乐，链到子页；音乐入口有权限才显示 |
| `content/<分区>.md`、`<分区>.zh.md` + `layouts/_default/<分区>.html` | 五个子页 `/curio/<分区>/`（中文 `/curio/zh/<分区>/`）：finds、devices、games、movies、music |
| `layouts/partials/curio/` | 子页共用：确认框 + 提示条（common）、详情弹层（item-view）、页底「登录账号后可编辑」（signin） |
| `assets/js/curio.js` | 「发现」子页；纯函数导出给 `tests/curio/curio.test.mjs`；确认框 / 提示条 / 弹层开关 / 页底一行给别的子页用（`SgxCurioUI`） |
| `assets/js/curio-items.js` | 「设备」「游戏」子页（列表、详情、编辑、照片缩图上传）；裁剪借给电影页（`SgxCurioPhoto`）；纯函数同上 |
| `assets/js/curio-home.js` | 首页：旧 hash（`#devices` / `#games` / `#c/<分类>`）客户端转到子页；问 `/curio/api/access` 决定显不显示音乐入口 |
| `assets/js/curio-movies.js` | 「电影」子页：海报卡片、详情、有权限才有添加 / 编辑 / 删除 |
| `assets/js/curio-music.js` | 「音乐」私人子页：封面横滑、整张播放（短链）、歌词、倍速、上传专辑 |
| `assets/js/topbar.js` | 导航抽屉开关 |
| `assets/js/sgx/` | 外观和语言继承主站（`sgx-ui` cookie）；`shell/ui-cookie-read.js` 是主站共享外壳的 cookie 读端（baseof 内联），`shell/palette-scheme.js` 是自定义主题色引擎 |
| `assets/sgx-shell/` | 主站共享外壳的抽屉项 + 图标、预设种子，`atlas/scripts/curio/sync-shell.mjs` 同步，勿手改 |
| `assets/css/input.css` | 样式；`@sgx-shell:begin … end` 之间是主站共享外壳（勿手改），本站自己的在文件末尾（`cu-` 前缀；`bk-` 是沿用的共用弹层组件） |
| `assets/js/sgx-lock-sync.js` | 切回前台复查会话，401 → 刷新去主站锁屏 |

## workers/core/

| 位置 | 是什么 |
|---|---|
| `wrangler.toml` | 路由 `styrigx.com/curio/api/*`、D1 绑定 `D1_FINDS`（links、cats、imports）/ `D1_DEVICES`（devices）/ `D1_GAMES`（games）/ `D1_MOVIES`（movies）/ `D1_MUSIC`（music_*）（同一个库 styrigx-curio-core）、R2 绑定 `R2_PHOTOS`、`R2_MUSIC`（同一个桶，music/ 前缀）、网关服务绑定 `AUTH`、全站搜索 KV `KV_SEARCH_INDEX`、每小时 Cron |
| `src/index.js` | 部署入口：只再导出 `app.js` 的 default 和 `rpc/reader.js` 的 `CurioReader`（给 styrigx-ai 的只读固定查询，2026-11） |
| `src/app.js` | 接口（公开地址 `/curio/api/*` 去掉 `/curio` 前缀后按路由表找）：全部 `/api/*` 先问网关会话（没有公开接口） |
| `src/search-index.js` | 全站搜索索引：收藏 / 设备 / 游戏 → KV `site:curio`（改内容的写接口成功后重建 + Cron 每小时兜底，内容没变不写 KV；私密的标 `private`） |
| `src/routes.js` | 路由表（与 `src/api/` 一一对应，测试核对） |
| `src/api/links.js` | `GET` 列表（没登录账号只有公开的），`POST {op}` 增删改排序（同源 + 账号会话 + `curio.write`） |
| `src/api/import.js` | 导入浏览器书签：先备份原文到 R2，再 `json_each` 批量写入 |
| `src/api/export.js` | 导出书签文件 |
| `src/api/preview.js` | 抓网页标题、简介、图标 |
| `src/api/items.js` | 设备和游戏：`GET` 列表，`POST {op}` 增删改排序（同源 + 账号会话 + `curio.write`；删条目连照片删） |
| `src/api/photo.js` | 设备照片 / 游戏封面 / 电影海报：读、传、删（R2 `photos/`） |
| `src/api/movies.js` + `_movies.js` | 电影：进门可读，写要 `curio.write` |
| `src/api/music*.js` + `_music.js` | 私人音乐（仅本人，`curio.write`）：专辑 / 曲目、上传（单文件 ≤ 95 MB）、签播放令牌（随机，D1，10 分钟）、短链播放（Range）、封面 |
| `src/api/access.js` | 首页私人入口的权限探针（只回布尔） |
| `src/api/icon.js` | 图标：R2 缓存，没有就现抓（只抓公网地址），抓不到记「没有」7 天 |
| `src/api/_store.js` | 收藏的表结构、校验、读写 |
| `src/api/_items.js` | 设备、游戏的表结构、校验、读写 |
| `src/api/_netscape.js` | 书签文件的解析和生成 |
| `src/api/_preview.js` | 抓网页 + 地址安全检查（不抓内网 / 本机 / 自家域名） |
| `src/api/_auth.js` `_lib.js` `_write.js` | 问网关、JSON 响应、同源 / 同站检查、读 body |
| `src/api/_image.js` | 图片响应共用：`private, no-cache` + ETag + `Vary: Cookie`，浏览器每次用前回来验会话，304 排在会话和可见性检查之后 |
| `migrations/` | D1 迁移：`0001_init`（cats、links、imports）、`0002_seed`（初始收藏，由 `atlas/scripts/curio/gen-seed-sql.mjs` 生成）、`0003_devices_games`（devices、games）、`0004_movies_music`（movies、music_albums、music_tracks、music_tokens） |

## 部署

见仓库根 `.github/workflows/deploy.yml`（合并 PR3 起）：测试 → 接口 Worker（两个 core：D1 迁移 + 部署，挂 `styrigx.com/<站>/api/*`）→ 网关 → Pages `styrigx-space`（主站 + 三站一棵树）→ 冒烟（主域名 + atlas 301）。
