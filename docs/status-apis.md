# 状态接口分工表

> 状态：现行 ｜ 最后更新：2026-11-06

六个只读状态接口（账号状态由 `account` 报；锁屏凭证页的再验证由 `lock-reauth` 报 LockReauthTicket 状态）的分工：谁回答、鉴权要求、返回口径、调用方、用途。

账号拆分 PR3 起，`GET /api/account` 由账号 Worker `styrigx-account` 回答（代码 `workers/account/src/api/account/status.js`；POST 的子路径见下文「账号会话」）：浏览器照旧请求 `styrigx.com/api/account`，网关 `workers/auth-gateway/src/gate.js`（主站关口 `onRequest`）先验门，再经服务绑定 `ACCOUNT`（AccountService）转发（转发表 `workers/auth-gateway/src/router.js` 的 `FORWARDING`）。其余接口都在网关 `workers/auth-gateway/src/api/`，由网关回答。网关不读账号凭证、不验账号票，`/api/layer-status` 已删除（前端无调用方）。

共同约束：只返回「是否已设置」，绝不返回敏感数据（密码 hash、公钥、私钥、
cookie 值、挑战原文）。调用方列表由 `grep space/web/assets/js/` 下的 fetch 调用整理，
新增调用前先更新此表。

| 接口 | 谁回答 | 鉴权要求 | 返回什么 | 调用方 | 用途 |
|------|--------|----------|----------|--------|------|
| `GET /api/account` | 账号 Worker（网关验门后转发） | 有效 进站会话（任何 by；无会话 → 401，网关的门）；账号 Worker 只认网关写的 `X-Styrigx-Lock-Session: 1` 身份头；读状态不要求账号 session | `{ ok, configured:{ password, passkey }, signing, session, reauth, reset }` —— 账号密码 / 账号通行密钥是否设置（D1 `styrigx-account` 的 `account_password` / `account_passkey`）；`signing`＝`SGX_ACCOUNT_PRIVATE/PUBLIC` 是否齐全；`session`＝`{ by, authAt, expiresAt, device }` 或 `null`（400 天）；`reauth`＝`{ by, expiresAt }` 或 `null`（只在挂在本机 session 上时，3 分钟）；`reset`＝`{ by, expiresAt }` 或 `null`（by = recovery-key，3 分钟） | `space/web/assets/js/shell/account/api.js` `status()`（账号终端：选登录方式、主页、倒计时） | 账号终端。D1 读取失败 → 503。没绑定 `ACCOUNT` 或转发出错 → 网关回 503 upstream |
| `GET /api/lock-credentials` | 网关 | 有效 进站会话（任何 by），或有效的 LockResetTicket（sgx-lock-reset） | `{ ok, password, passkey }` —— 锁屏密码是否设置、是否有锁屏通行密钥（D1 `styrigx-auth-gateway` 的 password / passkey 表，realm='lock'） | `apps/security-lock.js`（验证后 `refreshStatus()`：解锁密码「已设置/未设置」、设置/修改标题、删除按钮显隐）、`apps/security.js`（安全与隐私页：锁屏凭证状态卡片 + 锁屏凭证行副标题；进门的人都调用，不分进门方式） | 锁屏凭证页、安全与隐私页。D1 读取失败 → 503（fail closed），不按未设置退回。账号凭证状态读 `GET /api/account`，不要读本接口 |
| `POST /api/lock-reauth { action:'status' }` | 网关 | 有效 进站会话，或有效的 LockResetTicket | `{ ok, valid, ticket?, by?, expiresAt?, password, passkey }` —— 当前有效的票（`ticket`＝`lock-reauth` 需配 进站会话；`lock-reset` 无会话）、票的绝对过期时刻（毫秒），以及锁屏凭证是否已设置（验证区按它显示入口） | `apps/security-lock.js`（进页探针：有效 → 管理区，否则验证区）、`apps/app-gate.js`（倒计时取 expiresAt） | 锁屏凭证页的再验证。`{ action:'clear' }` 清 LockReauthTicket（幂等，不要求会话，离开页面时调） |
| `GET /api/space-audit` | 网关 | 进门 + 账号会话（没进门 / 坏会话 → 401 session；账号会话无效 → 401 account）；不要 LockReauthTicket（只读，不含凭证） | `{ ok, items: [{ ts, ipPrefix, ok }] }` —— 最近 7 天**进站凭证**（`SGX_LOCK_SPACE_KEY`）使用记录，新的在前，最多 50 条；不返回 decoy / via / path | `apps/space-status.js`（设置 → 服务状态页底「进站凭证使用记录」折叠区，**展开时才请求**，不随页面加载和 60 秒刷新） | 让主人看到进站凭证有没有被人试过（D1 audit 表 realm='lock'）。账号拆分前写在 realm='root' 的旧行已在 PR4 删除。恢复密钥的记录在账号 Worker 的 `account_audit`（事件 `reset-recovery-key`，没有读接口）。D1 失败 → 503 |
| `GET /api/lock-entry` | 网关 | **无需鉴权**（公开） | `{ ok, passkey, password }` —— 锁屏有效配置；fail closed：真实锁屏凭证存在、或任何读取失败，都按已配置返回（D1，不存标记）。两个都为 false＝锁屏从未设置。PR3 起不再返回 `accountConfigured` / `resetOnly`（网关读不到账号凭证） | `shell/lock.js`（锁屏页入口按配置显示） | 锁屏页无会话时决定显示哪些入口；失败时按「已配置」处理，避免暴露根密钥入口 |
| `GET /api/lock-session-check` | 网关 | **无需鉴权**（自检会话） | 有有效会话 → 200 `{ ok: true, by, exp, next }`（`by`＝进门方式，只作展示；带 `?return=` 时 `next`＝服务端校验后的去处；不带时 `next=null`；P2-3 起不再回等级和 upgrade）；否则 → 401 `{ ok: false }` | `shell/lock-guard.js`（解锁成功后先确认会话真的生效再跳 `?return=`；`visibilitychange`/`focus`/`pageshow` 时复查会话） | 防解锁后跳转循环；页面可见性变化时确认会话仍有效 |

