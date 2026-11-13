# 账号命名 v2：照设计稿从上往下定（取代 RENAME-INTERNAL.md）

- 基准：`styrigx/styrigx-space` main `d3a59d8`（#324）+ K2 `refactor/acct-k2-key-names`（#325，`fbd3632`）；也读了没合的 `feat/acct-term-ui`（`23f447d`，`shell/account-term.js`）和 `feat/acct-k4-reset-finish`（`a97f07a`）。只读，没改代码、没推送、没读任何密值。
- 依据：Gray 18:43「各管各的功能 各管各的会话」，18:44 不批 RENAME-INTERNAL（不留兼容、不留旧值），18:45「代码以及仓库的文件名统一修改」「不要有顾虑 大展身手」。只有 §5 的技术红线不动。
- 范围：账号这一侧全部。锁屏侧只查名字有没有撞、有没有串（§2.10），这次不改。

---

## 1. 命名模型（一个概念 = 一个词，到处都用它）

| 概念 | 这个词 | 各处写法 | 不再用 |
|---|---|---|---|
| 账号（这个 Worker 和它的数据） | **account** | Worker `styrigx-account`、`/api/account/*`、cookie 前缀 `sgx-account-`、头 `X-Styrigx-Account-*`、表前缀 `account_`、目录 `shell/account/`、i18n `account.*` | realm、`REALM_ACCOUNT`、`ACCOUNT_DB_REALM` |
| 登录会话（`sudo root` 签发） | **session** | `/api/account/session`、cookie `sgx-account-session`、票 `session`、纪元 `session`、`core/session.js`、i18n `account.session.*` | login、`AccountSessionTicket`、`account-epoch` |
| 再验证（`sudo root reauth`，3 分钟，挂在某个会话上） | **reauth** | `/api/account/reauth`、cookie `sgx-account-reauth`、票 `reauth`（带会话的 deviceId）、`core/reauth.js`、i18n `account.reauth.*` | `AccountReauthTicket`、`reauth:true` 顺手签 |
| 重置（`sudo root reset`，3 分钟，不签会话） | **reset** | `/api/account/reset`、cookie `sgx-account-reset`、票 `reset`、纪元 `reset`、`core/reset.js`、i18n `account.reset.*` | `root-reset`、`AccountResetTicket`、`ROOT_*` |
| 账号密码 | **password** | by `password`、表 `account_password`、限速 kind `password`、`core/password.js`；密码管理器显示名 `AccountPassword`（K2） | `AccountKey` |
| 账号通行密钥 | **passkey** | by `passkey`、表 `account_passkey`、`core/passkey.js`；WebAuthn `user.name` `AccountPasskey`（K2） | `AccountKey` |
| 恢复密钥 | **recovery key** | `recoveryKey` / `RECOVERY_KEY` / `recovery-key`（action、by、限速 kind、文件名）；Secrets `SGX_ACCOUNT_RECOVERY_KEY`；`core/recovery-key.js`；显示名 `RecoveryKey` | root、rootkey、根凭证、根密钥 |
| 管理账号钥匙（界面叫「账号安全」） | **keys** | `/api/account/keys`、`shell/account/keys.js`、i18n `account.keys.*`、审计 `keys-*` | security（**这个词归锁屏 / 盾牌**：`sudo security`、`/security/`、`security-lock.js`） |
| reset 最后一步的登出选择 | **signOut** | `{ action:'finish', signOut:'all'\|'others'\|'none' }`、审计 `reset-finish-<值>`、i18n `account.reset.signOut.<值>` | `reset-signout-*`、`soAll/soOthers/soNone` |
| 审计 | **audit** | 表 `account_audit`、列 **`event`**、`core/audit.js`、`writeAudit(event)`；事件名 = `<功能>-<动作>` | `path` 列、`writeRootAudit`、`writeSecurityEvent`、`SECURITY_EVENTS` |
| 设备 | **device(s)** | 表 `account_device`、`/api/account/devices`、`core/devices.js` | `account-devices` |
| 应用授权 | **grant(s)** | 表 `account_grant`、`/api/account/grants`、`core/grants.js` | `app_grant`、`app-grant` |
| 验证用的哪把钥匙 | **by** | 值只有 `password` / `passkey` / `recovery-key` | `root` |
| 票的签名钥匙 | **signing** | `signingReady()`；Secrets 名 `SGX_ACCOUNT_PRIVATE/PUBLIC` 不变（和锁屏 `SGX_LOCK_PRIVATE/PUBLIC` 平行） | `accountKeysReady`（读起来像 AccountKey） |
| 进站会话（网关签发的凭证，锁屏侧的概念） | **进站会话**（代码：gateway） | 账号 Worker 只读网关写的结论头 `X-Styrigx-Lock-Session: 1`（头名跨 Worker，不改）：`lib/gateway.js`（原 `lib/lock-identity.js`）、`passedGateway(headers)`（原 `hasLockSession`）。注释 / 文档 / 测试一律写「进站会话」；盾牌上的用户可见文案等锁屏那轮 | 进门、锁屏会话、`lock-identity`、`hasLockSession` |

**root 的规则**：root 只出现在用户看得见的地方：终端命令 `sudo root …`、提示符 `root@account:~#`、help 和「已登录（root）」这类文案。内部代码不出现 root，前端只有 `shell/account/commands.js` 里一个命令字常量 `ROOT_COMMAND = 'root'`。

**撞名检查**：`reauth` / `reset` / `session` / `passkey` / `password` 锁屏侧也有（`lock-reauth`、`lock-reset`、锁屏会话……）。规则：两边共用的地方一律加域前缀（cookie `sgx-account-*` / `sgx-lock-*`，头 `X-Styrigx-Account-*` / `-Lock-*`）；账号的代码只放在 `workers/account/`、`shell/account/` 里面，目录本身就是前缀。`security` 只给锁屏用。

---

## 2. 旧 → 新（按层）

### 2.0 会话现在哪里互相顶替，怎么拆开（「各管各的会话」）

