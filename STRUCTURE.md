# 仓库结构

按用途分层，根目录只放入口文件和顶层目录。改一处不牵连别处：换网站构建工具只动 `space/web/`，加 Worker 只动 `workers/`。

2026-11 合站起只有一个网站：`space/web/` 是一个 Hugo 站（一份 `hugo.yaml`），一次构建出主站（`/`、中文 `/zh/`）和三个子站（博客 `/blog/`、奇趣 `/curio/`、日刻 `/daymark/`，中文 `/<站>/zh/`），产物就是 `space/web/public/`，随 Pages 一起部署。子站按站分目录放在同一个站里（`content/<站>/`、`layouts/<站>/`、`layouts/partials/<站>/`、`assets/<站>/`、`static/<站>/`、`data/<站>/`），共享外壳直接用主站的 partial 和 JS，没有副本、没有同步脚本。`space/scripts/` 是全仓的构建 / 生成 / 检查脚本，子站自己的脚本在 `space/scripts/<站>/`。`tests/`、`docs/`、`workers/`、`.github/` 在根目录，里面子站的东西按站分目录。子站的正式入口在 `styrigx.com/<站>/`（网关按路径前缀走子站关口），接口在 `styrigx.com/<站>/api/*`（本仓库的两个接口 Worker）；旧图志域名的 301 已于 P4-3 PR-1 删除、域名下线。

> **历史布局换算**（看旧文档、旧提交时用）：2026-11-02 合并 PR1 把主站搬进 `web/atlas/`；2026-11-06 分包（任务书 `docs/repo-split-task.md`）起主站包叫 `space/`、子站包叫 `atlas/`（`atlas/web/<站>/` 各自整套 Hugo 站，`atlas/scripts/<站>/` 子站脚本），合并 PR2 起四个站各自构建再用 `space/scripts/assemble.mjs` 拼成 `dist/site/`；2026-11 合站后 `atlas/`、`assemble.mjs`、`build-sites.mjs`、`dist/site/`、`space/web/shared/shell/`、各站 `sync-shell.mjs` 和 `sgx-shell.lock.json` 都没有了。换算：`web/atlas/` → `space/web/`；`web/<站>/`、`atlas/web/<站>/` → `space/web/` 下的 `content|layouts|assets|static|data/<站>/`（博客的 i18n 在 `space/web/i18n/`，奇趣 / 日刻的字符串表在 `data/<站>/i18n/`）；`scripts/<站>/`、`atlas/scripts/<站>/` → `space/scripts/<站>/`；其余 `scripts/` → `space/scripts/`。线上旧图志域名和监测里的站点名 `atlas` 与包名无关（两者都在 P4-3 PR-1 随 301 一起删除）。

## 根目录

