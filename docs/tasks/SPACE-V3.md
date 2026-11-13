# 进站（锁屏 / 盾牌）重构 v3：主机 `space` ↔ 账号 `account`，身份 `styrigx`（代码 `admin`）↔ `root`，Worker `styrigx-space`

> **v3 已定（Gray 2026-11-09 07:25–07:38；07:38 锁屏提示符由 lock@space 改为 entry@space，盾牌用 styrigx@space 不用 security 这个通用词）**：`space` 与 `account` 同层当主机；@ 左边是身份，唯一最高身份：界面叫 `styrigx`、代码叫 `admin`，对应账号界面 `root` / 代码 `root`（07:46 定；owner 弃用；daymark 的 `set_by 'admin'` 先改 `'grant'` 把 admin 让出来）。命令 `sudo styrigx` / `sudo styrigx reauth` / `sudo styrigx reset`；提示符 `entry@space:~$`、`styrigx@space:~#`、`reset@space:~#` ↔ `login@account`、`root@account`、`reset@account`。代码域词 `space`（v2 工作词 `entry` 直接换成 `space`；仓库里本来就有的 `entries/entry-*.js`、`/api/lock-entry` 是现存文件名，不在此列）。密钥名 `SGX_SPACE_*` 仍取决于 Q18。D1 库名 `styrigx-space-gateway`、迁移记录表 `d1_migrations_gateway` 不换。账号侧对照改名等本设计定稿后再出。

- 基准：`styrigx/styrigx-space` main `6dd63e9`（#332，含 #333 `566d529`；07:06 `git fetch origin main`，远端 main 仍是 `6dd63e9`）。只读：V1 读过的全部，加上账号侧现状 `workers/account/src/**`（`api/account/{status,session,reauth,reset,keys,devices,grants,_request}.js`、`core/config.js`、`lib/{db,ticket,gateway}.js`、`rpc/*`、`router.js`、`wrangler.toml`）、`shell/account/*`（12 个文件）、`sgx-shell-i18n` 的 `account:` 块、`deploy.yml` 各部署 job、`deploy-rollback-floor.json`、`check-layers.mjs` / `check-worker-routes.mjs`、share / status / ai / curio-core / daymark-core 的 `wrangler.toml`、share / status 的迁移。没读任何密值，没写代码，没推送。
- 依据：V1 的全部依据；Gray 2026-11-09 07:04–07:05（锁屏 ↔ 账号登录、盾牌 ↔ 账号安全、reset ↔ reset、`sudo space` ↔ `sudo root`；07:25–07:34 改为主机 `space`、身份 `owner`；07:42–07:46 改为界面 `styrigx`、代码 `admin`）；07:09 定 Worker `styrigx-space` / 目录 `workers/space` / 部署密钥 `STYRIGX_SPACE_DEPLOY`；07:10 `styrigx-space` 是整站后端核心、不是鉴权域；07:15 不要 `lock` 当代码词，进站系统和账号平行；07:17 确认「进站系统 ↔ account、`space` ↔ `root`」，域词待定；07:19 提示符方案（待 Gray）。
- 范围、工作树：同 V1（`/workspace/work/lock-shield-wt`，分支 `refactor/lock-gateway-names`，在 `6dd63e9` 上，没有提交）。

**定了的**：Worker `styrigx-space`、目录 `workers/space`、GitHub 环境 / 环境密钥 `STYRIGX_SPACE_DEPLOY`；主机 `space` ↔ `account`、身份界面 `styrigx` / 代码 `admin` ↔ `root`（Q12、Q13、Q18、Q20 已定，Q15 随之定）。**待 Gray**：Q14、Q16、Q17、Q19、Q20；Q1–Q11 沿用 V1。

---

## 0. v2 相对 v1 改了什么

| # | V1 | V2 |
|---|---|---|
| 1 | 代码域词 `lock`，`space` 只在界面当身份 | 代码域词 **`space`**（已定），用在账号用 `account` 的每一处，界面上也是主机名（`@space`）；身份词界面 `styrigx`、代码 `admin` ↔ `root`（`sudo styrigx`、`styrigx@space`）；`styrigx-space` 是 Worker 名；`lock` 只剩锁屏这个界面元素（`entry@space` 提示符、`#sgx-lock*` DOM、`?lock=1`，Q20） |
| 2 | Worker `styrigx-auth-gateway`、`workers/auth-gateway` 不动 | **`styrigx-space`、`workers/space`**（定了）；新增 §3.7 改名清单和一次性切换步骤 |
| 3 | 接口 `/api/lock/*` | **`/api/space/*`**，子路径照账号：`GET /api/space`、`/session`、`/reauth`、`/reset`、`/keys`（V1 的 credentials）、`/tempkeys`、`/audit` |
| 4 | 「所有设备回锁屏」= `/api/lock/session {end-all}` | `/api/space/session {end-all}`（要 reauth；账号对应的是 `/api/account/devices {revoke-all}`，进站没有设备表） |
| 5 | cookie `sgx-lock-*` 不变（已进站的设备不掉线） | **`sgx-space-session` / `-reauth` / `-reset`** → 部署后**所有设备回锁屏一次**（§5） |
| 6 | 表 `lock_*`、绑定 `D1_LOCK`、头 `X-Styrigx-Lock-*` | 表 **`space_*`**、绑定 **`D1_SPACE`**、头 **`X-Styrigx-Space-*`**（账号 Worker 跟着改读新头，Q19） |
| 7 | Secrets `SGX_LOCK_*` | **`SGX_SPACE_*`（5 个，Q18 已定 07:40）**；Gray 07:04 建的 `SGX_LOCK_*` 作废，切换后删 |
| 8 | 前端 `shell/lock/` + `shell/security/`，i18n `lock.*` + `security.*` | **`shell/space/`** 一个目录（照 `shell/account/`），i18n 一个根 **`space.*`** |
| 9 | 提示符 `entry@space` / `reset@space` / `security@space` | 建议 **`entry@space:~$` / `styrigx@space:~#` / `reset@space:~#`**（Q13，对应 `login@account` / `root@account` / `reset@account`） |
| 10 | 显示名 `LockPassword` / `LockPasskey` / `LockRecoveryKey` | `SpacePassword` / `SpacePasskey` / `SpaceRecoveryKey`（Q6 跟着域词改，其余 Q1–Q11 建议不变；Q4 / Q5 / Q7 里的路径换成新路径） |

**不变的**：V1 §2 的流程（L1–L17 的拆法、三个终端的状态图、三张票、两个纪元、限速、`by` 值、审计事件规则）、§4 的迁移思路（只是表名 `space_*`）、§7 的 WebAuthn 红线（`SGX_RP_ID` / `SGX_ORIGIN`、user handle 逐字节、`credential_id` / `publicKey` 原样）。

---

## 1. 命名模型

### 1.1 三层

| 层 | 词 | 用在哪 |
|---|---|---|
| 整站后端（Worker / D1 / 部署） | **space**（Worker 名） | Worker `styrigx-space`、目录 `workers/space/`、测试 `tests/workers/space/`、部署 job `deploy-space-worker`、`STYRIGX_SPACE_DEPLOY`、token `styrigx-space-deploy`、回滚下限键 `styrigx-space`。这个 Worker 管整站路由 `styrigx.com/*`、进站系统、转发（`/api/account*`、`/api/avatar*`、`/api/prefs*`、`/api/profile`、`/api/wellbeing*`、`/avatar/*` → styrigx-account；`/api/status` → styrigx-status；`/api/ai` → styrigx-ai）、AI 总闸、`/api/geo`、给 share Worker 签链接钥匙（`ShareIssuer`）。D1 `styrigx-space-gateway` 同时放 share（`share_*`）和 status（`status_*`）的表 |
| 进站系统（↔ 账号） | **space**（代码域词，已定） | 接口 `/api/space/*`、cookie `sgx-space-*`、表 `space_*`、绑定 `D1_SPACE`、头 `X-Styrigx-Space-*`、Secrets `SGX_SPACE_*`（Q18）、前端 `shell/space/`、i18n `space.*`、测试 `tests/space/e2e/space/`、页面属性 `data-sgx-space-session`、显示名 `Space*`；界面「进站」/ Space（进站密码 Space Password、进站通行密钥 Space Passkey、进站会话 Space Session、进站验证）、提示符的主机名 `@space` |
| 身份词（↔ `root`） | 界面 **styrigx**、代码 **admin**（Gray 07:46 定） | 命令 `sudo styrigx`、`sudo styrigx reauth`、`sudo styrigx reset`、`man styrigx`；进站后的提示符 `styrigx@space:~#`。代码里只有 `shell/space/commands.js` 一个 `ADMIN_COMMAND = 'styrigx'`、提示符常量 `PS_ADMIN = 'styrigx@space:~#'`（↔ `PS_ROOT`）（↔ `ROOT_COMMAND = 'root'`） |
| 锁屏这个界面 | **entry**（代码名，Q20 已定 07:41）；**lock** 只剩动作 | 代码里锁屏界面一律叫 entry：锁屏 DOM `#sgx-entry*` / `.sgx-entry-*`（原 `#sgx-lock*` / `.sgx-lock-*`，约 90 处 CSS / DOM）、状态类 `body.sgx-entry`（原 `body.sgx-locked`）、地址参数 `?entry=1&why=…`（原 `?lock=1`，旧参数 301 / 兼容读一版）、提示符 `entry@space:~$`。`lock` 只留动作：命令 `lock`（立即锁屏）和文案「锁屏 / 立即锁屏 / 回锁屏」。不出现在接口、cookie、表、绑定、Secrets、头、i18n 根里 |
| 同库同 Worker 的其他功能 | 各自前缀 | `share_*`（share Worker）、`status_*`（status Worker）、`ai_limit`（AI 总闸，V1 L14） |

**撞名**：`space` 已经是主站目录（`space/web`、`tests/space/`）、旷野页代码名（`apps/space.js`、`js.space.*`）和 Worker `styrigx-space`，都是「整站 / 主机」的意思，和 v3 的主机定位一致。真正要防混的是现存入口文件 `space/web/assets/js/entries/entry-*.js`（含 `entry-space.js`、`entry-space-wild.js`）与旧接口 `/api/lock-entry`：它们是现存文件名，不跟着换词；新目录 `shell/space/`、接口 `/api/space/*` 与它们路径不同。旷野页 wellbeing 区域键 `space` 是存量数据，不改。

### 1.2 账号是怎么分「登录」和「账号安全」的（核对 main 代码）

账号**一个域词、一个前缀**：`GET /api/account` + `/api/account/{session,reauth,reset,keys,devices,grants}`（`workers/account/src/router.js` `API_ROUTES`）。「账号安全」代码里叫 **`keys`**（`api/account/keys.js`、`shell/account/keys.js`、i18n `account.keys.*`、审计 `keys-*`、challenge 用途 `keys-add`），`security` 只在界面（`cd security`、`~/account/security`、标题「账号安全」）。「登录」代码里叫 **`session`**，`login` 只在提示符 `login@account:~$`、别名 `login`。进站照抄：一个前缀 `/api/space/*`；盾牌的「进站凭证」代码里叫 `keys`（界面仍叫「进站凭证」/ security）；锁屏进站代码里叫 `session`，`lock` 只在界面。

### 1.3 账号 ↔ 进站逐项对照（目标态）

「—」= 这一边没有。

**资源 / 部署**

| 项 | 账号 | 进站 | 备注 |
|---|---|---|---|
| Worker | `styrigx-account` | `styrigx-space`（原 `styrigx-auth-gateway`） | 进站系统只是 `styrigx-space` 里的一块 |
| Worker 目录 / 测试 | `workers/account/`、`tests/workers/account/` | `workers/space/`、`tests/workers/space/` | |
| 前端目录 / e2e | `shell/account/`、`tests/space/e2e/account/` | `shell/space/`、`tests/space/e2e/space/` | |
| D1 库 | `styrigx-account` | `styrigx-space-gateway`（改不改名 Q16） | |
| D1 绑定 | `D1_ACCOUNT` | `D1_SPACE`（Q15） | |
| 迁移记录表 | `d1_migrations`（预览 `d1_migrations_account`） | `d1_migrations_gateway`（不改） | |
| 部署 job / 环境 = 密钥 / token | `deploy-account-worker`、`STYRIGX_ACCOUNT_DEPLOY`、`styrigx-account-deploy` | `deploy-space-worker`、`STYRIGX_SPACE_DEPLOY`、`styrigx-space-deploy` | |
| 回滚下限 | `styrigx-account` `[D1_ACCOUNT]` | `styrigx-space` `[D1_SPACE, ACCOUNT, SGX_SPACE_RECOVERY_KEY, SGX_SPACE_TEMPKEY_PEPPER, AI_SERVICE]` | |
| 路由 | 无 | `styrigx.com/*` | |
| RPC 入口（别人绑它） | `AccountService`、`AccountVerifier`（网关绑，`ACCOUNT` / `ACCOUNT_VERIFIER`） | `AuthVerifier`（share / curio-core / daymark-core 绑，`AUTH`）、`ShareIssuer`（share 绑，`ISSUER`）；建议改 `SpaceVerifier` / `SPACE`（Q17） | |
| RPC 方法 | `authorize()` | `lockSession()` → `session()`；`conclusion()` 回 `{ space, account }`（原 `{ lock, account }`） | |
| 结论头 | `X-Styrigx-Account-Session` / `-Device` / `-Scopes` / `-Reauth` | `X-Styrigx-Space-Session` / `-By` / `-Tempkey-Id`（原 `X-Styrigx-Lock-*`） | 读的一方：账号 Worker `lib/gateway.js`（建议改名 `lib/space.js`）、`gate.js`、`api/account/_request.js` |
| 页面属性 | `data-sgx-account-session="in\|out"` | `data-sgx-space-session="valid\|locked"` | |
| 首帧标记 cookie | `sgx-account-signed-in` | — | 进站不需要，Worker 直接在 HTML 上写属性 |