| # | 现在的顶替 | 位置（main + K2） | 拆法 |
|---|---|---|---|
| C1 | **有会话、没 reauth 票时，reset 票顶 reauth 票**，能改密码、增删通行密钥 | `api/account.js:466-477` | 管理钥匙只在 `/api/account/keys`，只认 reauth 票；reset 自己的操作在 `/api/account/reset`，只认 reset 票。两个接口共用 `core/password.js` / `core/passkey.js` 做写入，但验票各验各的 |
| C2 | 没会话时，reset 票进的是**同一个管理分支**，靠票里 `by` 区分；前端按 `sessBy==='root'` 换标题、锁改名 | `api/account.js:434-441`；前端 `apps/account-security.js:127,175,260,263,393,407-410` | 同 C1：reset 是一个单独的面板 `shell/account/reset.js`；`by==='root'` 的判断全部删 |
| C3 | **一次验证签两张票**：登录带 `reauth:true` 时，同时签 session 和 reauth | `api/account.js:341-344, 416-419`；前端 `account-methods.js` `opts.reauth`，以及 `apps/account.js:144`、`account-apps.js:162`、`account-security.js:54` | `/api/account/session` 只签 session；reauth 只能从 `/api/account/reauth` 拿（**Q1**） |
| C4 | 结束一个会话时连带清了别人的：`logout` 清 reset 票，`reauth-clear` 也清 reset 票 | `api/account.js:266-284` | `session end` 清 session 和 reauth（reauth 挂在会话上，会话没了它也没了）；`reauth end` 只清 reauth；`reset end` 只清 reset |
| C5 | 三张票**共用一个纪元** `account-epoch`；`rotateAccount` 推纪元后，用的是哪张短票就重签哪张（`reissueTicketWithEpoch`），所以 reset 票的死活跟着会话事件走 | `core/realm.js:33`、`api/account.js:482-489`、`core/account-session.js:301` | 分成两个纪元：`session`（管 session 和 reauth）、`reset`（只管 reset 票，`finish` 时 +1，所以 reset 票只能用一次）。账号安全页改钥匙时，只重签本机的 session 和 reauth |
| C6 | reset 票下改密码、删通行密钥会**自动登出其他设备**（main）；K4 改成推迟了，但还是在同一个分支里判断 | `api/account.js:530-551`；K4 `deferRotate` | reset 下的写操作都不碰会话，只有 `reset finish {signOut}` 决定登出（K4 并进来）。`finish` 读一下本机会话，只是为了知道 `others` 要留哪台设备，不拿它当凭证 |
| C7 | reauth 票没绑会话：票里只有 `by.epoch.iat.exp` | `core/realm.js:78-86` | reauth 票加 `deviceId`，验的时候要求同一台设备的会话有效。代码一眼能看出「reauth = 某个会话的 3 分钟提权」 |
| C8 | 通行密钥 challenge 用途共用：登录和再验证都是 `login`，账号安全页添加和 reset 添加都是 `register` | `core/realm.js:105` | 用途按入口分开：`session` / `reauth` / `keys-add` / `reset-add`。一个入口签的 challenge，别的入口用不了 |
| C9 | 账号和锁屏**共用一个 pepper** `SGX_PW_PEPPER` | `workers/account/wrangler.toml`（`SGX_PW_PEPPER`）、`lib/password.js:42` | 账号单独用 `SGX_ACCOUNT_PASSWORD_PEPPER`（**Q2**）；锁屏那边的改名等锁屏那轮 |
| C10 | 预览库 `styrigx-test-preview` 里，账号和锁屏的行在**同一批表**里（`epoch`、`password`、`passkey`、`device`、`audit`……），只靠 `realm` 列分开 | 账号 `migrations/0003`、网关 `0006_auth_state.sql` | 账号的表全部改名 `account_*`，去掉 `realm` 列（和 `share_*`、`status_*` 同一种写法） |
| C11 | 锁屏在调账号模块：锁屏凭证页的门和锁屏复验弹层，都在用 `auth/account-methods.js` 的 `renderAccountMethods` / `accountSubmitters` | `apps/security-lock.js:24,674`、`auth/lock-reauth.js:15,85` | 渲染部分改成中性的 `auth/verify-rows.js`（`renderVerifyRows`），锁屏传自己的提交函数；账号的提交函数搬进 `shell/account/session.js`、`reauth.js` |
| C12 | `auth/reset-flow.js` 锁屏重置和账号重置共用一个流程，靠 `keyKind:'space'\|'root'` 切换 | `auth/reset-flow.js:7,40`、`apps/account-reset.js:40` | 账号重置搬进 `shell/account/reset.js`（终端写法），`reset-flow.js` 只剩锁屏用（锁屏那轮再改名） |

**入口 × 票（目标态）**

| 接口 | 要什么 | 签 / 清什么 |
|---|---|---|
| `GET /api/account` | 进站会话 | 只读：`{ ok, configured:{password,passkey}, signing, session, reauth, reset }` |
| `/api/account/session` | 进站会话 | 签 / 清 session（清的时候连 reauth 一起清） |
| `/api/account/reauth` | 进站会话 + session | 签 / 清 reauth（绑 deviceId） |
| `/api/account/reset` | 进站会话；拿到 reset 票以后只认 reset 票 | 签 / 清 reset；`finish` 推 `reset` 纪元，按 signOut 推 `session` 纪元 |
| `/api/account/keys` | session + reauth（`passkey-list` 只要 session） | 改了钥匙：推 `session` 纪元，本机 session 和 reauth 重签，删其他设备行（现有 `rotateAccount` 的语义） |
| `/api/account/devices` | session（`revoke-all` 还要 reauth） | — |
| `/api/account/grants` | session（`add` 还要 reauth） | — |

### 2.1 API action 名

| 旧 `POST /api/account {action}` | 新 |
|---|---|
| `login-challenge` | `/session {passkey-challenge}`；再验证用 `/reauth {passkey-challenge}` |
| `login-passkey`（带 `reauth:true`） | `/session {passkey}`；`/reauth {passkey}` |
| `login-password`（带 `reauth:true`） | `/session {password}`；`/reauth {password}` |
| `logout` | `/session {end}` |
| `reauth-clear` | `/reauth {end}`（不再清 reset） |
| `root-reset { key }` | `/reset {recovery-key, key}` |
| `reset-finish { signOut }`（K4） | `/reset {finish, signOut}` |
| —（新） | `/reset {end}` |
| `password-change` | `/keys {password-set}`；`/reset {password-set}` |
| `passkey-list` | `/keys {passkey-list}`；`/reset {passkey-list}` |
| `passkey-register-challenge` / `passkey-register` | `/keys {passkey-add-challenge}` / `{passkey-add}`；`/reset` 同名 |
| `passkey-delete` | `/keys {passkey-delete}`；`/reset {passkey-delete}` |
| `passkey-rename` | `/keys {passkey-rename}`（reset 没有，#324 Q1 已定） |
| `device-list` / `device-revoke` / `device-revoke-all` | `/devices {list}` / `{revoke}` / `{revoke-all}` |
| `grant-list` / `grant-revoke` / `grant-add` | `/grants {list}` / `{revoke}` / `{add}` |
| `audit-list` | **删**（前端没调用，**Q3**）。审计照写 |
| 请求字段 `reauth:true` | 删 |
| 错误码 `401 account` / `403 reauth` | 保留：词和概念对得上。另加 `401 reset`（reset 票无效），不再借用 `401 account`（K4 现在回的是 account） |

网关转发表 `/api/account` 本来就按前缀转（`workers/auth-gateway/src/router.js:72,86`），子路径不用改网关，只改账号 Worker 的 `router.js` `API_ROUTES`。

### 2.2 票、by、cookie

