# 状态接口分工表（Item 23）

五个只读状态接口的分工：谁调用、鉴权要求、返回口径、用途。

共同约束：只返回「是否已设置」，绝不返回敏感数据（密码 hash、公钥、私钥、
cookie 值、挑战原文）。调用方列表由 `grep assets/js/` 下的 fetch 调用整理，
新增调用前先更新此表。

| 接口 | 鉴权要求 | 返回什么 | 调用方 | 用途 |
|------|----------|----------|--------|------|
| `GET /api/owner-status` | 有效 **owner** 会话（访客/无会话 → 401） | `{ ok, password, passkey }` —— `owner-pw` 是否设置、是否有 class=owner 的通行密钥 | `assets/js/apps/security.js`（站长设置页：状态卡片刷新；「管理凭证」弹层每次打开时读取，把 `(j.password, j.passkey)` 喂给 `mgmtButtons()` 纯函数决定按钮）、`assets/js/apps/security-lock.js`（**owner 模式** `?mode=owner`：`statusApi` 指向本接口——进入时试读（成功直接进管理区）、`openGate()` 通行密钥按钮显隐、`refreshStatus()` 状态卡片）、`layouts/_default/security.html`（状态卡片占位注释） | 站长设置页：「管理凭证」弹层按返回决定显示「根凭证 / 通行密钥验证 / 密码验证」按钮；凭证管理页 owner 模式的状态显示 |
| `GET /api/lock-status` | 有效 owner 会话（任何 by），或有效的 stepup 票据（scope=keys / lockreset） | `{ ok, password, passkey }` —— `lock-pw` 是否设置、是否有 class=lock 的通行密钥 | `assets/js/apps/security-lock.js`（**lock 模式**（默认）：`statusApi` 指向本接口——进入时试读、`openGate()` 通行密钥按钮显隐、`refreshStatus()`：解锁密码「已设置/未设置」、设置/修改标题、删除按钮显隐） | 锁屏/重置页：锁屏凭证状态卡片。KV 读取失败 → 503（fail closed），不按未设置退回。**注意**：`lock-status` 在 scope=root 票据下不可读，owner 模式必须用 `owner-status`（见 `statusApi` 注释） |
| `GET /api/layer-status` | 有效 owner 会话（任何 by） | `{ ok, layers: { owner, lock, app } }` —— 每层 `'configured'`（已接管）或 `'takeover'`（仍由根凭证代管） | **无生产前端调用**（仅 `tests/kernel/auth-211.test.mjs`；`functions/_middleware.js` 白名单放行） | 2.11 预留：UI 显示「由根凭证代管 / 已接管」。会话有效时顺带触发恢复开关计时 |
| `GET /api/lock-config` | **无需鉴权**（公开） | `{ ok, passkey, password }` —— 锁屏有效配置；fail closed：KV 标记 `layer:lock` 为 `'1'`、或真实锁屏凭证存在、或任何读取失败，都按已配置返回 | `assets/js/shell/lock.js`（锁屏页入口按配置显示） | 锁屏页无会话时决定显示哪些入口；失败时按「已配置」处理，避免暴露根凭证入口 |
| `GET /api/session-check` | **无需鉴权**（自检会话） | 有有效会话 → 200 `{ ok: true, role }`；否则 → 401 `{ ok: false }` | `assets/js/shell/lock.js`（解锁成功后先确认会话真的生效再跳 `?return=`；`visibilitychange`/`focus`/`pageshow` 时复查会话） | 防解锁后跳转循环；页面可见性变化时确认会话仍有效 |

## 口径对照

- `owner-status` 只看**站长层**：`owner-pw` + class=owner 通行密钥。
- `lock-status` 只看**锁屏层**：`lock-pw` + class=lock 通行密钥。
- `lock-config` 看**锁屏层有效配置**（公开可读版，fail closed 向「已配置」倾斜）。
- `owner-status` 和 `lock-status` 的 `passkey` 口径不同（class=owner vs class=lock），
  **绝不能混用**（历史教训：`security-lock.js` 的 `refreshStatus` 曾误读
  `owner-status` 显示锁屏密码状态，导致「只设站长密码时锁屏页误显示已设置、
  只设锁屏密码时误显示未设置」，2.11 拆出 `lock-status` 修复）。
- `layer-status` 看的是**层接管标记**，不是凭证是否设置。

## 为什么不合并（保留原因）

- `owner-status` × `lock-status`：同形 `{ password, passkey }`，但**数据源与鉴权
  都不同**。`lock-status` 接受无会话的 stepup 票据（scope=keys/lockreset），
  `owner-status` 只认 owner 会话。合并成一个接口只能取鉴权并集，会让锁屏/重置
  流程读到站长层状态，或让管理页逻辑混入锁屏口径 → 保持拆分。
- `lock-status` × `lock-config`：`lock-config` 必须**无鉴权**（锁屏页无会话时调用），
  `lock-status` 必须鉴权（把颗粒度状态给已验证的管理者看）。合并无法同时满足
  两种鉴权要求 → 保持拆分。
- `layer-status`：返回层标记而非凭证状态，暂无生产调用方（2.11 预留），
  并有副作用（触发恢复开关计时）。并入其他接口会污染语义 → 保留独立。
- `session-check`：查的是**会话有效性**而非凭证配置，用途完全不同 → 独立。

## mgmt-buttons 说明

`assets/js/apps/mgmt-buttons.js` 的 `mgmtButtons(hasPw, hasPk)` 纯函数与
`GET /api/owner-status` 的返回语义一一对应（`hasPw` = 站长密码已设置，
`hasPk` = class=owner 通行密钥已设置）；调用方是
`assets/js/apps/security.js`「管理凭证」入口。**不要**把 `lock-status`
的返回值喂给它（口径不同：锁屏层 vs 站长层）。
