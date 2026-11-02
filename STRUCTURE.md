# 仓库结构

按用途分层，根目录只放入口文件和顶层目录。改一处不牵连别处：换网站构建工具只动 `web/`，加 Worker 只动 `workers/`。

2026-11-02 起 `web/` 是包容器（主站 space 容纳子站包，PR1 搬运）：主站整套在 `web/atlas/`，博客、奇趣、日刻各自整套在 `web/blog/`、`web/curio/`、`web/daymark/`；`scripts/`、`tests/`、`workers/`、`docs/` 里子站的东西按站分目录。合并 PR3 之前子站线上仍由 styrigx-atlas 仓库部署，这里的子站文件只构建、只测试；改子站以本仓库为准（冻结规则见合并方案）。

## 根目录

```
styrigx-space/
├─ web/
│  ├─ atlas/
│  ├─ blog/
│  ├─ curio/
│  └─ daymark/
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
├─ renovate.json
└─ .gitignore
```

| 位置 | 是什么 |
|---|---|
| `web/atlas/` | 主站包：网站本体（Hugo 项目），由 Cloudflare Pages 发布（只放静态文件） |
| `web/blog/` `web/curio/` `web/daymark/` | 子站包：各自整套 Hugo 站（`hugo.yaml`、content、layouts、assets、static）+ 共享外壳副本的 `sgx-shell.lock.json`；PR1 起进仓，单独构建，还不进主站 Pages 产物（拼树在 PR2） |
| `workers/` | 所有 Cloudflare Worker，一个 Worker 一个目录 |
| `tests/` | 全部测试，按测试对象分目录 |
| `scripts/` | 构建、生成数据、静态检查脚本（CI 调用） |
| `docs/` | 设计文档、截图 |
| `.github/` | CI 工作流（GitHub 规定的位置） |
| `package.json` `package-lock.json` | npm 依赖（npm 只认根目录） |
| `renovate.json` | Renovate 依赖升级配置 |

## web/atlas/ 主站包

```
web/atlas/
├─ hugo.yaml
├─ wrangler.toml
├─ content/
├─ layouts/
├─ assets/
│  ├─ css/
│  └─ js/
├─ static/
├─ shared/
├─ data/
└─ public/
```

| 位置 | 是什么 |
|---|---|
| `hugo.yaml` | Hugo 配置 |
| `wrangler.toml` | Pages 项目 `styrigx-space` 的配置：生产不带任何变量和绑定；`preview` 环境只给 passkey-e2e 用。在 `web/atlas/` 下执行 `wrangler pages deploy public` |
| `content/` | 页面入口，中英双语（`content/en/` 是英文） |
| `layouts/` | 模板；`_default/` 下是各 App 页面，`partials/` 是公共片段 |
| `assets/css/` | `input.css`、`tw-input.css` 是源文件；`main.css` 由 `scripts/build-css.cjs` 生成 |
| `assets/js/` | 前端脚本：`lib/` 公共库、`auth/` 鉴权与凭证流程、`shell/` 系统外壳、`apps/` 各 App、`entries/` 页面入口（依赖方向见 `docs/architecture.md`，`scripts/check-layers.mjs` 检查） |
| `static/` | 原样复制：字体、默认头像、`_redirects`、`_headers`、`robots.txt`、`_worker.js`（只把 `*.pages.dev` 跳回 `styrigx.com`） |
| `shared/shell/` | 共享外壳（顶栏、抽屉、搜索层的 CSS / JS / 导航数据）：`scripts/gen-shell.mjs` 从主站源头生成，子站用各自的 `scripts/sync-shell.mjs` 同步过去；CI 跑 `gen-shell.mjs --check`。外观 cookie `sgx-ui`（主站写、子站只读）的契约见 `docs/ui-cookie-contract.md` |
| `data/` | 站点数据 yaml/json（`data/en/` 是英文版） |
| `public/` | 构建产物，不进仓库 |

构建生成、不进仓库的数据文件：`data/tailwind.json` 由 `scripts/build-css.cjs` 生成。

本地预览：

```bash
npm ci
npm run build:css
hugo server -s web/atlas
```

## workers/ Worker

一个 Worker 一个目录，目录名 = Cloudflare 上的 Worker 名去掉 `styrigx-` 前缀；骨架、依赖链、对齐现状、防回退规则和新增 Worker 的步骤只写在 [`workers/README.md`](workers/README.md)。

