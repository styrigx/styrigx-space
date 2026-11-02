# 日刻（sites/daymark/）结构

图志仓库（styrigx-atlas）里的日刻，线上在 `https://atlas.styrigx.com/daymark/`（英文 `/daymark/en/`），接口在 `/daymark/api/*`。
仓库整体（三站合成一个 Pages、共用的 `root/`、CI）见仓库根 README。改页面只动 `web/`，改接口只动 `workers/core/`。

```
sites/daymark/
├─ web/          网站本体（Hugo，baseURL https://atlas.styrigx.com/daymark/），产物由仓库根 scripts/assemble.mjs 合进 public/daymark/
├─ workers/
│  └─ core/      Worker styrigx-daymark-core：句子的存、读、今日一句
├─ scripts/      生成脚本（种子迁移 SQL）、主站共享外壳同步
├─ tests/        全部测试，按测试对象分目录（e2e 对着仓库根合成的 public/）
├─ package.json  workspace 脚本（依赖在仓库根）
└─ STRUCTURE.md
```

## web/

| 位置 | 是什么 |
|---|---|
| `hugo.yaml` | Hugo 配置（`params.version` 是版本号，README 徽章读它） |
| `layouts/_default/baseof.html` | 沉浸式 app 顶栏（九宫格 · 首页 余响/拾录/百味 分段滑块、其他页页名 · 右圆分享）、导航抽屉（主站共享外壳 `assets/sgx-shell/nav.json`：四个应用）；没有页脚 |
| `layouts/index.html` | 首页三块面板（余响 · 拾录 · 百味）、记一句弹层、新建专题、确认框 |
| `assets/js/daymark.js` | 首页逻辑（页签 / hash 路由、余响、拾录、百味、记一句）；纯函数导出给 `tests/web/daymark.test.mjs` |
| `assets/js/topbar.js` | 导航抽屉开关 |
| `assets/js/sgx/` | 外观和语言继承主站（`sgx-ui` cookie）：`shell/ui-cookie-read.js` 是主站共享外壳的 cookie 读端（baseof 内联，`ui-inherit-run.js` 调 `SgxUI.apply`），`lib/ui-inherit.js` 管语言跟随；`shell/palette-scheme.js` 是自定义主题色引擎（`shell-accent.js` 按需加载） |
| `assets/sgx-shell/` | 主站共享外壳的抽屉项 + 图标（`nav.json`）、预设种子（`palettes.json`），`scripts/sync-shell.mjs` 同步，勿手改 |
| `assets/css/input.css` | 样式；`@sgx-shell:begin … end` 之间是主站共享外壳（色彩角色 + 顶栏材质 + 导航抽屉，`scripts/sync-shell.mjs` 写入，勿手改），后面的 `--m-*` 只是角色的别名 |
| `assets/js/sgx-lock-sync.js` | 切回前台复查会话，401 → 刷新去主站锁屏 |

CSS 类名里的 `bk-` 前缀沿用自 styrigx-book 的共用组件（弹层、标题行），本站新写的用 `dm-`。

## workers/core/

| 位置 | 是什么 |
|---|---|
| `wrangler.toml` | 路由 `atlas.styrigx.com/daymark/api/*`、D1 绑定 `D1_QUOTES`、网关服务绑定 `AUTH`（entrypoint `AuthVerifier`）、全站搜索 KV `KV_SEARCH_INDEX`、每小时 Cron |
| `src/index.js` | 入口（公开地址 `/daymark/api/*` 去掉 `/daymark` 前缀后按路由表找）：`/api/today` 公开，其余先问网关会话 |
| `src/search-index.js` | 全站搜索索引：句子 → KV `site:daymark`（写接口成功后重建 + Cron 每小时兜底，内容没变不写 KV；私密句子 `private:true`） |
| `src/routes.js` | 路由表（与 `src/api/` 一一对应，测试核对） |
| `src/api/quotes.js` | `GET` 列表（管理员全部 + 随手一笔 + 所在专题 / 访客公开），`POST` `PUT` `DELETE` 只管理员 + 同源 |
| `src/api/collections.js` | 百味自建专题：`GET`（访客只含公开句子、空的不给），`POST` `PUT`（含排序 `quote_ids`）`DELETE` 只管理员 + 同源 |
| `src/api/today.js` | 今日一句：`GET` 公开（CORS 只给 `https://styrigx.com`）；`PUT` 设为今日，只管理员 + 同源 |
| `src/api/_today.js` | 今日一句的锁定（`daily_pick`：当天第一次请求挑好写进去，失效（删了 / 改私密）就重挑）与改写 |
| `src/api/_quotes.js` | 表结构、校验、行映射（`note` 只给管理员）、按日期挑句子 |
| `src/api/_write.js` | 写接口共用：读 body、同源 + 管理员门槛、`?id=` |
| `migrations/` | D1 迁移：`0001_init`（quotes）、`0002_three_tabs`（quotes.source_type / note，collections、collection_quotes）、`0003_seed_quotes`（63 句种子 + 专题「尼采」「了不起的盖茨比」，只增不删，由 `scripts/gen-seed-sql.mjs` 生成）、`0004_daily_pick`（今日一句锁定表）、`0005_daily_pick_set_by_admin`（`set_by` 的 `'owner'` → `'admin'`）。代码里的 `CREATE TABLE IF NOT EXISTS` 只兜底全新的库，不做 ALTER |

## 部署

见仓库根 `.github/workflows/deploy.yml`：测试 → 构建合成 → 网关闸门 → 两个 core（D1 迁移 + 部署）→ Pages `styrigx-atlas` → 冒烟。
