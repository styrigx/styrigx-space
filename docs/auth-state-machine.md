# 四站锁屏 / 解锁 / 回跳 / 管理员验证 / 账号页：状态机（2026-10-21）

唯一状态源是服务端（网关 `styrigx-auth-gateway`）验签过的 cookie。前端只「反映服务端的回答」：
页面里的 `<html data-sgx-lock-session / data-sgx-role / data-sgx-account-session / data-sgx-upgrade>`（网关注入）和
`GET /api/lock-session-check[?return=]` 的 JSON。前端不在 localStorage / sessionStorage / 内存里另存「已解锁 / 已锁定」。

## 1. cookie

| 名字 | 谁签 | 作用域 | 属性 | 寿命 | 用途 |
|---|---|---|---|---|---|
| `sgx-lock-session` | 网关（SGX_LOCK_PRIVATE） | `Domain=.styrigx.com; Path=/` | HttpOnly, Secure, SameSite=Lax | admin 12 h / visitor 按临时钥匙剩余时间（上限 12 h） | LockSessionTicket `by.role.epoch.exp.tempkeyId.sig`（签名串带 `sgx-lock-session\|` 前缀）；主站和 blog / daymark / curio 共用；role = `admin` / `visitor`；by = password / passkey / tempkey；admin 的 tempkeyId 为空串，visitor 必须带一把未作废的临时钥匙 id；epoch ≠ Lock 纪元即失效 |
| （同名清除） | 网关 | host-only `Path=/` | Max-Age=0 | — | 每次签发 / 清除都附带，清掉 host-only 同名 cookie |
| `sgx-lock-reset` | 网关（SGX_LOCK_PRIVATE） | host-only styrigx.com | HttpOnly, Secure, SameSite=Strict | 180 s，不续期 | LockResetTicket `by.epoch.iat.exp.sig`：重置锁屏；by = root / account |
| `sgx-lock-reauth` | 网关（SGX_LOCK_PRIVATE） | host-only styrigx.com | HttpOnly, Secure, SameSite=Strict | 180 s，不续期 | LockReauthTicket `by.epoch.iat.exp.sig`：进「锁屏凭证」页前再验一次；by = password / passkey / root |
| `sgx-account-session` | 网关（SGX_ACCOUNT_PRIVATE） | host-only styrigx.com | HttpOnly, Secure, SameSite=Strict | 400 天 | AccountSessionTicket `by.epoch.authAt.exp.deviceId.sig`：账号会话（与锁屏会话无关）；by = password / passkey；Account 纪元变了或设备被单独退出即失效 |
| `sgx-account-reset` | 网关（SGX_ACCOUNT_PRIVATE） | host-only styrigx.com | HttpOnly, Secure, SameSite=Strict | 180 s，不续期 | AccountResetTicket `by.epoch.iat.exp.sig`：重置账号登录方式；by = root |
| `sgx-account-reauth` | 网关（SGX_ACCOUNT_PRIVATE） | host-only styrigx.com | HttpOnly, Secure, SameSite=Strict | 180 s，不续期 | AccountReauthTicket `by.epoch.iat.exp.sig`：进「账号安全」页前再验一次；by = password / passkey / root |
| `sgx-ui` | 主站 JS | `Domain=styrigx.com` | Secure, SameSite=Lax（非 HttpOnly） | 400 天 | 只有外观设置，子站读；不含任何会话信息 |

六张票的总表在 `workers/auth-gateway/functions/_kernel/realms.js`（`TICKETS`）。签名串一律是 `<cookie 名>|<票内容>`，
同一把私钥签的票互相冒充不了。Lock 三张票共用 Lock 纪元，Account 三张票共用 Account 纪元。
RootKey 不拥有会话：`/api/root-auth { key, purpose }` 的 purpose 只有 `lock-reauth` / `lock-reset` / `account-reauth` / `account-reset`，
各签一张对应的短票（by=root）；LockSessionTicket 的 by 永远没有 root。

立即锁定 = `POST /api/lock-now` 清 `sgx-lock-session`（两条）+ `sgx-lock-reauth` + `sgx-lock-reset`。锁定所有设备 = Lock 纪元 +1。

## 2. 路由（谁处理请求）

`styrigx.com/*`、`blog.styrigx.com/*`、`daymark.styrigx.com/*`、`curio.styrigx.com/*` 全进网关；`daymark.styrigx.com/api/*` 归 `styrigx-daymark-core`、
`curio.styrigx.com/api/*` 归 `styrigx-curio-core`（更具体），两站的 `/api/lock-session-check` 又比它更具体，归网关。
静态资源（主站 `/css/ /js/ /fonts/ /fav/ /images/`，子站静态后缀和 `/manifest.json` 等）第一行原样回源，不验会话、不打 `X-SGX-Runtime`。

Cloudflare 路由规则：不带 `*` 的规则要求整条 URL（含查询串）完全相等；带查询串就不命中（2026-10-21 线上实测，`scripts/lib/cf-routes.mjs`）。

