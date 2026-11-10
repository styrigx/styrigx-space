# 进站 / 锁屏 / 回跳状态机

| 项 | 值 |
|---|---|
| 文档编号 | SGX-SPEC-001 |
| 版本 | 2.0 |
| 日期 | 2026-11-09 |
| 状态 | 现行 |
| 取代 | `docs/auth-state-machine.md`（2026-11-06） |

## 1. 范围

本规范定义四站（主站、博客、奇趣、日刻）的进站状态如何产生、如何判定、前端如何反映，以及全部会话类 cookie。安全语义（哪些操作要 reauth）见 SGX-SEC-001；接口返回口径见 SGX-SPEC-002。

## 2. 总则

2.1 唯一状态源是站点核心（`styrigx-space-core`）验签过的 cookie。前端只反映服务端的回答：网关注入的 `<html data-sgx-lock-session>` 与 `GET /api/lock-session-check[?return=]` 的 JSON。

2.2 前端 MUST NOT 在 localStorage、sessionStorage 或内存里另存「已进站 / 已锁定」。

2.3 进门是二值的：有效进站会话 = 已进站，没有等级、没有角色。by（进门方式）只用于审计与展示。

2.4 任何不确定的状态 MUST 按「锁定」处理（fail closed）。

## 3. Cookie

| 名字 | 签发方 | 作用域 | 属性 | 寿命 | 内容与用途 |
|---|---|---|---|---|---|
| `sgx-space-session` | 站点核心（`SGX_SPACE_PRIVATE`） | `Domain=.styrigx.com; Path=/` | HttpOnly, Secure, SameSite=Lax | 解锁密码 / 通行密钥 12 h；临时钥匙 min(钥匙剩余, 12 h)；分享链接 min(链接会话档位, 钥匙剩余)，档位 30 min / 1 h / 3 h / 12 h / 1 d / 3 d / 7 d | LockSessionTicket `by.epoch.exp.tempkeyId.sig`；by ∈ `password` / `passkey` / `tempkey`（分享链接也记为 `tempkey`）；by=tempkey 时带钥匙 id，其余为空串 |
| （同名清除） | 站点核心 | host-only `Path=/` | Max-Age=0 | — | 每次签发 / 清除都附带，清掉历史上的 host-only 同名 cookie |
| `sgx-space-reauth` | 站点核心 | host-only | HttpOnly, Secure, SameSite=Strict | 180 s，不续期 | LockReauthTicket `by.epoch.iat.exp.sig`；只能由解锁密码 / 通行密钥签出（`/api/lock-password`、`/api/lock-passkey` 带 `reauth:true`，要求已进站） |
| `sgx-space-reset` | 站点核心 | host-only | HttpOnly, Secure, SameSite=Strict | 180 s，不续期 | LockResetTicket `by.epoch.iat.exp.sig`；由恢复钥匙经 `/api/lock-reset { verify }` 签出，by=`space` |
| `sgx-account-session` | 账号 Worker（`SGX_ACCOUNT_PRIVATE`） | host-only | HttpOnly, Secure, SameSite=Strict | 30 d，滑动续期（剩不到 15 d 时重签） | `by.epoch.authAt.exp.deviceId.sig`；见 SGX-SEC-001 |
| `sgx-account-reauth` | 账号 Worker | host-only | HttpOnly, Secure, SameSite=Strict | 180 s | `by.epoch.iat.exp.deviceId.sig`；只在同一设备的账号会话有效时算数 |
| `sgx-account-reset` | 账号 Worker | host-only | HttpOnly, Secure, SameSite=Strict | 180 s | `by.epoch.iat.exp.sig`，by=`recovery-key`；`finish` 后作废 |
| `sgx-account-signed-in` | 账号 Worker | host-only | Secure, SameSite=Strict，非 HttpOnly | 同账号会话 | 值恒为 `1`，只给首帧选提示符；服务端 MUST NOT 读取 |
| `sgx-ui` | 主站 / 子站 JS | `Domain=styrigx.com` | Secure, SameSite=Lax，非 HttpOnly | 400 d | 外观设置，不含会话信息；见 SGX-SPEC-003 |

3.1 签名串一律为 `<cookie 名>|<票内容>`（Ed25519）。同一把私钥签的不同票互相冒充不了。

3.2 进站侧三张票共用进站纪元（`lock-epoch`，D1 `epoch` 表）；票内纪元与库中不等即失效。每次验票 MUST 读 D1 主库，不缓存。

3.3 by=tempkey 的会话在每次验证时查钥匙是否已作废；作废后下一个请求即失效。

3.4 票表在 `workers/space-core/src/core/realms.js`（`TICKETS`）与 `workers/account/src/core/config.js`（`TICKET`）。站点核心 MUST NOT 签发或验证账号票。

## 4. 路由与关口

4.1 站点核心只登记 `styrigx.com/*`；`/curio/api/*`、`/daymark/api/*` 归接口 Worker。子站页面也归站点核心（`gate.js` 的 `handleSubsite`，只注入会话标记，不拦）。

4.2 静态资源（主站 `/css/ /js/ /fonts/ /fav/ /images/`，子站前缀下的静态后缀）第一行原样回源，不验会话。

