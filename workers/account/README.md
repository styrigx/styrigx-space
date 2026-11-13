# styrigx-account

> 已被 v6 定稿取代（见 `docs/decisions/ADR-0006-identity-v6.md`）。

## 职责

账号 Worker：主人账号的完整账号系统。账号身份（账号密码、账号通行密钥、恢复密钥、已登录设备、session / reauth / reset 三张票、审计）和账号名下的数据（头像、个人资料、设置云同步）都在这里；网关 `styrigx-space-core` 里没有任何账号鉴权代码。本 Worker 不调网关、不绑任何锁屏数据或钥匙（没有 `[[services]]`）。

命名（账号命名 v2，2026-11-08）：一个概念一个词——`session`（`sudo root` 登录）、`reauth`（`sudo root reauth`，3 分钟，挂在本机 session 上）、`reset`（`sudo root reset`，恢复密钥换 3 分钟的票，不签 session）、`keys`（账号安全）、`devices`、`audit`、`recovery key`。`root` 只出现在用户看得见的终端命令里，代码里没有。网关签发、本 Worker 只读结论头的那张凭证叫「进站会话」（`X-Styrigx-Space-Session: 1`）。

## 入口

`src/index.js`（`wrangler.toml` 的 `main`）只接线：

| 导出 | 文件 | 做什么 |
|---|---|---|
| `default` | `src/app.js` | 默认 fetch 一律 404（第二道保险：即使线上残留公开路由，伪造的头也碰不到任何接口） |
| `AccountService` | `src/rpc/account-service.js` | 网关经服务绑定 `ACCOUNT` 转发来的请求：`serviceFetch` → `gate.js` → `router.js` |
| `AccountVerifier` | `src/rpc/account-verifier.js` | 只读 RPC，不签任何东西，调用方只有网关（服务绑定 `ACCOUNT_VERIFIER`）：`admit(cookieHeader, method, pathname)` → v6 新会话的放行结论（P1，见「v6 身份」）。命名 v2 删了 `session()`（唯一的调用方是网关给旧账号整页的首帧提示，整页 #327 已删） |
| `AccountJanitor` | `src/rpc/account-janitor.js` | v6 P2c：`purgeExpiredUsers(at)`——到期满 30 天宽限期（`core/user-expiry.js` 的 `EXPIRED_USER_GRACE_MS`）的用户自动删除，删法同 userdel（会话、身份栈、凭据、组；用户行留墓碑 `#deleted-<uid>`，uid 永不复用），永不删 root / styrigx。调用方只有 styrigx-status 每日一轮（服务绑定 `JOB_ACCOUNT`，03:41 CST）；本 Worker 不自带 Cron |

- `src/gate.js`：只有 `AccountService` 读身份头——网关写的 `X-Styrigx-Space-*`（Session / By / Link-Id；By、Link-Id 只作审计）、`X-Styrigx-Client-*`（Address / Country / City），`src/lib/gateway.js` 白名单校验（`passedGateway`：有没有进站会话）。纵深防御：没有进站会话的 `/api/*` → 401（`PUBLIC_API` 除外：`POST /api/identity`、`GET /api/profile`）；之后 `/api/prefs`、`/api/avatar`、`/api/profile` PUT 要 v6 会话（`gate.js scopeDenial`：401 session）；`/api/account/*` 各入口自己验票。
- `src/router.js`：接口路由表 `API_ROUTES` 和头像文件 `/avatar/<尺寸>.webp`。
- 一个文件一件事，文件名就是那件事的词：

| 目录 | 文件 |
|---|---|
| `src/api/account/` | `status.js`（GET 状态）、`session.js`、`reauth.js`、`reset.js`、`keys.js`、`devices.js`，公共的 `_request.js`（进站会话、同源、读 body、客户端地址、兜底 500） |
| `src/api/` | `avatar.js`、`avatar-file.js`、`profile.js`、`prefs.js` |
| `src/core/` | `config.js`（票 / 纪元 / cookie / challenge 用途 / rp）、`session.js`、`reauth.js`、`reset.js`、`password.js`、`password-limit.js`、`passkey.js`、`recovery-key.js`、`devices.js`、`audit.js` |
| `src/lib/` | `ticket.js`（签 / 验票）、`db.js`（D1_ACCOUNT；表只由 migrations 建）、`webauthn.js`、`gateway.js`、`attempt-limit.js`、`crypto.js`、`cookies.js`、`http.js`、`avatar.js`、`profile.js`、`security-headers.js`、`csp-hashes.js` |

不 import 网关或任何别的 Worker（`space/scripts/check/check-layers.mjs` 规则 14）；退役的旧名字一个都不许出现（规则 22，名单在 `space/scripts/check/retired-names.json`）。

## v6 身份（P1，分步割接中）

ADR-0006。P1 只加新路径，旧会话 / 旧入口 / 旧命令全部不动；还没有签发入口（P2 做 `su`）。