**接口 / 票 / 数据**

| 项 | 账号 | 进站 | 备注 |
|---|---|---|---|
| 状态 | `GET /api/account`（要进站会话） | `GET /api/space`（白名单） | 都回 `{configured, signing, session, reauth, reset}` |
| 子站 / 回跳查会话 | — | `GET /api/space/session?return=` | |
| 登录 / 进站 | `/session {password, passkey-challenge, passkey}` | `/session {password, passkey-challenge, passkey, tempkey}` | 分享链接经 share Worker → `ShareIssuer.openLinkSession` |
| 结束本机 | `/session {end}`（`exit`） | `/session {end}`（立即锁屏、命令 `lock`） | |
| 所有设备 | `/devices {revoke-all}`（要 reauth） | `/session {end-all}`（要 reauth） | |
| 设备列表 / 应用授权 / 资料 | `/devices`、`/grants`、`/api/profile`、`/api/avatar` | — | |
| 再验证 | `/reauth`（挂 `deviceId`） | `/reauth`（挂 `sid`） | |
| 重置 | `/reset {recovery-key, password-set, passkey-list, passkey-add-challenge, passkey-add, passkey-delete, finish, end}` | 同 | signOut：账号 `all/others/none`，进站 `all/none`（Q1） |
| 管理钥匙（安全） | `/keys {passkey-list, password-set, passkey-add-challenge, passkey-add, passkey-delete, passkey-rename}` | `/keys {list, password-set, password-remove, passkey-add-challenge, passkey-add, passkey-rename, passkey-delete}` | 进站多 `password-remove`；账号 `passkey-list` 只要 session，进站 `list` 要 reauth |
| 临时钥匙 | — | `/tempkeys {list, create, revoke}` | |
| 分享链接 | — | 盾牌层；接口是 share Worker 的 `/api/share` | |
| 审计列表 | —（NAMING-V2 Q3 删了） | `GET /api/space/audit`（Q7） | |
| cookie | `sgx-account-session`（400 天）/ `-reauth` / `-reset` | `sgx-space-session`（12 小时，`Domain=.styrigx.com; SameSite=Lax`）/ `-reauth` / `-reset` | |
| 票（`core/config.js` `TICKET`） | `session` / `reauth` / `reset` | 同 | 签名串前缀 = cookie 名 |
| 票内容 | session `by.epoch.authAt.exp.deviceId`；reauth `…deviceId`；reset `by.epoch.iat.exp` | session `by.epoch.exp.tid`；reauth `by.epoch.iat.exp.sid`；reset `by.epoch.iat.exp` | |
| 纪元 | `account_epoch` `session` / `reset` | `space_epoch` `session` / `reset` | |
| by | `password` / `passkey` / `recovery-key` | 加 `tempkey` / `link`（Q3） | |
| challenge 用途 | `session` / `reauth` / `keys-add` / `reset-add` | 同（V1 的 `credentials-add` → `keys-add`） | |
| 限速 kind | `password`、`recovery-key` | 加 `tempkey` | |
| 审计事件 | `session-*`、`reauth-*`、`reset-*`、`keys-*`、`devices-*`、`grants-*`、`password-cooldown` | `session-*`（含 `session-end-all`）、`reauth-*`、`reset-*`、`keys-*`、`tempkeys-*`、`password-cooldown` | |
| 错误码 | `401 session`、`401 account`、`403 reauth`、`401 reset`、`401 wrong`、`429 cooldown`、`503 config` | `401 session`、`403 reauth`、`401 reset`、`401 wrong`、`403 not-set`、`403 last-key`、`409 full`、`429 cooldown`、`503 config` | |
| 表 | `account_epoch` / `_password` / `_passkey` / `_user_handle` / `_challenge` / `_attempt_limit` / `_audit` / `_device` / `_grant` | `space_epoch` / `_password` / `_passkey` / `_user_handle` / `_challenge` / `_attempt_limit` / `_audit` / `_tempkey` | 进站没有 device / grant；账号没有 tempkey |
| 同库其他功能 | `settings_sync`、`wb_daily` | `share_link` / `share_fail`、`status_*`（7 张）、`ai_limit` | |

**Secrets**

| 用途 | 账号 | 进站（改名，Q18 已定） | 不改名 |
|---|---|---|---|
| 票签名 | `SGX_ACCOUNT_PRIVATE` / `PUBLIC` | `SGX_SPACE_PRIVATE` / `PUBLIC` | `SGX_LOCK_PRIVATE` / `PUBLIC`（现有） |
| 恢复钥匙 | `SGX_ACCOUNT_RECOVERY_KEY` | `SGX_SPACE_RECOVERY_KEY` | `SGX_LOCK_RECOVERY_KEY`（Gray 已建） |
| 密码 pepper | `SGX_ACCOUNT_PASSWORD_PEPPER` | `SGX_SPACE_PASSWORD_PEPPER` | `SGX_LOCK_PASSWORD_PEPPER`（Gray 已建） |
| 临时钥匙 pepper | — | `SGX_SPACE_TEMPKEY_PEPPER` | `SGX_LOCK_TEMPKEY_PEPPER`（Gray 已建） |
| RP | `SGX_RP_ID` / `SGX_ORIGIN`（红线） | 同 | 同 |

**界面**

| 项 | 账号 | 进站 |
|---|---|---|
| 命令字常量 | `ROOT_COMMAND = 'root'` | `SPACE_COMMAND = 'space'` |
| 登录 / 进站 | `sudo root`（别名 `sudo -i`、`su`、`login`） | `sudo styrigx`、`sudo styrigx passkey\|password\|tempkey` |
| 再验证 | `sudo root reauth`（`sudo -v`） | `sudo styrigx reauth [passkey\|password]` |
| 重置 | `sudo root reset` | `sudo styrigx reset` |
| 没登录 / 锁着 | `login@account:~$` | `entry@space:~$`（Q13） |
| 登录后 | `root@account:~#` | `styrigx@space:~#`（盾牌命令行） |
| reset | `reset@account:~#` | `reset@space:~#`（Q13） |
| 输入行 | `[sudo] password for root:`、`[sudo] recovery key:` | `[sudo] password for <name>:`、`[sudo] recovery key:`、`tempkey:` |
| 退出 | `exit` / `logout` | `lock`（立即锁屏）；`exit` 关下拉 |
| 安全那一层 | `cd security` → `~/account/security` | 盾牌里点「进站凭证」行进层 |
| 显示名 | `AccountPassword` / `AccountPasskey` / `RecoveryKey` | `SpacePassword` / `SpacePasskey` / `SpaceRecoveryKey`（Q6） |
| i18n 根 | `account.*`（`common/session/reauth/reset/keys/devices/grants/profile/help`） | `space.*`（`common/session/reauth/reset/keys/tempkeys/links/shield/help`） |

**前端文件**（`space/web/assets/js/`）

| 账号 `shell/account/` | 进站 `shell/space/` |
|---|---|
| `term.js`（`mountAccountTerm`，下拉终端外壳） | `term.js`（终端外壳：输入、历史、^C、IME 修正；锁屏宿主 `mountSpaceTerm`）+ `shield.js`（盾牌下拉宿主，复用 term.js 的外壳）——进站有两个宿主（全屏锁屏、盾牌下拉），账号只有一个 |
| `commands.js` | `commands.js`（`SPACE_COMMAND`、`PS_LOCK` / `PS_SPACE` / `PS_RESET`、三次规则、别名） |
| `session.js`、`reauth.js`、`reset.js`、`keys.js`、`api.js` | 同名 |
| `devices.js`、`grants.js`、`profile.js`、`avatar-edit.js`、`passkey-signal.js` | — |
| — | `guard.js`（原 `lock-guard.js`）、`tempkeys.js`、`links.js`、`lock-now.js`、`state.js`（原 `lib/lock-state.js`） |

**Worker 文件**（`workers/account/src/` ↔ `workers/space/src/`）

| 账号 | 进站 |
|---|---|
| `api/account/{status,session,reauth,reset,keys,_request}.js` | `api/space/{status,session,reauth,reset,keys,_request}.js` |
| `api/account/{devices,grants}.js` | — |
| — | `api/space/{tempkeys,audit}.js` |
| `core/{config,session,reauth,reset,password,password-limit,passkey,recovery-key,audit}.js` | 同名 |
| `core/{devices,grants,authorize,scopes}.js` | — |
| — | `core/{tempkeys,links,ai-limit,anon-limit,conclusion,forward,return,account-rpc,identity-headers}.js` |
| `lib/{db,ticket,webauthn,attempt-limit,http,cookies,crypto,security-headers,csp-hashes}.js` | 同名 |
| `lib/gateway.js`（读进站头） | `core/identity-headers.js`（写进站头） |
| `rpc/account-service.js`、`account-verifier.js` | `rpc/auth-verifier.js`（Q17）、`share-issuer.js` |
| `gate.js`、`router.js`、`secrets.js`、`index.js`、`app.js` | 同名 |
| `migrations/0005_account_tables.sql` | `migrations/0010_space_tables.sql` |

---

## 2. 流程体系

### 2.0 现在哪里互相顶替、混在一起，怎么拆开

| # | 现在 | 位置（main `6dd63e9`） | 拆法 |
|---|---|---|---|
| L1 | **恢复钥匙（现叫进站凭证）也能签 reauth 票**：`/api/space-auth { purpose:'lock-reauth' }`，by=space | `api/space-auth.js:96-171`、`realms.js` `spaceIssues` | 删。reauth 只认解锁密码 / 通行密钥（Gray C）。恢复钥匙只开 reset |
| L2 | **reset 要两次验证**：恢复钥匙对了以后，开关没开就回 `needLock`，再要解锁密码 / 通行密钥 | `api/lock-reset.js:150-196`、前端 `shell/lock.js:642-700`（`rpick`/`rpw`） | 删 needLock、删 `lockProof`。恢复钥匙一把就签 reset 票（Gray B）。限速照旧（单 IP 5 次锁 15 分钟 + 全局减速） |
| L3 | **重置开关** `lock_reset_switch`：开关有效时恢复钥匙直接开 reset，否则走 L2 | `core/lock-reset-switch.js`、`migrations/0008`、`api/lock-reset.js:147-156` | L2 删了以后开关没有意义 → 模块、表、`touchLockResetSwitch` 全删 |
| L4 | **锁屏没有凭证时恢复钥匙走另一个入口**：`/api/space-auth { purpose:'lock-reset' }` + 假入口（锁屏已设置时写死 401） | `api/space-auth.js:110-145`、`core/lock-configured.js`、前端 `lock.js:634` | 只剩 `/api/space/reset { recovery-key }` 一个入口，有没有凭证都一样。假入口、`global:false` 计数分支删 |
| L5 | **一张 reset 票进的是管理接口的同一个分支**：`checkLockManage({allowReset})` 让 reset 票顶 reauth 票改密码、增删通行密钥 | `core/lock-manage.js:24-42`、`api/lock-password.js:149`、`api/lock-passkey.js:126-419` | 同账号 C1：`/api/space/keys` 只认 reauth 票；reset 下的写在 `/api/space/reset` 里，只认 reset 票。写入都用 `core/password.js` / `core/passkey.js`，验票各验各的 |
| L6 | **解锁和再验证是同一个接口**：`/api/lock-password {verify, reauth:true}`、`/api/lock-passkey {auth, reauth:true}`，一个参数决定签会话还是签 reauth | `api/lock-password.js:78-143`、`api/lock-passkey.js:263-324` | `/api/space/session {password\|passkey}` 只签会话；`/api/space/reauth {password\|passkey}` 只签 reauth（要本机进站会话） |
| L7 | **三张票共用一个纪元** `lock-epoch`；改凭证推纪元后重签手上那张短票（`reissueTicketWithEpoch`），reset 票的死活跟着会话事件走 | `realms.js:42`、`tickets.js:150-170`、`api/lock-password.js:186-194` | 两个纪元：`session`（管 session + reauth）、`reset`（只管 reset 票，`finish` / `end` 时 +1，reset 票只能用一轮）。同账号 C5 |
| L8 | **reset 下改密码、删通行密钥自动推纪元**（所有设备掉回锁屏），没有选择 | `api/lock-password.js:186`、`api/lock-passkey.js:403` | reset 下的写都不碰会话；`/api/space/reset { finish, signOut }` 决定（Gray B 三选一，见 **Q1**）。不选就离开 = `none` 并提示 |
| L9 | **reauth 票没挂在会话上**：票里只有 `by.epoch.iat.exp`，换一台设备的进站会话也能用（cookie 是 SameSite=Strict、只发主站，实际偷不走，但概念上没绑） | `tickets.js:27-34` | reauth 票加 `sid`（本机进站会话票签名的前 16 个字符），验 reauth 时要求同一张进站会话有效。会话结束 / 换票，reauth 跟着失效。同账号 C7 |
| L10 | **challenge 用途共用**：解锁、再验证都是 `auth`，盾牌加通行密钥和 reset 加都是 `register`，reset 二次验证是 `reset` | `realms.js:111` | 按入口分：`session` / `reauth` / `keys-add` / `reset-add`（`reset` 那个随 L2 删）。同账号 C8 |
| L11 | **分享链接生成 / 作废要 reauth**（share Worker 先问 `ShareIssuer.checkReauth`，网关 `createLinkKey` / `revokeLinkKey` 里再验一次） | `workers/share/src/api/share.js:63-73`、`core/link-keys.js:44-62` | 拆开（Q3 定稿 08:00）：`create` 只要进站会话；`list` / `revoke` / `revoke-all` 一律 reauth |
| L12 | **三个接口都在回「凭证设没设」**：`/api/lock-entry`（无会话）、`/api/lock-credentials`（会话或 reset 票）、`/api/lock-reauth {status}`（再带票状态）；`/api/lock-session-check` 回会话 | 四个文件 | 一个 `GET /api/space`（无会话可调）回 `{ configured, signing, session, reauth, reset }`，字段按身份裁剪（§2.4）。`GET /api/space/session?return=` 留给子站和锁屏回跳 |
| L13 | **pepper 一份管两件事**：`SGX_PW_PEPPER` 同时用于解锁密码哈希和临时钥匙码哈希 | `core/password.js:42`、`core/lock-tempkey.js:115`、`core/link-keys.js:75` | 解锁密码 `SGX_SPACE_PASSWORD_PEPPER`，临时钥匙码 `SGX_SPACE_TEMPKEY_PEPPER`（Gray E）。分享链接签的钥匙没有码（`code_hash` 为空），不用 pepper |
| L14 | **AI 全站总闸借了锁屏的限速表**：`attempt_limit` realm='ai' | `core/ai-limit.js:28-29` | 单独一张 `ai_limit`（同一个库）。不再借 `D1_SPACE` |
| L15 | **作废检查对「行不存在」放行**：`isTempkeyRevoked` 只认 `revoked_at > 0`，行被删了会话照样有效 | `core/lock-tempkey.js:231-236` | 改成「行在、没作废、没过期才算有效」（fail closed）。迁移时也照这个口径（§4） |
| L16 | **一个通用的 realm 层**：网关只剩一个域，`realmShape` / `realmOf` / `authDb(env, realm)` / `passwordLimiter(env, realm, …)` / `spaceLimiter(realm)` 都还带 realm 参数 | `core/d1-state.js`、`attempt-limit.js`、`password-limit.js`、`space-*.js` | realm 全删（同账号）；库访问 `lib/db.js`，表名就是前缀 |
| L17 | **前端两套验证 UI**：盾牌下拉 + 安全页门口的验证行（`auth/verify-rows.js`）+ 底部弹层（`auth/lock-reauth.js`、`auth/auth-sheet.js`）+ 子站分享按钮自带的最小复验 | `apps/security-lock.js`、`auth/*`、`shell/share-button.js:lockReauthStep` | 只剩命令行：锁屏 `entry@space`、reset `reset@space`、盾牌 `styrigx@space`。弹层、验证行、门口页全删（Gray C「NO popups」） |

