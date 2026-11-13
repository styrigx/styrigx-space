# 系统总览

> 已被 v6 定稿取代（见 `docs/decisions/ADR-0006-identity-v6.md`）。

| 项 | 值 |
|---|---|
| 文档编号 | SGX-ARCH-001 |
| 版本 | 2.2 |
| 日期 | 2026-11-11 |
| 状态 | 现行 |
| 取代 | `docs/architecture.md`（2026-11-06） |

## 1. 范围

本文描述 `styrigx.com` 的运行时结构：一次请求经过哪些组件、每个 Worker 管什么、前端代码怎样分层，以及 CI 守住的边界规则。目录结构见 SGX-ARCH-002，cookie 与状态机见 SGX-SPEC-001，安全模型见 SGX-SEC-001。

## 2. 模型

2.1 主站（`/`）相当于操作系统的桌面与系统设置；子站 `/blog/`、`/curio/`、`/daymark/` 相当于其中的应用。进站属于系统层：v5 起页面对所有人公开，进站会话只管 AI、听歌、监控三处部件与要进站的接口（ADR-0005）。

2.2 **门归网站，账号管授权**。「能不能进来」只由进站会话回答；「能不能写、能不能读私密内容」只由账号 Worker 回答。两者是两套独立的票据（SGX-SEC-001）。

2.3 **唯一状态源**。是否已进站，只由站点核心签发并验签的 `sgx-space-session`（`Domain=.styrigx.com; Path=/`）决定。任何站点、任何页面 MUST NOT 用 sessionStorage、localStorage、前端内存或标签页状态另做判断（`space/scripts/check-layers.mjs` 规则 7–9）。

## 3. 请求路径

```
浏览器
  │  https://styrigx.com/*
  ▼
styrigx-space-core（路由 styrigx.com/*）
  ├─ 静态资源（/css/ /js/ /fonts/ /fav/ /images/、子站静态后缀）→ 原样回源 Pages
  ├─ /api/csp-report → 只记日志，204
  ├─ /s/<码>、/api/share → 分享链接
  ├─ 子站页面 /blog/ /curio/ /daymark/ → handleSubsite：页面公开，注入 data-sgx-lock-session → 回源 Pages
  ├─ 主站页面 → onRequest：页面公开，注入 data-sgx-lock-session、no-store → 回源 Pages
  └─ /api/*
       ├─ 访问表 ROUTE_ACCESS（gate.js）：公开清单之外一律要进站会话，否则 401
       ├─ API_ROUTES（进站凭证、分享、find、geo、status、ai …）→ 本 Worker 处理
       ├─ FORWARDING（/api/account* /api/prefs* /api/avatar* /api/profile*、/avatar/*）
       │     → 服务绑定 ACCOUNT（AccountService）→ styrigx-account
       ├─ /api/ai → 服务绑定 AI_SERVICE → styrigx-ai（SSE 原样流回）
       └─ /api/status → 服务绑定 STATUS → styrigx-status

styrigx.com/curio/api/*   → styrigx-curio-core   ─┐ 服务绑定 SPACE（SpaceVerifier）
styrigx.com/daymark/api/* → styrigx-daymark-core ─┘ 回问站点核心：进站会话 + 账号结论
proxy-rules.styrigx.com   → styrigx-proxy-rules（自定义域名，不经站点核心）
```

3.1 Cloudflare 按最具体的路由匹配：`styrigx.com/curio/api/*`、`styrigx.com/daymark/api/*` 归接口 Worker，其余 `styrigx.com/*` 都归站点核心。不带 `*` 的路由遇到查询串不命中，所以站点核心 MUST 使用整站通配路由（`space/scripts/lib/cf-routes.mjs` 按线上实测建模，`check-worker-routes.mjs` 在 CI 核对）。

3.2 Pages 项目 `styrigx-space` 只放静态文件，生产环境 MUST NOT 持有任何变量、绑定或钥匙（`space/web/wrangler.toml`）。

3.3 账号 Worker MUST NOT 有路由（`check-layers.mjs` 规则 17）；它的路径归站点核心，经转发表 `workers/space-core/src/router.js` 的 `FORWARDING` 进入。

## 4. Worker 分工

