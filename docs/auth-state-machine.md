# 四站锁屏 / 解锁 / 回跳 / 复验 / 账号页：状态机（2026-10-21）

> 状态：现行 ｜ 最后更新：2026-11-06

唯一状态源是服务端（网关 `styrigx-auth-gateway`）验签过的 cookie。前端只「反映服务端的回答」：
页面里的 `<html data-sgx-lock-session / data-sgx-account-session>`（网关注入；进门二值，P2-3 起没有等级标记）和
`GET /api/lock-session-check[?return=]` 的 JSON。前端不在 localStorage / sessionStorage / 内存里另存「已解锁 / 已锁定」。

## 1. cookie

| 名字 | 谁签 | 作用域 | 属性 | 寿命 | 用途 |
|---|---|---|---|---|---|
| `sgx-lock-session` | 网关（SGX_LOCK_PRIVATE） | `Domain=.styrigx.com; Path=/` | HttpOnly, Secure, SameSite=Lax | 锁屏密码 / 通行密钥进门 12 h；临时钥匙（含分享短链）进门按钥匙剩余时间（上限 12 h） | LockSessionTicket v2 `by.epoch.exp.tempkeyId.sig`（签名串带 `sgx-lock-session\|` 前缀）；主站和 blog / daymark / curio 共用；票里没有等级，有效就是进门了；by = password / passkey / tempkey，只作审计；by=tempkey 时带一把未作废的临时钥匙 id，其余为空串；epoch ≠ Lock 纪元即失效；v1 的 6 段票一律 bad-format（上线即作废） |
| （同名清除） | 网关 | host-only `Path=/` | Max-Age=0 | — | 每次签发 / 清除都附带，清掉 host-only 同名 cookie |
| `sgx-lock-reset` | 网关（SGX_LOCK_PRIVATE） | host-only styrigx.com | HttpOnly, Secure, SameSite=Strict | 180 s，不续期 | LockResetTicket `by.epoch.iat.exp.sig`：重置锁屏；by = space / password / passkey（进站凭证 + 恢复开关，或进站凭证 + 锁屏凭证） |
| `sgx-lock-reauth` | 网关（SGX_LOCK_PRIVATE） | host-only styrigx.com | HttpOnly, Secure, SameSite=Strict | 180 s，不续期 | LockReauthTicket `by.epoch.iat.exp.sig`：锁侧复验——进「锁屏凭证」页、新建 / 作废临时钥匙、生成 / 作废分享短链前再验一次；by = password / passkey / space（临时钥匙、短链进门的会话本身不算复验） |
| `sgx-account-session` | 账号 Worker（SGX_ACCOUNT_PRIVATE） | host-only styrigx.com | HttpOnly, Secure, SameSite=Strict | 400 天 | AccountSessionTicket `by.epoch.authAt.exp.deviceId.sig`：账号会话（与进站会话无关）；by = password / passkey；Account 纪元变了或设备被单独退出即失效 |
| `sgx-account-reset` | 账号 Worker（SGX_ACCOUNT_PRIVATE） | host-only styrigx.com | HttpOnly, Secure, SameSite=Strict | 180 s，不续期 | AccountResetTicket `by.epoch.iat.exp.sig`：重置账号登录方式；by = root |
| `sgx-account-reauth` | 账号 Worker（SGX_ACCOUNT_PRIVATE） | host-only styrigx.com | HttpOnly, Secure, SameSite=Strict | 180 s，不续期 | AccountReauthTicket `by.epoch.iat.exp.sig`：进「账号安全」页前再验一次；by = password / passkey / root |
| `sgx-ui` | 主站 JS | `Domain=styrigx.com` | Secure, SameSite=Lax（非 HttpOnly） | 400 天 | 只有外观设置，子站读；不含任何会话信息 |

六张票分两处登记：锁屏三张在网关 `workers/auth-gateway/src/core/realms.js`（`TICKETS`），账号三张在账号 Worker `workers/account/src/core/realm.js`（`TICKETS`）；网关不签、不验账号票（账号拆分 PR3）。签名串一律是 `<cookie 名>|<票内容>`，
同一把私钥签的票互相冒充不了。Lock 三张票共用 Lock 纪元，Account 三张票共用 Account 纪元。
SpaceKey 不拥有会话，两把各管各的：进站凭证 `SGX_LOCK_SPACE_KEY` 走网关 `/api/space-auth { key, purpose }`，purpose 只有 `lock-reauth` / `lock-reset`；
账号根密钥 `SGX_ACCOUNT_ROOT_KEY` 走账号 Worker `POST /api/account { action:'root-reset', key }`，只签 AccountResetTicket（2026-11-08 删 `root-reauth`：恢复密钥只给 `sudo root reset` 用，不能登录、不能再验证；AccountReauthTicket 只认 password / passkey）。各签一张对应的短票（锁屏侧 by=space，账号侧 by=root）；LockSessionTicket 的 by 永远没有 space。

立即锁定 = `POST /api/lock-now` 清 `sgx-lock-session`（两条）+ `sgx-lock-reauth` + `sgx-lock-reset`。锁定所有设备 = Lock 纪元 +1。

## 2. 路由（谁处理请求）

网关只登记一条路由：`styrigx.com/*`（主站和三个子站同一个 Pages、一棵树，三站各占 `/blog/`、`/curio/`、`/daymark/`，按路径前缀走子站关口）。
旧图志域名那条（合并 PR3 起只做 301）已于 P4-3 PR-1 删除。
`styrigx.com/daymark/api/*` 归 `styrigx-daymark-core`、`styrigx.com/curio/api/*` 归 `styrigx-curio-core`（更具体，本仓库 `workers/<站>-core`；旧图志域名上的旧接口路由 P4-3 PR-1 删除）；
子站页面用的 `/api/lock-session-check` 就是主站根上的同一个接口，归网关。旧子域名 blog / daymark / curio.styrigx.com 已停用，不再登记。
静态资源（主站 `/css/ /js/ /fonts/ /fav/ /images/`，子站前缀下的静态后缀，如 `/blog/manifest.json`）第一行原样回源，不验会话、不打 `X-SGX-Runtime`。