| 旧 | 新 | 说明 |
|---|---|---|
| `ACCOUNT_SESSION_TICKET='AccountSessionTicket'`、`ACCOUNT_REAUTH_TICKET`、`ACCOUNT_RESET_TICKET`、`TICKETS{…}` | `TICKET.session` / `TICKET.reauth` / `TICKET.reset`（`core/config.js`，键就是票名） | 网关里本来就禁止出现账号票名（check-layers 规则 16），把禁止的名单换成新名 |
| `BY_ROOT='root'` | `BY_RECOVERY_KEY='recovery-key'` | reset 票只会是这个值 |
| `BY_PASSWORD` / `BY_PASSKEY` | 不变 | |
| 票内容：session `by.epoch.authAt.exp.deviceId`；reauth / reset `by.epoch.iat.exp` | session 不变；reauth `by.epoch.iat.exp.deviceId`；reset 不变（纪元改成 `reset`） | 签名串还是 `<cookie>|<内容>`，签名格式统一放进 `lib/ticket.js` |
| `ACCOUNT_EPOCH='account-epoch'` | `EPOCH.session='session'`、`EPOCH.reset='reset'` | 见 C5 |
| `SHORT_TICKETS`、`SHORT_TICKET_MAX_AGE`、`issueShortTicket`… | `TICKET_MAX_AGE.reauth/reset = 180`；`issueTicket(name)` / `verifyTicket(name)` / `clearTicket(name)` 一套函数 | 不再分长票、短票两套 |
| cookie `sgx-account-session` / `-reauth` / `-reset` | **不变** | 已经是「账号 + 入口名」，对得上 |
| `realmCookie` / `realmClearCookie` / `realmPrivateKey` / `realmPublicKey` / `REALM_ACCOUNT` / `ACCOUNT_DB_REALM` / `ROOT_REALM` / `GRANT_DB_REALM` / `realmOf` | 删；cookie 拼法放进 `lib/ticket.js`，库访问放进 `lib/db.js`，都不带 realm 参数 | 账号 Worker 只有一个域，realm 是网关时代留下来的 |

### 2.3 Worker 模块、函数、常量（`workers/account/src/`）

| 旧文件 | 新文件 | 主要改名 |
|---|---|---|
| `api/account.js`（单入口，650 行） | `api/account/status.js`（GET）、`session.js`、`reauth.js`、`reset.js`、`keys.js`、`devices.js`、`grants.js`，加上公共的 `api/account/_request.js`（进门、同源、读 body、IP） | `handlePost` → 每个文件各有一个 `onRequestPost`；`MGMT`、`isDeviceAction`、`resetOk`、`ticketName`、`deferRotate` 都删；`rotateAccount` → `core/session.js` `rotateSessions({ keepDeviceId })` |
| `core/realm.js` | `core/config.js` | 留 `TICKET`、`EPOCH`、cookie 名、`CHALLENGE_PURPOSE`、`rpConfig`、`KEY_ACCOUNT_PASSKEY` |
| `core/account-session.js` | `core/session.js`（签 / 验 / 清 session、`rotateSessions`、`touchDevice`）+ `core/reauth.js` | `verifyAccountSession` → `verifySession`；`issueAccountSession` → `issueSession`；`clearAccountSession` → `endSession`；`bumpAccountEpoch` / `getAccountEpoch` → `bumpEpoch(name)` / `readEpoch(name)`；`accountKeysReady` → `signingReady`；`accountConfigMissing` → `signingMissing`；`accountSessionOpts` → `sessionOpts`；`isAccountBy` → `isSessionBy`；`signAccountSessionTicket` / `parseAccountSessionTicket` → `lib/ticket.js` `signTicket` / `parseTicket` |
| `lib/tickets.js` | `lib/ticket.js` | `*ShortTicket*` → 去掉 Short |
| `core/account-root.js` | `core/reset.js`（打开 reset、`finish`）+ `core/audit.js` | `handleRootAction` → `openReset`；`ROOT_ACTIONS` 删；`handleAuditList` / `AUDIT_SHOW` 删（Q3）；`MIN_DELAY_MS` / `padTo` → `core/recovery-key.js` |
| `lib/root-check.js` + `lib/root-limit.js` | `core/recovery-key.js`（一份：限速 + 比对） | `rootChecker` / `checkRootCredential` → `checkRecoveryKey`；`rootLimiter` / `checkRootLimit` / `recordRootFail` / `clearRootFail` → `recoveryKeyLimit()` / `recordRecoveryKeyFail` / `clearRecoveryKeyFail`；`ROOT_IP_MAX_FAIL` / `ROOT_GLOBAL_*` → `RECOVERY_KEY_*`；`KIND='rootkey'` → `'recovery-key'`；`opts.global=false`（给假入口用的）删 |
| `lib/root-audit.js` | `core/audit.js` | `rootAuditor` / `writeRootAudit` / `listRootAudit` 加 `account-root.js` 里的 `writeSecurityEvent` / `listAudit` → 一个 `writeAudit(env, ip, event, ok)`；`SECURITY_EVENTS` → `AUDIT_EVENTS`；`decoy` / `via` 删；保留期统一 30 天（现在恢复密钥是 7 天、安全事件是 30 天） |
| `lib/crypto.js` `normalizeRootKey` | 搬到 `core/recovery-key.js`，叫 `normalizeRecoveryKey` | |
| `core/account-store.js` | `core/passkey.js`（通行密钥 + user handle）；建表语句搬到 `lib/db.js` | `ACCOUNT_AUTH_SCHEMA` → `ACCOUNT_SCHEMA`；`storeReady` → `dbReady`；`getPasskeys` 等名字不变；`PASSKEY_DISPLAY_NAME` 不变；`LEGACY_PROVIDER_NAMES` / `LEGACY_DEFAULT_NAMES` 删（§2.6 用 SQL 一次改好） |
| `lib/password.js` + `lib/password-limit.js` | `core/password.js` + `core/password-limit.js`（这两个只有账号在用） | `verifyRealmPassword(env, realm, …)` → `verifyPassword(env, …)`；`PEPPER_SECRET` → `'SGX_ACCOUNT_PASSWORD_PEPPER'`；`passwordLimiter(env, realm, ip)` → `passwordLimit(env, ip)` |
| `core/account-devices.js` | `core/devices.js` | 函数名不变 |
| `core/app-grant.js` | `core/grants.js` | `APP_GRANT_SCHEMA` → 并进 `ACCOUNT_SCHEMA`；`SEED_MARK` / `SEED_SUPPLEMENTS` / `ensureSeed` / `ensureSupplements` / `readGrantState().seeded` 删（§3） |
| `core/authz.js` | `core/authorize.js` | 函数名和结论形状 `{ok,reason,deviceId,scopes,reauth}` 不变 |
| `lib/d1-state.js` | `lib/db.js` | `authDb` / `onAuthDb` / `withSchema` → `db` / `onDb` / `withSchema`；`*PasskeyRecord` / `*PasswordRecord` / `userHandleRecord` 搬进对应的 core 文件；`realm` 参数全删 |
| `lib/passkey-verify.js` | `lib/webauthn.js` | `consumeChallenge` / `issueChallenge` 改成按用途 `purpose` 分 |
| `lib/http.js` | 不变；删掉错误码 `same-as-lock` / `same-as-account` 的残留（K1 已删一部分，确认没有了） | |
| `lib/lock-identity.js` | `lib/gateway.js` | `hasLockSession` → `passedGateway`（「有没有进站会话」） |
| `gate.js`、`router.js`、`secrets.js`、`rpc/account-service.js`、`rpc/account-verifier.js` | 文件名不变（`rpc/` 的文件名就是入口类名） | `AccountVerifier.accountSession()` 和网关 `askAccountSession` / `askAccountSessionFor` **删掉**（P2 实施时定：唯一的调用方是网关 `gate.js isAccountPage` 给旧账号整页的首帧提示，整页 #327 已删）；网关只留 `askAuthorize` |
| `secrets.js` `SECRET_NAMES` | 换成新的 Secrets 名 | |
| `migrations/0001-0004` | 不动（已经执行过的历史迁移） | 新加 `0005_account_tables.sql`（§2.6） |