| 文件 | 做什么 |
|---|---|
| `migrations/0006_identity.sql` | 8 张身份表：`account_users`、`account_user_groups`、`account_user_password`（含 `pepper_id`）、`account_user_passkey`、`account_sessions`、`account_session_stack`、`account_user_audit`、`account_recovery_key` |
| `src/core/groups.js` | uid（root 0、styrigx 1000）、组、styrigx 默认组、临时用户不进特权 / 写组（`canJoinGroup`）、**唯一的权限判断 `permits(identity, level, { rescue })`** |
| `src/core/route-access.js` | 全站路由访问表 v6（public / user / 组名 / root，未列入拒绝；盘点文档 `docs/specs/v6-route-inventory.md`） |
| `src/core/identity-session.js` | 新会话判定 `admitSession`：一次 D1 查询、只读；会话时长常量与续期节流 `shouldRenew` |
| `src/core/users.js` | epoch bump（自改续命 / root 重置全作废）、加删组、期限（`expiryFromDate`：该日 00:00 Asia/Shanghai 起失效） |
| `src/core/user-audit.js` | 身份审计（90 天） |
| `src/core/admit.js` | 放行结论 = 路由档 + 新会话身份 + `permits`；`AccountVerifier.admit(cookieHeader, method, pathname)` 调它 |
| `src/api/identity.js`（P2） | `POST /api/identity`：whoami / su / sudo / exit / idle / lock / passwd / passkey-* / groups / who / useradd / userdel / usermod / passwd-user，每个 action 一档（`route-access.js`），判断只经 `permits` |
| `src/core/identity-auth.js`（P2） | v6 用户密码：pepper 方案 a（按 `pepper_id` 取 pepper，验对后改用账号 pepper）、一次性密码（16 位以上、24 小时、首登强制改）、两维限流（IP 6 次 / 分钟；用户名 1s → 5s → 30s → 5min）、防枚举 |
| `src/core/identity-stack.js`（P2） | 身份栈写操作：签发会话（拒签 root）、压 / 弹 root 层、清栈、滑动续写；救援会话签发函数（P3 才有调用方） |
| `src/core/identity-passkey.js`（P2） | v6 用户通行密钥：可发现凭据断言（不按用户列钥匙）、注册（user.name = 用户名）、ls / rm |
| `src/core/user-admin.js`（P2） | useradd / userdel / usermod / passwd <名> / groups / who（护栏：拒删 root 与 styrigx、临时用户不进特权 / 写组、最后一个 wheel / sudoers 先警告） |

数据迁移（凭据 → root / styrigx）的对照表见 `docs/specs/v6-identity-migration.md`；生成脚本 `space/scripts/v6-identity-migrate.mjs` 已于 v6 P4 收尾删除（Gray 2026-11-11 20:11）。

## 账号接口

全部要进站会话（各入口的 `end` 除外），POST 要同源。

| 接口 | 要什么 | action |
|---|---|---|
| `GET /api/account` | 进站会话 | → `{ ok, configured:{password,passkey}, signing, session, reauth, reset }` |
| `POST /api/account/session` | 进站会话 | `passkey-challenge` / `passkey` / `password` 签 session（不顺手签 reauth）；`end` 清 session 和挂在上面的 reauth |
| `POST /api/account/reauth` | + session | `passkey-challenge` / `passkey` / `password` 签 reauth（带本机 deviceId）；`end` 只清 reauth |
| `POST /api/account/reset` | 进站会话；拿到票后只认 reset 票（401 reset） | `recovery-key { key }`；`password-set`、`passkey-list`、`passkey-add-challenge`、`passkey-add`、`passkey-delete`；`finish { signOut: all\|others\|none }`（推 reset 纪元，票只能用一次）；`end` |
| `POST /api/account/keys` | + session + reauth（`passkey-list` 只要 session） | `password-set`、`passkey-list`、`passkey-add-challenge`、`passkey-add`、`passkey-delete`、`passkey-rename`；改了钥匙推 session 纪元、本机重签、删其他设备行 |
| `POST /api/account/devices` | + session（`revoke-all` 还要 reauth） | `list`、`revoke { deviceId }`、`revoke-all` |

- 两个纪元：`session`（管 session 和 reauth）、`reset`（只管 reset 票）。challenge 用途按入口分：`session` / `reauth` / `keys-add` / `reset-add`。限速按钥匙算：kind `password`、`recovery-key`。
- 审计事件 = `<入口>-<action>`（`session-<by>`、`reauth-<by>`、`reset-recovery-key`、`reset-finish-<值>`、`keys-passkey-add`、`devices-revoke`……），表 `account_audit` 的 `event` 列，保留 30 天。

## 路由