### 2.1 会话 / 凭证种类（目标态）

| 票 | 怎么拿到 | 能做什么 | 时长 | 怎么失效 |
|---|---|---|---|---|
| **session**（进站会话）cookie `sgx-space-session`，`Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Lax`（子站要读，不变） | `sudo styrigx password` / `passkey`（by=password / passkey）；`sudo styrigx tempkey`（by=tempkey，`tid`=钥匙 id）；点开带会话的分享链接（by=link，`tid`=链接钥匙 id，**Q3**） | 看主站和子站页面；调要进站的接口；临时钥匙 / 分享链接 list；分享链接 create / revoke（**Q3**）；立即锁屏 | 密码 / 通行密钥 12 小时；临时钥匙 min(钥匙剩余, 12 小时)；分享链接按链接档位（30 分钟–7 天，不超过钥匙剩余） | 到期；`session` 纪元 +1（所有设备回锁屏、改进站凭证、reset finish all）；`tid` 指的钥匙作废 / 删除 / 过期（每个请求查一次 D1 主库）；本机立即锁屏清 cookie |
| **reauth**（再验证）cookie `sgx-space-reauth`（原 `sgx-lock-reauth`），`Path=/; HttpOnly; Secure; SameSite=Strict`，只发主站（不变） | 盾牌命令行 `sudo styrigx reauth [passkey\|password]`；要本机有效进站会话（任何 by）；**只认**解锁密码 / 通行密钥 | 进站凭证层（改解锁密码、加 / 改名 / 删通行密钥）、临时钥匙 create / revoke、所有设备回锁屏 | 3 分钟，不续期 | 到期；`session` 纪元 +1；本机进站会话换票 / 结束（票里的 `sid` 对不上）；`/api/space/reauth {end}` |
| **reset** cookie `sgx-space-reset`，同 reauth 属性 | 锁屏 `sudo styrigx reset` → `[sudo] recovery key:` → `/api/space/reset {recovery-key}`；不要会话 | 只在 reset 终端里：设解锁密码、通行密钥 ls / add / rm；`finish {signOut}`；**不签进站会话** | 3 分钟，不续期 | 到期；`reset` 纪元 +1（`finish` / `end` 都推，所以一张 reset 票只能用一轮） |
| 临时钥匙（不是票，是 D1 一行） | 盾牌 → 临时钥匙 → 新建（要 reauth） | 在锁屏换进站会话（by=tempkey） | 1–24 小时或 3 / 7 / 15 / 30 天 | 作废（要 reauth）；到期 |
| 分享链接（share Worker 一行 + 网关一把 `link=1` 钥匙） | 盾牌 → 分享链接 → 新建，或快捷面板「分享本页」（只要进站会话） | 点开后签进站会话（by=link） | 链接 1–24 小时或 3–30 天；会话档位 30 分钟–7 天 | 作废一条 / 全部；到期 |

**票格式**（签名串仍是 `<cookie 名>|<内容>`，Ed25519，`SGX_SPACE_PRIVATE`）：

| 票 | 现在 | 新 |
|---|---|---|
| session | `by.epoch.exp.tempkeyId.sig`（v2） | 内容格式不变，字段改名 `tid`；by 多一个值 `link`（**Q3**）。cookie 名（= 签名串前缀）改成 `sgx-space-session`，所以部署后所有设备回锁屏一次（§5） |
| reauth | `by.epoch.iat.exp.sig`，by ∈ password / passkey / space | `by.epoch.iat.exp.sid.sig`，by ∈ password / passkey。纪元 = `session` |
| reset | `by.epoch.iat.exp.sig`，by ∈ space / password / passkey | `by.epoch.iat.exp.sig`，by = `recovery-key`。纪元 = `reset` |

### 2.2 三个终端的状态图

**A. 锁屏终端**（`shell/space/term.js`，提示符 `entry@space:~$`）

```
[cmd] entry@space:~$ ──help / man space / clear──▶ [cmd]
   │  sudo styrigx ──────────────▶ [pick] "选择方式 [1/2/3]:"（只列设了的：[1] passkey [2] password；[3] tempkey 一直在）
   │                                 │  数字不对 → "没有这个选项"，再问（不算次数）
   │                                 │  ^C / esc → [cmd]
   │                                 ├─1─▶ [passkey] 系统窗口 ──成功──▶ [granted] → /api/space/session 回跳
   │                                 │          └─取消 / 失败（算 1 次）──▶ 还没到 3 次 → [pick] 再问；第 3 次 → [cmd] + "sudo: 3 incorrect password attempts"
   │                                 ├─2─▶ [password] "[sudo] password for <name>:"（不回显）
   │                                 │          ├─错 → "Sorry, try again."（同一行再问，算 1 次）；第 3 次 → [cmd] + "sudo: 3 incorrect …"
   │                                 │          ├─429 cooldown → 倒计时行 → [cmd]
   │                                 │          └─对 → [granted]
   │                                 └─3─▶ [tempkey] "tempkey:"（不回显，XXXX-XXXX-XXXX）同 password 的三次规则
   │  sudo styrigx passkey | password | tempkey ──▶ 直接进对应状态（跳过 [pick]）
   │        └─没设的方式 → "<方式>：未设置" + 列出能用的，回 [cmd]
   │  sudo styrigx（解锁密码和通行密钥都没设）──▶ 提示 "还没有进站凭证 · sudo styrigx reset"（tempkey 仍可用）
   │  sudo styrigx reset ──▶ [recovery] "[sudo] recovery key:"（不回显）
   │        ├─错 → "Sorry, try again."，第 3 次 → [cmd]；429 → 倒计时 → [cmd]
   │        └─对 → B（reset 终端）
   └─ 不认识 → "command not found: x · try help"
每个隐藏输入 / 选择行：触屏 ^C 键（同账号 C.interrupt）= 回 [cmd]；一轮结束后输入行保持可用、聚焦（#333 的 IME 回车 / 聚焦修正照搬）。
删：快捷键按钮 #sgx-lock-k-pw / #sgx-lock-k-pk，别名 sudo spacekey…、pw、pk、key、forgot、裸 password / passkey / tempkey / reset、sudo password / sudo passkey / sudo tempkey / sudo reset、cd .. / cd /（回 [cmd] 用 ^C）。
```

**B. reset 终端**（`shell/space/reset.js`，提示符 `reset@space:~#`，只在锁屏上）

```
[reset] reset@space:~#
   │  passwd ──▶ "new password:" → "retype:"（不回显，≥8 位）→ /api/space/reset {password-set} → 第一次改动 → C3
   │  passkey ls ──▶ 列表 [1] 名字 · 提供方 · 日期
   │  passkey add ──▶ 系统窗口 → /api/space/reset {passkey-add} → 第一次改动 → C3
   │  passkey rm <n> ──▶ "确认删除 <名字>? [y/N]" → {passkey-delete}（最后一把且没密码 → "至少留一个进站凭证"）→ 第一次改动 → C3
   │  help / clear
   │  exit / ^C / esc ──▶ 有过改动且还没选 → finish {signOut:'none'} + 提示 "没有让其他设备回锁屏"；没改动 → reset {end}；都回 A [cmd]
   └─ reset 票过期（3 分钟）→ "reset 已过期" → A [cmd]
C3（第一次改动后问一次，同账号 reset.js 的三选一写法）：
   "其他设备怎么办？ [1] 全部回锁屏（默认，回车） [2] 不动"  （见 Q1：本机在锁屏上没有会话，Gray 原稿 [1]/[2] 在这里结果相同）
   选了就 /api/space/reset {finish, signOut}，之后还能接着改（finish 后 reset 票失效 → 提示重新 sudo styrigx reset，见 Q2）
不签进站会话；不跳 /security/lock/。改完回 [cmd]，用新的密码 / 通行密钥 sudo styrigx 进站。
```

**C. 盾牌下拉 + 命令行**（`shell/space/shield.js`，提示符 `styrigx@space:~#`，`# 输入 help 查看安全命令`）

```
下拉头：已进站（by 的显示名 · 剩余 h:mm）；有 reauth 时右侧 `reauth · m:ss`
行（点进去是一层，左上 ‹ 返回；不是 cd 文本）：
  进站凭证 ›   要 reauth：没有 → 命令行自动跑 sudo styrigx reauth，通过后进层
      层内：解锁密码（设 / 改 / 删）· 通行密钥列表（改名 / 删 / 添加）· 所有设备回锁屏（Q5）
  临时钥匙 ›   要 reauth（列表也要：层里一打开就能新建，钥匙是明文码）
      层内：列表（名字 · 剩余）· 新建（名字、有效期 → 明文码只显示一次 + 复制）· 作废
  分享链接 ›   不验证
      层内：列表（名字 · 打开的页面 · 剩余 · 带不带会话）· 新建 · 作废一条 · 全部作废
  立即锁屏      不验证，直接 /api/space/session {end} → /?lock=1
命令行：
  [cmd] styrigx@space:~#
     │ sudo styrigx reauth ──▶ [pick] 只列设了的 [1] passkey [2] password（没有 tempkey）
     │ sudo styrigx reauth passkey | password ──▶ 跳过选择；没设 → 未设置 + 列出能用的
     │       三次规则、^C、没有这个选项同 A
     │       通过 → 头部 `reauth · 3:00` 倒计时；如果是点行触发的 → 进那一层
     │ help / clear / lock（= 立即锁屏）/ exit（关下拉）
     └ 不认识 → command not found
  进站会话是临时钥匙 / 分享链接换来的：reauth 照样只认解锁密码 / 通行密钥；进站凭证、临时钥匙两行显示锁着，分享链接看 Q3。
没有弹层：auth/lock-reauth.js 的底部弹层、确认弹层 #sec-locknow-confirm、安全页门口全删。
```

### 2.3 接口（目标态，全部在站点核心 Worker `styrigx-space`，`/api/share` 在 share Worker）