### 2.4 跨 Worker（网关 ↔ 账号 ↔ 子站）

| 名字 | 结论 |
|---|---|
| `X-Styrigx-Account-Session` / `-Device` / `-Scopes` / `-Reauth`、`ACCOUNT_CONCLUSION_PREFIX`、`writeAccountConclusion` | **保留**：就是「账号的会话 / reauth 结论」，和词表一致 |
| 网关服务绑定 `ACCOUNT` / `ACCOUNT_VERIFIER`，入口类 `AccountService` / `AccountVerifier` | **保留** |
| RPC `accountSession()` | 改成 `session()`（见上） |
| `data-sgx-account-session="in|out"`（网关 `gate.js:64`） | **保留** |
| 网关 `gate.js` `isAccountPage`（`/account/`、`/zh/account/`） | 跟着 UI 改版走：整页不要了（OPEN O1），这个函数可以删，或者改成判断「打开账号面板」的入口 |
| 子站 `workers/curio-core`、`daymark-core` 的 `_auth.js`、`share/src/auth.js` | 只读结论头，不用改 |

### 2.5 绑定 / Secrets（Cloudflare）

| 旧 | 新 | 理由 |
|---|---|---|
| Secrets `SGX_ACCOUNT_ROOT_KEY`（binding 同名） | **`SGX_ACCOUNT_RECOVERY_KEY`** | root 不出现在内部 |
| 账号 Worker 绑的 `SGX_PW_PEPPER`（和网关共用） | **`SGX_ACCOUNT_PASSWORD_PEPPER`**（账号独占） | C9（Q2） |
| `SGX_ACCOUNT_PRIVATE` / `SGX_ACCOUNT_PUBLIC` | 不变 | 三张票共用一对签名钥匙没问题：签名串带 cookie 名，三张票互相冒充不了；名字和锁屏的 `SGX_LOCK_PRIVATE/PUBLIC` 平行 |
| D1 绑定 `D1_WELLBEING` / `D1_SETTINGS_SYNC` / `D1_ACCOUNT_AUTH`（三个名字指向同一个库 `styrigx-account`） | **一个 `D1_ACCOUNT`** | 一个东西只叫一个名字；功能靠表名分开（`wb_daily`、`settings_sync`、`account_*`）。改到 `api/prefs.js`、`api/wellbeing.js` |
| KV 绑定 `KV_PROFILE`（键 `profile`、`avatar:*`、`avatar:ver`） | 不变 | 是个人资料 / 头像的数据，名字对 |
| `SGX_RP_ID` / `SGX_ORIGIN` | **不动**（红线） | |

**Gray 要在 Cloudflare 做的事**（按 2026-10-18 的约定，密值 Gray 自己搬，Hark 不碰）：
1. **P2 合并前**：Secrets Store（账号和网关用的那个 store `a5a984f3…`）→ 新建 `SGX_ACCOUNT_RECOVERY_KEY`，值 = 现在的恢复密钥（就是 Samsung Pass 里那把，和 `SGX_ACCOUNT_ROOT_KEY` 同一个值；想顺便换一把也可以，换了就把新值存进 Samsung Pass 的 RecoveryKey 条目）。作用域选 Workers。
2. **P2 合并前**：新建 `SGX_ACCOUNT_PASSWORD_PEPPER`，值 = 一串新的随机值（比如 `openssl rand -hex 32`）。不要复制 `SGX_PW_PEPPER`（Q2 按建议选的话）。
3. **P2 部署绿了、`sudo root reset` 实测能用以后**：在 Secrets Store 删掉 `SGX_ACCOUNT_ROOT_KEY`。**不要删** `SGX_PW_PEPPER`，网关还在用。
4. 怎么验证读到了新绑定：生产部署后，在已解锁的设备上跑一次 `sudo root reset`，故意输错一次。回 `Sorry, try again.` = 读到了；回「服务器配置有误」= 没读到，马上回滚。
- 部署 token 已经有 Secrets Store 编辑权限，不用改。D1 / KV / Worker 资源一个都不用新建、不用改名。

### 2.6 D1 存储（表、列、值）和一次性迁移

**表名对照**（全部在 `styrigx-account` 库；预览库 `styrigx-test-preview` 同一份）

| 旧表（`realm='account'`） | 新表 | 列的变化 |
|---|---|---|
| `epoch(realm, value)` | `account_epoch(name, value)` | 行：`session`（复制旧的 `account` 那行的值）、`reset`（从 0 开始） |
| `password(realm, record)` | `account_password(id=1, record)` | 单行 |
| `passkey(realm, credential_id, record)` | `account_passkey(credential_id, record)` | record 原样复制，只把显示用的 `provider` / `name` 归一 |
| `user_handle(realm, handle, legacy_handle)` | `account_user_handle(id=1, handle, legacy_handle)` | **值逐字节照抄**（红线） |
| `challenge(realm, id, purpose, …)` | `account_challenge(id, purpose, challenge, expires_at)` | 不复制（5 分钟就过期）；用途换成新值 |
| `attempt_limit(realm, kind, bucket, …)` | `account_attempt_limit(kind, bucket, …)` | `rootkey` → `recovery-key` |
| `device(realm, device_id, …)` | `account_device(device_id, …)` | |
| `audit(realm, id, ts, ip_prefix, ok, decoy, via, path, expires_at)` | `account_audit(id, ts, ip_prefix, ok, event, expires_at)` | `path` → `event`；`decoy` / `via` 删 |
| `app_grant(app, record, granted_at)` | `account_grant(app, record, granted_at)` | 改表名 |
| `data_migration(name, migrated_at)` | 删 | 只剩授权种子标记和旧迁移脚本在用（§3） |
| `settings_sync`、`wb_daily` | 不变 | 是设置同步、数字健康的数据，名字已经说清楚了 |

**`workers/account/migrations/0005_account_tables.sql`**（部署 job 的 `d1 migrations apply` 会跑；生产和预览各跑一次）：

