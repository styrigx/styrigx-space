# 状态接口分工表（Item 23）

五个只读状态接口（账号体系后 `owner-status` 由 `account` 取代）的分工：谁调用、鉴权要求、返回口径、用途。

共同约束：只返回「是否已设置」，绝不返回敏感数据（密码 hash、公钥、私钥、
cookie 值、挑战原文）。调用方列表由 `grep assets/js/` 下的 fetch 调用整理，
新增调用前先更新此表。

| 接口 | 鉴权要求 | 返回什么 | 调用方 | 用途 |
|------|----------|----------|--------|------|
| `GET /api/account` | 有效 **owner** lock 会话（访客/无会话 → 401）；不要求账号会话 | `{ ok, password, passkey, ready, session, door }` —— `owner-pw`（账号密码）是否设置、是否有 class=owner 的通行密钥（账号通行密钥）；`ready`＝`SGX_ACCOUNT_PRIVATE/PUBLIC` 是否齐全；`session`＝当前账号会话 `{ by, authAt, expiresAt, recent }` 或 `null`（400 天）；`door`＝账号门票 `{ by, expiresAt }` 或 `null`（安全与隐私子页的门，3 分钟） | `assets/js/apps/account.js`（账号页 `/settings/account/`：决定显示登录区还是账号区、三个登录入口、账号凭证状态）、`assets/js/apps/security.js`（安全与隐私页：账号凭证状态卡片；访客不调用） | 账号页登录/管理；安全页状态卡片。KV 读取失败 → 503。原 `GET /api/owner-status` 已随「站长凭证升级为账号」删除，由本接口取代 |
| `GET /api/lock-status` | 有效 owner 会话（任何 by），或有效的 stepup 票据（scope=keys / lockreset） | `{ ok, password, passkey }` —— `lock-pw` 是否设置、是否有 class=lock 的通行密钥 | `assets/js/apps/security-lock.js`（**lock 模式**（默认）：`statusApi` 指向本接口——进入时试读、`openGate()` 通行密钥按钮显隐、`refreshStatus()`：解锁密码「已设置/未设置」、设置/修改标题、删除按钮显隐） | 锁屏/重置页：锁屏凭证状态卡片。KV 读取失败 → 503（fail closed），不按未设置退回。**注意**：`lock-status` 在 scope=root 票据下不可读；账号凭证状态读 `GET /api/account`，不要读本接口 |
| `GET /api/layer-status` | 有效 owner 会话（任何 by） | `{ ok, layers: { owner, lock, app } }` —— 每层 `'configured'`（已接管）或 `'takeover'`（仍由根凭证代管） | **无生产前端调用**（仅 `tests/kernel/auth-211.test.mjs`；`functions/_middleware.js` 白名单放行） | 2.11 预留：UI 显示「由根凭证代管 / 已接管」。会话有效时顺带触发恢复开关计时 |
| `GET /api/lock-config` | **无需鉴权**（公开） | `{ ok, passkey, password }` —— 锁屏有效配置；fail closed：KV 标记 `layer:lock` 为 `'1'`、或真实锁屏凭证存在、或任何读取失败，都按已配置返回 | `assets/js/shell/lock.js`（锁屏页入口按配置显示） | 锁屏页无会话时决定显示哪些入口；失败时按「已配置」处理，避免暴露根凭证入口 |
| `GET /api/session-check` | **无需鉴权**（自检会话） | 有有效会话 → 200 `{ ok: true, role }`；否则 → 401 `{ ok: false }` | `assets/js/shell/lock.js`（解锁成功后先确认会话真的生效再跳 `?return=`；`visibilitychange`/`focus`/`pageshow` 时复查会话） | 防解锁后跳转循环；页面可见性变化时确认会话仍有效 |

## 口径对照

- `account` 只看**账号层**（原站长层）：`owner-pw` + class=owner 通行密钥，另报账号钥匙是否配置与当前账号会话。
- `lock-status` 只看**锁屏层**：`lock-pw` + class=lock 通行密钥。
- `lock-config` 看**锁屏层有效配置**（公开可读版，fail closed 向「已配置」倾斜）。
- `account` 和 `lock-status` 的 `passkey` 口径不同（class=owner vs class=lock），
  **绝不能混用**（历史教训：`security-lock.js` 的 `refreshStatus` 曾误读
  原 `owner-status` 显示锁屏密码状态，导致「只设站长密码时锁屏页误显示已设置、
  只设锁屏密码时误显示未设置」，2.11 拆出 `lock-status` 修复）。
- `layer-status` 看的是**层接管标记**，不是凭证是否设置。

## 为什么不合并（保留原因）

- `account` × `lock-status`：同形部分 `{ password, passkey }`，但**数据源与鉴权
  都不同**。`lock-status` 接受无会话的 stepup 票据（scope=keys/lockreset），
  `account` 只认 owner lock 会话。合并成一个接口只能取鉴权并集，会让锁屏/重置
  流程读到账号层状态，或让账号页逻辑混入锁屏口径 → 保持拆分。
- `lock-status` × `lock-config`：`lock-config` 必须**无鉴权**（锁屏页无会话时调用），
  `lock-status` 必须鉴权（把颗粒度状态给已验证的管理者看）。合并无法同时满足
  两种鉴权要求 → 保持拆分。
- `layer-status`：返回层标记而非凭证状态，暂无生产调用方（2.11 预留），
  并有副作用（触发恢复开关计时）。并入其他接口会污染语义 → 保留独立。
- `session-check`：查的是**锁屏会话有效性**而非凭证配置，用途完全不同 → 独立；
  它不看账号会话（账号会话只由 `GET /api/account` 的 `session` 字段报告）。

## 账号会话（sgx-account）说明

- 账号登录三个入口平级：账号通行密钥（`POST /api/account` challenge + login-passkey）、
  账号密码（login-password）、根凭证（`POST /api/root-auth { target:'account' }`）。
- 前置条件是已解锁的 owner lock 会话，但 lock 会话**从不**被当作账号认证。
- 「管理凭证」进门：`POST /api/stepup { action:'enter' }`，要求账号登录在 10 分钟内，
  签发 stepup(by=account, scope=keys)。原 `mgmt-buttons.js`（按 `owner-status` 决定
  站长凭证弹层按钮）已删除。