| 方法 路径 | 要什么 | 请求 | 响应 / 副作用 |
|---|---|---|---|
| `GET /api/space` | 无（白名单） | — | `{ ok, configured:{password,passkey}, signing, session:{by,exp}\|null, reauth:{by,exp}\|null, reset:{exp}\|null }`。没会话时 `session/reauth` 恒为 null；凭证读失败按「都设了」回（fail closed，同现在 `lock-entry`）。取代 `lock-entry`、`lock-credentials`、`lock-reauth {status}` |
| `GET /api/space/session?return=` | 无（白名单） | — | 有会话 200 `{ ok, by, exp, next }`，否则 401 `{ ok:false }`（子站三个同步脚本只认 401，不变）。原 `/api/lock-session-check` |
| `POST /api/space/session` | 无（白名单；匿名限流） | `{action:'passkey-challenge'}` → `{cid, challenge, rpId, allowCredentials}`；`{action:'passkey', cid, credential}`；`{action:'password', password}`；`{action:'tempkey', code}`；`{action:'end'}` | 前四个成功签 session（已有有效会话的 `tempkey` 直接 ok，同现在）。错误：401 `wrong`（密码 / 钥匙不对，统一一个码）、403 `not-set`、429 `cooldown {retryAfter}`、503 `config` / `server`。`end` 清 session + reauth + reset（幂等）；`end-all`（要会话 + reauth）推 `session` 纪元、清本机 cookie |
| `POST /api/space/reauth` | 进站会话 | `{action:'passkey-challenge'}`、`{action:'passkey', …}`、`{action:'password', password}`、`{action:'end'}` | 签 reauth（`sid` = 本机会话）。密码和解锁共用一个输错计数（按钥匙计，同账号）。`end` 只清 reauth |
| `POST /api/space/keys` | 进站会话 + reauth | `{action:'list'}` → `{password:bool, passkeys:[{credId,name,provider,createdAt,lastUsedAt}]}`；`password-set {password}`（≥8）；`password-remove`；`passkey-add-challenge` / `passkey-add {cid, credential, name}`；`passkey-rename {credId, name}`；`passkey-delete {credId}`；（所有设备回锁屏不在这里：`/api/space/session {end-all}`，见上） | 改了任何东西：推 `session` 纪元，本机 session + reauth 重签（保留原 exp），其他设备回锁屏（同现在、同账号 keys，**Q5**）。最后一把 → 403 `last-key` |
| `POST /api/space/reset` | 无（白名单；匿名限流）；拿到 reset 票以后只认 reset 票 | `{action:'recovery-key', key}`；`password-set {password}`；`passkey-list`；`passkey-add-challenge` / `passkey-add`；`passkey-delete {credId}`；`{action:'finish', signOut:'all'\|'none'}`；`{action:'end'}` | `recovery-key` 对 → 签 reset（by=recovery-key），错 → 401 `wrong`，429 `cooldown`。写操作不碰会话。`finish`：`all` 推 `session` 纪元；都推 `reset` 纪元并清 reset cookie。`end`：推 `reset` 纪元、清 cookie。reset 票无效 → 401 `reset` |
| `POST /api/space/tempkeys` | 进站会话；`list` 也要 reauth（**Q4**），`create` / `revoke` 要 reauth | `list` → `{keys:[{id,name,createdAt,expiresAt}]}`；`create {name?, hours?\|days?}` → `{key, code}`；`revoke {id}` | 同现在（20 把上限 409 `full`） |
| `GET /api/space/audit` | 进站会话（**Q7**） | — | `{ items:[{ts, ipPrefix, ok, event}] }`，最近 30 天、最多 50 条（恢复钥匙的 `reset-recovery-key` 和 `password-cooldown` 等）。原 `/api/space-audit` |
| `POST /api/share`（share Worker） | `create`：进站会话（任何 by，不验证）；`list` / `revoke` / `revoke-all`（管理页）：进站会话 + reauth（Q3 定稿 08:00） | `list` / `create {name?, hours\|days, to, session, reuse?}` / `revoke {id}` / `revoke-all`（新） | `create` 不问 `checkReauth`；管理动作先问 `ShareIssuer.checkReauth` |
| RPC `ShareIssuer` | 只有 share Worker 绑 | `createLinkKey(cookie, p)`、`revokeLinkKey(cookie, id)`、`openLinkSession(id, sec)`、`checkReauth(cookie)` | `checkReauth` 保留，只给管理动作用 |
| RPC `SpaceVerifier`（原 `AuthVerifier`，绑定 `SPACE`，原 `AUTH`；Q17） | 子站 / 账号 / share | `session(cookie)`（原 `lockSession`）、`conclusion(cookie, ctx, opts)` → `{ space, account }` | 结论头 `X-Styrigx-Space-Session` / `-By` / `-Tempkey-Id`；`-Tempkey-Id` 的值对 by=link 也填 |
| `GET /api/geo`、`/api/status`、`/api/ai` | 同现在 | — | 不在本次范围（只改它们借用的绑定名 / 限速表） |

**删除的接口**：`/api/lock-entry`、`/api/lock-credentials`、`/api/lock-reauth`、`/api/lock-session-check`、`/api/lock-password`、`/api/lock-passkey`、`/api/lock-tempkey`、`/api/lock-tempkey-unlock`、`/api/lock-reset`、`/api/lock-now`、`/api/lock-all-devices`、`/api/space-auth`、`/api/space-audit`（13 个，换成上面 8 个）。
**白名单（无会话可调）**：`GET /api/space`、`/api/space/session`、`/api/space/reset`、`/api/geo`。匿名限流 `ANON_LIMITER` 只管 `POST /api/space/session`、`POST /api/space/reset`。
**页面**：`/security/`、`/security/lock/`、`/security/tempkeys/`（含 `/zh/`）删，`_redirects` 301 到 `/#sec`、`/#sec=keys`、`/#sec=tempkeys`（同 `/account/` → `/#acct`）；`/owner/` 改成直接 301 到 `/#sec=keys`。网关 `gate.js` 的 `LOCK_RESET_PATHS`、页面状态 `lock-reset` 删，`data-sgx-space-session` 只剩 `valid` / `locked`。

---

## 3. 旧 → 新（按层）

### 3.1 Secrets / 绑定 / 变量（`workers/auth-gateway/wrangler.toml` → `workers/space/wrangler.toml`）

| 旧 | 新 | 说明 |
|---|---|---|
| Secrets `SGX_LOCK_SPACE_KEY` | **`SGX_SPACE_RECOVERY_KEY`**（Q18 已定） | 值 Gray 定（沿用原值或换一把，**Q8**） |
| Secrets `SGX_PW_PEPPER` | **`SGX_SPACE_PASSWORD_PEPPER`**（新随机值） | 解锁密码要重设一次（§4） |
| — | **`SGX_SPACE_TEMPKEY_PEPPER`**（新随机值） | 现有临时钥匙作废（§4）；分享链接不受影响 |
| D1 绑定 `D1_LOCK_AUTH` | **`D1_SPACE`**（同一个库 `styrigx-space-gateway`，id 不变） | 同时 `space/web/wrangler.toml [env.preview]`（预览组合入口）、deploy.yml、kv-budget |
| `SGX_LOCK_PRIVATE` / `SGX_LOCK_PUBLIC` | **`SGX_SPACE_PRIVATE` / `SGX_SPACE_PUBLIC`**（Q18 已定） | Gray 新建条目、把签名钥匙对的值重新录一遍（或换一对新的）；cookie 改名已经让所有设备回锁屏一次，换签名钥匙不再多一次 |
| `SGX_RP_ID` / `SGX_ORIGIN` / `SGX_ENV` / `SGX_SITE` | **不动**（红线） | |
| `ANON_LIMITER`（2801）、`AI_LIMITER`（2802）、服务绑定 `ACCOUNT` / `ACCOUNT_VERIFIER` / `STATUS` / `AI_SERVICE` | 不变 | |
| Worker `name = "styrigx-auth-gateway"`、目录 `workers/auth-gateway/` | **`styrigx-space`**、**`workers/space/`**（Gray 07:09 定） | 一次性切换见 §3.7 |
| `secrets.js` `SECRET_NAMES` | `SGX_SPACE_PRIVATE`、`SGX_SPACE_PUBLIC`、`SGX_SPACE_RECOVERY_KEY`、`SGX_SPACE_PASSWORD_PEPPER`、`SGX_SPACE_TEMPKEY_PEPPER`（5 个；Q18 不改名就是 `SGX_LOCK_*` 同样 5 个） | |
| CI 预览现生成的测试值 `PREVIEW_TEST_SPACE_KEY` / `PREVIEW_TEST_PW_PEPPER`，测试变量 `SGX_TEST_SPACE_KEY`、`--space-key` / `--pepper` | `PREVIEW_TEST_SPACE_RECOVERY_KEY`、`PREVIEW_TEST_SPACE_PASSWORD_PEPPER`、新 `PREVIEW_TEST_SPACE_TEMPKEY_PEPPER`；`SGX_TEST_SPACE_RECOVERY_KEY`；`--space-recovery-key` / `--space-password-pepper` / `--space-tempkey-pepper` | deploy.yml:712-1017、`ci-local.sh`、`preview-emulator.cjs`、`preview-helpers.cjs`、`cred-e2e-helpers.cjs`、`edge-harness.cjs`、`passkey/*.spec.js` |
| `deploy-rollback-floor.json` `requireBindings` `[D1_LOCK_AUTH, ACCOUNT, SGX_LOCK_SPACE_KEY, AI_SERVICE]` | `[D1_SPACE, ACCOUNT, SGX_SPACE_RECOVERY_KEY, SGX_SPACE_TEMPKEY_PEPPER, AI_SERVICE]` | 自动回滚不退到读旧表 / 旧 pepper 的版本（退回去解锁密码又验不过） |
| `retired-names.json` | `legacy` 加 `SGX_LOCK_SPACE_KEY`、`SGX_PW_PEPPER`、`D1_LOCK_AUTH`、`REALM_LOCK`、`KEY_SPACE`、`BY_SPACE`、`spaceKey`、`space-auth`、`space-audit`、`LockReauthTicket`、`LockResetTicket`、`LockSessionTicket`、`lock-reset-switch`、`needLock`、`lockProof`；`html` 换新名 | 旧名只留这一份（同账号） |

### 3.2 票、by、cookie、纪元

| 旧 | 新 |
|---|---|
| `LOCK_SESSION_TICKET='LockSessionTicket'` / `LOCK_REAUTH_TICKET` / `LOCK_RESET_TICKET`、`TICKETS{…}`、`TICKET_IDS {'lock-reauth','lock-reset'}` | `TICKET.session` / `TICKET.reauth` / `TICKET.reset`（`core/config.js`，键就是票名）；`TICKET_IDS` 删（`GET /api/space` 直接分字段回） |
| `BY_SPACE='space'` | 删；reset 的 by = `BY_RECOVERY_KEY='recovery-key'` |
| `BY_PASSWORD` / `BY_PASSKEY` / `BY_TEMPKEY` | 不变；新加 `BY_LINK='link'`（**Q3**） |
| `LOCK_EPOCH='lock-epoch'` | `EPOCH.session='session'`、`EPOCH.reset='reset'` |
| `SHORT_TICKETS`、`SHORT_TICKET_MAX_AGE`、`signShortTicket` / `parseShortTicket` / `verifyShortTicket` / `issueShortTicket` / `reissueShortTicketWithEpoch` / `clearShortTicket` + 具名包装 `signLockResetTicket`… | `TICKET_MAX_AGE.reauth/reset = 180`；`lib/ticket.js` 一套 `signTicket(name)` / `parseTicket` / `verifyTicket` / `issueTicket` / `reissueTicket` / `clearTicket`（session 也走它，不再单独一份 `signLockSessionTicket`） |
| cookie `sgx-lock-session` / `-reset` | **`sgx-space-session` / `sgx-space-reset`**，属性不变（session `Domain=.styrigx.com; SameSite=Lax`；reset `SameSite=Strict`、不带 Domain）。签名串前缀跟着变 → 所有设备回锁屏一次（§5） |
| cookie `sgx-lock-reauth` | **`sgx-space-reauth`**（属性不变：`Path=/; HttpOnly; Secure; SameSite=Strict`，不带 Domain）。退役名单加 `sgx-lock-session` / `-reauth` / `-reset`、`X-Styrigx-Lock-*`、`SGX_LOCK_*`（Q18 改名时）、`D1_LOCK_AUTH` |
| `realmCookie` / `realmClearCookie` / `realmPrivateKey` / `realmPublicKey` / `REALM_LOCK` / `REALMS` / `KEY_LOCK='LockKey'` / `KEY_SPACE='SpaceKey'` | 删；cookie 拼法在 `lib/ticket.js`；钥匙显示名见 **Q6**（`KEY_SPACE_PASSWORD` / `KEY_SPACE_PASSKEY` / `KEY_SPACE_RECOVERY_KEY`） |
| 页面状态 `data-sgx-lock-session="valid\|locked\|lock-reset"` | `data-sgx-space-session="valid\|locked"` |

### 3.3 Worker 模块（`workers/auth-gateway/src/` → `workers/space/src/`）

