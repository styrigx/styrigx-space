# 状态接口分工表（Item 23）

六个只读状态接口（账号状态由 `account` 报；锁屏凭证页的再验证由 `lock-reauth` 报 LockReauthTicket 状态）的分工：谁调用、鉴权要求、返回口径、用途。

共同约束：只返回「是否已设置」，绝不返回敏感数据（密码 hash、公钥、私钥、
cookie 值、挑战原文）。调用方列表由 `grep assets/js/` 下的 fetch 调用整理，
新增调用前先更新此表。

| 接口 | 鉴权要求 | 返回什么 | 调用方 | 用途 |
|------|----------|----------|--------|------|
| `GET /api/account` | 有效 **admin** lock 会话（访客/无会话 → 401）；不要求账号会话 | `{ ok, password, passkey, ready, session, reauth, reset }` —— `account-password`（账号密码）是否设置、是否有账号通行密钥（`account-passkey:*`）；`ready`＝`SGX_ACCOUNT_PRIVATE/PUBLIC` 是否齐全；`session`＝当前账号会话 `{ by, authAt, expiresAt, device }` 或 `null`（400 天）；`reauth`＝AccountReauthTicket `{ by, expiresAt }` 或 `null`（账号安全子页，3 分钟）；`reset`＝AccountResetTicket `{ by, expiresAt }` 或 `null`（重置登录页，3 分钟） | `assets/js/apps/account.js`（账号页 `/account/`：决定显示登录区还是账号区、三个登录入口、账号凭证状态）、`assets/js/apps/account-security.js`（账号 → 账号安全的再验证） | 账号页登录/管理。KV 读取失败 → 503。 |
| `GET /api/lock-credentials` | 有效 admin 会话（任何 by），或有效的 LockResetTicket（sgx-lock-reset） | `{ ok, password, passkey }` —— `lock-password` 是否设置、是否有 class=lock 的通行密钥 | `assets/js/apps/security-lock.js`（验证后 `refreshStatus()`：解锁密码「已设置/未设置」、设置/修改标题、删除按钮显隐）、`assets/js/apps/security.js`（安全与隐私页：锁屏凭证状态卡片 + 锁屏凭证行副标题；访客不调用） | 锁屏凭证页、安全与隐私页。KV 读取失败 → 503（fail closed），不按未设置退回。账号凭证状态读 `GET /api/account`，不要读本接口 |
| `POST /api/lock-reauth { action:'status' }` | 有效 admin 会话，或有效的 LockResetTicket | `{ ok, valid, ticket?, by?, expiresAt?, password, passkey }` —— 当前有效的票（`ticket`＝`lock-reauth` 需配 admin 会话；`lock-reset` 无会话）、票的绝对过期时刻（毫秒），以及锁屏凭证是否已设置（验证区按它显示入口） | `assets/js/apps/security-lock.js`（进页探针：有效 → 管理区，否则验证区）、`assets/js/apps/app-gate.js`（倒计时取 expiresAt） | 锁屏凭证页的再验证。`{ action:'clear' }` 清 LockReauthTicket（幂等，不要求会话，离开页面时调） |
| `GET /api/layer-status` | 有效 admin 会话（任何 by） | `{ ok, layers: { account, lock } }` —— 每层 `'configured'`（已接管）或 `'takeover'`（仍由根凭证代管） | **无生产前端调用**（仅 `tests/kernel/auth-211.test.mjs`；`functions/_middleware.js` 白名单放行） | 2.11 预留：UI 显示「由根凭证代管 / 已接管」。会话有效时顺带触发恢复开关计时 |
| `GET /api/lock-entry` | **无需鉴权**（公开） | `{ ok, passkey, password }` —— 锁屏有效配置；fail closed：KV 标记 `lock-configured` 为 `'1'`、或真实锁屏凭证存在、或任何读取失败，都按已配置返回 | `assets/js/shell/lock.js`（锁屏页入口按配置显示） | 锁屏页无会话时决定显示哪些入口；失败时按「已配置」处理，避免暴露根凭证入口 |
| `GET /api/lock-session-check` | **无需鉴权**（自检会话） | 有有效会话 → 200 `{ ok: true, role }`；否则 → 401 `{ ok: false }` | `assets/js/shell/lock.js`（解锁成功后先确认会话真的生效再跳 `?return=`；`visibilitychange`/`focus`/`pageshow` 时复查会话） | 防解锁后跳转循环；页面可见性变化时确认会话仍有效 |