账号路径（`/api/account`、`/api/prefs*`、`/api/avatar*`、`/api/wellbeing*`、`/avatar/*`）同样归网关的 `styrigx.com/*`：网关验门后经服务绑定 `ACCOUNT` 转给账号 Worker
（转发表 `workers/auth-gateway/src/router.js` 的 `FORWARDING`）。账号 Worker 没有任何路由（账号拆分 PR3）。

Cloudflare 路由规则：不带 `*` 的规则要求整条 URL（含查询串）完全相等；带查询串就不命中（2026-10-21 线上实测，`space/scripts/lib/cf-routes.mjs`）。

## 3. 网关的判定（页面）

主站（`workers/auth-gateway/src/gate.js` 的 `onRequest`）：

| 会话 | 路径 | 结果 |
|---|---|---|
| 无效 | 首页 `/`、`/en/`（任意查询串） | 200，`data-sgx-lock-session="locked"`，桌面（`SGX-DESKTOP` 标记之间）剥掉，no-store |
| 无效 | 其他页面 | 302 `/?lock=1&return=<站内路径>` |
| 无效 | `/api/*` 白名单外 | 401 JSON |
| 有效 | 首页 + `return`、无 `why` | 302 到 `resolveReturn(return)` |
| 有效 | 首页 + `why`（子站踢回） | 200 valid（不 302，防两站来回跳；前端问 session-check 拿 next，20 秒窗口防死循环） |
| 有效 | 其他页面（含锁屏凭证页、临时钥匙页、服务状态页；不分进门方式） | 200 valid，no-store；账号页另注入 `data-sgx-account-session="in|out"`（in 时登录区整段不下发） |

图志（`workers/auth-gateway/src/gate.js` 的 `handleSubsite`）：有效 → 回源 + no-store；无效 → 302 `https://styrigx.com/?lock=1&why=<no-cookie|invalid-session>&return=<完整地址>`；
图志根上的 `/api/lock-session-check`：有效 204、无效 401 `{ ok:false }`（`src/api/lock-session-check.js`）。

`resolveReturn(return)`（唯一实现，首页 302 和 session-check 共用）：站内路径（不许 `//`、`/\`、`/lock/`）或 `https://*.styrigx.com`
（无用户名密码、无反斜杠、不含已下线子站），否则回首页。只做地址白名单，不看进门方式（P2-3）：门内页要的锁侧复验由页面自己要。

## 4. 前端状态机（`space/web/assets/js/shell/lock-guard.js` 判定 + `shell/lock.js` 锁屏界面，按需加载）

页面状态 `pageState()` = `data-sgx-lock-session`：`valid` / `locked` / `lock-reset` / `unknown`（没有属性 = 页面没经过网关）。

```
            ┌──────────── unknown / locked ─────────────┐
 page load ─┤  画锁屏（fail closed）+ 立刻 askServer()   │
            │  ok → proceed()      401 → 保持锁屏        │
            │  解锁（密码 / 通行密钥 / 临时钥匙）→ askServer │
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
- `next` 是别处 → `location.replace(next)`（带 `why` 时先过 20 秒同 target 防死循环，触发则出失败卡）
- 无 `next`：页面是 `locked`（瘦身过）→ 换到去掉 `lock/why/return` 的地址重新取（10 秒同地址只一次）；`valid` / `unknown` → 原地开锁并改地址栏

永不「重载同一个锁屏地址等服务端 302」。

锁侧复验（P2-3 起取代旧的升级验证层）是独立的一态，不改会话：就地弹层，只有锁屏通行密钥 / 解锁密码（进站凭证兜底），通过后服务端种 3 分钟的 `sgx-lock-reauth`。
入口：锁屏凭证页门口（`apps/security-lock.js`）；临时钥匙 / 分享短链的新建、作废先照常请求，服务端回 401 reauth 时弹主站复验层（`auth/lock-reauth.js` 的 `withLockReauth`），通过后自动重试一次；
子站顶栏分享按钮用共享外壳 `share.js` 里的最小复验步骤（只有锁屏通行密钥 / 解锁密码）。取消不调任何接口，会话不动。

账号页（`apps/account.js`）：登录区、总览默认都隐藏；网关注入 `data-sgx-account-session`（经 `ACCOUNT_VERIFIER` 问账号 Worker；没绑定 / RPC 出错就不给属性）：`in` → 登录区不下发、总览首帧可见；
`out` → 登录区首帧可见；没有属性 → 中性，等 `/api/account`。只有服务端说「未登录」才出现「欢迎回来」。

不预渲染：站内链接不再用 Speculation Rules prerender（预渲染启用的是按下那一刻的会话状态快照）。

## 5. 测试

- 单测：`tests/workers/auth-gateway/auth-flow-2026-10-21.test.mjs`
- 端到端：`SGX_TEST_SUITE=edge`（`tests/space/e2e/edge/edge-flow.spec.js` + `edge-harness.cjs`）：真实网关代码 + 账号 Worker 代码（两边绑定和钥匙按正式环境拆开）+ wrangler.toml 路由 + 线上匹配规则 +
  真实域名（本地 HTTPS 代理）+ CDP 虚拟认证器 + 假 Turnstile
- 锁屏套件：`SGX_TEST_SUITE=lock`（http-server + mock，覆盖界面细节）
