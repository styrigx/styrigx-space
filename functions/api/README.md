# 状态接口分工表

5 个只读状态接口的分工（谁调、鉴权、返回、用途）。只返回「是否已设置」，
绝不返回敏感数据（密码 hash、公钥、私钥、cookie 值）。

| 接口 | 鉴权要求 | 返回什么 | 调用方 | 用途 |
|------|----------|----------|--------|------|
| `GET /api/owner-status` | 有效 **owner** 会话（访客/无会话 → 401） | `{ ok, password, passkey }` — 站长密码是否设置、是否有 class=owner 的通行密钥 | `assets/js/apps/security.js`（管理凭证弹层按钮决策、状态卡片）、`assets/js/apps/security-lock.js`（站长模式状态卡片）、`layouts/_default/security.html`（状态卡片占位）、`assets/js/apps/mgmt-buttons.js`（纯函数与该返回语义对齐） | 站长设置页：「管理凭证」弹层按返回决定显示「根凭证 / 通行密钥验证 / 密码验证」按钮 |
| `GET /api/lock-status` | 有效 owner 会话（任何 by），或有效的 stepup 票据（scope=keys / lockreset） | `{ ok, password, passkey }` — lock-pw 是否设置、是否有 class=lock 的通行密钥 | `assets/js/apps/security-lock.js`（锁屏模式状态卡片） | 锁屏/重置页：锁屏凭证状态卡片。修复过「误读 owner-status 导致锁屏页显示错误」的问题 |
| `GET /api/layer-status` | 有效 owner 会话（任何 by） | `{ ok, layers: { owner, lock, app } }` — 每层 `'configured'`（已接管）或 `'takeover'`（仍由根凭证代管） | **无生产前端调用**（仅 `tests/kernel/auth-211.test.mjs`；`functions/_middleware.js` 白名单放行） | 2.11 预留：UI 显示「由根凭证代管 / 已接管」。会话有效时顺带触发恢复开关计时 |
| `GET /api/lock-config` | **无需鉴权**（公开） | `{ ok, passkey, password }` — 锁屏有效配置；fail closed：KV 标记 `layer:lock` 为 '1'、或真实锁屏凭证存在、或任何读取失败，都返回 true | `assets/js/shell/lock.js`（锁屏页入口显示） | 锁屏页无会话时决定显示哪些入口；失败时按「已配置」处理，避免暴露根凭证入口 |
| `GET /api/session-check` | **无需鉴权**（自检会话） | 有有效会话 → 200 `{ ok: true, role }`；否则 → 401 `{ ok: false }` | `assets/js/shell/lock.js`（解锁后确认、visibilitychange/focus/pageshow 时复查） | 防解锁后跳转循环：解锁成功后先向服务端确认会话真的生效才跳 `?return=`；页面可见性变化时确认会话仍有效 |

## 口径对照

- `owner-status` 只看 **站长层**：`owner-pw` + class=owner 通行密钥。
- `lock-status` 只看 **锁屏层**：`lock-pw` + class=lock 通行密钥。
- `lock-config` 看 **锁屏层有效配置**（公开版 lock-status 语义 + fail closed）：标记或真实凭证任一存在、或读取失败都算已配置。
- `lock-config` 是无会话可调的公开接口；`lock-status` 是有鉴权才能看的锁屏层状态。
- `owner-status` 和 `lock-status` 的 `passkey` 口径不同（class=owner vs class=lock），**绝不能混用**。
- `layer-status` 目前没有生产调用方，新增调用前先读 `docs/` 中 2.11 的相关说明。