| 旧 | 新 | 主要改名 / 删除 |
|---|---|---|
| `api/lock-entry.js` + `api/lock-credentials.js` + `api/lock-reauth.js`（status 部分） | `api/space/status.js`（`GET /api/space`） | |
| `api/lock-session-check.js` + `api/lock-password.js`（verify）+ `api/lock-passkey.js`（challenge auth / auth）+ `api/lock-tempkey-unlock.js` + `api/lock-now.js` + `api/lock-all-devices.js` | `api/space/session.js`（GET + POST） | `reauth:true` 分支删 |
| `api/lock-password.js`（verify reauth）+ `api/lock-passkey.js`（auth reauth）+ `api/lock-reauth.js`（clear） | `api/space/reauth.js` | |
| `api/lock-password.js`（set/change/remove）+ `api/lock-passkey.js`（register/list/rename/delete） | `api/space/keys.js` | `set` / `change` 合成 `password-set`（有没有旧密码服务端自己知道） |
| `api/lock-reset.js` + `api/space-auth.js` | `api/space/reset.js` | needLock、lockProof、开关、`purpose`、假入口删 |
| `api/lock-tempkey.js` | `api/space/tempkeys.js` | |
| `api/space-audit.js` | `api/space/audit.js` | 账号会话要求删（**Q7**） |
| — | `api/space/_request.js` | 同源、读 body、IP、要会话 / 要 reauth 的公共门（取代 `core/lock-manage.js`） |
| `core/realms.js` | `core/config.js` | 留 `TICKET`、`EPOCH`、`BY_*`、cookie 名 / 属性、`CHALLENGE_PURPOSE`、`rpConfig`、显示名 |
| `core/lock-session.js` | `core/session.js` | `issueLockSession` → `issueSession`；`verifyLockSession` → `verifySession`；`checkLockSession` → `checkSession`；`lockSessionOf` → `sessionOf`；`bumpLockEpoch` / `getLockEpoch` → `bumpEpoch(name)` / `readEpoch(name)`；`reissueLockSessionWithEpoch` → `rotateSession` |
| `core/tickets.js` | `lib/ticket.js` + `core/reauth.js` + `core/reset.js` | 见 §3.2 |
| `core/lock-manage.js` | 删（`api/space/_request.js`） | `checkLockManage({allowReset})` 删（L5） |
| `core/lock-configured.js` | 并进 `api/space/status.js` | `realCredentialPresence` / `isLockEffectivelyConfigured` → `configured(env)`；`LAYER_LOCK` 删 |
| `core/space-check.js` + `core/space-limit.js` + `lib/crypto.js normalizeSpaceKey` | `core/recovery-key.js` | `checkSpaceCredential` → `checkRecoveryKey`；`spaceChecker` / `spaceLimiter` / `checkSpaceLimit` / `recordSpaceFail` / `clearSpaceFail` → `recoveryKeyLimit` / `recordRecoveryKeyFail` / `clearRecoveryKeyFail`；`SPACE_GLOBAL_*` → `RECOVERY_KEY_GLOBAL_*`；kind `spacekey` → `recovery-key`；`{global:false}` 删 |
| `core/space-audit.js` | `core/audit.js` | `writeSpaceAudit(env, ip, ok, {path, via})` → `writeAudit(env, ip, event, ok)`；`listSpaceAudit` → `listAudit`；`decoy` / `via` 删；保留期 30 天（同账号） |
| `core/lock-reset-switch.js` | 删（L3） | |
| `core/password.js` | `core/password.js` | `verifyRealmPassword(env, realm, pepper, pw)` → `verifyPassword(env, pw)`；`PEPPER_SECRET` → `'SGX_SPACE_PASSWORD_PEPPER'`；`getPassword(env, realm)` 等去 realm；无 pepper 的旧记录分支（`needsRehash`）删（新 pepper 以后不会再有旧记录） |
| `core/password-limit.js` + `core/attempt-limit.js` | `core/password-limit.js` + `lib/attempt-limit.js` | `passwordLimiter(env, realm, ip)` → `passwordLimit(env, ip)`；表 `space_attempt_limit`，去 realm |
| `core/passkey-store.js` | `core/passkey.js` | `PASSKEY_LOCK`、domain 参数删；`getPasskeys(env)` 等；`normalizeProvider` / `normalizePasskeyName` 认旧中文名的分支删（迁移 SQL 一次改好，同账号） |
| `core/passkey-verify.js` | `lib/webauthn.js` | `issueChallenge(env, realm, purpose, …)` → `issueChallenge(env, purpose, …)` |
| `core/lock-tempkey.js` | `core/tempkeys.js` | `getPepper` → `tempkeyPepper(env)`（`SGX_SPACE_TEMPKEY_PEPPER`）；`isTempkeyRevoked` → `isTempkeyValid`（L15，fail closed）；`TEMPKEY_*` 不变 |
| `core/link-keys.js` | `core/links.js` | `gateError` 只验会话；`checkLinkReauth` 删 |
| `core/d1-state.js` | `lib/db.js` | `SCHEMA` → `SPACE_SCHEMA`（只有 `space_*` 和 `ai_limit`）；`authDb` / `onAuthDb` / `realmOf` / `realmShape` → `db` / `onDb`；`kv_migration`、`device` 表删 |
| `core/ai-limit.js` | `core/ai-limit.js` | `REALM_AI` 删，用 `ai_limit` 表（L14） |
| `core/lock-identity.js` | `core/identity-headers.js` | `writeLockIdentity` → `writeIdentityHeaders`；头名不变 |
| `core/account-rpc.js`、`conclusion.js`、`forward.js`、`return.js`、`anon-limit.js` | 文件名不变 | 只换 import / 路径表 |
| `gate.js` | 不变 | `API_WHITELIST` 换新路径；`LOCK_RESET_PATHS` / `isLockResetPath` / `lock-reset` 状态删；`verifyLockResetTicket` import 删 |
| `router.js` `API_ROUTES` | 换成 `/api/space`、`/api/space/session`、`/api/space/reset`、`/api/space/reauth`、`/api/space/keys`、`/api/space/tempkeys`、`/api/space/audit` 7 条 + 不变的 `ai` / `geo` / `status` | |
| `rpc/share-issuer.js` | 不变 | `checkReauth` 保留，只给管理动作用 |
| `rpc/auth-verifier.js`、`app.js`、`index.js`、`secrets.js`、`lib/http.js`、`cookies.js`、`security-headers.js`、`csp-hashes.js` | 不变 | `lib/http.js` 错误码表：删 `auth`、`purpose`、`epoch`；加 `wrong`、`reset` |
| `migrations/0001-0009` | 不动 | 新加 `0010_space_tables.sql`（§4）、`0011_drop_old_tables.sql`（收尾 PR） |

`workers/share/src/api/share.js`：`create` 不再问 `checkReauth`，`list` / `revoke` / `revoke-all` 先问 `checkReauth`；加 `revoke-all`；文件头说明改。

### 3.4 前端

**目录**（照 `shell/account/` 的拆法）

| 旧 | 新 | 说明 |
|---|---|---|
| `shell/lock-guard.js`（core chunk） | `shell/space/guard.js` | 守卫、去处判定；`askServer` 改问 `GET /api/space/session` |
| `shell/lock.js`（1113 行） | `shell/space/term.js`（终端外壳、输入、历史、^C、IME 修正）、`commands.js`（`SPACE_COMMAND`、`PS_LOCK='entry@space:~$'`、`PS_RESET='reset@space:~#'`、`PS_PASSWORD`、`PS_RECOVERY_KEY='[sudo] recovery key:'`、`MAX_TRIES=3`、`TRY_AGAIN`、`TRIES_OVER`、别名表）、`session.js`（三种进站方式）、`reset.js`（B）、`api.js`（`/api/space*` 的唯一一处） | 和 `shell/account/{term,commands,session,reset,api}.js` 一一对应 |
| `shell/topbar-panel.js` 盾牌段（L583-640）+ `shell-topbar.html #sgx-sec` | `shell/space/shield.js`（下拉 + `styrigx@space` 命令行）、`reauth.js`、`keys.js`、`tempkeys.js`、`links.js`、`lock-now.js` | topbar-panel 只留 `wire()` 一行；`sudo security` 跳安全页那一支删，改成打开盾牌 |
| `apps/security.js`、`security-lock.js`、`security-tempkeys.js`、`security-share-links.js`、`tempkeys-i18n.js`、`app-gate.js` | 删 | 功能进 `shell/space/*` |
| `entries/entry-security.js`、`entry-security-lock.js`、`entry-security-tempkeys.js` | 删 | |
| `auth/lock-reauth.js`、`auth/auth-sheet.js`、`auth/cred-rows.js`、`auth/verify-rows.js`、`auth/auth-flow.js`、`auth/lock-now.js` | 删 | 只有已删的页面 / 弹层在用（import 关系已查） |
| `auth/passkey-assert.js`、`auth/passkey-register.js`、`auth/post-json.js` | 留（账号也在用）；`passkey-register.js` 去掉命名弹层，改成终端里问名字（**Q9**） | |
| `lib/lock-state.js` | `shell/space/state.js` | 只缓存服务端说法 |
| `lib/key-names.js` | 留；`KEY_SPACE` / `KEY_LOCK` 换成 **Q6** 的三个名 | |
| `shell/share-button.js` | 留；`lockReauthStep()`、`.sgx-share-reauth` 删，401 只剩「回锁屏」 | 子站和主站同一份 |
| `blog/js/blog/sgx-lock-check.js`、`curio/js/sgx-lock-sync.js`、`daymark/js/sgx-lock-sync.js`、`partials/blog/head.html` | 路径 `/api/lock-session-check` → `/api/space/session` | |
| `shell/account/commands.js`、`session.js`、`reauth.js` | D：`sudo root passkey\|password`、`sudo root reauth passkey\|password` 直达；没设 → 未设置 + 列能用的 | 账号只动这一处 |

**模板 / 内容 / CSS / i18n**

| 旧 | 新 |
|---|---|
| `layouts/_default/security.html`、`security-lock.html`、`security-tempkeys.html`、`content/security*.md`、`content/zh/security*.md` | 删；`static/_redirects` 加 6 条 301 + `/owner/` 改 |
| `partials/account-i18n.html` | 删（只剩临时钥匙页在用） |
| `partials/shell-topbar.html` `#sgx-sec`（`sudo security` 两个 `[1]/[2]` 链接、`lock --all` 行、指向 `/security/lock/` 的行） | 换成 C 的结构：头 + 四行 + 层 + 命令行；链接 `href` 留 `/#sec`（没 JS 时的去处） |
| `shell.css` 的 `.sgx-lock-k*`（快捷键）、`.sgx-reset*`、`.sgx-verify-dlg*`、`.sgx-method-sheet*`、`#sec-locknow-confirm`、`.sgx-share-reauth`、`input.css` 里安全页的 `.lockmgr*` / `.sec-*` / `.tk-*` / `.sl-*` | 删；盾牌层、命令行复用账号下拉的 `.sgx-pop*` / `.sgx-acct-term*`（改成中性的 `.sgx-pop-term*`，账号跟着改 class 名，**只改名不改样式**） |
| i18n `data/i18n/{zh,en}.yaml`：`securityLock`、`securityTempkeys`、`security`、`lockmgr`、`lock-gate`、`lockScreenCredentials`、`js.lock*`（锁屏） | 锁屏和盾牌的串都搬到 `data/sgx-shell-i18n/{zh,en}.yaml` 的一个根 `space:`（同账号 `account:`）：`space.common.*`、`space.session.*`（锁屏进站）、`space.reset.*`、`space.reauth.*`、`space.keys.*`（进站凭证）、`space.tempkeys.*`、`space.links.*`、`space.shield.*`（盾牌头部、立即锁屏）、`space.help.*`；原 `sec:` 删；整页的键删 |
| 文案：进门 / 进门会话 / 锁屏会话 → 进站 / 进站会话；锁屏凭证 / 锁屏钥匙 → 进站凭证；进站凭证（指 SpaceKey 的）→ 恢复钥匙；分享短链 → 分享链接；立即锁定 → 立即锁屏；锁定所有设备 → 所有设备回锁屏；锁侧复验 → 再验证 | 全仓（代码注释、文档、测试标题一起） |

### 3.5 测试

| 旧 | 新 |
|---|---|
| `tests/workers/auth-gateway/` 49 个文件（新目录 `tests/workers/space/`），按批次命名（`auth-2101`、`auth-2102`、`auth-211`、`batchc-spacekey-userhandle`、`b1-9-guest-401`、`auth-flow-2026-10-21`、`kv-*`、`space-*`、`short-tickets`、`realms`、`lock-reauth`、`last-key`…） | 按接口 / 模块重排：`api-status`、`api-session`、`api-reauth`、`api-keys`、`api-reset`、`api-tempkeys`、`api-audit`、`ticket`、`session`、`recovery-key`、`password-limit`、`tempkeys`、`links`、`webauthn`、`db`、`gate`（含 retired-en、static-passthrough、return-guard、subsites、sitemap）、`config`（含 binding-names、realms 的 rp 断言、secrets）、`migration-0010`、`deploy-rollback`、`ai-limit`、`conclusion`、`verifier`、`security-headers`、`old-names` |
| 删 | `kv-migration.test.mjs`、`kv-budget` 里 KV 部分、`kv-binding-split.test.mjs`（换成 `db.test.mjs` 里「只碰 `space_*` / `ai_limit`」的视图检查）、`d1-cutover.test.mjs`（**Q10**）、`space-check` / `space-limit` / `space-audit`（并进 `recovery-key` / `api-audit`）、`auth-211` 开关部分 |
| `tests/space/e2e/lock/*`（`b1-12-guard`、`b1-8-return-guard`、`lock-flags`、`lock-mobile`、`lock-now`、`lock-reset-pk-busy`、`reauth-return`、`reauth-verify`）、`visual/lock.spec.js`、`topbar/sec-pop.spec.js`、`passkey/{reauth,reset,security-status,lock}.spec.js`、`lock-term.cjs` | `tests/space/e2e/space/term-{session,reset}.spec.js`、`tests/space/e2e/space/term-{reauth,credentials,tempkeys,links,lock-now}.spec.js`、`lock/redirects.spec.js`（6 条 301）、`passkey/space-passkey.spec.js`（预览真 WebAuthn：解锁、reauth、reset add/rm）；每个 spec 带手机视口；`account/term-skip.spec.js`（D） |
| `tests/space/ui/space/lock-now.test.mjs` | `tests/space/ui/space/commands.test.mjs`（别名、跳过形式、未设置、三次）+ `security/state.test.mjs` |
| 视觉基线 | **仓库里没有任何基线图**（`find tests -name '*.png'` 为空；`visual/lock.spec.js:14`、`blog-visual.spec.js:4` 都是 `SHOTS = false`）。本次不重拍；以后要重拍是另一件事 |