## 3. 网关的判定（页面）

主站（`functions/_middleware.js`）：

| 会话 | 路径 | 结果 |
|---|---|---|
| 无效 | 首页 `/`、`/en/`（任意查询串） | 200，`data-sgx-lock-session="locked"`，桌面（`SGX-DESKTOP` 标记之间）剥掉，no-store |
| 无效 | 其他页面 | 302 `/?lock=1&return=<站内路径>` |
| 无效 | `/api/*` 白名单外 | 401 JSON |
| 有效 | 首页 + `return`、无 `why` | 302 到 `resolveReturn(return)`；访客 + 管理员专属页 → 200 `data-sgx-upgrade="1"`（管理员验证层，不出锁屏） |
| 有效 | 首页 + `why`（子站踢回） | 200 valid（不 302，防两站来回跳；前端问 session-check 拿 next，20 秒窗口防死循环） |
| 访客 | 锁屏凭证页 `/settings/security/lock/` | 302 `/?return=<该页>`（管理员验证，不带 `lock=1`） |
| 有效 | 其他页面 | 200 valid + role，no-store；账号页另注入 `data-sgx-account-session="in|out"`（in 时登录区整段不下发） |

子站（`src/subsites.js`）：有效 → 回源 + no-store；无效 → 302 `https://styrigx.com/?lock=1&why=<no-cookie|invalid-session>&return=<完整地址>`；
`/api/lock-session-check` blog 204 / daymark、curio 200 / 无效 401。

`resolveReturn(return, role)`（唯一实现，首页 302 和 session-check 共用）：站内路径（不许 `//`、`/\`、`/lock/`）或 `https://*.styrigx.com`
（无用户名密码、无反斜杠、不含已下线子站），否则回首页；已登录 + 门内页 → 安全与隐私总览；访客 + 管理员专属页 → upgrade。

## 4. 前端状态机（`web/assets/js/shell/lock-guard.js` 判定 + `shell/lock.js` 锁屏界面，按需加载）

页面状态 `pageState()` = `data-sgx-lock-session`：`valid` / `locked` / `lock-reset` / `unknown`（没有属性 = 页面没经过网关）。

```
            ┌──────────── unknown / locked ─────────────┐
 page load ─┤  画锁屏（fail closed）+ 立刻 askServer()   │
            │  ok → proceed()      401 → 保持锁屏        │
            │  解锁（密码 / 通行密钥 / 访客）→ askServer │
            │  切回前台 / focus / bfcache → askServer    │
            └───────────────────────────────────────────┘
            ┌──────────── valid ─────────────────────────┐
            │  不画锁屏；带 why+return → askServer→proceed│
            │  切回前台 / focus / bfcache / 转屏：        │
            │  session-check 401 → 重载（服务端画锁屏）   │
            └───────────────────────────────────────────┘
            lockreset：不画锁屏（重置流程落地页）
```

`proceed(answer)`：
- `upgrade` → `/?return=<next>`（服务端给管理员验证层）
- `next` 是别处 → `location.replace(next)`（带 `why` 时先过 20 秒同 target 防死循环，触发则出失败卡）
- 无 `next`：页面是 `locked`（瘦身过）→ 换到去掉 `lock/why/return` 的地址重新取（10 秒同地址只一次）；`valid` / `unknown` → 原地开锁并改地址栏

永不「重载同一个锁屏地址等服务端 302」。

管理员验证（访客 → 管理员，`shell/upgrade.js`）是独立的一态：就地弹层，只有通行密钥 / 密码（根凭证兜底），没有访客入口；
不出锁屏、不跳页；取消不调任何接口（访客会话保留）；通过 → 服务端签 admin 锁屏会话 → 跳目标页。
入口：安全与隐私页里访客点「锁屏凭证」（`apps/security.js`）、服务端 upgrade 页（`data-sgx-upgrade`）。

账号页（`apps/account.js`）：登录区、总览默认都隐藏；网关注入 `data-sgx-account-session`：`in` → 登录区不下发、总览首帧可见；
`out` → 登录区首帧可见；没有属性 → 中性，等 `/api/account`。只有服务端说「未登录」才出现「欢迎回来」。

不预渲染：站内链接不再用 Speculation Rules prerender（预渲染启用的是按下那一刻的会话状态快照）。

## 5. 测试

- 单测：`tests/workers/auth-gateway/auth-flow-2026-10-21.test.mjs`
- 端到端：`SGX_TEST_SUITE=edge`（`tests/web/e2e/edge-flow.spec.js` + `edge-harness.cjs`）：真实网关代码 + wrangler.toml 路由 + 线上匹配规则 +
  真实域名（本地 HTTPS 代理）+ CDP 虚拟认证器 + 假 Turnstile
- 锁屏套件：`SGX_TEST_SUITE=lock`（http-server + mock，覆盖界面细节）