```
styrigx-space/
├─ space/
│  ├─ scripts/
│  │  ├─ blog/
│  │  ├─ curio/
│  │  └─ daymark/
│  └─ web/
├─ workers/
├─ tests/
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
| `space/` | 网站 + 基建：`space/web/` 网站本体（一个 Hugo 项目，主站和 blog / curio / daymark 三个子站同一次构建），由 Cloudflare Pages 发布（只放静态文件）；`space/scripts/` 全仓共用的构建、生成数据、静态检查脚本（CI 调用），子站自己的脚本在 `space/scripts/<站>/` |
| `workers/` | 所有 Cloudflare Worker，一个 Worker 一个目录 |
| `tests/` | 全部测试，按测试对象分目录 |
| `docs/` | 设计文档、任务书、截图；入口索引 `docs/README.md` |
| `.github/` | CI 工作流（GitHub 规定的位置） |
| `package.json` `package-lock.json` | npm 依赖（npm 只认根目录） |
| `renovate.json` | Renovate 依赖升级配置 |

## space/web/ 网站（主站 + 三个子站，一个 Hugo 站）

```
space/web/
├─ hugo.yaml
├─ wrangler.toml
├─ content/
│  ├─ zh/
│  ├─ blog/
│  ├─ curio/
│  └─ daymark/
├─ layouts/
│  ├─ _default/
│  ├─ blog/
│  ├─ curio/
│  ├─ daymark/
│  └─ partials/
│     ├─ blog/
│     ├─ curio/
│     └─ daymark/
├─ assets/
│  ├─ css/
│  ├─ js/
│  ├─ blog/
│  ├─ curio/
│  └─ daymark/
├─ static/
│  ├─ blog/
│  ├─ curio/
│  └─ daymark/
├─ data/
│  ├─ shell/
│  ├─ curio/
│  └─ daymark/
├─ i18n/
└─ public/
```

| 位置 | 是什么 |
|---|---|
| `hugo.yaml` | Hugo 配置（全站唯一一份：语言、博客的 permalinks / 标签、子站分区的附带输出 RSS / 站点地图；子站中文页的地址 `/<站>/zh/…` 由各自 front matter 的 `url` 给，模板里有守卫，写错直接构建失败） |
| `wrangler.toml` | Pages 项目 `styrigx-space` 的配置：生产不带任何变量和绑定；`preview` 环境只给 passkey-e2e 用。在 `space/web/` 下执行 `wrangler pages deploy public` |
| `content/` | 页面入口，中英双语（主站英文默认在 `content/`，中文在 `content/zh/`，url 带 `/zh/`；P4-3 PR-4c）；子站在 `content/blog/`、`content/curio/`、`content/daymark/` 分区里（中文 `<名>.zh.md`，url 带 `/<站>/zh/`），标签页在 `content/tags/` |
| `layouts/` | 模板；`_default/` 下是主站各 App 页面，`blog/` `curio/` `daymark/` 是子站的分区模板，`partials/` 是公共片段（含共享外壳 `shell-topbar.html`、`sgx-entries.html`、`sgx-page-hero.html`、`sgx-segtabs.html`、`sgx-tr.html`、`sgx-lang-path.html`，四站共用），`partials/<站>/` 是子站自己的片段 |
| `assets/css/` | `input.css`、`tw-input.css` 是源文件；`main.css` 由 `space/scripts/build-css.cjs` 生成 |
| `assets/blog/`、`assets/curio/`、`assets/daymark/` | 子站的 `css/`、`js/`（发布路径仍是 `/<站>/css/…`、`/<站>/js/…`，和合站前一样）；子站样式表 `@import` 共享外壳的 `assets/css/shell/*.css`，子站 JS 直接 import 主站的 `assets/js/shell/`、`assets/js/lib/` |
| `assets/js/` | 前端脚本：`lib/` 公共库、`auth/` 鉴权与凭证流程、`shell/` 系统外壳、`apps/` 各 App、`entries/` 页面入口（依赖方向见 `docs/architecture.md`，`space/scripts/check-layers.mjs` 检查）。前端规范 `space/scripts/check-frontend.mjs`（CI 必过）：规则 1 禁原生弹窗（alert / confirm / prompt）；规则 2 禁独立 `token` 变量；规则 3 不做底部弹出窗口——`openSheet(` 只许出现在白名单文件（`SHEET_ALLOW`：只剩 `shell/sheet.js`；旧账号整页 `apps/account*.js`、`apps/avatar-edit.js`、`apps/settings.js` 都已删除），新调用一律拦下，选项改行内展开单选（P4-3 §6.7） |
| `static/` | 原样复制：字体、默认头像、`_redirects`、`_headers`、`robots.txt`、`_worker.js`（只把 `*.pages.dev` 跳回 `styrigx.com`）；域名根文件只在这里，`static/<站>/` 是子站的静态文件（博客字体、manifest 等） |
| `data/` | 站点数据 yaml/json（`data/en/` 是英文版；只是数据目录名，和地址无关）；`data/shell/`（`nav.json`、`palettes.json`）是共享外壳的派生数据，`space/scripts/gen-shell.mjs` 从主站源头生成（同时生成 `assets/css/shell/tokens.css`、`shell.css`），CI 跑 `gen-shell.mjs --check`；`data/curio/i18n/`、`data/daymark/i18n/` 是奇趣 / 日刻的字符串表。外观 cookie `sgx-ui`（主站写、子站只读）的契约见 `docs/ui-cookie-contract.md` |
| `i18n/` | Hugo 的字符串表（博客用） |
| `public/` | 构建产物，不进仓库 |

构建生成、不进仓库的文件：`data/tailwind.json`、`assets/css/main.css` 和三个子站的 `assets/<站>/css/main.css` 都由 `space/scripts/build-css.cjs` 生成（它顺带构建子站样式，`--main-only` 只构建主站）。

本地预览：

```bash
npm ci
npm run build:css
hugo server -s space/web   # 主站和三个子站一起：/、/blog/、/curio/、/daymark/
```

## workers/ Worker

一个 Worker 一个目录，目录名 = Cloudflare 上的 Worker 名去掉 `styrigx-` 前缀；骨架、依赖链、对齐现状、防回退规则和新增 Worker 的步骤只写在 [`workers/README.md`](workers/README.md)。

| Worker | 目录 | 管什么 |
|---|---|---|
| `styrigx-space-core` | `workers/space-core/` | 站点核心（进站 v3 L2 起，原 `styrigx-auth-gateway`；分享链接 `styrigx-share` 并入）：签发和校验进站会话、锁屏凭证与再验证、恢复钥匙、分享链接 `https://styrigx.com/s/<码>` 和管理接口 `/api/share`（`src/router.js` 的 `routeShare`）、其余接口；`/api/*` 和全部页面先过它，页面验完回源 Pages 取静态文件；账号路径（`/api/account*`、`/api/prefs*`、`/api/avatar*`、`/api/wellbeing*`、`/api/profile*`、`/avatar/*`）验门后经服务绑定 `ACCOUNT` 转给账号 Worker（`src/router.js` 的转发表 `FORWARDING`）；子站 `styrigx.com/blog/`、`/curio/`、`/daymark/` 的页面按路径前缀由它验会话（`src/gate.js` 的子站关口 `handleSubsite`）（旧图志域名的 301 已于 P4-3 PR-1 删除）；钥匙只有 5 个 `SGX_SPACE_*`（签名钥匙对、`SGX_SPACE_RECOVERY_KEY`、`SGX_SPACE_PASSWORD_PEPPER`、`SGX_SPACE_TEMPKEY_PEPPER`，Secrets Store）；数据在 D1 `styrigx-space-core`（一个绑定 `D1_SPACE`：进站 + 分享链接，一份基线；进站 v3 L2b 从旧库 `styrigx-space-gateway` 搬来，旧库 L3 已删；不绑 KV）。没有任何账号鉴权代码，见 `workers/space-core/README.md` |
| `styrigx-account` | `workers/account/` | 完整的账号系统（账号拆分 PR3；账号命名 v2 起接口按入口拆成 `/api/account/session`、`/reauth`、`/reset`、`/keys`、`/devices`、`/grants`）：账号密码 / 账号通行密钥、已登录设备、账号 session 与 reauth / reset 两张短票、恢复密钥、账号审计 `account_audit`、应用授权记录 `account_grant`（P3-1，账号终端「应用授权」层）（D1 `styrigx-account`，一个绑定 `D1_ACCOUNT`；账号表 `account_*` 由 `migrations/0005_account_tables.sql` 从旧 realm 表搬来），以及头像与个人资料（KV `KV_PROFILE`，只放公开数据：头像 `avatar:*`、个人资料 `profile`，2026-11-07 起 `GET` / `PUT /api/profile`）、设置云同步含主题等外观（同库 `settings_sync`）、数字健康（同库 `wb_daily`）。**没有公开路由**：只经网关的服务绑定 `ACCOUNT`（AccountService，读网关写的身份头）和 `ACCOUNT_VERIFIER`（AccountVerifier，只读授权结论 RPC `authorize()`）进来，默认 fetch 一律 404；钥匙 `SGX_ACCOUNT_PRIVATE` / `SGX_ACCOUNT_PUBLIC`、`SGX_ACCOUNT_RECOVERY_KEY`、`SGX_ACCOUNT_PASSWORD_PEPPER`（账号独占，不再和网关共用 pepper）；不调网关，见 `workers/account/README.md` |
| `styrigx-ai` | `workers/ai/` | 站内对话助手（P4-1；P4-2 并入原 styrigx-chat 的外部模型，接手 search-index 的索引上传）：站内召回（两档：没有账号会话只召回公开条目）+ 模型流式回答（自营 Workers AI 或外部 Gemini，模型登记在 KV `ai:models`）；没有公开地址，只经网关的服务绑定 `AI_SERVICE` 进来（`POST /api/ai` 验同源、进门、两档 AI 限流）；只读 KV `styrigx-search-index` |
| `styrigx-status` | `workers/status/` | 站点监测：cron 每分钟检查主站、规则集、AI（旧图志那项 P4-3 PR-1 删除），每小时读一次 Cloudflare 用量，结果在自己的 D1 `styrigx-status` 的 `status_*` 表（进站 v3 L2b 起）；没有公开地址，只经网关的服务绑定 `STATUS` 进来（`/api/status` 先验会话，设置 → 服务状态页读它） |
| `styrigx-curio-core` | `workers/curio-core/` | 奇趣接口（`styrigx.com/curio/api/*`，D1 + R2；旧图志域名下的旧路由 P4-3 PR-1 删除），2026-11-02 从 styrigx-atlas 搬来，合并 PR3 起由本仓库 CI 部署（在网关之前），见 `workers/curio-core/README.md` |
| `styrigx-daymark-core` | `workers/daymark-core/` | 日刻接口（`styrigx.com/daymark/api/*`，D1；旧图志域名下的旧路由 P4-3 PR-1 删除），同上，见 `workers/daymark-core/README.md` |
| `styrigx-proxy-rules` | `workers/proxy-rules/` | 规则集加速反代：`proxy-rules.styrigx.com`（自定义域名，不过网关），只放行 MetaCubeX/meta-rules-dat 的 geosite/geoip 规则集（`.mrs` `.yaml` `.list`），上游 jsDelivr → raw.githubusercontent，边缘缓存 24 小时 |

路由登记：挂路由的是站点核心和两个子站接口 Worker，各自 `wrangler.toml` 里的 `[[routes]]` 就是登记表（站点核心整站通配（`/s/*`、`/api/share` 也在里面，按路径分），接口 Worker 是更具体的前缀规则，Cloudflare 取最具体的一条）。账号 Worker 没有任何路由（账号拆分 PR3 删掉原来的四条），它的路径归网关的 `styrigx.com/*`，再按网关转发表（`workers/space-core/src/router.js` 的 `FORWARDING`）转过去；`space/scripts/check-layers.mjs` 规则 17 禁止账号 Worker 的 `wrangler.toml` 出现非空 routes。2026-10-21 起各站都是整站通配，网关只有一条 `styrigx.com/*`（旧图志域名那条合并 PR3 起只做 301，P4-3 PR-1 删除）；`styrigx.com/curio/api/*`、`styrigx.com/daymark/api/*` 归本仓库的两个接口 Worker：Cloudflare 不带 `*` 的规则遇到查询串不命中，以前 `styrigx.com/?lock=1&return=…`（锁屏入口）和子站首页带查询串都绕过了网关。静态资源（`/css/` `/js/` `/fonts/` `/fav/` `/images/`、子站静态后缀）进 Worker 后第一行原样回源，不验会话、不打 `X-SGX-Runtime`。
`space/scripts/check-worker-routes.mjs`（CI 跑，匹配规则在 `space/scripts/lib/cf-routes.mjs`，照线上实测）核对：每个 HTML 页面（含带查询串）、锁屏入口、`/api/` 都过网关，账号 Worker 0 条路由、头像 / 云同步 / 数字健康 / `/api/account` 在网关转发表里、`/s/*` 和 `/api/share` 归站点核心的整站路由，且接口 Worker 都没抢走网关路由表里的任何接口，路由不重复，只登记 `styrigx.com` 一个域名，`styrigx.com/daymark/api/*` 归 `styrigx-daymark-core`、`styrigx.com/curio/api/*` 归 `styrigx-curio-core`，子站页面仍归网关。锁屏 / 解锁 / 回跳的完整状态机见 `docs/auth-state-machine.md`。
站点核心、账号和两个子站接口 Worker 的 `wrangler.toml` 由 `check-worker-routes.mjs` 一起核对，不重复、不互抢。

部署顺序（`.github/workflows/deploy.yml`）：ai → status → 账号 → 站点核心 → 奇趣接口 ∥ 日刻接口 → Pages（主站 + 三站同一个 Hugo 站的产物 `space/web/public/`）。进站 v3 L2 起两个接口 Worker 排在站点核心之后：它们的服务绑定 `SPACE` → `SpaceVerifier` 要先在。预览 / 测试资源（KV、D1，以后的 R2）所有 Worker 只用一个 `styrigx-test-preview`（`tests/workers/space-core/preview-resources.test.mjs` 守卫）。

Worker 之间的边界（`space/scripts/check-layers.mjs`，CI 必过）：每个 Worker 只 import 自己目录下的文件，Worker 之间互不 import；没有 `workers/shared` 这类公共目录（2026-10-30 删除，各 Worker 各自一份）；网关源码不许出现账号鉴权标识；账号 Worker 不许有路由；Worker 骨架防回退（规则 18–21）。规则见 `docs/architecture.md`「Worker 边界」和 [`workers/README.md`](workers/README.md)。

安全响应头（2026-10-25）：网关的值在 `workers/space-core/src/lib/security-headers.js`；账号 Worker 一份同值的 `src/lib/security-headers.js`（2026-10-30 起没有 `workers/shared`，单测核对与网关同值），`space/scripts/gen-csp.mjs` 同时生成两份 `csp-hashes.js`（分享链接 L2 起用站点核心那份）。

| 出口 | 加什么 |
|---|---|
| 网关：主站 `styrigx.com` 的页面、锁屏首页、所有跳转、`/api/*` | 全套：HSTS（一年，不带 includeSubDomains）、nosniff、`X-Frame-Options: DENY`、Referrer-Policy、Permissions-Policy、强制 CSP（只有 `frame-ancestors` / `object-src` / `base-uri` / `form-action`）、完整的 `Content-Security-Policy-Report-Only` |
| 账号 Worker；站点核心的分享链接 `/s/<码>`、`/api/share` | 同上（`/s/<码>` 自己的 `Referrer-Policy: no-referrer` 不被覆盖） |
| Pages 静态文件 | `space/web/static/_headers` 的 `/*` 段，同一套，由 `space/scripts/gen-csp.mjs` 生成 |
| Pages `_worker.js` 的 `*.pages.dev` → 301 | 不依赖内容的那几个（HSTS、nosniff、X-Frame-Options、Referrer-Policy、强制 CSP） |
| 网关代理的子站 `styrigx.com/blog/`、`/curio/`、`/daymark/` 页面、跳转和 401 | HSTS（统一覆盖）；nosniff、`X-Frame-Options: DENY`、Referrer-Policy、只有 `frame-ancestors` / `object-src` / `base-uri` 的强制 CSP（图志自己没发才补，已有任何 CSP 就不补）；不加 Permissions-Policy 和 Report-Only，图志内容的完整 CSP 各自审计后再加。图志静态资源直通时只补 HSTS、nosniff |
| `proxy-rules.styrigx.com` | 上游头一律不透传，只留 ETag / Last-Modified，加 nosniff |

Report-Only 里的内联脚本 sha256 由 `space/scripts/gen-csp.mjs` 从生产构建算出（`workers/space-core/src/lib/csp-hashes.js`），CI 在构建后跑 `--check`。改了模板里的内联脚本：`hugo --minify -s space/web && node space/scripts/gen-csp.mjs`。

## tests/ 测试

```
tests/
├─ config/
├─ space/
│  ├─ e2e/<功能>/
│  └─ ui/<功能>/
├─ blog/
├─ curio/
├─ daymark/
├─ workers/
│  ├─ curio-core/
│  ├─ daymark-core/
│  ├─ space-core/
│  ├─ account/
│  ├─ ai/
│  ├─ status/
│  └─ proxy-rules/
└─ fixtures/
```

| 位置 | 是什么 |
|---|---|
| `config/` | `playwright.config.js`、`pw-local.config.js`（本地挑几个 spec 跑，换端口）、`lighthouserc.json`、`stylelintrc.json` |
| `space/e2e/` | 主站 Playwright 页面测试，按功能分子目录：`account/`、`passkey/`（预览站 / 测试服务器真后端）、`lock/`、`space/`、`topbar/`、`layout/`、`edge/`、`visual/`（`visual.spec.js`、`lock.spec.js` 和各自的截图基线 `<spec>-snapshots/`）；`helpers/` 放非 spec 文件（`helpers.js`、`*.cjs`、预览组合入口 `preview-worker.js`）。Playwright 的 `testMatch` 按文件名匹配，换子目录不用改配置 |
| `space/ui/` | 主站前端单元测试（`node --test`），按功能分子目录：`account/`、`passkey/`、`lock/`、`sync/`、`status/`、`space/`、`topbar/`、`shell/`、`theme/`、`layout/`、`build/`、`home/` |
| `blog/`、`curio/`、`daymark/` | 子站测试（从 styrigx-atlas 搬来），三站同一结构：单测在 `tests/<站>/*.test.mjs`、e2e 在 `tests/<站>/e2e/`（blog 的截图基线在 `e2e/blog-visual.spec.js-snapshots/`）、Playwright 配置在 `config/`。sgx-ui 契约夹具不放副本，直接读共享的 `tests/fixtures/ui-cookie-contract.json` |
| `workers/curio-core/`、`workers/daymark-core/` | 子站接口 Worker 单元测试（node:sqlite 真跑 D1 的 SQL） |
| `workers/_harness.mjs`、`_harness.cjs` | 测试台公共件：内存 KV（`makeKV`）、内存认证 D1（`makeAuthD1`，node:sqlite）、`derToPem`、`genKeyPair`、`postReq`；e2e 的 `edge-harness.cjs` / `cred-e2e-helpers.cjs` 也用 `_harness.cjs`，不再各写一份 |
| `workers/space-core/` | 站点核心单元测试（`node --test`；进站、关口、转发、分享链接 `share*.test.mjs`、部署后路由核对 `verify-core-routes.test.mjs`） |
| `workers/account/` | 账号 Worker 单元测试（账号身份、头像、云同步、数字健康、命名入口与身份头、没有公开路由） |
| `workers/ai/` | 站内对话助手单元测试（召回两档、上下文过滤、输入上限、SSE 顺序、断开取消上游；网关那边的门和限流在 `workers/space-core/ai-api.test.mjs`） |
| `workers/status/` | 站点监测单元测试（检查、汇总、用量；有 `node:sqlite` 时跑真 SQL） |
| `workers/proxy-rules/` | 规则集反代单元测试 |
| `fixtures/` | 测试用固定数据（四站共用；`ui-cookie-contract.json` 只此一份，`space/scripts/gen-ui-cookie-contract.mjs` 生成） |

常用命令（都在仓库根目录执行）：

```bash
node --test tests/workers/*/*.test.mjs "tests/space/ui/**/*.test.mjs"
# 构建（CSS + 一次 Hugo：主站和三个子站都在 space/web/public/）
npm run build
npm run test:sites   # 子站单测（要先构建）
npx playwright test --config=tests/blog/config/playwright.config.js   # 子站 e2e 对着 space/web/public（curio / daymark 同理）
npx playwright test --config=tests/config/playwright.config.js
```

## space/scripts/、docs/ 里的子站

| 位置 | 是什么 |
|---|---|
| `space/scripts/` | 基建脚本（全仓共用，CI 调用）：`build-css.cjs`（主站 CSS，顺带三个子站）、`gen-shell.mjs`（共享外壳的派生文件）、`gen-palettes.mjs`、`gen-ui-cookie-contract.mjs`、`gen-csp.mjs`（只算主站页面的内联脚本，子站目录不计）、`build-search-index.mjs`、`check-layers.mjs`、`check-frontend.mjs`、`check-worker-routes.mjs`（读 `space/web/public/`，子站页面在 `/<站>/` 下）、`health-gate.mjs`、`kv-budget.mjs`、`deploy-rollback.mjs`、`migrate-kv-to-d1.mjs`（一次性 KV → D1 导入，单测和预览模拟器还读它）、`lib/`、`ci-local.sh`（本地按 CI 顺序跑） |
| `space/scripts/blog/` | 博客：`build-css.mjs`、`build-search-index.mjs`（KV `site:blog`）、`gen-code-tokens.mjs`、`serve-static.mjs`（模拟 Pages 的静态服务器，子站 e2e 用，默认目录 `space/web/public`） |
| `space/scripts/curio/` | 奇趣：`gen-seed-sql.mjs`（`data/seed.json` → `workers/curio-core/migrations/0002_seed.sql`） |
| `space/scripts/daymark/` | 日刻：`gen-seed-sql.mjs` |
| `docs/blog/`、`docs/curio/STRUCTURE.md`、`docs/daymark/STRUCTURE.md` | 子站文档，原样搬来（里面的路径是合站前的站内相对路径：`web/…` 指合站前的 `atlas/web/<站>/…`，现在按上面的换算表找 `space/web/` 下的 `<目录>/<站>/`；`tests/…` 指 `tests/<站>/…`，`workers/core/` 指 `workers/<站>-core/`） |
