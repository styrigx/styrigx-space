# 三站锁屏 / 解锁 / 回跳 / 主人验证 / 账号页：状态机（2026-10-21）

唯一状态源是服务端（网关 `styrigx-auth-gateway`）验签过的 cookie。前端只「反映服务端的回答」：
页面里的 `<html data-sgx-lock-session / data-sgx-role / data-sgx-account-session / data-sgx-upgrade>`（网关注入）和
`GET /api/lock-session-check[?return=]` 的 JSON。前端不在 localStorage / sessionStorage / 内存里另存「已解锁 / 已锁定」。

## 1. cookie

| 名字 | 谁签 | 作用域 | 属性 | 寿命 | 用途 |
|---|---|---|---|---|---|
| `sgx-verified` | 网关（SGX_LOCK_PRIVATE） | `Domain=.styrigx.com; Path=/` | HttpOnly, Secure, SameSite=Lax | owner 12 h / visitor 1 h | 锁屏会话 `by.role.epoch.exp.sig`；三站共用；epoch < KV `session-epoch` 即失效 |
| （同名清除） | 网关 | host-only `Path=/` | Max-Age=0 | — | 每次签发 / 清除都附带，清掉 2.4.0 遗留的 host-only 同名 cookie |
| `sgx-door` | 网关 | host-only styrigx.com | HttpOnly, Secure, SameSite=Strict | 180 s | 锁屏凭证页 / 账号安全页的「门票」 |
| `sgx-account` | 网关（SGX_ACCOUNT_PRIVATE） | host-only styrigx.com | HttpOnly, Secure, SameSite=Strict | 400 天 | 账号会话（与锁屏会话无关），`account-epoch` 失效 |
| `sgx-ui` | 主站 JS | `Domain=styrigx.com` | Secure, SameSite=Lax（非 HttpOnly） | 400 天 | 只有外观设置，子站读；不含任何会话信息 |

立即锁定 = `POST /api/lock-now` 清 `sgx-verified`（两条）+ `sgx-door`。锁定所有设备 = `session-epoch +1`。

## 2. 路由（谁处理请求）

`styrigx.com/*`、`blog.styrigx.com/*`、`daymark.styrigx.com/*` 全进网关；`daymark.styrigx.com/api/*` 归 `styrigx-daymark-core`
（更具体），`daymark.styrigx.com/api/lock-session-check` 又比它更具体，归网关。
静态资源（主站 `/css/ /js/ /fonts/ /fav/ /images/`，子站静态后缀和 `/manifest.json` 等）第一行原样回源，不验会话、不打 `X-SGX-Runtime`。

Cloudflare 路由规则：不带 `*` 的规则要求整条 URL（含查询串）完全相等；带查询串就不命中（2026-10-21 线上实测，`scripts/lib/cf-routes.mjs`）。

## 3. 网关的判定（页面）

主站（`functions/_middleware.js`）：

| 会话 | 路径 | 结果 |
|---|---|---|
| 无效 | 首页 `/`、`/en/`（任意查询串） | 200，`data-sgx-lock-session="locked"`，桌面（`SGX-DESKTOP` 标记之间）剥掉，no-store |
| 无效 | 其他页面 | 302 `/?lock=1&return=<站内路径>` |
| 无效 | `/api/*` 白名单外 | 401 JSON |
| 有效 | 首页 + `return`、无 `why` | 302 到 `resolveReturn(return)`；访客 + 主人专属页 → 200 `data-sgx-upgrade="1"`（主人验证层，不出锁屏） |
| 有效 | 首页 + `why`（子站踢回） | 200 valid（不 302，防两站来回跳；前端问 session-check 拿 next，20 秒窗口防死循环） |
| 访客 | 锁屏凭证页 `/settings/security/lock/` | 302 `/?return=<该页>`（主人验证，不带 `lock=1`） |
| 有效 | 其他页面 | 200 valid + role，no-store；账号页另注入 `data-sgx-account-session="in|out"`（in 时登录区整段不下发） |

子站（`src/subsites.js`）：有效 → 回源 + no-store；无效 → 302 `https://styrigx.com/?lock=1&why=<no-cookie|invalid-session>&return=<完整地址>`；
`/api/lock-session-check` blog 204 / daymark 200 / 无效 401。

`resolveReturn(return, role)`（唯一实现，首页 302 和 session-check 共用）：站内路径（不许 `//`、`/\`、`/lock/`）或 `https://*.styrigx.com`
（无用户名密码、无反斜杠、不含已下线子站），否则回首页；已登录 + 门内页 → 安全与隐私总览；访客 + 主人专属页 → upgrade。

## 4. 前端状态机（`web/assets/js/shell/lock.js`）

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
- `upgrade` → `/?return=<next>`（服务端给主人验证层）
- `next` 是别处 → `location.replace(next)`（带 `why` 时先过 20 秒同 target 防死循环，触发则出失败卡）
- 无 `next`：页面是 `locked`（瘦身过）→ 换到去掉 `lock/why/return` 的地址重新取（10 秒同地址只一次）；`valid` / `unknown` → 原地开锁并改地址栏

永不「重载同一个锁屏地址等服务端 302」。

主人验证（访客 → 站长，`shell/upgrade.js openOwnerVerify`）是独立的一态：就地弹层，只有通行密钥 / 密码（根凭证兜底），没有访客入口；
不出锁屏、不跳页；取消不调任何接口（访客会话保留）；通过 → 服务端签 owner 会话 → 跳目标页。
入口：安全与隐私页里访客点「锁屏凭证」（`apps/security.js`）、服务端 upgrade 页（`data-sgx-upgrade`）。

账号页（`apps/account.js`）：登录区、总览默认都隐藏；网关注入 `data-sgx-account-session`：`in` → 登录区不下发、总览首帧可见；
`out` → 登录区首帧可见；没有属性 → 中性，等 `/api/account`。只有服务端说「未登录」才出现「欢迎回来」。

不预渲染：站内链接不再用 Speculation Rules prerender（预渲染启用的是按下那一刻的会话状态快照）。

## 5. 测试

- 单测：`tests/workers/auth-gateway/auth-flow-2026-10-21.test.mjs`
- 端到端：`SGX_TEST_SUITE=edge`（`tests/web/e2e/edge-flow.spec.js` + `edge-harness.cjs`）：真实网关代码 + wrangler.toml 路由 + 线上匹配规则 +
  真实域名（本地 HTTPS 代理）+ CDP 虚拟认证器 + 假 Turnstile
- 锁屏套件：`SGX_TEST_SUITE=lock`（http-server + mock，覆盖界面细节）