4.3 访问判定（v5 S3 整站放开）：`gate.js` 的 `ROUTE_ACCESS` 是站点核心唯一决定「要不要进站会话」的地方，主站（`onRequest`）与子站页面（`handleSubsite`）共用同一个放行函数 `admit`。规则：
- 页面与静态文件（不在 `/api/`、`/<子站>/api/` 下）一律公开：200，网关注入 `data-sgx-lock-session="valid|locked"`，两态页面内容相同，no-store。不再 302 去锁屏、不再剥掉桌面内容、没有路径白名单。
- `/api/*`：只有表里逐条写出的「方法 + 路径」公开（锁屏进站要用的接口、`/s/:code`、`/api/geo`、`/api/wellbeing` 合计等）；其余一律要进站会话，没有即 401 JSON（fail closed，精确匹配，从不按前缀）。
- 表在 `tests/workers/space-core/route-access.test.mjs` 里整张快照，改表即改谁能不进站调接口。
- 子站接口（`/curio/api/*`、`/daymark/api/*`）归各自 Worker，各有自己的 `ROUTE_ACCESS`（`src/routes.js`）。

4.4 首页带 `return` 且会话有效时仍 302 到 `resolveReturn(return)`（解锁后回原页）；其余情况不跳转。旧地址里的 `why`（S3 前子站踢回带的）前端读到即从地址栏去掉。

4.5 上锁的只剩三处部件（页面本身公开）：旷野状态卡（`/api/status` 要进站）、奇趣音乐的播放（歌单公开且不含音频地址，播放令牌 / 音频流要进站）、AI 窗口。这些地方（以及任何接口回 401 没进站）都只派发 `document` 上的 `sgx:sudo` 事件（`lib/sudo.js`），`shell/topbar-panel.js` 接住：打开顶栏终端并预填 `sudo styrigx`；回车后去主站带 `?entry` 的地址打开锁屏。解锁后页面重新取一次（访客态 → valid）。

4.6 `resolveReturn(return)` 是回跳地址的唯一实现（首页 302 与 session-check 共用）：只接受站内路径（不许 `//`、`/\`、`/lock/`）或 `https://*.styrigx.com`（无用户名密码、无反斜杠、不含已下线子域），否则回首页。

## 5. 前端状态机

页面状态取自 `data-sgx-lock-session`：`valid` / `locked` / `lock-reset`；没有该属性 = `unknown`（页面没经过站点核心）。

```
            ┌──────────── unknown / locked ─────────────────────┐
 page load ─┤  不盖遮罩，页面照常可看；上锁的部件自己画成锁       │
            │  地址带 ?entry（旧 ?lock 兼容读一版）才 import 锁屏   │
            │  sudo styrigx 成功 → askServer() → proceed()          │
            └──────────────────────────────────────────────────────┘
            ┌──────────── valid ───────────────────────────────────┐
            │  不画锁屏；绑自动回锁：                                │
            │  切回前台 / focus / bfcache / 转屏：                    │
            │  lock-session-check 401 → 重载（服务端画访客态）        │
            └──────────────────────────────────────────────────────┘
```

5.1 `askServer()` = `GET /api/lock-session-check[?return=]`；`proceed(answer)`：`next` 是别处 → `location.replace(next)`；无 `next` 且页面是 `locked` → 换到去掉 `entry/lock/why/return` 的地址重新取（10 秒内同地址一次）；`valid` / `unknown` → 原地开锁并改地址栏。前端 MUST NOT 「重载同一个锁屏地址等服务端 302」。

5.2 实现：`space/web/assets/js/shell/space/guard.js`（判定，在每页 core chunk 中）、`entry.js` / `term.js`（锁屏终端）、`reset.js`（reset 终端）。

5.3 子站不加载守卫（v5 S3 删除了子站的 `sgx-lock-sync.js` / `sgx-lock-check.js` 与踢回防循环）：子站页面本身公开，没进站的写 / 播放由接口回 401，前端发 `sgx:sudo`。

## 6. 锁屏终端（`entry@space:~$`）

6.1 命令：`sudo styrigx` 列出已设置的方式（`[1] passkey` `[2] password`；`tempkey` 始终可选）；`sudo styrigx passkey|password|tempkey` 直接进入对应方式；`sudo styrigx reset` 进入恢复流程；`help`、`clear`。其他输入回 `command not found`。

6.2 一轮最多错 3 次（`sudo: 3 incorrect password attempts`）；取消系统通行密钥窗口回到选择；触屏 `^C` 回命令行。服务端限速：解锁密码每连错 5 次冷却一轮（30 秒起逐轮翻倍，封顶 1 小时，429 `cooldown`）。

6.3 `sudo styrigx reset` → `[sudo] recovery key:`（不回显）→ 对了进入 reset 终端 `reset@space:~#`：`passwd`（设解锁密码）、`passkey ls|add|rm <n>`。reset 票下的写不推纪元；第一次改动后询问其他设备：`all`（所有设备回锁屏，推纪元）或 `none`（不动），即 `/api/lock-reset { finish, signOut }`。reset MUST NOT 签发进站会话。

6.4 立即锁屏 = `POST /api/lock-now`：清本机 `sgx-space-session`（两条）、`sgx-space-reauth`、`sgx-space-reset`；幂等，不需要验证。所有设备回锁屏 = `POST /api/lock-all-devices`（要 reauth）：进站纪元 +1 并清本机 cookie。

## 7. 预渲染

站内链接 MUST NOT 使用 Speculation Rules prerender：预渲染页面看到的是按下那一刻的会话快照。

## 8. 测试

| 层 | 位置 |
|---|---|
| 单测 | `tests/workers/space-core/*.test.mjs`（`auth-flow-2026-10-21.test.mjs`、`verifier.test.mjs` 等）、`tests/space/ui/lock/` |
| 端到端（锁屏套件） | `SGX_TEST_SUITE=lock`：静态服务器 + mock 接口，覆盖界面细节 |
| 端到端（edge 套件） | `SGX_TEST_SUITE=edge`（`tests/space/e2e/edge/`）：真实站点核心与账号 Worker 代码、wrangler 路由、线上匹配规则、本地 HTTPS 代理与 CDP 虚拟认证器 |
| passkey-e2e | CI 单独 job：预览环境真后端 |
