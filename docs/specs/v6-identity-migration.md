# v6 身份统一：数据迁移对照表（P1）

> 2026-11-11 v6 P4 收尾：生成脚本 `space/scripts/v6-identity-migrate.mjs` 及其单测已删除（Gray 20:11 批准）；下文提到的脚本用法是当时的记录。旧进站表 password / passkey / user_handle 等的 drop 见 `docs/ops/v6-p4-drop-space-legacy.sql`。

| 项 | 值 |
|---|---|
| 文档编号 | SGX-SPEC-005 |
| 版本 | 0.1 |
| 日期 | 2026-11-11 |
| 状态 | 草案（v6 P1，待 Gray 过目） |


> 状态：P1（2026-11-11），基线 main 05abe443。**P1 只写脚本与文档，不对任何生产 D1 做数据写入**；什么时候执行由 Gray 在 P2 / P3 批准。
> 表结构：`workers/account/migrations/0006_identity.sql`（合并后由账号部署 job 建空表）。脚本：`space/scripts/v6-identity-migrate.mjs`（只生成 SQL，不连 Cloudflare）。
> 相关：ADR-0006、`docs/specs/v6-route-inventory.md`、`docs/specs/v6-stepup-app-map.md`。

## 1. 新表（账号库 styrigx-account，不新增 D1）

| 表 | 作用 | 要点 |
|---|---|---|
| `account_users` | 用户 | uid 0 = root、1000 = styrigx、1001 起普通用户；`expires_at`（0 = 永久）、`epoch`、`disabled`、`avatar`（KV 键前缀） |
| `account_user_groups` | 组成员 | (uid, grp)；组名见 `core/groups.js` |
| `account_user_password` | 密码 | 每用户一行；`record` 沿用现有 JSON（加盐 + pepper）；**`pepper_id`**（account / space）；`must_change` + `expires_at` 给一次性密码用 |
| `account_user_passkey` | 通行密钥 | `credential_id` 全局唯一 → `uid`；`user_handle` / `legacy_handle`；`record` 原样 |
| `account_sessions` | 会话 | `id` = 令牌的 SHA-256；`uid` = 栈底；`epoch` 快照；`rescue`；`created_at` / `expires_at` / `renewed_at` |
| `account_session_stack` | 身份栈 | 挂在会话下，只有深度 1（su 压上来的 root）；`epoch` 快照；`expires_at`（≤ 1 小时） |
| `account_user_audit` | 身份审计 | uid、命令、结果、时间、IP 前缀；保留 90 天 |
| `account_recovery_key` | 救援钥匙指纹（定稿 v5.2 §九：钥匙本身在 Secrets Store `SGX_ACCOUNT_RESCUE_KEY`） | `id` = 用过的钥匙值的 SHA-256（不存明文），`created_at` / `used_at` = 救援签发时刻，永久保留；同值再用直接拒。P1 建表，P3 起写入 |

表名都带 `account_` 前缀：预览库 `styrigx-test-preview` 是网关 / 账号共用的，裸名 `audit`、`passkey` 会和网关旧表撞名（偏离定稿的表名写法，内容不变）。

## 2. 对照表

### 2.1 凭据

| 现在 | 所在库 | → v6 | pepper 来源 | 怎么搬 |
|---|---|---|---|---|
| `account_password`（id = 1，账号密码） | styrigx-account | `account_user_password` uid **0（root）** | `SGX_ACCOUNT_PASSWORD_PEPPER` → `pepper_id = 'account'` | 同库 `INSERT … SELECT`，record 原样 |
| `account_passkey`（账号通行密钥） | styrigx-account | `account_user_passkey` uid **0（root）** | —（通行密钥不用 pepper） | 同库 `INSERT … SELECT`；credential_id / record 逐字节照抄 |
| `account_user_handle`（handle / legacy_handle） | styrigx-account | 上一行每把钥匙的 `user_handle` / `legacy_handle` | — | 逐字节照抄 |
| `password` realm='lock'（进站密码） | styrigx-space-core | `account_user_password` uid **1000（styrigx）** | `SGX_SPACE_PASSWORD_PEPPER` → `pepper_id = 'space'` | 跨库：只读导出 → 生成 SQL，record 原样 |
| `passkey` realm='lock'（进站通行密钥） | styrigx-space-core | `account_user_passkey` uid **1000（styrigx）** | — | 跨库：只读导出；credential_id / record 逐字节照抄 |
| `user_handle` realm='lock' | styrigx-space-core | 上一行每把钥匙的 `user_handle` / `legacy_handle` | — | 逐字节照抄 |
| `SGX_ACCOUNT_RECOVERY_KEY`、`SGX_SPACE_RECOVERY_KEY`（两把恢复钥匙，Secrets Store） | — | Secrets Store `SGX_ACCOUNT_RESCUE_KEY`（一把，只管 root）；`account_recovery_key` 改作救援指纹表 | — | **不搬值**：新钥匙 Gray 已在 Store 建好，P3 只加绑定；旧的两把 P4 删（定稿 v5.2 §九） |

