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
└─ .gitignore
```

| 位置 | 是什么 |
|---|---|
| `web/` | 网站本体（Hugo 项目），由 Cloudflare Pages 发布（只放静态文件） |
| `workers/` | 所有 Cloudflare Worker，一个 Worker 一个目录 |
| `tests/` | 全部测试，按测试对象分目录 |
| `scripts/` | 构建、生成数据、静态检查脚本（CI 调用） |
| `docs/` | 设计文档、截图 |
| `.github/` | CI 工作流（GitHub 规定的位置） |
| `package.json` `package-lock.json` | npm 依赖（npm 只认根目录） |

## web/ 网站

```
web/
├─ hugo.yaml
├─ wrangler.toml
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
| `wrangler.toml` | Pages 项目 `styrigx-space` 的配置：生产不带任何变量和绑定；`preview` 环境只给 passkey-e2e 用。在 `web/` 下执行 `wrangler pages deploy public` |
| `content/` | 页面入口，中英双语（`content/en/` 是英文） |
| `layouts/` | 模板；`_default/` 下是各 App 页面，`partials/` 是公共片段 |
| `assets/css/` | `input.css`、`tw-input.css` 是源文件；`main.css` 由 `scripts/build-css.cjs` 生成 |
| `assets/js/` | 前端脚本：`lib/` 公共库、`shell/` 系统外壳、`apps/` 各 App、`entries/` 页面入口 |
| `static/` | 原样复制：字体、默认头像、`_redirects`、`_headers`、`robots.txt`、`_worker.js`（只把 `*.pages.dev` 跳回 `styrigx.com`） |
| `data/` | 站点数据 yaml/json（`data/en/` 是英文版） |
| `public/` | 构建产物，不进仓库 |

构建生成、不进仓库的数据文件：`data/tailwind.json` 由 `scripts/build-css.cjs` 生成。

本地预览：

```bash
npm install
npm run build:css
hugo server -s web
```

## workers/ Worker

```
workers/
├─ auth-gateway/
│  ├─ wrangler.toml
│  ├─ package.json
│  ├─ README.md
│  ├─ src/
│  ├─ functions/
│  └─ migrations/
├─ account/
│  ├─ wrangler.toml
│  ├─ package.json
│  ├─ README.md
│  ├─ src/
│  └─ migrations/
├─ search-index/
│  ├─ wrangler.toml
│  ├─ package.json
│  └─ src/
├─ chat/
│  ├─ wrangler.toml
│  ├─ package.json
│  ├─ README.md
│  └─ src/
└─ proxy-rules/
   ├─ wrangler.toml
   ├─ package.json
   └─ src/
```

- 目录名 = Cloudflare 上的 Worker 名去掉 `styrigx-` 前缀：`workers/auth-gateway/` ↔ `styrigx-auth-gateway`。
- 新增 Worker：新建 `workers/<名字>/`，在下面的路由登记表里登记它的路径。

| Worker | 目录 | 管什么 |
|---|---|---|
| `styrigx-auth-gateway` | `workers/auth-gateway/` | 主站会话和锁屏后端：签发和校验会话、二次验证、账号登录、其余接口；`/api/*` 和全部页面先过它，页面验完回源 Pages 取静态文件；blog、book 子站的页面也由它验会话（`src/subsites.js`）；所有公私钥只在这里（Secrets Store） |
| `styrigx-account` | `workers/account/` | 站长账号名下的数据（2026-10-24 从网关拆出来）：头像（KV `KV_PROFILE`）、设置云同步含主题等外观（`KV_SETTINGS_SYNC`）、数字健康（D1 `styrigx-account` 的 `wb_daily`）。自己挂 `styrigx.com/api/avatar*`、`/api/prefs*`、`/api/wellbeing*`、`/avatar/*` 四条比网关更具体的路由（前端地址不变）；不持钥匙，会话经网关的服务绑定 RPC `SessionVerifier` 验 |
| `styrigx-search-index` | `workers/search-index/` | 全站搜索：没有公开地址，只经网关的服务绑定 `SEARCH` 进来（`/api/search` 先验会话）；索引在 KV `styrigx-search-index` |
| `styrigx-chat` | `workers/chat/` | 聊天后端（2026-10-22 从网关拆出来）：没有公开地址，只经网关的服务绑定 `CHAT` 进来（`/api/chat` 先验同源 + 会话 + 只许站长，回答原样流回）；转给 Gemini（或 OpenAI 兼容接口），不存对话；钥匙 `SGX_CHAT_API_KEY`（Secrets Store）和 `CHAT_*` 变量只在这里 |
| `styrigx-proxy-rules` | `workers/proxy-rules/` | 规则集加速反代：`proxy-rules.styrigx.com`（自定义域名，不过网关），只放行 MetaCubeX/meta-rules-dat 的 geosite/geoip 规则集（`.mrs` `.yaml` `.list`），上游 jsDelivr → raw.githubusercontent，边缘缓存 24 小时 |

路由登记：挂路由的是网关和账号 Worker，各自 `wrangler.toml` 里的 `[[routes]]` 就是登记表（网关整站通配，账号 Worker 四条更具体的前缀规则，Cloudflare 取最具体的一条）。2026-10-21 起三站都是整站通配（`styrigx.com/*`、`blog.styrigx.com/*`、`daymark.styrigx.com/*`）：Cloudflare 不带 `*` 的规则遇到查询串不命中，以前 `styrigx.com/?lock=1&return=…`（锁屏入口）和子站首页带查询串都绕过了网关。静态资源（`/css/` `/js/` `/fonts/` `/fav/` `/images/`、子站静态后缀）进 Worker 后第一行原样回源，不验会话、不打 `X-SGX-Runtime`。
`scripts/check-worker-routes.mjs`（CI 跑，匹配规则在 `scripts/lib/cf-routes.mjs`，照线上实测）核对：每个 HTML 页面（含带查询串）、锁屏入口、`/api/` 都过网关，头像 / 云同步 / 数字健康归账号 Worker 且没抢走网关路由表里的任何接口，路由不重复，只登记三站域名，daymark 的句子接口仍归 `styrigx-daymark-core`。锁屏 / 解锁 / 回跳的完整状态机见 `docs/auth-state-machine.md`。
两个 Worker 的规则由 `check-worker-routes.mjs` 一起核对，不重复、不互抢。

## tests/ 测试

```
tests/
├─ config/
├─ web/
│  ├─ e2e/
│  └─ ui/
├─ workers/
│  ├─ auth-gateway/
│  ├─ account/
│  ├─ search-index/
│  ├─ chat/
│  └─ proxy-rules/
└─ fixtures/
```

| 位置 | 是什么 |
|---|---|
| `config/` | `playwright.config.js`、`lighthouserc.json`、`stylelintrc.json` |
| `web/e2e/` | Playwright 页面测试；`visual/` 下是截图基线 |
| `web/ui/` | 前端单元测试（`node --test`） |
| `workers/auth-gateway/` | 鉴权单元测试（`node --test`） |
| `workers/account/` | 账号 Worker 单元测试（头像、云同步、数字健康、门、路由；会话经网关真实的 verifier.js） |
| `workers/search-index/` | 全站搜索单元测试 |
| `workers/chat/` | 聊天 Worker 单元测试（网关那边的门和转发在 `workers/auth-gateway/chat-api.test.mjs`） |
| `workers/proxy-rules/` | 规则集反代单元测试 |
| `fixtures/` | 测试用固定数据 |

常用命令（都在仓库根目录执行）：

```bash
node --test tests/workers/*/*.test.mjs tests/web/ui/*.test.mjs
npx playwright test --config=tests/config/playwright.config.js
```
