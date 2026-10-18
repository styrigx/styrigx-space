# 仓库结构

按用途分层，根目录只放入口文件和顶层目录。改一处不牵连别处：换网站构建工具只动 `web/`，加 Worker 只动 `workers/`。

## 根目录

```
styrigx-space/
├─ web/
├─ workers/
├─ tests/
├─ scripts/
├─ docs/
├─ .github/
├─ README.md
├─ README.en.md
├─ STRUCTURE.md
├─ LICENSE
├─ package.json
├─ package-lock.json
├─ wrangler.toml
└─ .gitignore
```

| 位置 | 是什么 |
|---|---|
| `web/` | 网站本体（Hugo 项目），由 Cloudflare Pages 发布 |
| `workers/` | 所有 Cloudflare Worker，一个 Worker 一个目录 |
| `tests/` | 全部测试，按测试对象分目录 |
| `scripts/` | 构建、生成数据、静态检查脚本（CI 调用） |
| `docs/` | 设计文档、截图 |
| `.github/` | CI 工作流（GitHub 规定的位置） |
| `package.json` `package-lock.json` | npm 依赖（npm 只认根目录） |
| `wrangler.toml` | Pages 项目 `styrigx-space` 的配置 |

> 过渡期：`functions/`（Pages 上的鉴权代码）和 `migrations/`（D1 建表）暂留根目录。
> Pages 只认根目录的 `functions/`，要等鉴权网关接管全部页面后，和根目录 `wrangler.toml`
> 一起搬进 `workers/auth-gateway/`（`wrangler.toml` 搬到 `web/`）。

## web/ 网站

```
web/
├─ hugo.yaml
├─ content/
├─ layouts/
├─ assets/
│  ├─ css/
│  └─ js/
├─ static/
├─ data/
└─ public/
```

| 位置 | 是什么 |
|---|---|
| `hugo.yaml` | Hugo 配置 |
| `content/` | 页面入口，中英双语（`content/en/` 是英文） |
| `layouts/` | 模板；`_default/` 下是各 App 页面，`partials/` 是公共片段 |
| `assets/css/` | `input.css`、`tw-input.css` 是源文件；`main.css` 由 `scripts/build-css.cjs` 生成 |
| `assets/js/` | 前端脚本：`lib/` 公共库、`shell/` 系统外壳、`apps/` 各 App、`entries/` 页面入口 |
| `static/` | 原样复制：字体、头像、`_redirects`、`_headers`、`robots.txt` |
| `data/` | 站点数据 yaml/json（`data/en/` 是英文版） |
| `public/` | 构建产物，不进仓库 |

构建生成、不进仓库的数据文件：`data/posts.json`、`data/app_whitelist.json` 由 `scripts/gen-*.mjs` 生成，`data/tailwind.json` 由 `scripts/build-css.cjs` 生成。

本地预览：

```bash
npm install
npm run build:css
hugo server -s web
```

## workers/ Worker

```
workers/
└─ auth-gateway/
   ├─ wrangler.toml
   ├─ package.json
   ├─ README.md
   └─ src/
```

- 目录名 = Cloudflare 上的 Worker 名去掉 `styrigx-` 前缀：`workers/auth-gateway/` ↔ `styrigx-auth-gateway`。
- 新增 Worker：新建 `workers/<名字>/`，在下面的路由登记表里登记它的路径。

| Worker | 目录 | 管什么 |
|---|---|---|
| `styrigx-auth-gateway` | `workers/auth-gateway/` | 鉴权：签发和校验会话、二次验证、应用通行证；主站 `/api/*` 和全部页面先过它验会话，页面验完回源 Pages；所有私钥只在这里（Secrets Store） |

路由登记：现在只有一个 Worker，它的 `wrangler.toml` 里的 `[[routes]]` 就是登记表。
`scripts/check-worker-routes.mjs`（CI 跑）核对：每个 HTML 页面都有路由、静态资源（`/css/` `/js/` `/fonts/` `/fav/` `/avatar/`）不过 Worker、路由不重复。
以后加第二个 Worker 时，再把登记表提成所有 Worker 共用的 `workers/routes.yaml`，并检查路径不重叠。

## tests/ 测试

```
tests/
├─ config/
├─ web/
│  ├─ e2e/
│  └─ ui/
├─ workers/
│  └─ auth-gateway/
└─ fixtures/
```

| 位置 | 是什么 |
|---|---|
| `config/` | `playwright.config.js`、`lighthouserc.json`、`stylelintrc.json` |
| `web/e2e/` | Playwright 页面测试；`visual/` 下是截图基线 |
| `web/ui/` | 前端单元测试（`node --test`） |
| `workers/auth-gateway/` | 鉴权单元测试（`node --test`） |
| `fixtures/` | 测试用固定数据 |

常用命令（都在仓库根目录执行）：

```bash
node --test tests/workers/auth-gateway/*.test.mjs tests/web/ui/*.test.mjs
npx playwright test --config=tests/config/playwright.config.js
```