### 3.6 脚本 / 文档

- 删：`space/scripts/migrate-kv-to-d1.mjs`、`migrate-kv-names.mjs`（KV→D1 一次性导入，2026-10-27 已跑完；网关早就不绑 KV）、`kv-budget.mjs` 的 KV 部分（只留 `reset-preview` 清预览 D1，表名换 `space_*`；**Q10**）、`d1-cutover.mjs` + `.github/workflows/d1-cutover.yml`（2026-11-07 合库已完成，**Q10**）。
- 改：`workers/space/README.md` 照新结构重写；`docs/architecture.md`、`auth-state-machine.md`（锁屏那段照 §2 重写）、`status-apis.md`、`STRUCTURE.md`、`workers/account/README.md`（提到网关名字的两行）、`check-layers.mjs`（规则 16/22 的名单读 retired-names）、`check-worker-routes.mjs`。
- 不动：博客文章（白皮书等历史记录）、`docs/2.4.1-*`、`docs/styrigx-3.0-task.md`。

### 3.7 Worker 改名 `styrigx-auth-gateway` → `styrigx-space`（Gray 07:09 定）和一次性切换

**改到的地方**

| 地方 | 旧 | 新 |
|---|---|---|
| `wrangler.toml` `name`、目录 | `styrigx-auth-gateway`、`workers/auth-gateway/` | `styrigx-space`、`workers/space/` |
| 路由 | `styrigx.com/*` 挂在旧 Worker | 挂到 `styrigx-space`（Cloudflare 一个路由只能指一个 Worker，见下面的切换步骤） |
| 别人绑它（服务绑定的 `service =`） | `workers/share/wrangler.toml`（`AUTH`、`ISSUER`，正式 + 预览各两处）、`workers/curio-core/wrangler.toml`（`AUTH`）、`workers/daymark-core/wrangler.toml`（`AUTH`） | `service = "styrigx-space"`；入口类名 / 绑定名见 Q17 |
| 它绑别人 | `ACCOUNT` / `ACCOUNT_VERIFIER`（styrigx-account）、`STATUS`（styrigx-status）、`AI_SERVICE`（styrigx-ai）、`ANON_LIMITER`、`AI_LIMITER` | 不变 |
| 只在注释里提到旧名 | `workers/account/wrangler.toml`、`workers/ai/wrangler.toml`、`workers/status/wrangler.toml`、`space/web/wrangler.toml`、README / docs / STRUCTURE.md（共约 143 个文件提到 `auth-gateway`，大部分是测试目录） | 一起改 |
| 部署 job | `deploy-auth-worker`（deploy.yml:1753），`Auth Worker bundle check (styrigx-auth-gateway, dry-run)`（:104） | `deploy-space-worker`、`Space Worker bundle check (styrigx-space, dry-run)`；单测 glob `tests/workers/auth-gateway/*.test.mjs` → `tests/workers/space/*.test.mjs`（:66）；变更检测 glob（:661）；`deploy-share-worker` 里跑网关迁移的 `workingDirectory` |
| GitHub 环境 = 环境密钥 | `STYRIGX_AUTH_GATEWAY_DEPLOY`（6 处） | `STYRIGX_SPACE_DEPLOY`（定了）。和 Pages 的 `STYRIGX_SPACE_PAGES_DEPLOY` 不撞 |
| Cloudflare token | `styrigx-auth-gateway-deploy`（Workers Scripts 编辑、Secrets Store 编辑、Account Settings 读取、styrigx.com Workers Routes 编辑） | `styrigx-space-deploy`，权限照抄。按 2026-10-24 的做法：Hark 建 token（名字 + 权限），Gray 自己 roll 值、填进 GitHub 环境 `STYRIGX_SPACE_DEPLOY`（只允许 main） |
| 回滚 | `deploy-rollback-floor.json` 键 `styrigx-auth-gateway` | 键 `styrigx-space`。新 Worker 第一次部署没有「部署前版本」→ 这一次失败不会自动回滚（脚本现有行为：记成空、只打 warning） |
| 守卫脚本 | `check-layers.mjs` 规则 14 / 16 的路径、`check-worker-routes.mjs`（读 `workers/auth-gateway/wrangler.toml`、`src/router.js`）、`check-layers.test.mjs` | 换成 `workers/space/` |
| 预览组合入口 | `space/web/wrangler.toml [env.preview]` 的 `migrations_dir = "../../workers/auth-gateway/migrations"`、`D1_LOCK_AUTH`；`tests/space/e2e/helpers/preview-worker.js`、`edge-harness.cjs`、`cred-e2e-helpers.cjs` | `../../workers/space/migrations`、`D1_SPACE`；import 路径换新目录 |
| D1 迁移记录表 | `d1_migrations_gateway` | **不改**（改了 = 迁移从 0001 重跑） |
| 日志 / 指标 | 挂在旧 Worker 名下 | 新 Worker 从零开始；旧 Worker 删掉前还能看 |

**要先核实的一件事**：Pages 项目也叫 `styrigx-space`（deploy.yml:951、:1091 `--project-name=styrigx-space`）。Workers 和 Pages 现在在 Cloudflare 后台是同一个列表，我不确定同名能不能建。L2 开工前 Hark 在 Cloudflare 上先核实（只看、不建）；如果不让建，回来找 Gray 换名，不自己挑。

**一次性切换步骤**（现在的部署顺序是 share / curio-core / daymark-core 先于网关，而它们的服务绑定指向的 Worker 不存在时部署会失败，所以第一次要倒过来）

1. **Hark**：在 Cloudflare 建 token `styrigx-space-deploy`；**Gray**：roll 值、建 GitHub 环境 `STYRIGX_SPACE_DEPLOY`（只允许 main）、填同名环境密钥。Secrets 按 Q18。
2. **L2 合并**后，一个一次性的 `workflow_dispatch` 工作流（只在 main，形状同已有的 `d1-cutover.yml`）：
   a. 跑 `0010`（用 share 的 token，同现在）；
   b. 部署 `styrigx-space`，**不带路由**（用一份去掉 `[[routes]]` 的临时 toml）——Worker 先存在，`AuthVerifier` / `ShareIssuer` 入口先有；
   c. 用 Cloudflare API 把 `styrigx.com/*` 这条路由的 script 从 `styrigx-auth-gateway` 改成 `styrigx-space`（一次调用，token 有 Workers Routes 编辑权限）→ 冒烟（同现在 deploy job 的检查）；
   d. 部署 share / curio-core / daymark-core（服务绑定换到 `styrigx-space`）；
   e. 之后 deploy.yml 恢复正常顺序；`deploy-space-worker` 带路由部署时这条路由已经是它的，不再冲突。
   b–d 之间有几分钟：新 Worker 认 `sgx-space-session`，那时还没有人有这个 cookie，所有人本来就要回锁屏一次（§5）；子站接口这几分钟可能回 401。
3. **回退**（c 之后出问题）：把路由改回 `styrigx-auth-gateway`（旧 Worker 还在、旧表没删、旧 cookie 还在浏览器里），再把 share / curio-core / daymark-core 重新部署回上一个提交。
4. **收尾（L3，先给 Gray 清单）**：删 Worker `styrigx-auth-gateway`、token `styrigx-auth-gateway-deploy`、GitHub 环境 `STYRIGX_AUTH_GATEWAY_DEPLOY`。


---

## 4. 数据迁移

**库**：生产 `styrigx-space-gateway`（`39d037fe-…`），预览 `styrigx-test-preview`（和账号预览共用）。迁移由 deploy.yml 的 `deploy-share-worker` 跑（网关 token 没有 D1 权限，现状），记录表 `d1_migrations_gateway`。

**表对照**

| 旧表（`realm='lock'`） | 新表 | 怎么搬 |
|---|---|---|
| `epoch(realm, value)` | `space_epoch(name, value)` | `session` = 旧 `lock` 行的值（**不 +1**：已进站的设备不掉线）；`reset` = 0 |
| `password(realm, record)` | `space_password(id=1, record)` | **不复制**：新 pepper 下旧哈希验不过（Gray E 的直接后果）。解锁密码变「没设置」 |
| `passkey(realm, credential_id, record)` | `space_passkey(credential_id, record)` | 原样复制；只把显示用的 `provider` / `name` 归一（同账号 0005 那段 SQL） |
| `user_handle(realm, handle, legacy_handle)` | `space_user_handle(id=1, handle, legacy_handle)` | **逐字节照抄**（红线） |
| `challenge(realm, id, purpose, …)` | `space_challenge(id, purpose, challenge, expires_at)` | 不复制（5 分钟） |
| `attempt_limit(realm, kind, bucket, …)` | `space_attempt_limit(kind, bucket, …)` | 复制 `realm='lock'`，`spacekey` → `recovery-key`；`realm='ai'` 的不复制 |
| `attempt_limit` realm='ai' | `ai_limit(bucket, count, window_start, expires_at)` | 不复制（按分钟的桶） |
| `tempkey(realm, id, name, code_hash, link, …)` | `space_tempkey(id, name, code_hash, link, created_at, revoked_at, expires_at)` + `UNIQUE(code_hash)` | 全部复制；`link = 0` 且还有效的写 `revoked_at = now`（码用新 pepper 验不过，拿它进站的会话也要立刻失效，L15）；`link = 1` 原样（分享链接继续能用） |
| `audit(realm, id, ts, ip_prefix, ok, decoy, via, path, …)` | `space_audit(id, ts, ip_prefix, ok, event, expires_at)` | `path='lock-reset'` → `reset-recovery-key`；`lock-reauth`（用恢复钥匙 reauth）不迁 |
| `lock_reset_switch`、`kv_migration`、`device`（网关从没写过）、`recovery_switch`（0009 已删） | 删 | |

**`0010_space_tables.sql`**（只建表、复制，**不删旧行**：部署那几分钟旧代码还在读旧表）

```sql
CREATE TABLE space_epoch (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT INTO space_epoch (name, value) SELECT 'session', value FROM epoch WHERE realm = 'lock';
INSERT OR IGNORE INTO space_epoch (name, value) VALUES ('session', 0), ('reset', 0);

CREATE TABLE space_password (id INTEGER PRIMARY KEY CHECK (id = 1), record TEXT NOT NULL);  -- 不复制（新 pepper）

CREATE TABLE space_passkey (credential_id TEXT PRIMARY KEY, record TEXT NOT NULL);
INSERT INTO space_passkey SELECT credential_id, record FROM passkey WHERE realm = 'lock';
-- provider / name 归一：同 workers/account/migrations/0005 的两条 UPDATE

CREATE TABLE space_user_handle (id INTEGER PRIMARY KEY CHECK (id = 1), handle TEXT NOT NULL, legacy_handle TEXT NOT NULL DEFAULT '');
INSERT INTO space_user_handle SELECT 1, handle, legacy_handle FROM user_handle WHERE realm = 'lock';

CREATE TABLE space_challenge (id TEXT PRIMARY KEY, purpose TEXT NOT NULL, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL);

CREATE TABLE space_attempt_limit (kind TEXT NOT NULL, bucket TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, strikes INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, PRIMARY KEY (kind, bucket));
INSERT INTO space_attempt_limit SELECT CASE kind WHEN 'spacekey' THEN 'recovery-key' ELSE kind END, bucket, count, strikes, locked_until, window_start, expires_at
  FROM attempt_limit WHERE realm = 'lock';

CREATE TABLE ai_limit (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL);

CREATE TABLE space_tempkey (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', code_hash TEXT, link INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, revoked_at INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL);
CREATE UNIQUE INDEX space_tempkey_code ON space_tempkey (code_hash);
INSERT INTO space_tempkey SELECT id, name, code_hash, link, created_at,
  CASE WHEN link = 0 AND revoked_at = 0 THEN CAST(strftime('%s','now') AS INTEGER) * 1000 ELSE revoked_at END, expires_at
  FROM tempkey WHERE realm = 'lock';

CREATE TABLE space_audit (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, ip_prefix TEXT NOT NULL, ok INTEGER NOT NULL, event TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX space_audit_ts ON space_audit (ts);
INSERT INTO space_audit SELECT id, ts, ip_prefix, ok, 'reset-recovery-key', expires_at FROM audit WHERE realm = 'lock' AND path = 'lock-reset';
```