| Worker | 目录 | 管什么 |
|---|---|---|
| `styrigx-auth-gateway` | `workers/auth-gateway/` | 主站锁屏后端：签发和校验锁屏会话、锁屏凭证与再验证、锁屏根密钥、其余接口；`/api/*` 和全部页面先过它，页面验完回源 Pages 取静态文件；账号路径（`/api/account`、`/api/prefs*`、`/api/avatar*`、`/api/wellbeing*`、`/avatar/*`）验门后经服务绑定 `ACCOUNT` 转给账号 Worker（`src/router.js` 的转发表 `FORWARDING`）；图志 atlas.styrigx.com（/blog/、/curio/、/daymark/）的页面也由它验会话（`src/gate.js` 的图志关口 `handleSubsite`）；钥匙只有 `SGX_LOCK_*`、`SGX_ADMIN_KEY`、`SGX_PW_PEPPER`（Secrets Store）；认证状态在 D1 `styrigx-auth-gateway`（只有 `D1_LOCK_AUTH`，不绑 KV）。没有任何账号鉴权代码，见 `workers/auth-gateway/README.md` |
| `styrigx-account` | `workers/account/` | 完整的账号系统（账号拆分 PR3）：账号密码 / 通行密钥、已登录设备、账号会话与短票、账号根密钥、账号审计（D1 `styrigx-account`，`D1_ACCOUNT_AUTH`），以及头像（KV `KV_PROFILE`，只放公开的 `avatar:*`）、设置云同步含主题等外观（同库 `settings_sync`，`D1_SETTINGS_SYNC`）、数字健康（同库 `wb_daily`，`D1_WELLBEING`）。**没有公开路由**：只经网关的服务绑定 `ACCOUNT`（AccountService，读网关写的身份头）和 `ACCOUNT_VERIFIER`（AccountVerifier，只读账号会话 RPC）进来，默认 fetch 一律 404；钥匙 `SGX_ACCOUNT_PRIVATE` / `SGX_ACCOUNT_PUBLIC`、`SGX_ACCOUNT_ROOT_KEY`、`SGX_PW_PEPPER`；不调网关，见 `workers/account/README.md` |
| `styrigx-share` | `workers/share/` | 分享短链（2026-10-24）：`https://styrigx.com/s/<码>` 和管理员管理接口 `/api/share`，数据在 D1 `styrigx-share`（`D1_SHARE_LINK`）。自己挂 `styrigx.com/s/*`、`/api/share*` 两条比网关更具体的路由；不持钥匙，只认管理员锁屏会话（经网关 `AuthVerifier` 验，不问账号会话），短链钥匙和访客会话由网关的服务绑定 RPC `ShareIssuer` 签 |
| `styrigx-search-index` | `workers/search-index/` | 全站搜索：没有公开地址，只经网关的服务绑定 `SEARCH` 进来（`/api/search` 先验会话）；索引在 KV `styrigx-search-index` |
| `styrigx-status` | `workers/status/` | 站点监测：cron 每分钟检查主站、图志、规则集，每小时读一次 Cloudflare 用量，结果在 D1 `styrigx-status`；没有公开地址，只经网关的服务绑定 `STATUS` 进来（`/api/status` 先验会话，设置 → 服务状态页读它） |
| `styrigx-chat` | `workers/chat/` | 聊天后端（2026-10-22 从网关拆出来）：没有公开地址，只经网关的服务绑定 `CHAT` 进来（`/api/chat` 先验同源 + 会话 + 只许管理员，回答原样流回）；转给 Gemini（或 OpenAI 兼容接口），不存对话；钥匙 `SGX_CHAT_API_KEY`（Secrets Store）和 `CHAT_*` 变量只在这里 |
| `styrigx-curio-core` | `workers/curio-core/` | 奇趣接口（`atlas.styrigx.com/curio/api/*`，D1 + R2），2026-11-02 从 styrigx-atlas 搬来；PR3 之前线上部署仍在 styrigx-atlas 仓库，这里只打包检查和单测，见 `workers/curio-core/README.md` |
| `styrigx-daymark-core` | `workers/daymark-core/` | 日刻接口（`atlas.styrigx.com/daymark/api/*`，D1），同上，见 `workers/daymark-core/README.md` |
| `styrigx-proxy-rules` | `workers/proxy-rules/` | 规则集加速反代：`proxy-rules.styrigx.com`（自定义域名，不过网关），只放行 MetaCubeX/meta-rules-dat 的 geosite/geoip 规则集（`.mrs` `.yaml` `.list`），上游 jsDelivr → raw.githubusercontent，边缘缓存 24 小时 |