## 口径对照

- `account` 只看**账号层**（原管理员层）：`account-password` + 账号通行密钥（`account-passkey:*`），另报账号钥匙是否配置与当前账号会话。
- `lock-credentials` 只看**锁屏层**：`lock-password` + 锁屏通行密钥（`lock-passkey:*`）。
- `lock-entry` 看**锁屏层有效配置**（公开可读版，fail closed 向「已配置」倾斜）。
- `account` 和 `lock-credentials` 的 `passkey` 口径不同（`account-passkey:*` vs `lock-passkey:*`），
  **绝不能混用**（历史教训：`security-lock.js` 的 `refreshStatus` 曾误读
  原来的账号状态接口显示锁屏密码状态，导致「只设管理员密码时锁屏页误显示已设置、
  只设锁屏密码时误显示未设置」，2.11 拆出 `lock-credentials` 修复）。
- `layer-status` 看的是**层接管标记**，不是凭证是否设置。

## 为什么不合并（保留原因）

- `account` × `lock-credentials`：同形部分 `{ password, passkey }`，但**数据源与鉴权
  都不同**。`lock-credentials` 接受无会话的LockResetTicket，
  `account` 只认 admin lock 会话。合并成一个接口只能取鉴权并集，会让锁屏/重置
  流程读到账号层状态，或让账号页逻辑混入锁屏口径 → 保持拆分。
- `lock-credentials` × `lock-entry`：`lock-entry` 必须**无鉴权**（锁屏页无会话时调用），
  `lock-credentials` 必须鉴权（把颗粒度状态给已验证的管理者看）。合并无法同时满足
  两种鉴权要求 → 保持拆分。
- `layer-status`：返回层标记而非凭证状态，暂无生产调用方（2.11 预留），
  并有副作用（触发恢复开关计时）。并入其他接口会污染语义 → 保留独立。
- `lock-session-check`：查的是**锁屏会话有效性**而非凭证配置，用途完全不同 → 独立；
  它不看账号会话（账号会话只由 `GET /api/account` 的 `session` 字段报告）。

## 账号会话（sgx-account-session）说明

- 账号登录两个入口：账号通行密钥（`POST /api/account` challenge + login-passkey）、
  账号密码（login-password）。根凭证不再是登录入口：「无法登录？」→「重置登录」
  （`POST /api/root-auth { key, purpose:'account-reset' }`）只签 AccountResetTicket（`sgx-account-reset`，by=root），重置页设好新 AccountKey 后正常登录（不顺带签账号会话）。
- 锁屏弹层的「无法登录？」走同一个重置登录界面（auth/reset-flow.js）：根凭证 → `POST /api/lock-reset verify`，
  服务端返回 needAccount 时再验账号凭证（账号通行密钥 / 账号密码）。根凭证比对全站只有 `_kernel/root-check.js` 一份。
- 前置条件是已解锁的 admin lock 会话，但 lock 会话**从不**被当作账号认证。
- 锁屏凭证页的 LockReauthTicket（`sgx-lock-reauth`）由锁屏凭证（`lock-passkey auth` / `lock-password verify`
  带 `reauth:true`）或根凭证（`root-auth` `purpose:'lock-reauth'`）签发，SGX_LOCK_* 签名，与账号会话无关。

## 账号云同步（不算状态接口）

- `GET/POST /api/prefs`（2026-10-24 起在账号 Worker `styrigx-account`，代码 `workers/account/src/api/prefs.js`；会话经本网关的 `AuthVerifier` RPC 验）：admin lock 会话 + 账号会话（sgx-account-session）。存 KV `account-prefs`，逐项 `{ v, t }` 新的赢；只同步 `sgx-` 开头的设置项（白名单在 `assets/js/lib/cloud-sync.js`）。调用方：`assets/js/lib/cloud-sync.js`（主站每页加载拉一次、设置改动后防抖推）、`assets/js/apps/account.js`（账号页「云同步」行）。