没有公开路由（第一道保险）：`wrangler.toml` 没有任何 `[[routes]]` / `route`（`[env.preview]` 只写 `routes = []`），`workers_dev = false`、`preview_urls = false`。`space/scripts/check/check-worker-routes.mjs` 核对 0 条路由，`check-layers.mjs` 规则 17 禁止这个 toml 出现非空的 routes。

浏览器请求只能先进网关：网关验进站会话、剥掉外来的 `x-styrigx-*` / `x-sgx-*` 头，再经 `ACCOUNT` 转进 `AccountService`。网关转发表 `workers/space-core/src/router.js` 的 `FORWARDING` 按前缀转 `/api/account`，子路径不用改网关。

| 路径 | 处理 |
|---|---|
| `GET /api/account`、`POST /api/account/<入口>` | `api/account/*.js`（上表） |
| `PUT` / `DELETE /api/avatar` | `api/avatar.js`（进站会话 + session + `avatar.write`） |
| `GET /avatar/<32\|96\|192\|512>.webp` | `api/avatar-file.js`（公开；没上传过回 Pages 上的默认头像） |
| `GET` / `PUT /api/profile` | `api/profile.js`（GET 有进站会话即可；PUT 进站会话 + session + `profile.write`） |
| `GET` / `POST /api/prefs` | `api/prefs.js`（设置云同步，进站会话 + session + `prefs.sync`） |

## 绑定

| 类别 | 名字 | 说明 |
|---|---|---|
| D1 `styrigx-account` | `D1_ACCOUNT` | 一个库一个名字：账号表 `account_*`（epoch、password、passkey、user_handle、challenge、attempt_limit、device、audit）、设置云同步 `settings_sync` |
| KV | `KV_PROFILE` | 只放公开数据：头像 `avatar:*` + 个人资料 `profile` |

明文变量：`SGX_ENV = "production"`、`SGX_RP_ID`、`SGX_ORIGIN`（这两个是红线：改了所有通行密钥失效）；`placement.mode = "smart"`。

## 钥匙

Secrets Store（`src/secrets.js` 换成字符串，60 秒缓存）：

| 名字 | 用途 |
|---|---|
| `SGX_ACCOUNT_PRIVATE` / `SGX_ACCOUNT_PUBLIC` | 三张票的签名钥匙对（签名串带 cookie 名，票之间互相冒充不了） |
| `SGX_ACCOUNT_RECOVERY_KEY` | 恢复密钥（`POST /api/account/reset { action:'recovery-key', key }`，只签 reset 票），与进站凭证 `SGX_SPACE_RECOVERY_KEY` 是不同的值、各自计数 |
| `SGX_ACCOUNT_PASSWORD_PEPPER` | 账号密码哈希 pepper，账号独占（网关的锁屏密码用自己的 `SGX_SPACE_PASSWORD_PEPPER`） |
| `SGX_ACCOUNT_RESCUE_KEY` | v6 P3 救援钥匙（定稿 v5.2 §九）：`POST /api/identity { action:'rescue', key }` 只读比对，通过签 15 分钟一次性 root 救援会话；Gray 在 dashboard 设值 / 换值，代码不写不删 |

## 数据与迁移

D1 `styrigx-account`，迁移在 `migrations/`：`0001_wellbeing.sql`、`0002_settings_sync.sql`、`0003_account_auth.sql`、`0004_app_grant.sql`（历史，不动）、`0006_identity.sql`（v6 P1：8 张身份表，只建表）、`0005_account_tables.sql`（命名 v2：账号行搬进 `account_*`、去掉 realm 列；`user_handle`、通行密钥的 `credential_id` / 公钥逐字节照抄；账号密码换新 pepper 后不复制，要重设一次；旧表只删 `realm='account'` 的行——预览库里网关的锁屏行也在这些表里）。部署 job `deploy-account-worker` 先跑 `d1 migrations apply styrigx-account --remote`，再部署，再冒烟。

- 部署顺序：搜索、聊天 → 监测 → **账号** ∥ 短链 → 网关 → Pages。回滚下限：`space/scripts/deploy/deploy-rollback-floor.json` 要求目标版本带 `D1_ACCOUNT`（不退回读旧表的版本）。
- 预览：不部署单独的预览 Worker。`[env.preview]` 只登记测试资源（`styrigx-test-preview`，迁移记录表 `d1_migrations_account`）；预览里的账号代码由组合入口 `tests/space/e2e/helpers/preview-worker.js` 在进程内跑。
- 生产库 `styrigx-account` 里 8 张空的旧表（`epoch`、`password`、`passkey`、`user_handle`、`challenge`、`attempt_limit`、`device`、`audit`）等 P4 由 Gray 确认后 DROP；预览库的旧表等锁屏那一轮。
- 测试：`tests/workers/account/`（按文件名对应：`api-<入口>.test.mjs`、`session.test.mjs`、`reset.test.mjs`、`recovery-key.test.mjs`、`rp.test.mjs`、`migration-0005.test.mjs`……）。