| Worker | 管什么 | 进入方式 |
|---|---|---|
| `styrigx-space-core` | 进站会话、进站凭证、reauth / reset 票、分享链接（含链接会话）、关键词搜索 `/api/find`、访问表与接口路由转发、安全响应头、CSP 报告 | 路由 `styrigx.com/*` |
| `styrigx-account` | 账号密码 / 通行密钥、账号 session / reauth / reset、已登录设备、应用授权、头像与个人资料、设置云同步（数字健康 v6 P4 删除） | 服务绑定 `ACCOUNT`（AccountService）、`ACCOUNT_VERIFIER`（AccountVerifier.authorize）、`JOB_ACCOUNT`（AccountJanitor，status 每日一轮） |
| `styrigx-ai` | 站内对话：召回（关键词 + Vectorize 语义 + 奇趣只读查询）+ 模型流式回答 | 服务绑定 `AI_SERVICE` |
| `styrigx-status` | 站点监测（每分钟）、Cloudflare 用量（每小时）、每日任务（经服务绑定 `JOB_SPACE` 清理过期 / 作废的分享链接；`JOB_ACCOUNT` 删到期满 30 天的用户，v6 P2c） | 服务绑定 `STATUS` |
| `styrigx-curio-core` | 奇趣数据接口 | 路由 `styrigx.com/curio/api/*` |
| `styrigx-daymark-core` | 日刻数据接口 | 路由 `styrigx.com/daymark/api/*` |
| `styrigx-proxy-rules` | 规则集加速反代（来源：MetaCubeX/meta-rules-dat、自有仓 styrigx/mihomo-rules release）+ 代理订阅（`/s/<令牌>/<来源名>`，age 加密；管理经 account `/api/account/proxy` → 服务绑定 ProxyAdmin） | 自定义域名 `proxy-rules.styrigx.com` |

绑定、数据库与 Secret 名见 SGX-OPS-002；每个 Worker 的细节见 `workers/<名字>/README.md`。

## 5. 后端分层（站点核心）

| 层 | 位置 | 职责 |
|---|---|---|
| 入口 | `src/index.js` → `src/app.js`、`src/rpc/*` | 只接线；`SpaceVerifier` 是给接口 Worker 的 RPC 入口 |
| 路由 | `src/router.js` | `API_ROUTES`、`FORWARDING`、`routeShare` |
| 关口（L1） | `src/gate.js` | 访问表 `ROUTE_ACCESS` 与放行函数 `admit`：判断「要不要进站会话」的唯一位置；主站 `onRequest`、子站 `handleSubsite`、分享链接共用，都调 L0 的同一个 `verifyLockSession` |
| 接口（L2） | `src/api/*.js` | 一个接口一个文件；可以按需再验（如 reauth 票），但 MUST 使用 `core/` 的同一份实现 |
| 内核（L0） | `src/core/` | 票据、会话、凭证、限流、分享链接与链接会话、账号 RPC |
| 通用件 | `src/lib/` | crypto、cookies、http、security-headers、csp-hashes |

5.1 依赖 MUST 沿 `index → app/rpc → router → gate → api → core → lib` 单向进行，可以跳层，不可反向。Worker 内部方向不进 CI，靠评审守住；骨架契约见 `workers/README.md`。

5.2 关口规则（`src/gate.js`，v5 S3 整站放开）：
- 页面与静态文件一律公开，注入 `<html data-sgx-lock-session="valid|locked">`（两态内容相同），HTML 带 `Cache-Control: private, no-store`。
- `/api/*` 只有访问表里逐条写出的「方法 + 路径」公开；其余一律要进站会话，没有回 401 JSON（fail closed，精确匹配，从不按前缀）。表在 `tests/workers/space-core/route-access.test.mjs` 里整张快照。
- 首页带 `return` 且会话有效时 302 到 `resolveReturn(return)`；其余情况不跳转。

## 6. 前端分层

前端代码在 `space/web/assets/shell/js/`，四站共用。

| 层 | 目录 | 允许 import |
|---|---|---|
| lib | `lib/` | `lib/` |
| auth | `auth/`（`passkey-assert.js`、`passkey-register.js`、`post-json.js`） | `lib/`、`auth/` |
| shell | `shell/`（含 `term/` 终端引擎与命令表、`shell/space/` 钥匙层、`account/` 账号层与账号窗口） | `lib/`、`auth/`、`shell/` |
| apps | `apps/` | 以上全部，`apps/` |
| entries | `entries/` | 以上全部 |

6.1 只能向左 import；前端 MUST NOT import `space/web/assets/shell/js/` 以外的文件（`check-layers.mjs` 规则 1–5）。

6.2 `lib/` MUST NOT 含鉴权逻辑：不得出现 `/api/lock-*`、`/api/space-*`、`/api/account` 与 `navigator.credentials`（规则 6）。

6.3 进站守卫 `auth/guard.js` 在每页的 core chunk 里，只读网关注入的 `data-sgx-lock-session`：`valid` 时绑自动回锁（切回前台问服务端，401 → 重载）；不盖遮罩、没有锁屏界面。进站在顶栏终端里 `sudo styrigx`（钥匙层 `shell/space/layer.js`，ADR-0005）；上锁部件与接口 401 派发 `sgx:sudo`，`topbar/topbar-panel.js` 打开终端预填。

6.4 进站与账号的接口调用各只有一处：`shell/space/api.js`（地址表 `shell/space/paths.js`）、`account/api.js`。