### 2.2 画像与数据（归 styrigx）

| 现在 | → v6 归属 | P1 动作 |
|---|---|---|
| 头像 KV_PROFILE `avatar:*` | styrigx（`account_users.avatar = 'avatar:'`） | 不动数据；P2a 已按 uid 分键：styrigx 沿用 `avatar:*`，别的用户 `avatar:u<uid>:*`（KV，不用迁移） |
| 个人资料 KV_PROFILE `profile` | 站点资料（站长），PUT 定 root（Gray 2026-11-11：站长名片只有一份） | 不动 |
| 设置云同步 `settings_sync` | styrigx | P2a：`workers/account/migrations/0007_v6_uid_columns.sql` 加 uid 进主键、现有行归 1000（2026-11-11 Gray 批准，挪进 `migrations/`，部署 job 执行）；迁移前只有 styrigx 能读写 |
| 已登录设备 `account_device` | styrigx（v6 的设备 = 自己的会话） | P2a：0007 加 uid 列（默认 1000，待批）；v6 新会话的设备管理直接按 `account_sessions.uid`；旧账号会话照旧用到 P4 |
| 数字健康 `wb_daily` | styrigx | P2a：同一份 0007 加 uid 进主键（待批）；迁移前只收 styrigx 的上报，公开合计 = 站长的 |
| 应用授权 `account_grant`（app allow / deny） | root | 不动；子应用权限改由组表达（P2） |

### 2.3 用户与组

| uid | 名 | 组 | 期限 |
|---|---|---|---|
| 0 | root | 无（root 本来就是全部权限；`canJoinGroup` 拒绝给 root 加组） | 永久（代码拒绝给 root 设期限） |
| 1000 | styrigx | wheel、sudoers、listen、ai、status、curio-write、daymark-write | 永久 |

## 3. 通行密钥：只改挂 uid，RP 不变

- RP ID `styrigx.com`、origin `https://styrigx.com` 不变，浏览器 / 密码管理器里的钥匙不用重新注册。
- `credential_id` 与 `record`（credId、publicKey、signCount、aaguid）逐字节不动；只多了一个 `uid`。
- **userHandle 处理**：WebAuthn 断言里的 `userHandle` = 注册时的 `user.id`。现状是账号一份（`handle`，外加拆分前锁屏用的 `legacy_handle`）、进站一份（realm='lock' 的 `handle`）。每把钥匙记下它可能用过的两个值（`user_handle` / `legacy_handle`），验证时任一相等都认（与现在账号登录认 handle 或 legacy_handle 的规则相同）；断言不带 userHandle（非可发现凭据）时照旧不比。之后新注册的钥匙：root 沿用账号 handle、styrigx 沿用进站 handle、新用户各自新生成 32 字节随机值（P2）。
- 凭据 ID 撞车（同一把钥匙既在账号又在进站）：脚本给了账号导出时先比对、撞了直接报错不出 SQL；没给时通行密钥用普通 `INSERT`，撞主键整句失败，**不会悄悄丢一把钥匙**。要人工定归属。
- 浏览器选钥匙时分得清：P2 注册新钥匙时显示名区分 `styrigx` / `root`。
- 迁后实测（P2 / P3 执行迁移时）：用旧钥匙各走一次 su styrigx、su root，确认验得过。