**收尾 `0011_drop_old_tables.sql`**（收尾 PR，Hark 做，先给 Gray 清单）：`DROP TABLE epoch, password, passkey, user_handle, challenge, attempt_limit, tempkey, device, audit, kv_migration, lock_reset_switch;`。生产和预览都能 DROP（账号的行 0005 已经搬走，预览库这几张表只剩锁屏的旧行）。

**审计事件**（`<接口>-<action>`）：`session-password` / `session-passkey` / `session-tempkey`（只记失败和冷却，成功不记，免得每次解锁写一行）、`reauth-password` / `reauth-passkey`、`password-cooldown`、`reset-recovery-key`、`reset-password-set`、`reset-passkey-add`、`reset-passkey-delete`、`reset-finish-all|none`、`keys-password-set|remove`、`keys-passkey-add|rename|delete`、`session-end-all`、`tempkeys-create|revoke`。

**顺序（和 Gray 的 Secrets Store 那一步）**

1. **Gray（L2 合并前）**：Secrets Store（store `a5a984f3…`，作用域 Workers）按 Q18（已定改名）： 新建 5 个 `SGX_SPACE_PRIVATE` / `SGX_SPACE_PUBLIC`（签名钥匙对：录原值或换一对新的，Gray 自己生成和录入）、`SGX_SPACE_RECOVERY_KEY`（值 **Q8**）、`SGX_SPACE_PASSWORD_PEPPER`、`SGX_SPACE_TEMPKEY_PEPPER`（各一串 `openssl rand -hex 32`；可以直接录刚建的 `SGX_LOCK_*` 那两串，反正还没用过）；**不改名** = 用 Gray 已建好的 `SGX_LOCK_RECOVERY_KEY` / `SGX_LOCK_PASSWORD_PEPPER` / `SGX_LOCK_TEMPKEY_PEPPER` 和现有 `SGX_LOCK_PRIVATE` / `PUBLIC`，什么都不用再建。建完告诉 Hark。缺任何一个，新网关部署后解锁 / reset / 临时钥匙一律 503 `config`。
2. **Hark**：合 L2 → deploy.yml：`deploy-share-worker` 先跑 `0010` → 按 §3.7 第一次部署 `styrigx-space` 并切路由（绑定新名）。
3. **Gray 实测**（cookie 改名，所有设备都回锁屏了）：锁屏上 → `sudo styrigx reset` → 恢复钥匙 → `passwd` 设新的解锁密码 → 选「全部回锁屏」或「不动」→ 用新密码 `sudo styrigx password` 进站。通行密钥照常能用（没换）。再在盾牌里重新发需要的临时钥匙。恢复钥匙输错一次应回 `Sorry, try again.`；回「服务器配置有误」= 没读到新 Secrets，马上回滚。
4. **Gray**：实测通过后在 Secrets Store 删 `SGX_LOCK_SPACE_KEY`、`SGX_PW_PEPPER`；再删 `SGX_LOCK_PRIVATE`、`SGX_LOCK_PUBLIC`、`SGX_LOCK_RECOVERY_KEY`、`SGX_LOCK_PASSWORD_PEPPER`、`SGX_LOCK_TEMPKEY_PEPPER`（后三个从没被部署读过）。（账号早就不用 `SGX_PW_PEPPER` 了，`workers/account/wrangler.toml` 已核对。）
5. **Hark（收尾 PR）**：`0011` DROP 旧表；`deploy-rollback-floor.json` 的 `notBefore` 设到 L2 的部署时间。

---

## 5. 一次性影响

| 影响 | 说明 |
|---|---|
| 已进站的设备 | **全部回锁屏一次**：cookie 名 `sgx-lock-session` → `sgx-space-session`（签名串前缀跟着变）；Q18 改 Secrets 名、换签名钥匙也落在同一次里，不会再多一次。V1 的「不掉线」在 space 模型下做不到，除非新代码同时认旧 cookie（不建议：Gray 18:44 不留兼容） |
| 解锁密码 | 要重设一次（新 pepper）。没有通行密钥的话，部署后锁屏上只能 `sudo styrigx tempkey`（已有临时钥匙也作废了）或 `sudo styrigx reset` |
| 临时钥匙 | 全部作废，拿它进站的会话下一个请求就回锁屏；要的重新发 |
| 分享链接 | 继续能用（链接钥匙没有码，不用 pepper） |
| 正在用的 reauth / reset 票 | 作废一次（3 分钟；reauth 格式加了 `sid`，reset 换了纪元） |
| 恢复钥匙的输错计数 | 搬过去（kind 改名），不清零 |
| `/security/*` 书签 | 301 到首页对应的盾牌层 |
| 部署切换那几分钟 | 账号 Worker 先部署、改读 `X-Styrigx-Space-*` 头，旧网关还在发 `X-Styrigx-Lock-*` → 账号面板这几分钟当成没进站（Q19）；子站接口同理（§3.7） |
| 浏览器里缓存的旧 JS | 调旧接口回 404，刷新就好 |
| 通行密钥在密码管理器里的显示名 | 已注册的照旧显示 `LockKey`（解锁密码的条目同理，Samsung Pass 里要不要手动改名 Gray 定）（`user.name` 只在注册时写）；新注册的用 **Q6** 的名字 |

## 6. 建议的 PR 顺序

| # | 内容 | 要等 Secrets？ |
|---|---|---|
| L1 | **界面改版，用现有接口**：锁屏 `sudo styrigx`（A，`shell/space/*`）、reset 终端（B）、盾牌下拉 + `styrigx@space`（C，`shell/space/*`）、删安全页三页 + 301、删弹层 / 验证行 / 快捷键 / 旧别名、i18n、账号 D、测试（手机视口）。服务端只改两处小的：`/api/lock-reset` 删 needLock（恢复钥匙一把签 reset 票）、分享链接 create 去掉 reauth、管理（list / revoke）保留 reauth（share Worker）。reset 写入不推纪元 + finish 三选一要新的服务端动作，在 L1 里先加到旧 `/api/lock-reset { action:'finish' }`（L2 原样搬家） | 否（旧绑定照用）。绿了就能合 |
| L2 | **网关重构**：§3.1–3.3 全部（目录、接口 13→8、票、纪元、realm 删除、`0010`、新 Secrets / `D1_SPACE`、`ai_limit`、`isTempkeyValid`、死码）；前端只换 `shell/space/api.js`、子站四处路径；Worker 改名和切路由（§3.7）；测试按 §3.5 重排；CI 变量、守卫、退役名单、文档 | **是**：Gray 按 Q18 建好 Secrets、Hark 建好 token `styrigx-space-deploy`、Gray 配好 GitHub 环境 `STYRIGX_SPACE_DEPLOY` 才能合。部署后 Gray 做 §4 第 3、4 步 |
| L3 | 收尾：`0011` DROP 旧表（先给 Gray 清单）、删 §3.6 的一次性脚本和 workflow、回滚下限 `notBefore` | 是（Gray 确认清单） |

L1 先做的理由：L1 不碰任何 Secrets / 绑定，Gray 可以先在手机上验收新界面；L2 是纯后端 + 换 `api.js`，接口和调用方一起改，CI 的 e2e 才对得上（同账号 P2）。如果 Gray 想反过来（先 L2 再 L1），L1 的界面就要在新接口上写，旧页面就不用再碰——工作量差不多，但 L2 合并要等 Secrets，界面验收会被拖住。

## 7. 技术红线（不动）

- `SGX_RP_ID = "styrigx.com"`、`SGX_ORIGIN = "https://styrigx.com"`：值和名字都不动（网关、账号、`space/web/wrangler.toml` 预览段）。改了所有通行密钥失效。
- `space_user_handle.handle` / `legacy_handle`：逐字节照抄（WebAuthn `user.id`，旧通行密钥断言带的就是它）。
- 通行密钥 `credential_id`、record 里的 `publicKey` / `signCount` / `aaguid` / `credId`：原样复制，只归一 `provider` / `name`。
- WebAuthn 校验口径：UP=1、UV=1（注册和断言都要求）、`clientData.origin` 严格等于 `SGX_ORIGIN`、`rpIdHash`、COSE（kty=2、alg=-7、crv=1）、signCount 递增、`excludeCredentials`、断言时核对 userHandle。只搬文件，不改逻辑。
- （V1 的「签名钥匙、签名串前缀不变」这一条在 space 模型下撤掉：cookie 和 Secrets 都改名，所有设备回锁屏一次，见 §5。）
- cookie `sgx-space-session` 的 `Domain=.styrigx.com; SameSite=Lax`（子站要带）；reauth / reset 的 `SameSite=Strict`、不带 Domain。
- 头只改前缀（`X-Styrigx-Lock-*` → `X-Styrigx-Space-*`，后缀 `Session` / `By` / `Tempkey-Id` 和取值白名单不变）；`app.js` 第一步照旧剥掉所有外部 `x-styrigx-*` 头。
- 验收：`git diff main -- '**/wrangler.toml' | grep -E 'SGX_RP_ID|SGX_ORIGIN'` 为空；`config.test.mjs` 断言 `rpId === 'styrigx.com'`；`migration-0010.test.mjs` 比对 user_handle、publicKey 前后逐字节相同；预览 passkey-e2e 跑解锁 + reauth + reset add 各一轮。

## 8. 需要 Gray 定的（每条附建议）

### 沿用 V1（Q1–Q11，建议不变；只把路径 / 名字换成 V2 的，Q6 跟着域词改成 `Space*`）

- **Q1 reset 的三选一**：锁屏上的这台设备没有进站会话（reset 也不签），所以原稿 `[1] 全部设备回锁屏` 和 `[2] 除本机以外` 结果完全一样。**建议两选：`[1] 全部回锁屏`（默认，回车）`[2] 不动`**；不选就离开 = 不动，并提示一行。备选：照原稿保留三项，[2] 的说明写「本机本来就在锁屏上」。
- **Q2 finish 以后还能接着改吗？** 建议**不能**：finish 推 `reset` 纪元，reset 票随之失效（同账号，一张 reset 票只用一轮）；还想改就再 `sudo styrigx reset`。所以三选一放在「第一次改动之后」问，问完还在 reset 终端里会显示「已结束，exit 回锁屏」。备选：finish 只记选择、`exit` 时才真正提交。
- **Q3 临时钥匙 / 分享链接进来的人能发分享链接吗？** 原稿是「分享链接完全不验证」。这样一个拿 30 分钟分享链接进来的人，可以给自己发一条 7 天的新链接，而且作废原来那把钥匙不会连带作废新链接——访问可以无限续下去。**建议：分享链接的新建 / 作废不要 reauth，但只给用解锁密码 / 通行密钥进站的会话（by=password / passkey）；临时钥匙 / 分享链接进来的会话能看列表，不能新建**（快捷面板的「分享本页」对他们显示「用临时钥匙进来的，不能分享」）。配套：分享链接换来的会话 by 记成 `link`（现在记成 `tempkey`，和临时钥匙分不开）。备选：完全照原稿，谁进来都能发。
- **Q4 临时钥匙列表要不要 reauth？** 原稿「临时钥匙（list/new/revoke；要 reauth）」。现在列表只要进站。**建议列表也要 reauth**（层一打开就有「新建」，进层就验一次，不用列表看着、点新建再验）。列表本身不含码，备选：列表只要进站，新建 / 作废时再自动跑 reauth。
- **Q5 「所有设备回锁屏」放哪、改进站凭证要不要自动踢别的设备？** 现在：安全页底部有「锁定所有设备」；改密码 / 删通行密钥时自动推纪元（别的设备全回锁屏，本机重签）。**建议：放在进站凭证层最下面一行（要 reauth）；改进站凭证照现在自动推纪元**（和账号「改钥匙 = 其他设备登出」一致）。备选：改凭证不踢，只靠这一行手动。
- **Q6 密码管理器 / 通行密钥的显示名**：账号是 `AccountPassword` / `AccountPasskey` / `RecoveryKey`。**建议进站用 `SpacePassword` / `SpacePasskey` / `SpaceRecoveryKey`**（V1 建议 `Lock*`；V2 跟着域词改，英文界面「Space Password」对得上。`lib/key-names.js`、WebAuthn `user.name`；已注册的通行密钥照旧显示 `LockKey`，Samsung Pass 里的条目要不要改名你自己定）。备选：`SpacePassword` / `SpacePasskey` / `SpaceRecoveryKey`，和命令 `sudo styrigx` 对上。
- **Q7 恢复钥匙使用记录（旷野 → 服务状态页底部）**：现在 `/api/space-audit` 要进站 + 账号会话（网关问账号 Worker `askAuthorizeFor`）；当初要账号会话是因为要和账号的 `audit-list` 合成一张表，账号那边命名 v2 已经删了 `audit-list`，`apps/space-status.js` 现在也只请求 `/api/space-audit`。**建议：留 `GET /api/space/audit`，只要进站会话，只列进站这一侧**（恢复钥匙使用、解锁密码冷却、reset 改动）。备选：要 reauth；或者整块删。
- **Q8 `SGX_SPACE_RECOVERY_KEY` 的值**：建议**换一把新的**（`openssl rand -hex 32`，存进 Samsung Pass 的 SpaceRecoveryKey 条目）——反正这轮解锁密码、临时钥匙都要重来，旧值以前叫「进站凭证」，在好几个地方当兜底复验输过。备选：沿用旧值，不用改 Samsung Pass。
- **Q9 加通行密钥时的命名**：现在是添加后弹一个命名弹层。终端里没有弹层。**建议：`passkey add` 先在命令行问 `name (回车用设备名):`，再调起系统窗口**；之后改名在进站凭证层的行上点。备选：不问，默认用提供方名，之后再改。
- **Q10 一次性的旧脚本**：`migrate-kv-to-d1.mjs`、`migrate-kv-names.mjs`、`kv-budget.mjs` 的 KV 部分、`d1-cutover.mjs` + `d1-cutover.yml` 都是已经跑完的一次性搬迁。**建议 L3 一起删**（`kv-budget.mjs` 只留 `reset-preview`，改名 `preview-reset.mjs`）。备选：留着当历史，只改绑定名。
- **Q11 `sudo styrigx` 选完以后能不能记住上次的方式？** 建议**不记**（每次都列，和账号一致）。只是确认，不选也行。