```sql
-- 账号表改名 account_*，去掉 realm（命名 v2）。旧表留着，只删 realm='account' 的行：预览库里网关的锁屏行也在这些表里。
CREATE TABLE account_epoch (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT INTO account_epoch (name, value) SELECT 'session', value FROM epoch WHERE realm = 'account';
INSERT OR IGNORE INTO account_epoch (name, value) VALUES ('session', 0), ('reset', 0);

CREATE TABLE account_password (id INTEGER PRIMARY KEY CHECK (id = 1), record TEXT NOT NULL);
-- Q2 选「新 pepper」：不复制（旧哈希用新 pepper 验不过，密码算「没设置」，重设一次）。
-- Q2 选「沿用旧 pepper 的值」：改成执行下面这行
-- INSERT INTO account_password (id, record) SELECT 1, record FROM password WHERE realm = 'account';

CREATE TABLE account_passkey (credential_id TEXT PRIMARY KEY, record TEXT NOT NULL);
INSERT INTO account_passkey (credential_id, record) SELECT credential_id, record FROM passkey WHERE realm = 'account';
UPDATE account_passkey SET record = json_set(record, '$.provider', CASE json_extract(record, '$.provider')
  WHEN 'Samsung Pass' THEN 'samsung-pass' WHEN 'Google 密码管理器' THEN 'google-password-manager'
  WHEN 'Apple 密码' THEN 'apple-passwords' WHEN 'iCloud 钥匙串' THEN 'icloud-keychain'
  WHEN 'Microsoft 密码管理器' THEN 'microsoft-password-manager' WHEN 'Windows Hello' THEN 'windows-hello'
  WHEN '1Password' THEN '1password' WHEN 'Bitwarden' THEN 'bitwarden'
  ELSE json_extract(record, '$.provider') END);
UPDATE account_passkey SET record = json_set(record, '$.name', '') WHERE json_extract(record, '$.name') IN
  ('通行密钥', 'Samsung Pass', 'Google 密码管理器', 'Apple 密码', 'iCloud 钥匙串', 'Microsoft 密码管理器', 'Windows Hello', '1Password', 'Bitwarden');

CREATE TABLE account_user_handle (id INTEGER PRIMARY KEY CHECK (id = 1), handle TEXT NOT NULL, legacy_handle TEXT NOT NULL DEFAULT '');
INSERT INTO account_user_handle (id, handle, legacy_handle) SELECT 1, handle, legacy_handle FROM user_handle WHERE realm = 'account';

CREATE TABLE account_challenge (id TEXT PRIMARY KEY, purpose TEXT NOT NULL, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL);

CREATE TABLE account_attempt_limit (kind TEXT NOT NULL, bucket TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, strikes INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, PRIMARY KEY (kind, bucket));
INSERT INTO account_attempt_limit SELECT CASE kind WHEN 'rootkey' THEN 'recovery-key' ELSE kind END, bucket, count, strikes, locked_until, window_start, expires_at
  FROM attempt_limit WHERE realm = 'account';

CREATE TABLE account_device (device_id TEXT PRIMARY KEY, record TEXT NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL);
INSERT INTO account_device SELECT device_id, record, last_seen, revoked_at, expires_at FROM device WHERE realm = 'account';

CREATE TABLE account_audit (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, ip_prefix TEXT NOT NULL, ok INTEGER NOT NULL, event TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX account_audit_ts ON account_audit (ts);
INSERT INTO account_audit (id, ts, ip_prefix, ok, event, expires_at)
  SELECT id, ts, ip_prefix, ok, CASE path
    WHEN 'root-reset' THEN 'reset-recovery-key'
    WHEN 'password-change' THEN 'keys-password-set'
    WHEN 'passkey-register' THEN 'keys-passkey-add'
    WHEN 'passkey-delete' THEN 'keys-passkey-delete'
    WHEN 'passkey-rename' THEN 'keys-passkey-rename'
    WHEN 'device-revoke' THEN 'devices-revoke'
    WHEN 'device-revoke-all' THEN 'devices-revoke-all'
    WHEN 'login-password-cooldown' THEN 'password-cooldown'
    WHEN 'reset-signout-all' THEN 'reset-finish-all'
    WHEN 'reset-signout-others' THEN 'reset-finish-others'
    WHEN 'reset-signout-none' THEN 'reset-finish-none'
  END, expires_at
  FROM audit WHERE realm = 'account' AND path IN ('root-reset','password-change','passkey-register','passkey-delete','passkey-rename',
    'device-revoke','device-revoke-all','login-password-cooldown','reset-signout-all','reset-signout-others','reset-signout-none');
  -- 'root-reauth' 这类旧行不迁（K1 起已经没有这个入口）

ALTER TABLE app_grant RENAME TO account_grant;
DROP TABLE data_migration;

DELETE FROM epoch WHERE realm = 'account';  DELETE FROM password WHERE realm = 'account';
DELETE FROM passkey WHERE realm = 'account'; DELETE FROM user_handle WHERE realm = 'account';
DELETE FROM challenge WHERE realm = 'account'; DELETE FROM attempt_limit WHERE realm = 'account';
DELETE FROM device WHERE realm = 'account';  DELETE FROM audit WHERE realm = 'account';
```

- **生产收尾（P4，Hark 做，先给 Gray 看一遍要删的清单）**：生产库 `styrigx-account` 里那 8 张旧表到这时已经是空的，执行 `wrangler d1 execute styrigx-account --remote --command "DROP TABLE epoch; DROP TABLE password; DROP TABLE passkey; DROP TABLE user_handle; DROP TABLE challenge; DROP TABLE attempt_limit; DROP TABLE device; DROP TABLE audit;"`。预览库**不能 DROP**，那里网关的锁屏行还在这些表里，等锁屏那轮改 `lock_*` 时一起处理。
- 新的事件名（`AUDIT_EVENTS`）：`session-<by>`、`reauth-<by>`（成功 / 失败都记，`ok` 列区分）、`password-cooldown`、`reset-recovery-key`、`reset-password-set`、`reset-passkey-add`、`reset-passkey-delete`、`reset-finish-all|others|none`、`keys-password-set`、`keys-passkey-add`、`keys-passkey-delete`、`keys-passkey-rename`、`devices-revoke`、`devices-revoke-all`、`grants-add`、`grants-revoke`。规则 = `<接口>-<action>`，看事件名就知道是从哪个入口做的。
- challenge 用途：`session` / `reauth` / `keys-add` / `reset-add`（C8）。限速 kind：`password`、`recovery-key`。限速按**钥匙**算，不按入口算（session 和 reauth 输错的是同一把密码，所以共用一个计数，这不算串）。
- 运行时兜底建表（`ACCOUNT_SCHEMA`，`withSchema`）同步换成新表。

### 2.7 CI / 测试变量