路由登记：挂路由的只有网关和短链 Worker，各自 `wrangler.toml` 里的 `[[routes]]` 就是登记表（网关整站通配，短链 Worker 两条更具体的前缀规则，Cloudflare 取最具体的一条）。账号 Worker 没有任何路由（账号拆分 PR3 删掉原来的四条），它的路径归网关的 `styrigx.com/*`，再按网关转发表（`workers/auth-gateway/src/router.js` 的 `FORWARDING`）转过去；`scripts/check-layers.mjs` 规则 17 禁止账号 Worker 的 `wrangler.toml` 出现非空 routes。2026-10-21 起各站都是整站通配，2026-11-02 博客 / 奇趣 / 日刻并入图志后只剩两条（`styrigx.com/*`、`atlas.styrigx.com/*`；图志的 `/curio/api/*`、`/daymark/api/*` 归 styrigx-atlas 仓库的两个接口 Worker）：Cloudflare 不带 `*` 的规则遇到查询串不命中，以前 `styrigx.com/?lock=1&return=…`（锁屏入口）和子站首页带查询串都绕过了网关。静态资源（`/css/` `/js/` `/fonts/` `/fav/` `/images/`、子站静态后缀）进 Worker 后第一行原样回源，不验会话、不打 `X-SGX-Runtime`。
`scripts/check-worker-routes.mjs`（CI 跑，匹配规则在 `scripts/lib/cf-routes.mjs`，照线上实测）核对：每个 HTML 页面（含带查询串）、锁屏入口、`/api/` 都过网关，账号 Worker 0 条路由、头像 / 云同步 / 数字健康 / `/api/account` 在网关转发表里、`/s/*` 和 `/api/share*` 归短链 Worker，且都没抢走网关路由表里的任何接口，路由不重复，只登记主站 `styrigx.com` 和图志 `atlas.styrigx.com` 两个域名，图志的 `/daymark/api/*` 仍归 `styrigx-daymark-core`、`/curio/api/*` 仍归 `styrigx-curio-core`。锁屏 / 解锁 / 回跳的完整状态机见 `docs/auth-state-machine.md`。
网关、账号、短链三个 Worker 的 `wrangler.toml` 由 `check-worker-routes.mjs` 一起核对，不重复、不互抢。

部署顺序（`.github/workflows/deploy.yml`）：搜索/聊天/监测 → 账号 ∥ 短链 → 网关 → Pages（账号和短链两个 job 并行）。预览 / 测试资源（KV、D1，以后的 R2）所有 Worker 只用一个 `styrigx-test-preview`（`tests/workers/auth-gateway/preview-resources.test.mjs` 守卫）。

Worker 之间的边界（`scripts/check-layers.mjs`，CI 必过）：每个 Worker 只 import 自己目录下的文件，Worker 之间互不 import；没有 `workers/shared` 这类公共目录（2026-10-30 删除，各 Worker 各自一份）；网关源码不许出现账号鉴权标识；账号 Worker 不许有路由；Worker 骨架防回退（规则 18–21）。规则见 `docs/architecture.md`「Worker 边界」和 [`workers/README.md`](workers/README.md)。

安全响应头（2026-10-25）：网关的值在 `workers/auth-gateway/src/lib/security-headers.js`；账号、短链 Worker 各自一份同值的 `src/lib/security-headers.js`（2026-10-30 起没有 `workers/shared`，单测核对与网关同值），`scripts/gen-csp.mjs` 同时生成三份 `csp-hashes.js`。

| 出口 | 加什么 |
|---|---|
| 网关：主站 `styrigx.com` 的页面、锁屏首页、所有跳转、`/api/*` | 全套：HSTS（一年，不带 includeSubDomains）、nosniff、`X-Frame-Options: DENY`、Referrer-Policy、Permissions-Policy、强制 CSP（只有 `frame-ancestors` / `object-src` / `base-uri` / `form-action`）、完整的 `Content-Security-Policy-Report-Only` |
| 账号 Worker、分享短链 Worker | 同上（`/s/<码>` 自己的 `Referrer-Policy: no-referrer` 不被覆盖） |
| Pages 静态文件 | `web/atlas/static/_headers` 的 `/*` 段，同一套，由 `scripts/gen-csp.mjs` 生成 |
| Pages `_worker.js` 的 `*.pages.dev` → 301 | 不依赖内容的那几个（HSTS、nosniff、X-Frame-Options、Referrer-Policy、强制 CSP） |
| 网关代理的图志 `atlas.styrigx.com`（`/blog/`、`/curio/`、`/daymark/`）页面、跳转和 401 | HSTS（统一覆盖）；nosniff、`X-Frame-Options: DENY`、Referrer-Policy、只有 `frame-ancestors` / `object-src` / `base-uri` 的强制 CSP（图志自己没发才补，已有任何 CSP 就不补）；不加 Permissions-Policy 和 Report-Only，图志内容的完整 CSP 各自审计后再加。图志静态资源直通时只补 HSTS、nosniff |
| `proxy-rules.styrigx.com` | 上游头一律不透传，只留 ETag / Last-Modified，加 nosniff |