## 口径对照

- `account` 只看**账号层**：账号密码 + 账号通行密钥（账号库 realm='account'），另报账号钥匙是否配置与当前账号会话。
- `lock-credentials` 只看**锁屏层**：锁屏密码 + 锁屏通行密钥（网关库 realm='lock'）。
- `lock-entry` 看**锁屏层有效配置**（公开可读版，fail closed 向「已配置」倾斜）。
- `account` 和 `lock-credentials` 的 `passkey` 口径不同（账号通行密钥 vs 锁屏通行密钥，两个库、两个 Worker），
  **绝不能混用**（历史教训：`security-lock.js` 的 `refreshStatus` 曾误读
  原来的账号状态接口显示锁屏密码状态，导致「只设账号密码时锁屏页误显示已设置、
  只设锁屏密码时误显示未设置」，拆出 `lock-credentials` 修复）。

## 为什么不合并（保留原因）

- `account` × `lock-credentials`：同形部分 `{ password, passkey }`，但**数据源、鉴权和所在 Worker
  都不同**。`lock-credentials` 接受无会话的 LockResetTicket，
  `account` 只认网关写的进门身份头。PR3 起两者分属网关和账号 Worker，各自只读自己的库，更不能合并。
- `lock-credentials` × `lock-entry`：`lock-entry` 必须**无鉴权**（锁屏页无会话时调用），
  `lock-credentials` 必须鉴权（把颗粒度状态给已验证的管理者看）。合并无法同时满足
  两种鉴权要求 → 保持拆分。
- `lock-session-check`：查的是**进站会话有效性**而非凭证配置，用途完全不同 → 独立；
  它不看账号会话（账号会话只由 `GET /api/account` 的 `session` 字段报告）。

## 账号会话（sgx-account-session）说明

- session / reauth / reset 三张票全部由账号 Worker 签发和验证（`workers/account/src/core/session.js`、`reauth.js`、`reset.js`，`SGX_ACCOUNT_PRIVATE / PUBLIC`）。网关不签、不验；网关需要授权结论时经 `ACCOUNT_VERIFIER.authorize()` 问账号 Worker。
- 接口按入口拆（账号命名 v2，`workers/account/src/api/account/`）：`POST /api/account/session`（`passkey-challenge` / `passkey` / `password` 登录，只签 session；`end` 退出）、
  `/reauth`（同三个 action，签挂在本机 session 上的 reauth；`end`）、`/reset`（`recovery-key { key }` 比对 `SGX_ACCOUNT_RECOVERY_KEY`，只签 reset 票，不签 session；
  之后 `password-set`、`passkey-list`、`passkey-add-challenge`、`passkey-add`、`passkey-delete`，最后 `finish { signOut: 'all' | 'others' | 'none' }` 回 `{ ok, signOut, signedOut }` 并作废 reset 票）、
  `/keys`（账号安全，要 reauth）、`/devices`、`/grants`。恢复密钥不能登录、不能再验证；reset 下不能给通行密钥改名。
- 锁屏终端的 `reset` 命令只管锁屏：进站凭证 → `POST /api/lock-reset verify`；
  恢复开关无效时服务端返回 `needLock`，再验锁屏凭证（锁屏通行密钥 / 锁屏密码，`lockProof`）。网关不读账号凭证。
  进站凭证比对只在网关 `src/core/space-check.js`（`SGX_LOCK_SPACE_KEY`）；恢复密钥比对只在账号 Worker `src/core/recovery-key.js`（`SGX_ACCOUNT_RECOVERY_KEY`），两套互不相干、各自计数。
- 前置条件是已解锁的 进站会话，但进站会话**从不**被当作账号认证。
- 锁屏凭证页的 LockReauthTicket（`sgx-lock-reauth`）由锁屏凭证（`lock-passkey auth` / `lock-password verify`
  带 `reauth:true`）或进站凭证（`space-auth` `purpose:'lock-reauth'`）签发，SGX_LOCK_* 签名，与账号会话无关。

## 账号云同步（不算状态接口）

- `GET/POST /api/prefs`（账号 Worker，代码 `workers/account/src/api/prefs.js`；网关验门后经 `ACCOUNT` 转发）：进站会话 + 账号会话（sgx-account-session，账号 Worker 自己验）。存 D1 `styrigx-account` 的 `settings_sync` 表（绑定 `D1_ACCOUNT`；2026-10-28 前在 KV `account-prefs`），逐项 `{ v, t }` 新的赢；只同步 `sgx-` 开头的设置项（白名单在 `space/web/assets/js/lib/cloud-sync.js`）。调用方：`lib/cloud-sync.js`（主站每页加载拉一次、设置改动后防抖推）。