| 旧 | 新 | 在哪 |
|---|---|---|
| `PREVIEW_TEST_ACCOUNT_ROOT_KEY`、`account_root_key` | `PREVIEW_TEST_ACCOUNT_RECOVERY_KEY`、`account_recovery_key` | `.github/workflows/deploy.yml:712-878,963-969` |
| `SGX_TEST_ACCOUNT_ROOT_KEY` | `SGX_TEST_ACCOUNT_RECOVERY_KEY` | deploy.yml:794,969、`ci-local.sh:128`、`preview-helpers.cjs:9,45-97`、`passkey/passkey.spec.js:19-22` |
| `--account-root-key`、`ACCOUNT_ROOT_KEY` | `--account-recovery-key`、`ACCOUNT_RECOVERY_KEY` | deploy.yml:775、`ci-local.sh:115-117`、`preview-emulator.cjs:6,34-55,336`、`preview-helpers.cjs:540`、`account-challenge.spec.js:18` |
| 预览要写的密值 `SGX_ACCOUNT_ROOT_KEY`、`SGX_PW_PEPPER`（账号那一半） | `SGX_ACCOUNT_RECOVERY_KEY`、新的 `SGX_ACCOUNT_PASSWORD_PEPPER`（每次现生成，`PREVIEW_TEST_ACCOUNT_PASSWORD_PEPPER`） | deploy.yml:870-878、`preview-worker.js:12,29`、`preview-emulator.cjs` |
| 守卫清单（技术名 grep、预览打码 forbidden、check-layers 规则 16） | 换成新名字；旧名字只在一份「退役名单」里出现一次（见 §3） | deploy.yml:79,178-182,1004、`space/scripts/check-layers.mjs:32,165-180`、`check-layers.test.mjs:305-357` |
| 测试固定值 `ROOT_KEY`、`'test-account-root-key-…'`、`'e2e-test-account-root-key'`、`'edge-test-account-root-key-…'`、`signTicket(…,'AccountResetTicket','root',…)` | `RECOVERY_KEY`、`'test-account-recovery-key-…'` 等；`signTicket(…, 'reset', 'recovery-key', …)` | `tests/workers/account/_identity.mjs:27,45,96`、`cred-e2e-helpers.cjs:158,257`、`edge-harness.cjs:156` |
| 测试文件 | 见 §2.9 | |

### 2.8 前端（以 `feat/acct-term-ui` 为准；旧整页由 UI PR 删掉，不给它们改名）

| 旧 | 新 |
|---|---|
| `shell/account-term.js`（1193 行，没合） | `shell/account/term.js`（终端外壳、输入、历史）、`commands.js`（`sudo root …`、help，`ROOT_COMMAND`）、`session.js`、`reauth.js`、`reset.js`、`keys.js`、`devices.js`、`grants.js`、`profile.js` |
| `shell/avatar-edit.js` | `shell/account/avatar-edit.js` |
| `auth/account-api.js`（`ACCOUNT_API`、`postJSON`、`errText`） | `shell/account/api.js`：每个接口一个对象，比如 `session.password(pw)`、`reauth.passkey()`、`reset.recoveryKey(k)`、`reset.finish(signOut)`、`keys.passwordSet(pw)`… |
| `auth/account-methods.js`（`visibleKinds`、`accountSubmitters`、`renderAccountMethods`，锁屏也在用） | 渲染部分 → `auth/verify-rows.js`（`renderVerifyRows`、`visibleKinds`，中性）；账号的提交函数 → `shell/account/session.js` / `reauth.js`（C11） |
| `apps/account-common.js` `signalAccountName` | `shell/account/passkey-signal.js` `signalPasskeyName` |
| `apps/account-reset.js`、`auth/reset-flow.js` 的 `keyKind:'root'` 分支 | 删，换成 `shell/account/reset.js`（C12） |
| `lib/key-names.js`（`KEY_ACCOUNT_PASSWORD` / `KEY_ACCOUNT_PASSKEY` / `KEY_RECOVERY`） | 文件不变；`KEY_RECOVERY` → `KEY_RECOVERY_KEY`，和词表一致 |
| GET 状态字段 `ready` | `signing`；`password` / `passkey` → `configured.password` / `configured.passkey` |
| i18n `data/sgx-shell-i18n/{zh,en}.yaml` 的 `acct:` 块 | 改成 `account:`，按功能分子块：`account.common.*`（signOut、back…）、`account.session.*`（`guestLine`→`lead`、`already`、`notSignedIn`、`cantSignIn`、`noMethod`、`noConfig`→`noSigning`）、`account.reauth.*`（`reauthLead`→`lead.keys`、`reauthLeadApps`→`lead.grants`、`reauthLeadDev`→`lead.devices`、`reauthOk`→`ok`、`reauthEnded`→`ended`）、`account.reset.*`（`resetLead`→`lead`、`rkAria`→`recoveryKeyAria`、`resetCool`→`cooldown`、`soAll/soOthers/soNone`→`signOut.all/others/none`、`soSame`/`soDone`/`soKept`/`soPending`→`signOut.same/done/kept/pending`）、`account.keys.*`（`security`→`title`（显示还是「账号安全」）、`secHint`→`hint`）、`account.devices.*`、`account.grants.*`（`apps`→`title`）、`account.profile.*`、`account.help.*`（`helpRoot`→`session`、`helpReauth`→`reauth`、`helpReset`→`reset`、`keyMap3`→`keyMap`；`keyMap` 两钥匙版删） |
| `data/i18n/{zh,en}.yaml` 的 `account*`、`accountSecurity`、`accountApps`、`accountDevices`、`accountProfile`、`accountSync`、`sgxAccountCard`、`js.account.*`（含 `rfRoot*`、`errWrongRoot`、`byRoot`） | 跟旧整页一起删（UI PR）。锁屏页还在用的那几个键（见 §2.10）搬到 `securityLock.*` |
| 旧整页：`layouts/_default/account*.html`、`content/account*.md`（含 zh）、`entries/entry-account*.js`、`apps/account*.js`、`partials/account-i18n.html`、`sgx-account-card.html`、`account-app-icons.html` | UI PR 删（OPEN O1）；`/account/*` 地址只留跳转，跳到首页并打开账号面板对应的那一层。`account-app-icons.html` 新面板要是还用应用图标，就挪到 `partials/shell/account-app-icons.html` |
| `shell-topbar.html` 的 `[2] accountkey` 等 | K3 / UI PR 已经按 v3 改了 |

### 2.9 文件 / 目录：旧 → 新（全部）

**Worker**：见 §2.3（`api/account.js` 拆成 `api/account/*.js` 七个文件加 `_request.js`；`core/realm.js`→`core/config.js`；`core/account-session.js`→`core/session.js` + `core/reauth.js`；`core/account-root.js`→`core/reset.js` + `core/audit.js`；`lib/root-check.js` + `lib/root-limit.js`→`core/recovery-key.js`；`lib/root-audit.js`→`core/audit.js`；`core/account-store.js`→`core/passkey.js`；`lib/password.js`→`core/password.js`；`lib/password-limit.js`→`core/password-limit.js`；`core/account-devices.js`→`core/devices.js`；`core/app-grant.js`→`core/grants.js`；`core/authz.js`→`core/authorize.js`；`lib/d1-state.js`→`lib/db.js`；`lib/tickets.js`→`lib/ticket.js`；`lib/passkey-verify.js`→`lib/webauthn.js`）。

**Worker 测试 `tests/workers/account/`**