Report-Only 里的内联脚本 sha256 由 `scripts/gen-csp.mjs` 从生产构建算出（`workers/auth-gateway/src/lib/csp-hashes.js`），CI 在构建后跑 `--check`。改了模板里的内联脚本：`hugo --minify -s web/atlas && node scripts/gen-csp.mjs`。

## tests/ 测试

```
tests/
├─ config/
├─ web/
│  ├─ e2e/
│  └─ ui/
├─ blog/
├─ curio/
├─ daymark/
├─ workers/
│  ├─ curio-core/
│  ├─ daymark-core/
│  ├─ auth-gateway/
│  ├─ account/
│  ├─ share/
│  ├─ search-index/
│  ├─ status/
│  ├─ chat/
│  └─ proxy-rules/
└─ fixtures/
```

| 位置 | 是什么 |
|---|---|
| `config/` | `playwright.config.js`、`pw-local.config.js`（本地挑几个 spec 跑，换端口）、`lighthouserc.json`、`stylelintrc.json` |
| `web/e2e/` | 主站 Playwright 页面测试；`visual/` 下是截图基线 |
| `web/ui/` | 主站前端单元测试（`node --test`） |
| `blog/`、`curio/`、`daymark/` | 子站测试（从 styrigx-atlas 搬来）：blog 的单测在 `tests/blog/*.test.mjs`、e2e 和截图基线在 `tests/blog/e2e/`；curio / daymark 在 `tests/<站>/web/`（单测）、`web/e2e/`、`config/`、`fixtures/`。CI 的「Subsite builds + unit tests」一步跑单测；子站 Playwright 在 PR2 接 |
| `workers/curio-core/`、`workers/daymark-core/` | 子站接口 Worker 单元测试（node:sqlite 真跑 D1 的 SQL） |
| `workers/_harness.mjs`、`_harness.cjs` | 测试台公共件：内存 KV（`makeKV`）、内存认证 D1（`makeAuthD1`，node:sqlite）、`derToPem`、`genKeyPair`、`postReq`；e2e 的 `edge-harness.cjs` / `cred-e2e-helpers.cjs` 也用 `_harness.cjs`，不再各写一份 |
| `workers/auth-gateway/` | 鉴权单元测试（`node --test`） |
| `workers/account/` | 账号 Worker 单元测试（账号身份、头像、云同步、数字健康、命名入口与身份头、没有公开路由） |
| `workers/share/` | 短链 Worker 单元测试（规则、生成 / 打开 / 作废、权限、限速、路由；钥匙和锁屏会话经网关真实的 `rpc/share-issuer.js` / `rpc/auth-verifier.js`；不问账号会话） |
| `workers/search-index/` | 全站搜索单元测试 |
| `workers/status/` | 站点监测单元测试（检查、汇总、用量；有 `node:sqlite` 时跑真 SQL） |
| `workers/chat/` | 聊天 Worker 单元测试（网关那边的门和转发在 `workers/auth-gateway/chat-api.test.mjs`） |
| `workers/proxy-rules/` | 规则集反代单元测试 |
| `fixtures/` | 测试用固定数据 |

常用命令（都在仓库根目录执行）：

```bash
node --test tests/workers/*/*.test.mjs tests/web/ui/*.test.mjs
# 子站单测要先构建子站（命令见 .github/workflows/deploy.yml 的 Subsite builds + unit tests）
node --test tests/blog/*.test.mjs tests/curio/web/*.test.mjs tests/daymark/web/*.test.mjs
npx playwright test --config=tests/config/playwright.config.js
```

## scripts/、docs/ 里的子站

| 位置 | 是什么 |
|---|---|
| `scripts/blog/` | 博客：`build-css.mjs`、`build-search-index.mjs`（KV `site:blog`）、`gen-code-tokens.mjs`、`serve-static.mjs`、`sync-shell.mjs` |
| `scripts/curio/` | 奇趣：`gen-seed-sql.mjs`（`data/seed.json` → `workers/curio-core/migrations/0002_seed.sql`）、`sync-shell.mjs` |
| `scripts/daymark/` | 日刻：`gen-seed-sql.mjs`、`sync-shell.mjs` |
| `docs/blog/`、`docs/curio/STRUCTURE.md`、`docs/daymark/STRUCTURE.md` | 子站文档，原样搬来（里面的路径是站内相对路径：`web/…` 指 `web/<站>/…`，`tests/…` 指 `tests/<站>/…`，`workers/core/` 指 `workers/<站>-core/`） |