## 4. 两把 pepper（方案 a，Gray 2026-11-11 定稿）

迁到 styrigx 的进站密码哈希是 `SGX_SPACE_PASSWORD_PEPPER` 做的，账号 Worker 现在只绑 `SGX_ACCOUNT_PASSWORD_PEPPER`。`account_user_password.pepper_id` 记每条哈希的来源。实现要求见 ADR-0006 §2.12 (b)：

- 验证按记录的 `pepper_id` 取 pepper（不认识 / 缺失 → fail closed）；`pepper_id = 'space'` 的密码登录成功时用账号 pepper 重算哈希、同一次写入改成 `'account'`。
- 账号 Worker 加绑 space pepper（只加绑定，值不动）——**P2 随 su 验密一起加**（P1 没有 v6 密码验证，用不到）。
- 旧 space pepper 保留到所有活跃用户迁完（`SELECT COUNT(*) … WHERE pepper_id = 'space'` 对活跃用户 = 0），**P4 才删**。

## 5. 签名钥匙与密钥的终局（P4）

| 现在 | v6 |
|---|---|
| `SGX_SPACE_PRIVATE` / `SGX_SPACE_PUBLIC`（进站会话、锁屏短票） | v6 会话是 D1 里的不透明 id，不需要签名 → **P4 删** |
| `SGX_ACCOUNT_PRIVATE` / `SGX_ACCOUNT_PUBLIC`（账号三张票） | 若 curio / daymark 的子应用令牌仍要签名就**只留这一对**，否则也删 |
| `SGX_SPACE_RECOVERY_KEY`、`SGX_ACCOUNT_RECOVERY_KEY` | 换成 Secrets Store 里的一把 `SGX_ACCOUNT_RESCUE_KEY`（P3 绑定）→ 两把旧 Secret **P4 删** |
| `SGX_SPACE_PASSWORD_PEPPER`、`SGX_ACCOUNT_PASSWORD_PEPPER` | 见 §4 |

删任何 Secret 前先核 main 的代码与 wrangler 绑定。

## 6. 执行步骤（P2 / P3，Gray 批准后；P1 不执行）

1. 备份：确认两个库的 D1 Time Travel 可用（`wrangler d1 time-travel info styrigx-account` / `styrigx-space-core`），记下时间点；需要时 `wrangler d1 export` 一份。D1 是用户、组、凭据的唯一真相来源，这一步写进运维笔记 `docs/operations/`（P3 补）。
2. 只读导出：`node space/scripts/v6-identity-migrate.mjs --print-export` 打印两条 `SELECT`（`--json`）命令，跑出 `space.json`、`account.json`。
3. 生成：`node space/scripts/v6-identity-migrate.mjs --space space.json --account account.json --out v6-identity.sql`，人工过一眼。
4. 执行（Gray 批准）：`wrangler d1 execute styrigx-account --remote --file v6-identity.sql`。幂等，失败可重跑。
5. 实测：旧钥匙 su styrigx / su root；`SELECT uid, grp FROM account_user_groups`。
6. 旧表、旧 Secret 留到 P4。

## 7. 时间语义

- `useradd -e YYYY-MM-DD`：按 Linux 语义，**该日 00:00（Asia/Shanghai）起失效**（可用到前一天结束），存 UTC 毫秒（`core/users.js expiryFromDate`；例：`2026-12-01` → `2026-11-30T16:00:00Z`）。
- 会话：styrigx 层 30 天滑动续期（只在剩余不到一半时续写，每会话每天至多一次；admit 只读）；root 层 ≤ 1 小时、前台空闲 15 分钟弹回；救援 15 分钟、不续期。
- 到期之后（P2c）：到期即禁用、会话作废；**到期满 30 天**（`core/user-expiry.js` `EXPIRED_USER_GRACE_MS`）自动删除，删法同 userdel（会话、身份栈、凭据、组；用户行留墓碑 `#deleted-<uid>`，uid 不复用）。每日 03:41 CST 一轮（styrigx-status → `JOB_ACCOUNT`），useradd 前另懒清理一次。宽限期内用户行、凭据、组都还在（只是登不上）。