| 旧 | 新 |
|---|---|
| `account-root.test.mjs` | `reset.test.mjs` + `recovery-key.test.mjs` |
| `account-auth-scaffold.test.mjs` | `config.test.mjs`（删掉和网关 `realms.js` 逐字段比对的部分） |
| `account-identity.test.mjs` | `session.test.mjs`（删掉网关签名兼容）+ `rp.test.mjs`（`rp.id === 'styrigx.com'` 断言保留） |
| `account-worker.test.mjs` | 按接口拆：`api-session.test.mjs`、`api-reauth.test.mjs`、`api-reset.test.mjs`、`api-keys.test.mjs`、`api-devices.test.mjs`、`api-grants.test.mjs` |
| `app-grant.test.mjs` / `authz.test.mjs` | `grants.test.mjs` / `authorize.test.mjs` |
| `account-entrypoints.test.mjs` | `entrypoints.test.mjs` |
| `_identity.mjs` | `_fixtures.mjs` |
| `migrate-account-auth.test.mjs`、`migrate-prefs.test.mjs` | 删 |
| 新加 | `migration-0005.test.mjs`（在内存库里跑 0005：迁移前后的行数、`rootkey`→`recovery-key`、事件名映射、user_handle 逐字节相同、预览库里锁屏行不被碰） |

**前端测试**

| 旧 | 新 |
|---|---|
| `tests/space/e2e/topbar/acct-sec-pop.spec.js` | `tests/space/e2e/account/term-*.spec.js`（session / reauth / reset / keys 各一个） |
| `tests/space/e2e/passkey/account-challenge.spec.js` | `tests/space/e2e/passkey/account-passkey.spec.js` |
| `tests/space/e2e/account/account.spec.js`、`account-apps.spec.js`、`account-profile.spec.js`、`avatar-edit.spec.js`、`dialog-kb.spec.js` | 跟旧整页一起删 / 重写成 term 测试（UI PR） |
| `tests/space/e2e/account/reauth-return.spec.js`、`reauth-verify.spec.js`、`b1-12-guard.spec.js`（测的是锁屏：`lock-passkey`、`lock-reauth`） | 搬到 `tests/space/e2e/lock/`（§2.10） |
| `tests/space/ui/account/account-signal.test.mjs` | `passkey-signal.test.mjs` |
| `tests/space/ui/account/account-grants.test.mjs`、`apps-row-icon.test.mjs` | `grants.test.mjs`、`grants-icon.test.mjs` |
| `tests/space/ui/account/frontend-session.test.mjs`、`eye-row-feedback.test.mjs`、`ai-model.test.mjs` | 看 UI PR：测旧页的删；`frontend-session` 改成 `session-state.test.mjs` |

**脚本 / 文档**：`space/scripts/migrate-account-auth.mjs`、`migrate-prefs-kv-to-d1.mjs` 删；`workers/account/README.md` 照新结构重写；`docs/auth-state-machine.md` 账号那段、`docs/status-apis.md:48-51`、`docs/architecture.md:77,135-146`、`STRUCTURE.md:112`、`wrangler.toml` 注释改成新词。博客旧文章（`2026-10-11-key-spec-whitepaper-v2*`）是历史记录，不动。

**资源和路径（判断）**

| 名字 | 结论 |
|---|---|
| Worker / D1 / KV `styrigx-account` | **保留**：就是账号，和词表一致，改了还得在 Cloudflare 重建资源，换不来什么 |
| `/api/account`（GET）、`/api/account/*` | **保留并细分**：子路径就是入口名（§2.1） |
| `/api/profile`、`/api/avatar`、`/api/prefs`、`/api/wellbeing`、`/avatar/*` | **保留**：是不同的功能，不是账号身份，不并进 `/api/account/` |
| `/account/*` 页面地址 | **只留跳转**（UI PR，OPEN O1）：子站 `?return=` 和书签还会用到 |
| cookie `sgx-account-*` | **保留**：已经符合词表 |

### 2.10 锁屏侧：只列名字不对、或者在用账号东西的地方（这次不改）

| 地方 | 问题 |
|---|---|
| `apps/security-lock.js:24,674`、`auth/lock-reauth.js:15,85` | 调的是 `renderAccountMethods`（C11）。账号这边改成中性的 `auth/verify-rows.js` 以后，这两处只改 import，可以跟 P3 一起做 |
| `layouts/_default/security-tempkeys.html:141` | 引用了 `partials/account-i18n.html`（锁屏页拿账号的字符串表）。删旧账号页之前，要先把它用到的键搬到 `securityLock` / `securityTempkeys` |
| `apps/app-gate.js:63-64,126-132,541-542`、`security-lock.js:97-99` | `account-configured`、`same-as-account` 死码（PROPOSAL X7 / X8） |
| `auth/reset-flow.js` | 账号分支删掉以后只剩锁屏在用，以后改名 `lock-reset-flow.js` |
| 网关的表 `epoch` / `password` / `passkey` / `user_handle` / `challenge` / `attempt_limit` / `device` / `audit`（`realm='lock'`） | 以后改成 `lock_*`。那时预览库的这几张旧表才能 DROP |
| 网关 `SGX_PW_PEPPER` | 以后改成 `SGX_LOCK_PASSWORD_PEPPER` |
| 测试 mock `{ keys: [], scope: 'root' }`（`b1-12-guard.spec.js:39,72,144`、`reauth-return.spec.js:33,76,128,165`、`visual.spec.js:128`） | 服务端早就不回 `scope` 字段了，旧词 |
| `reauth-return.spec.js:512-587` 用例标题「AccountKey 联动」 | 测的是锁屏最后一把钥匙，跟 AccountKey 无关 |
| SpaceKey 的测试值 `'root-key'`、`'test-root-key'`、`'root-key-1'`（`visual/lock.spec.js:365-413`、`lock/lock-reset-pk-busy.spec.js:114`、`reauth-verify.spec.js:74,161`） | 应该叫 `space-key` |
| 网关注释：`api/space-auth.js:6`、`core/space-check.js:14`、`lib/crypto.js:49`、`secrets.js:15`、`core/realms.js:6,113`、`migrations/0006_auth_state.sql:24` | 还写着「账号根密钥」`SGX_ACCOUNT_ROOT_KEY`、`SGX_ROOT_KEY`、`realm 'root'`。P2 改账号 Secrets 名的时候，这几处注释顺手改（只改注释） |
| `space/scripts/migrate-kv-names.mjs` + `tests/workers/auth-gateway/kv-migration.test.mjs` | 一次性的 `root-auth-*` KV 改名，已经跑完了，死脚本 |
| 盾牌 `sec-lockkey` 文案「不能和账号密码相同」 | OPEN O22 |

---

## 3. 直接删的死东西

