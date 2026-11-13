# 仓库结构

| 项 | 值 |
|---|---|
| 文档编号 | SGX-ARCH-002 |
| 版本 | 2.0 |
| 日期 | 2026-11-09 |
| 状态 | 现行 |
| 取代 | 根目录 `STRUCTURE.md` |

## 1. 原则

1.1 按用途分层，根目录只放入口文件与顶层目录。改一处不牵连别处：换网站构建工具只动 `space/web/`，加 Worker 只动 `workers/`。

1.2 网站只有一个：`space/web/` 是一个 Hugo 站（一份 `hugo.yaml`），一次构建出主站与三个子站，产物 `space/web/public/` 随 Pages 部署（ADR-0001）。

1.3 子站内容按站分目录放在同一个 Hugo 站里；共享外壳直接用主站的 partial 与 JS，MUST NOT 维护副本或同步脚本。

## 2. 根目录

```
styrigx-space/
├─ .github/        CI 工作流、共享 action
├─ docs/           规范书（本目录）
├─ space/          网站 + 构建 / 检查脚本
│  ├─ scripts/
│  └─ web/
├─ tests/          全部测试
├─ workers/        全部 Cloudflare Worker
├─ .gitignore
├─ LICENSE
├─ README.md / README.en.md
└─ package.json / package-lock.json
```

| 位置 | 是什么 |
|---|---|
| `space/web/` | 网站本体（Hugo），Cloudflare Pages 项目 `styrigx-space` 发布 |
| `space/scripts/` | 全仓共用的构建、生成、静态检查脚本（CI 调用）；子站自己的脚本在 `space/scripts/<站>/` |
| `workers/` | 一个 Worker 一个目录，目录名 = Worker 名去掉 `styrigx-` |
| `tests/` | 按测试对象分目录 |
| `docs/` | 规范书，入口 `docs/README.md` |
| `.github/` | `workflows/`（`deploy.yml`、`update-snapshots.yml`）、`actions/`（setup-hugo / setup-node-deps / setup-playwright） |
| `package.json` | npm 依赖与脚本（npm 只认根目录） |

## 3. `space/web/`

```
space/web/
├─ hugo.yaml          全站唯一配置（语言、博客 permalinks、taxonomies、子站输出格式）
├─ wrangler.toml      Pages 项目配置（生产无变量；preview 环境只给 passkey-e2e）
├─ archetypes/        hugo new 的模板（blog.md）
├─ content/           主站英文在根、中文在 zh/；子站在 blog/ curio/ daymark/；标签页 tags/
├─ layouts/           _default/ 主站；blog/ curio/ daymark/ 子站；partials/ 公共片段，partials/<站>/ 子站片段
├─ assets/
│  ├─ css/            input.css、tw-input.css（源）；main.css 生成；shell/ 外壳 token 与样式（生成）
│  ├─ js/             lib/ auth/ shell/ apps/ entries/（分层见 SGX-ARCH-001 §6）
│  └─ blog/ curio/ daymark/   子站的 css/ 与 js/（发布路径 /<站>/css/…、/<站>/js/…）
├─ static/            原样复制：字体、_redirects、_headers、robots.txt、_worker.js；static/<站>/ 子站静态文件
├─ data/              站点数据；shell/（nav.json、palettes.json，生成）；curio/ daymark/ 的 i18n 字符串表；version.yaml
├─ i18n/              Hugo 字符串表（博客用）
└─ public/            构建产物，不进仓库
```

3.1 地址规则：主站与子站英文为默认语言；中文主站在 `/zh/`，子站中文在 `/<站>/zh/…`，由各页 front matter 的 `url` 给出，模板里有守卫，写错直接构建失败。

3.2 生成物，MUST NOT 手改（CI 跑 `--check`）：`assets/shell/css/main.css`、`assets/<站>/css/main.css`、`data/shell/tailwind.json`（`build-css.cjs`）；`assets/shell/css/tokens.css`、`shell.css`、`data/shell/*.json`（`gen-shell.mjs`）；`data/shell/palette-roles.json` 与 `input.css` 的 `@gen-palettes` 段（`gen-palettes.mjs`）；`static/_headers` 与 `workers/*/src/lib/csp-hashes.js`（`gen-csp.mjs`）。

3.3 `static/_worker.js` 只把 `*.pages.dev` 301 回 `styrigx.com`。旧地址的 301 写在 `static/_redirects`。

本地预览：

```bash
npm ci
npm run build:css
hugo server -s space/web   # /、/blog/、/curio/、/daymark/ 一起
```

## 4. `space/scripts/`

| 脚本 | 用途 |
|---|---|
| `build-css.cjs` | 主站 CSS（Tailwind 4），顺带三个子站；`--main-only` 只构建主站 |
| `gen-shell.mjs` | 外壳派生文件（tokens / shell.css、nav / palettes.json、`ui-cookie-read.js` 的 `@ui-cookie-presets` 段） |
| `gen-palettes.mjs` | 调色板角色（`--roles`） |
| `gen-ui-cookie-contract.mjs` | `tests/fixtures/ui-cookie-contract.json` |
| `gen-csp.mjs` | Report-Only CSP 的内联脚本哈希；只算主站页面 |
| `build-search-index.mjs` | 主站搜索索引（KV `site:space`）；博客的在 `blog/build-search-index.mjs` |
| `check-layers.mjs` | 前端分层与 Worker 边界（SGX-ARCH-001 §6–7） |
| `check-frontend.mjs` | 前端规范：禁原生弹窗、禁独立 `token` 变量、`openSheet(` 只许出现在白名单 |
| `check-worker-routes.mjs` | 路由归属核对（匹配规则 `lib/cf-routes.mjs`） |
| `verify-core-routes.mjs` | 部署后线上路由核对 |
| `health-gate.mjs`、`kv-budget.mjs` | 部署后健康检查、KV 写额度守卫 |
| `deploy-rollback.mjs`、`deploy-rollback-floor.json` | 部署失败自动回滚与回滚下限 |
| `retired-names.json` | 退役名单（规则 22） |
| `ci-local.sh` | 本地按 CI 顺序跑 |
| `blog/` | 博客：`build-css.mjs`、`build-search-index.mjs`、`gen-code-tokens.mjs`、`serve-static.mjs` |
| `curio/`、`daymark/` | 种子 SQL 生成：`gen-seed-sql.mjs` |

## 5. `workers/`

骨架、依赖链、防回退规则与新增步骤只写在 [`workers/README.md`](../../workers/README.md)。每个 Worker 的职责、路由、绑定、数据与迁移写在各自的 `README.md`。资源名清单见 SGX-OPS-002。

## 6. `tests/`

```
tests/
├─ config/        playwright.config.js、pw-local.config.js、lighthouserc.json、stylelintrc.json
├─ space/
│  ├─ e2e/<功能>/ account passkey lock space topbar layout edge visual helpers
│  └─ ui/<功能>/  account build home layout lock passkey shell space status sync theme topbar
├─ blog/ curio/ daymark/   子站：*.test.mjs、e2e/、config/
├─ workers/<名字>/          Worker 单测；_harness.mjs / _harness.cjs / _conclusion.mjs 是公共测试台
└─ fixtures/      共享夹具（ui-cookie-contract.json 只此一份）
```

常用命令（仓库根目录）：

```bash
node --test tests/workers/*/*.test.mjs "tests/space/ui/**/*.test.mjs"
npm run build            # CSS + 一次 Hugo
npm run test:sites       # 子站单测（先构建）
npx playwright test --config=tests/config/playwright.config.js
npx playwright test --config=tests/blog/config/playwright.config.js   # curio / daymark 同理
```