### V2 新增（每条附建议）

- **Q12 域词（已定，07:25）**：`space`，和 `account` 同层当主机；`styrigx`（代码 `admin`）是 @ 左边的唯一最高身份。
- **Q13 提示符（已定，07:25–07:34）**：`entry@space:~$`（锁屏，↔ `login@account`）、`styrigx@space:~#`（盾牌命令行，↔ `root@account`，取代 `security@space`）、`reset@space:~#`（↔ `reset@account`）；命令 `sudo styrigx` / `sudo styrigx reauth` / `sudo styrigx reset`。
- **Q14 管理钥匙的代码词**：建议照账号叫 **`keys`**（`/api/space/keys`、`shell/space/keys.js`、`space.keys.*`、审计 `keys-*`、challenge `keys-add`），界面仍叫「进站凭证」。代价：和 `tempkeys` 并排（`/keys` 管密码 + 通行密钥，`/tempkeys` 管临时钥匙），读的时候要分清。备选：`credentials`（V1）。
- **Q15 D1 绑定名（随 Q12 自然定了）**：**`D1_SPACE`**。v2 的两个选项（按域词 / 按库名）在域词定为 `space` 后重合。Worker 只碰 `space_*` 和 `ai_limit`；share / status 的 `D1_SHARE_LINK` / `D1_UPTIME_MONITOR` / `D1_CLOUDFLARE_USAGE` 不动。
- **Q16 D1 库要不要从 `styrigx-space-gateway` 改名 `styrigx-space`？** 建议**这次不改**。D1 没有原地改名：要新建库 → 复制所有表（`space_*`、`share_*`、`status_*`、`ai_limit`、三张迁移记录表）→ 短暂停写 → 改三个 Worker 的绑定（space、share 的 `D1_SHARE_LINK`、status 的 `D1_UPTIME_MONITOR` / `D1_CLOUDFLARE_USAGE`，正式各一处）→ 部署 → 核对 → 删旧库，等于把 11-07 的合库再做一遍（要留着 `d1-cutover.mjs`，和 Q10 的删除冲突）。预览库 `styrigx-test-preview` 不受影响。要改的话放在 L3 之后单独一个 PR。
- **Q17 RPC 入口类和绑定名**：建议 **`AuthVerifier` → `SpaceVerifier`、绑定 `AUTH` → `SPACE`**（照账号 `AccountVerifier` / `ACCOUNT_VERIFIER`），方法 `lockSession()` → `session()`，`conclusion()` 回 `{ space, account }`；`ShareIssuer` / `ISSUER` 不改（它就是给 share 签钥匙的）。share / curio-core / daymark-core 反正要因为 Worker 改名重新部署，类名一起改不多花成本。备选：类名、绑定名都不动，只改 `service =`。
- **Q18 Secrets 改名（已定，Gray 07:40）**：`SGX_LOCK_*` → `SGX_SPACE_*`（5 个：`SGX_SPACE_PRIVATE`、`SGX_SPACE_PUBLIC`、`SGX_SPACE_RECOVERY_KEY`、`SGX_SPACE_PASSWORD_PEPPER`、`SGX_SPACE_TEMPKEY_PEPPER`）。Gray 在 L2 合并前新建；07:04 建的 `SGX_LOCK_*` 作废，切换验证后删。理由：`space` 与 `account` 配一套，`lock` 是过去式。
- **Q19 头改名的那几分钟**：现在的部署顺序是账号 Worker 先、`styrigx-space` 后。账号改读 `X-Styrigx-Space-*` 以后、新 Worker 切路由之前，旧网关还在发 `X-Styrigx-Lock-*`，账号面板会把所有人当成没进站（几分钟）。建议**接受**：那一刻所有人本来就要回锁屏重进（cookie 改名）。备选：账号 Worker 这一版两个头都认，L3 删掉旧名（Gray 18:44 不留兼容，所以不建议）。
- **Q20 `lock`（已定，Gray 07:41）**：`lock` 是过去式。锁屏界面的代码名全部改 entry（`#sgx-entry*`、`.sgx-entry-*`、`body.sgx-entry`、`?entry=1&why=…`，旧 `?lock=1` 兼容读一版）；只保留命令 `lock`（立即锁屏）和「锁屏」文案，因为那是动作。子站同步脚本、e2e 选择器、视觉基线里的选择器跟着改。

## 以后（Gray 2026-11-09 07:47，不在这次范围）

现在只有 Gray 一个人，所以身份只有 `admin`（界面 `styrigx`）。将来要是开放注册、别人也能登录账号，普通身份叫 **`user`**（与 `admin` 并列，`user@space`），到时候临时钥匙甚至可以整套下线。本设计不在任何代码名里占用 `user`，留给那一天；WebAuthn 的 `user handle`（`space_user_handle` 等）是规范术语，不算占用。

## 定稿记录（Gray 2026-11-09 07:54）

「其他都按建议」：Q14 `keys`；Q8 恢复钥匙换新随机值（Gray 建 `SGX_SPACE_RECOVERY_KEY` 时生成）；Q16 D1 库名这次不改；Q17 `AuthVerifier` → `SpaceVerifier`、`AUTH` → `SPACE`，`ShareIssuer` 不改；Q19 接受部署那几分钟；Q1、Q2、Q4、Q5、Q6（`SpacePassword` / `SpacePasskey` / `SpaceRecoveryKey`）、Q7、Q9、Q10、Q11 按建议。只剩 **Q3**（分享链接的创建 / 作废是否只限密码或通行密钥进站的会话，不加 reauth）等 Gray 答复。

## Q3 定稿（Gray 2026-11-09 08:00）：「新建」和「管理」分开

| 对象 | 新建 | 管理（列表 / 改 / 作废） |
|---|---|---|
| 进站凭证（解锁密码、通行密钥，`keys`） | reauth | reauth |
| 临时钥匙（`tempkeys`，明文） | reauth | reauth |
| 分享链接 | 只要有进站会话，不验证；临时钥匙、分享链接进来的人也能发 | 进管理页一律 reauth（不论怎么进站的；reauth 只认解锁密码 / 通行密钥） |
| 锁屏 | 点锁屏或命令行 `lock`：默认只锁当前设备，不验证 | 锁其他设备 / 所有设备回锁屏：reauth（Gray 08:03） |

reauth 只认解锁密码 / 通行密钥，所以用临时钥匙或分享链接进站的人能发链接，但进不了分享链接管理页。这推翻 V1 L11 里「分享链接列表只要进站会话」的写法；`ShareIssuer.checkReauth` 不删，改成只在 list / revoke 上用。

## 环境提示符规则（Gray 2026-11-08 21:57 定，2026-11-09 08:14 确认保留；main 上未做，并入 L1）

除下面四个自带提示符的终端外，全站所有命令行 / 装饰提示符按**账号**登录状态显示：

| 账号状态 | 提示符 |
|---|---|
| 未登录 | `styrigx@space:~$` |
| 已登录 | `root@account:~#` |

自带提示符、不跟这条规则：锁屏 `entry@space:~$`、盾牌 `styrigx@space:~#`、进站 reset `reset@space:~#`、账号下拉 `login@account:~$` / `root@account:~#` / `reset@account:~#`。

main（`6dd63e9`）现状要改的：
- `shell/terminal.js:33` `user:'guest@space'`、i18n `sgx-shell-i18n/{en,zh}.yaml` `user`、标题栏 `guest@space: ~`
- `layouts/_default/wild.html:14`、`layouts/blog/tree.html`（4 处）`guest@space`
- `partials/sgx-ph.html:16`、`daymark/section.html:16` 页头 `styrigx@space:~$`（静态先出未登录版，登录时换）
- `shell-topbar.html:153` `sloan@space:~$ sudo security` → 跟规则，命令改 `sudo styrigx`
- AI 窗：用户行跟规则；回答前的 `gray@space:~$` 是 AI 自己的发言标记，待 Gray 定是否也跟规则
- 实现：一个共享取值（读账号会话状态，`body[data-sgx-account]`），首屏前写好避免闪；`cd` 后路径照旧（`~/blog`）；`:~$` / `:~#` 跟身份走

## Worker / D1 命名定稿与 share 并入 core（Gray 2026-11-09 08:18，取代 07:09 的 `styrigx-space` 与 Q16）

和奇趣、日刻一个模子：站（Pages）`styrigx-space` + 后端 Worker `styrigx-space-core` + 数据 D1 / KV `styrigx-space-core`。

| 项 | 旧 | 新 |
|---|---|---|
| 网关 Worker | `styrigx-auth-gateway`（`workers/auth-gateway/`） | **`styrigx-space-core`**（`workers/space-core/`） |
| share Worker | `styrigx-share`（路由 `styrigx.com/s/*`、`styrigx.com/api/share*`） | **并入 `styrigx-space-core`**：`/s/*` 和 `/api/share` 由 core 自己的 `styrigx.com/*` 路由接；`workers/share/` 删 |
| RPC `ShareIssuer` / 绑定 `ISSUER` | share → 网关 | **删**，改成 core 内直接函数调用（`checkReauth` 变成内部同一套 reauth 校验） |
| RPC `AuthVerifier` / `AUTH` | 子站、账号、share 绑 | `SpaceVerifier` / `SPACE`；只剩奇趣、日刻（和账号如有）绑 |
| D1 | `styrigx-space-gateway`（39d037fe） | **`styrigx-space-core`**，新库、一张迁移记录表 `d1_migrations_core`、新 baseline（网关 + 短链 + 监测表一起）。D1 不能原地改名 → 建新库 + 导出导入 + 换绑定（同 11-07 那套：试跑 → 短暂停写 → 正式搬 → 重新部署 → 核对） |
| KV | `styrigx-space-gateway` | **`styrigx-space-core`**，同一次搬 |
| 其他绑这套库的 | `styrigx-status`（`D1_UPTIME_MONITOR` 等）、搜索索引 KV | Worker 不动，只把绑定换到新库 |
| 部署 | `STYRIGX_AUTH_GATEWAY_DEPLOY`、`STYRIGX_SHARE_DEPLOY` / token `styrigx-auth-gateway-deploy`、`styrigx-share-deploy` | **`STYRIGX_SPACE_CORE_DEPLOY`** / token `styrigx-space-core-deploy`（权限 = 两者之和；Hark 建名字和权限，Gray roll 值、填 GitHub） |
| 回滚下限键 | `styrigx-auth-gateway`、`styrigx-share` | `styrigx-space-core` |

11-07 建过一个 D1 `styrigx-space-core`（84c00172），后来方案改了；现状待 Hark 只读核：空库就直接用，不在就新建。

**PR 顺序（更新）**

| # | 内容 |
|---|---|
| L0 | daymark `set_by 'admin'` → `'grant'`（迁移 `0006`） |
| L1 | 界面改版（含「环境提示符规则」），用现有接口，不碰 Secrets |
| L2 | 后端重构 + Worker `styrigx-space-core` + share 并入；先还连旧 D1 `styrigx-space-gateway`。要 Gray 先建 `SGX_SPACE_*`、配 `STYRIGX_SPACE_CORE_DEPLOY` |
| L2b | D1 / KV 搬到 `styrigx-space-core`（status 一起换绑定），新 baseline 一张迁移表 |
| L3 | 收尾：删 Worker `styrigx-auth-gateway` / `styrigx-share`、旧 token / GitHub 环境、旧 D1 / KV、`SGX_LOCK_*`（都先给 Gray 清单） |

**补充（Gray 08:19）**：`styrigx-status`、`styrigx-ai`、`styrigx-proxy-rules` 和 `styrigx-account` 一样是独立于站的功能，保持独立 Worker，不并进 core。只有 share 并入。status 的数据（`D1_UPTIME_MONITOR` 等，现在在 `styrigx-space-gateway`）搬家时放哪：待 Gray 定。

**定（Gray 08:21）**：status 单独一个 D1 `styrigx-status`（和账号一个做法）；L2b 时监测表从 `styrigx-space-gateway` 搬过去，`styrigx-status` Worker 换绑定。space-core D1 只放网关 + 短链。搜索索引 KV 归属随 L2b 时按谁读写定（网关 / AI 读的放 space-core）。搬家过程中 Cloudflare / GitHub 操作 Hark 直接做，不再确认。

**Secrets（08:33）**：Gray 已建好 5 个 `SGX_SPACE_*`。L2/L2b 部署核对后，Hark 删掉 Secrets Store 里没有代码再读的旧密钥。