6.5 打包：所有入口在 `layouts/partials/shell/sgx-js-batch.html` 里一次 `js.Batch`（esbuild ESM + 代码分割）；首帧前必须执行的主题、语言、布局、提示符脚本是 `<head>` 里的同步内联脚本，其 sha256 进 CSP（`space/scripts/gen-csp.mjs`）。

## 7. Worker 边界（`space/scripts/check-layers.mjs`，CI 必过）

| 规则 | 要求 |
|---|---|
| 14 | 每个 Worker MUST 只相对 import 自己目录下的文件；非相对 import 只认 `cloudflare:workers` |
| 15 | MUST NOT 存在 `workers/shared` |
| 16 | 站点核心源码（去注释）MUST NOT 出现账号鉴权标识（`SGX_ACCOUNT_*`、`D1_ACCOUNT`、账号票名等，完整列表见脚本 `GATEWAY_ACCOUNT_AUTH_RE`） |
| 17 | 账号 Worker 的 `wrangler.toml` MUST NOT 有路由 |
| 18–21 | Worker 骨架防回退：无 `functions/`、`_kernel/`；`main = "src/index.js"`；有 `README.md`；`package.json` 有 `name` |
| 22 | 退役名单 `space/scripts/retired-names.json` 里的账号旧名 MUST NOT 出现在账号 Worker 与账号前端（含注释） |

## 8. 网关结论（授权）

8.1 站点核心只验门；需要授权结论时经 `ACCOUNT_VERIFIER.authorize()` 问账号 Worker（`workers/account/src/core/authorize.js`），再把结论交给下游。账号 Worker 不调站点核心，站点核心不读账号库。

8.2 HTTP 下游（`styrigx-account`、`styrigx-ai`）收到的身份头。站点核心在 fetch 第一步 MUST 剥掉全部入站 `x-styrigx-*`、`x-sgx-*` 头，再按验证结果重写，只写白名单值，没有就不写：

| 头 | 值 | 写给 |
|---|---|---|
| `X-Styrigx-Space-Session` | `1` | 账号 Worker |
| `X-Styrigx-Space-By` | `password` \| `passkey` \| `link` | 账号 Worker（只作审计） |
| `X-Styrigx-Space-Link-Id` | 分享链接 id | 账号 Worker（只在 by=link 时，只作审计） |
| `X-Styrigx-Account-Session` / `-Device` / `-Scopes` / `-Reauth` | `1` / 设备 id / 作用域 / `1` | 只写给 `styrigx-ai` |
| `X-Styrigx-Client-Address` / `-Country` / `-City` | — | 客户端上下文 |

8.3 RPC 下游（接口 Worker）调 `SpaceVerifier.conclusion(cookie, clientContext, opts)`，得到 `{ space: { ok, by, linkId, reason }, account: { ok, deviceId, scopes, reauth, reason } }`；`space.ok=false` 时不问账号；账号绑定缺失或 RPC 出错 → `account.ok=false`。

8.4 作用域表（`workers/account/src/core/scopes.js`，数据在 `account_grant`）：

| 作用域 | 应用 | 取消后 |
|---|---|---|
| `curio.write` | 奇趣 | 写接口 403 `scope`；读不变 |
| `daymark.write` | 日刻 | 同上 |
| `prefs.sync` | 设置同步 | `/api/prefs` 403 `scope`，只存本机 |
| `avatar.write` | 头像 | `PUT` / `DELETE /api/avatar` 403 `scope` |
| `profile.write` | 个人资料 | `PUT /api/profile` 403 `scope` |

## 9. 一致性规则

9.1 主站与子站的任意页面 MUST 对所有人返回同一份内容；没有进站会话时，只有三处上锁部件（AI 窗口、听歌播放、状态页监控卡）与要进站的接口不可用，它们 MUST 由服务端拒绝（401），前端遮罩只是外观。

9.2 有效时，四站上锁部件与接口 MUST 直接可用；新标签页、刷新不再要求进站。

9.3 同一浏览器同一时刻 MUST NOT 出现一个站认为已进站、另一个站认为未进站的情况（四站同一个 cookie、同一份验签）。

9.4 会话过期时间对所有站点一致，由站点核心签发时决定；子站只验签，不延长。

## 10. 安全响应头

10.1 值在 `workers/space-core/src/lib/security-headers.js`；账号 Worker 有一份同值副本（单测核对）。Pages 静态文件的同一套头写在 `space/web/static/_headers`，由 `gen-csp.mjs` 生成。

10.2 强制 CSP 只含 `frame-ancestors`、`object-src`、`base-uri`、`form-action`；完整 CSP 以 `Content-Security-Policy-Report-Only` 下发，报告送 `POST /api/csp-report`（`core/csp-report.js`：只 `console.log`，回 204，正文超 16 KB 丢弃，一次最多记 5 条）。

10.3 子站页面经站点核心代理时只补 HSTS、nosniff、`X-Frame-Options`、Referrer-Policy 和最小强制 CSP；不加 Report-Only。