- `space/scripts/migrate-account-auth.mjs` + `tests/workers/account/migrate-account-auth.test.mjs`（网关 → 账号库的一次性搬迁，PR4 cleanup 已跑完）。
- `space/scripts/migrate-prefs-kv-to-d1.mjs` + `tests/workers/account/migrate-prefs.test.mjs`（2026-10-29 旧键已删），连同 `wrangler.toml`、`api/prefs.js`、`0002` 里提到它的注释。
- 授权种子：`SEED_MARK`、`SEED_SUPPLEMENTS`、`ensureSeed`、`ensureSupplements`、`grantedScopes` 里「没种子 = 全部作用域」的分支、`grant-list` 先跑种子那一步、`data_migration` 表。以后授权只看 `account_grant` 里的行。
- `LEGACY_PROVIDER_NAMES`、`LEGACY_DEFAULT_NAMES`、`normalizeProvider` 认旧显示名的分支（0005 用 SQL 一次改好）。
- `decoy` / `via` 审计标记、`recordRootFail({global:false})`（给假入口用的，账号 Worker 没有假入口）、`listRootAudit`。
- `ROOT_ACTIONS`、`rootIssues`、`rootKey` 域字段、`BY_ROOT`、`REALM_ACCOUNT` 及所有 realm 参数、`ACCOUNT_DB_REALM`、`ROOT_REALM`、`GRANT_DB_REALM`。
- `reauth:true` 登录参数（Q1）、`audit-list`（Q3）、`MGMT` 分支、`deferRotate`、K4 的 `RESET_SIGNOUT` 搬进 `core/reset.js`。
- 和网关逐字段比对 / 签名兼容的测试（`account-auth-scaffold.test.mjs:20` 起 import 网关的 `realms.js`，`account-identity.test.mjs` 用网关的签名函数签票）。不再要求和网关的格式一致。
- 前端：`accountSubmitters().root` 的残留、`by==='root'` 分支（`account-security.js`）、`keyKind:'root'`、`KEY_RECOVERY` 旧名、旧整页（UI PR）。
- 退役名单只留一份：`SGX_ROOT_KEY`、`SGX_ACCOUNT_ROOT_KEY`、`D1_ROOT_AUTH`、`REALM_ROOT`、`AccountKey`、`root-reset`、`rootkey`、`accountKeysReady` 等，统一放进 `space/scripts/retired-names.json`，由 check-layers / deploy.yml 共同读取，各处不再各自抄一份。

---

## 4. 一次性影响（Gray 已表示可以接受）

| 影响 | 说明 |
|---|---|
| 正在用的 reauth / reset 票作废一次 | 都只有 3 分钟；reauth 票格式加了 deviceId |
| 登录会话**不会**掉 | session 票格式、cookie、签名钥匙都没变，0005 把纪元值复制过去了。想让所有设备都重新登录一次，就把 0005 第 2 行改成复制 `value + 1`（可选） |
| 账号密码要重设一次（Q2 按建议选的话） | 换了新 pepper：用通行密钥登录 → `sudo root reauth` → 重设密码；两种都用不了就 `sudo root reset` |
| 正在进行的通行密钥 challenge 作废 | 5 分钟 |
| 应用授权 | 生产要是还没写过种子标记（从没打开过授权页、也没在登录后检查过授权），删掉种子逻辑以后，所有应用都显示未授权，在同意卡里逐个重新授权（每个要 reauth 一次）。生产有没有标记我没法从外面看到 |
| 审计 | 旧行按映射迁过去；`root-reauth` 这类旧行不迁 |
| 部署那几分钟 | 0005 比新代码先跑，旧代码会有一小段时间读不到表；浏览器里缓存的旧 JS 发旧 action 会回 400。刷新就好 |
| 密码管理器 | 显示名 `AccountPassword` / `AccountPasskey` / `RecoveryKey` 是 K2 定的，这次不变 |
| 预览库 | 旧表里锁屏的行原样留着；账号的行搬进 `account_*` |

## 5. 真正的技术红线（不是命名问题，一律不动）

- `SGX_RP_ID = "styrigx.com"`、`SGX_ORIGIN = "https://styrigx.com"`：值和变量名都不动（账号和网关的 `wrangler.toml`）。`rp.id` 改了，所有通行密钥都失效。
- `user_handle.handle` / `legacy_handle` 的值（= WebAuthn `user.id`，旧通行密钥断言时带的就是它）：0005 只换表，值逐字节照抄。
- 通行密钥 `credential_id`、record 里的 `publicKey` / `signCount` / `aaguid` / `credId`：原样复制，只改显示用的 `provider` / `name`。
- 验收：`git diff main -- '**/wrangler.toml' | grep -E 'SGX_RP_ID|SGX_ORIGIN'` 为空；`rp.test.mjs` 的 `rp.id === 'styrigx.com'` 断言还在；`migration-0005.test.mjs` 比对 user_handle 和 publicKey 前后逐字节相同；预览 passkey-e2e 注册 + 登录各跑一轮。

## 6. 建议的 PR 顺序

| # | 内容 | 动 Cloudflare？ |
|---|---|---|
| P0 | **#325（K2）照原样合**：它定的用户可见名字（AccountPassword / AccountPasskey / RecoveryKey）在 v2 里不变；它内部的常量名到 P2 再统一改。`feat/acct-k4-reset-finish` **不单独开 PR**，并进 P2 | Gray 在 Secrets Store 新建两个条目（§2.5 第 1、2 步） |
| P1 | UI 改版 `feat/acct-term-ui`：**合之前直接写成** `shell/account/*` 的拆法和新的 i18n 键（§2.8），删旧账号整页，`/account/*` 改成跳转。这时还调旧 API | 否 |
| P2 | 账号 Worker：新目录结构、API 按入口拆、会话拆开（C1-C10）、reset finish（K4 并进来）、0005 迁移、`D1_ACCOUNT` 绑定、新 Secrets 名、CI / 测试变量、守卫和退役名单、§3 的死码；前端 `shell/account/api.js` 在同一个 PR 里切到新接口（接口和调用方一起改，CI e2e 才对得上）；顺手改网关里提到旧名的注释和 RPC `session()` | 部署时 0005 自动跑；合并后 Gray 实测 §2.5 第 4 步 |
| P3 | 前端中性化：`auth/account-methods.js` → `auth/verify-rows.js`（锁屏只改 import）、锁屏页用到的 `account-i18n` 键挪走、测试文件改名 / 搬家（§2.9）、文档重写 | 否 |
| P4 | 收尾：Hark 把生产库里 8 张空的旧表 DROP 掉（先给 Gray 一份清单确认）；Gray 删 Secrets `SGX_ACCOUNT_ROOT_KEY` | 是 |

P2 改动最大，但只能一起改：接口、票、表、绑定、测试分开合的话，CI 会挂。按 2026-11-08 04:57 的规则（只覆盖 UI 改版系列）我不会自己合 P2 / P4。这两个 PR 要不要绿了我就直接合，等 Gray 一句话。

## 7. 需要 Gray 定的（每条附建议）

- **Q1 登录还要不要顺手签 reauth？** 建议**不签**（C3）。代价：从奇趣 / 日刻第一次授权某个应用时，`sudo root` 登录完还要再 `sudo root reauth` 一次，只有第一次授权才会这样。备选：只有同意卡这一处保留「一次验证签两张票」。
- **Q2 账号密码的 pepper**：建议**新建一个独立的值**（`SGX_ACCOUNT_PASSWORD_PEPPER`，账号密码要重设一次），两边彻底分开。备选：用新名字但值抄 `SGX_PW_PEPPER`，密码不用重设，但两边的值还是同一个。
- **Q3 `audit-list`**：建议**删掉这个接口**（前端没有地方调用，审计照写，要看可以直接查 D1）。备选：保留成 `/api/account/audit {list}`，要 session + reauth。
