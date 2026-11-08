# Styrigx Space 架构：分层规范

> 状态：现行 ｜ 最后更新：2026-11-06

> 2026-10-10 定稿（Gray 确认）。3.0 起长期生效。
> 参照 Linux：上层只能调用下层，不能跨层，也不能自己重新实现下层的职责。

## 模型

space（styrigx.com）相当于 One UI，子站 blog、daymark、curio（`styrigx.com/<站>/`）相当于其中的 App。
锁屏属于系统层，管住所有站点。

## 唯一状态源

是否已解锁，只由服务端签发的 `sgx-lock-session` 会话决定
（`Domain=.styrigx.com; Path=/`）。
任何站点、任何页面都不得用 sessionStorage、localStorage、
前端内存或标签页状态另做判断。

## 分层

### L0 内核·业务与通用件：`workers/auth-gateway/src/core/` + `src/lib/`
- `core/`：凭证、会话、票据和它们的存储——锁屏域配置 `realms.js`（只有 `REALM_LOCK`）、锁屏会话 `lock-session.js`（Ed25519 签名/验签，格式 `by.role.epoch.exp.tempkeyId.sig`；`checkLockSession` 给 RPC `AuthVerifier` 用）、
  锁屏短票 `tickets.js`、D1 认证状态 `d1-state.js`、密码 / 通行密钥 / 进站凭证（`password.js`、`password-limit.js`、`passkey-store.js`、`passkey-verify.js`、`space-check.js`、`space-limit.js`、`space-audit.js`）、输错计数 `attempt-limit.js`、临时钥匙 `lock-tempkey.js`、
  凭证管理门槛 `lock-manage.js`、锁屏是否已配置 `lock-configured.js`、重置开关 `lock-reset-switch.js`、回跳校验 `return.js`、无会话写接口限流 `anon-limit.js`、
  转发帮手 `forward.js` 与身份头 `lock-identity.js`、问账号 Worker 的 `account-rpc.js`、短链钥匙 `link-keys.js`。
- `lib/`：与业务无关的通用件（`crypto.js`、`cookies.js`、`http.js`、`security-headers.js`、`csp-hashes.js`）。
- 账号拆分 PR3 起这里没有账号的东西：账号会话、账号短票、`REALM_ACCOUNT` 都在账号 Worker（`workers/account/src/core/`）；网关要知道账号会话是否有效时只经 `core/account-rpc.js` 调账号 Worker 的 `AccountVerifier.accountSession()`。
- 不改写页面：HTML 会话标记、公开页清单在 L1 的 `src/gate.js`。
- 2026-10-30 起没有跨 Worker 的共享目录：账号、分享、chat、search-index 各自一份需要的通用件；每个 Worker 只能 import 自己目录下的文件，账号和网关互相不许 import（`space/scripts/check-layers.mjs` 规则 14、15，见下面「Worker 边界」）。

### L1 内核·权限：`workers/auth-gateway/src/gate.js`
- **页面和 `/api/*` 进门时决定是否已解锁的只有这一个文件**（2026-11-02 由原 `functions/_middleware.js` 和 `src/subsites.js` 合成），两个调用点（都在 `src/app.js`）：
  主站路径走 `onRequest`（原 `_middleware`），子站路径前缀 `styrigx.com/blog/`、`/curio/`、`/daymark/` 走 `handleSubsite`（原 `subsites`）；
  （旧图志域名进门前的 301 `atlasRedirect` 已于 P4-3 PR-1 删除。）
  两处都用 L0 同一个 `verifyLockSession`，没有第二套判断。每个页面请求都在这里判断会话。
- 这是粗粒度的门（有没有会话、什么角色、哪些路径公开）；L2 的处理函数可以按角色再验一次（例如 `api/lock-tempkey.js` 再要求锁屏进门会话），
  用的也是 L0 同一份 `lock-session.js`，不另写判断。
- 首页 `/` 和 `/en/` **不再无条件白名单**：照常返回页面，但把
  已锁/已解锁状态注入 HTML（`<html data-sgx-lock-session="valid|locked">`），
  前端不用猜。
- 受保护页面返回 `Cache-Control: private, no-store`（防浏览器缓存绕过锁屏）。
- `/api/*` 不走锁屏跳转，未登录返回 401 JSON。

### L2 系统调用：`workers/auth-gateway/src/api/*`（路由表 `src/router.js`）
- 解锁：`lock-password`、`lock-passkey`（进门会话）、`lock-tempkey-unlock`（临时码 → 临时钥匙进门的会话，by=tempkey）。
- 查询：`lock-session-check`、`lock-credentials`、`lock-entry`（锁屏上显示哪些入口，无需会话）、`space-audit`（进站凭证使用记录）。`layer-status` 已删除（PR3，前端无调用方）。
- 账号：`/api/account`、`/api/prefs*`、`/api/avatar*`、`/api/wellbeing*`、`/api/profile*`、`/avatar/*` 不在这一层：网关 `src/gate.js` 验门后经服务绑定 `ACCOUNT` 转给账号 Worker（转发表 `src/router.js` 的 `FORWARDING`，见下面「账号会话」）。
- 锁屏凭证页的再验证：`lock-reauth`（LockReauthTicket 状态 / 清票）；由 `lock-passkey`/`lock-password`（`reauth:true`）或 `space-auth`（`purpose:'lock-reauth'`）签 3 分钟 LockReauthTicket `sgx-lock-reauth`（SGX_LOCK_* 签）。
- 进站凭证（`SGX_LOCK_SPACE_KEY`）：`space-auth { key, purpose }`，purpose 只有 `lock-reauth` / `lock-reset`，各签一张 3 分钟锁屏短票（by=space），不签任何会话；`space-audit` 只读进站凭证使用记录。账号根密钥 `SGX_ACCOUNT_ROOT_KEY` 在账号 Worker（`POST /api/account { action:'root-reset' }`，只签 reset 票；2026-11-08 删 `root-reauth`），两套互不相干、各自计数。
- 重置与临时钥匙：`lock-reset`（丢了锁屏凭证：先交进站凭证，再按重置开关或锁屏凭证（`needLock` / `lockProof`）签 LockResetTicket；不读账号的任何东西）、`lock-tempkey`（旷野 → 安全 → 临时钥匙页 `/security/tempkeys/`的列表 / 新建 / 作废；只认锁屏进门会话，不问账号会话）。
- 网关只有 4 个密钥：锁屏签名钥匙 `SGX_LOCK_PRIVATE` / `SGX_LOCK_PUBLIC`、进站凭证 `SGX_LOCK_SPACE_KEY`、密码 pepper `SGX_PW_PEPPER`（与账号 Worker 共用同一个密值）。账号签名钥匙 `SGX_ACCOUNT_*` 和 `SGX_ACCOUNT_ROOT_KEY` 只在账号 Worker（stepup、应用凭证已删除）。
- 锁定：`lock-now`（清除 `Domain=.styrigx.com` 的 `sgx-lock-session`，子站一起上锁）、`lock-all-devices`（Lock 纪元 +1，所有设备一起上锁；要 LockReauthTicket）。
- 其他：`geo`（Cloudflare 给的城市 / 坐标 / 时区）；`status` 只做门，验锁屏会话后经服务绑定转给 styrigx-status（`chat`、`search` 在 P4-2b 退役，回 404）。
- 站内对话助手（P4-1）：`ai`（`POST /api/ai`）验同源、进门（不要账号会话），过两档 AI 限流（`core/ai-limit.js`：每 IP 每分钟 6 次走 Rate Limiting 绑定 `AI_LIMITER`，超了 429 `cooldown`；全站每分钟 60 次走 D1 `attempt_limit`（`realm='ai'`、`kind='global'`、bucket = 当前分钟）单条 upsert，超了或 D1 出错 429 `busy`），再写账号结论头，经服务绑定 `AI_SERVICE` 转给 styrigx-ai，SSE 原样流回。
- 前端改变会话只能通过这些接口。

### L3 共享库：`assets/js/lib/`（util、storage、events、scheduler、i18n、theme 等）
- 通用能力，不得包含鉴权逻辑：`lib/` 里不出现鉴权接口地址（`/api/lock-*`、`/api/root-*`、`/api/account`）和 `navigator.credentials`。
- `storage` 只存偏好（主题、天气等），**禁止存解锁状态**。

### L3½ 鉴权与凭证流程：`assets/js/auth/`
- 锁屏 / 账号的凭证界面和请求：`auth-flow`（密码框、再验证请求）、`auth-sheet`（登录方式弹层 / 验证弹层）、
  `cred-rows`（凭证验证行）、`reset-flow`（重置登录）、`account-methods`、`account-api`（`/api/account` 客户端）、
  `passkey-assert`（WebAuthn 断言：全站五处断言都经 `getPasskeyAssertion` + `assertionOptions` / `assertionToJSON`）、
  `passkey-register`（通行密钥注册 + 命名弹层，锁屏凭证页与账号安全页共用）、`lock-now`（立即锁定）。
- 只能 import `lib/` 和 `auth/`；`shell/`（lock.js、upgrade.js、quick-panel.js）和 `apps/` 用它。

### 依赖方向（`space/scripts/check-layers.mjs`，CI 必过）
- 前端：`lib` ← `auth` ← `shell` ← `apps` ← `entries`，只能向左 import；前端不 import `space/web/assets/js/` 以外的文件。
- Worker：骨架和依赖链见 [`workers/README.md`](../workers/README.md)（脚本不查 Worker 内部的依赖方向，只查下面的边界和骨架防回退）。
- 相对 import 解析不到文件也算失败。

### Worker 边界（`space/scripts/check-layers.mjs` 规则 14-21，CI 必过）
- 14：每个 Worker 只能相对 import 自己目录 `workers/<名字>/` 下的文件，Worker 之间（账号 ↔ 网关、短链、chat 等）一律不许 import；非相对 import 只认 `cloudflare:workers`。
- 15：不许出现 `workers/shared` 目录（2026-10-30 删除；通用件每个 Worker 各自一份）。
- 16：网关源码（`workers/auth-gateway/` 下的 `.js` / `.mjs` / `.cjs` 和 `wrangler.toml`，注释除外）不许出现账号鉴权标识：`SGX_ACCOUNT_*`、`SGX_ROOT_KEY`、`D1_ACCOUNT_AUTH`、`D1_ROOT_AUTH`、`REALM_ACCOUNT`、`REALM_ROOT`、`checkAccountSession`、`verifyAccountSession`、`Account*Ticket` / `ACCOUNT_*_TICKET` 等（完整列表在脚本的 `GATEWAY_ACCOUNT_AUTH_RE`）。网关只经 `ACCOUNT_VERIFIER.accountSession()` / `authorize()` 拿账号结论（字段名用 `account.reauth` 这类，不写账号票名）。
- 17：账号 Worker 的 `workers/account/wrangler.toml` 不许有路由（`[[routes]]`、`route = …`、非空的 `routes = [...]`；`[env.preview]` 的 `routes = []` 允许），账号请求只经网关的服务绑定进来。
- 18–21：Worker 骨架防回退（`workers/**` 没有 `functions/`、`_kernel/`；`main = "src/index.js"`；每个 Worker 有 `README.md`；`package.json` 有 `name`），各条见 [`workers/README.md`](../workers/README.md)。

### L4 桌面环境·One UI：nav、goodlock、lock.js、sheet、capsule
- 锁屏拆两块（2026-10-26）：`lock-guard.js` 在每页的 core 里，只读 L1 给出的状态（`data-sgx-lock-session`）、
  绑自动锁定、做去处判定；locked / unknown 时先同步盖不透明遮罩（fail closed），再 `import()` 锁屏界面 `lock.js`
  （加载失败遮罩不撤，只给重新加载）。旧的升级验证层 `upgrade.js` 已在 P2-3 删除（进门二值）；锁侧复验弹层 `auth/lock-reauth.js` 按需加载。
- `lock.js` 只负责两件事：
  1. 画锁屏；
  2. 把密码或通行密钥提交给 L2。
- 删除 `sessionStorage['sgx-lock-shown']` 及所有按标签页判断的逻辑。

### L5 应用：`apps/*.js` + `entries/entry-*.js`
- 一个页面一个入口，不自己实现鉴权，只调 `auth/`。
- 打包（2026-10-24）：所有入口在 `layouts/partials/sgx-js-batch.html` 里一次 `js.Batch`（esbuild ESM + 代码分割），
  共享代码（core 及其依赖）拆成一个内容哈希命名的 chunk，各页共用、换页走缓存；入口 fingerprint，静态依赖的 chunk 由 baseof 输出 `modulepreload`。
  新加入口要登记进 baseof 的入口列表（`tests/space/ui/build/js-split.test.mjs` 检查）。
  旷野页（/）走 `entry-space.js`、旷野子页走 `entry-space-sub.js`（P4-3 PR-4b 起主站只有一个顶级页，原顶栏三栏入口 `entry-tab-*` / `lazy-*` 和页内切换删除）。
  首帧前必须跑的（主题、语言、布局、防闪）仍是 `<head>` 里的同步内联脚本，不进模块。

### L6 外部 App：子站 styrigx.com/blog/、/curio/、/daymark/
- 合并 PR3 起三站和主站是同一个 Pages 项目 `styrigx-space` 里的一棵树，各占一个路径 `/blog/`、`/curio/`、`/daymark/`，代码在本仓库；2026-11 合站起三站和主站是同一个 Hugo 站（`space/web/` 下的 `content|layouts|assets|static/<站>/`），一次构建。
  旧图志域名的 301 跳转已于 P4-3 PR-1 删除，该域名下线。
- 子站页面由网关（`workers/auth-gateway/src/gate.js` 的 `handleSubsite`，按路径前缀）验同一份锁屏会话，Pages 不持任何钥匙。
- 未解锁时 302 到 space 锁屏并带完整 return。
- 子站的接口 `styrigx.com/daymark/api/*`、`/curio/api/*` 归本仓库的两个接口 Worker `styrigx-daymark-core`、`styrigx-curio-core`（`workers/daymark-core`、`workers/curio-core`；atlas 上的旧接口路由过渡期保留）；门内操作（daymark 记句子、curio 改收藏）由它们经服务绑定 `AuthVerifier` 再问网关。

## 一致性规则

1. **已锁**（无/无效/过期会话）：打开主站或任一分站任意页面，都先出锁屏。
   分站 302 到 space 锁屏，保留完整 return 地址。
2. **已解锁**（会话有效）：打开主站或任一分站任意页面，都直接进入；
   新标签页、刷新、内页都不再出锁屏。
3. 不允许同一浏览器同一时刻，一个站要解锁、另一个站直接进。

## 账号会话（账号域）

原「锁屏凭证」升级为账号体系，账号会话与锁屏会话**是两套独立的票据**：

- 锁屏会话 `sgx-lock-session`（`Domain=.styrigx.com`）只回答「是否已解锁」，
  是唯一的解锁状态源；它**从不**被当作账号认证。
- 账号会话 `sgx-account-session`（无 Domain，只发给主站；`HttpOnly; Secure; SameSite=Strict`；400 天，不点退出就一直登录）
  由账号 Worker 的 `workers/account/src/core/account-session.js` 签发与验证，格式 `by.epoch.authAt.exp.deviceId.sig`，
  用 `SGX_ACCOUNT_PRIVATE / SGX_ACCOUNT_PUBLIC`（Ed25519，PKCS8 / SPKI PEM，只绑在账号 Worker）签名。
  凭证域定义在 `workers/account/src/core/realm.js` 的 `REALM_ACCOUNT`。
- 请求路径（账号拆分 PR3）：浏览器 → 网关（验锁屏门、剥外来 `x-styrigx-*` / `x-sgx-*` 头、按验过的锁屏会话写 `X-Styrigx-Lock-*` / `X-Styrigx-Client-*`）
  → 服务绑定 `ACCOUNT` → 账号 Worker 命名入口 `AccountService`。账号 Worker 没有公开路由，默认 fetch 一律 404。
  网关只有账号页首帧提示还要账号会话结论，经 `ACCOUNT_VERIFIER`（`AccountVerifier.accountSession()`）问账号 Worker；临时钥匙、短链只认锁屏进门会话，短链 Worker 不绑账号 Worker。
- 登录入口两者平级：账号通行密钥、账号密码；前置条件是已解锁的 锁屏进门会话。账号根密钥（恢复密钥）不签账号会话。
- 敏感操作（注册/删除账号通行密钥、修改账号密码）要求有效的 3 分钟 AccountReauthTicket `sgx-account-reauth`
  （进「账号安全」子页前再验一次，离开即作废；会话还在时也认 AccountResetTicket），没有票返回 403 `reauth`，前端重新验证。
- 改账号密码 / 删账号通行密钥时 `account-epoch` +1，其他设备的账号会话失效，当前设备重签。
- 存储（账号拆分 PR3 起在 D1 `styrigx-account`，账号 Worker 的绑定 `D1_ACCOUNT_AUTH`，各表 `realm = 'account'`；网关库里的旧行已在 PR4 删除）：
  `password`、`passkey`、`user_handle`、`challenge`、`epoch`、`device`（已退出的 `revoked_at > 0`）；
  「已配置」由凭证推出；账号密码登录限速在 `attempt_limit`（`kind = 'password'`，规则同锁屏密码）。
- 缺账号钥匙 → 账号登录 503 `config`，只影响账号登录与进门，网站其余部分不受影响。
- 敏感操作还包括重命名账号通行密钥（`rename`，同样要 AccountReauthTicket，不推纪元）。
- 概念名（2026-11-08 三钥匙，不再有 `AccountKey` 统称）：账号密码在密码管理器里的隐藏用户名 `AccountPassword`；账号通行密钥注册时 WebAuthn `user.name = AccountPasskey`（原 `OwnerKey` → `AccountKey`，只是显示名，`user.id` / 凭证不变）；恢复密钥 `RecoveryKey`（原 `RootKey`）；
  通行密钥记录不再有 class 字段（键名已表明域）。`list` 返回账号 handle，
  前端支持时调 `PublicKeyCredential.signalCurrentUserDetails` 让密码管理器把旧条目改名
  （只对当前 handle `account-user-id`；旧 handle 与 LockKey 共用，不发）。
- 前端：账号页 `/account/`（`apps/account.js`），顶栏头像链接到它；登录后是三星式总览
  （账号卡 + 头像编辑、已登录卡、「安全与隐私」一行）；账号密码和账号通行密钥在子页
  `/account/security/`（`apps/account-security.js`）。顶栏没有 ‹ 返回（2026-10-20 删除），
  返回走浏览器 / 系统返回。原锁屏凭证页（`security-owner`）已删除。
- 发给 styrigx-ai 的请求写账号结论头（只认 `X-Styrigx-Account-Session: 1`）。search-index、chat 在 P4-2b 退役。入站的旧前缀 `x-sgx-*` 头仍照剥。
- 账号拆分已完成（PR4）：D1 `styrigx-auth-gateway` 不再存账号数据，只剩锁屏数据（`realm='lock'` 的行和恢复开关表 `lock_reset_switch`）；
  网关库里 `realm='account'` / `'root'` 的旧行和旧开关表 `recovery_switch` 已由 `space/scripts/migrate-account-auth.mjs --cleanup --confirm` 删除
  （预览库走网关 `migrations/0009_drop_recovery_switch.sql`）；Secrets Store 里的旧 `SGX_ROOT_KEY` 已删除。
- 恢复开关表（账号拆分方案 9.4）：叫 `lock_reset_switch`（网关 `migrations/0008_lock_reset_switch.sql`），后台开开关插行用 `INSERT INTO lock_reset_switch …`。

## 网关结论（授权骨架，P2-1）

门归网站、账号管授权：网关只验门（锁屏会话）；能不能写、能不能读私密由账号 Worker 回答（`workers/account/src/core/authz.js`，作用域表 `core/scopes.js`）；网关把结论交给下游，下游只信结论。依赖方向：浏览器 → 网关（验门）→ 需要授权时网关经 `ACCOUNT_VERIFIER.authorize()` 问账号 Worker → RPC 回结论对象（`AuthVerifier.conclusion()`）/ HTTP 转发写结论头。账号 Worker 不调网关，网关不读账号库（规则 14、16 不变）。

结论头（网关 fetch 第一步照旧剥掉所有入站 `x-styrigx-*`、`x-sgx-*`，再按验过的结果重写；只写白名单值，某一项没有就不写这个头，不写 `0`）：

| 头 | 值 | 含义 | 谁写（P2-1 起） |
|---|---|---|---|
| `X-Styrigx-Lock-Session` | `1` | 进门有效（网关验过的锁屏会话） | `core/lock-identity.js`，转发给账号 Worker 时写（P2-3 起唯一的锁侧身份头，没有等级头） |
| `X-Styrigx-Lock-By` | `password` \| `passkey` \| `tempkey` | 进门方式，只作审计 | `core/lock-identity.js`（不变） |
| `X-Styrigx-Lock-Tempkey-Id` | `<id>` | 审计，只在 `by=tempkey` 时有 | `core/lock-identity.js`（不变） |
| `X-Styrigx-Account-Session` | `1` | 网关问过账号 Worker，账号会话有效 | `core/conclusion.js` `writeAccountConclusion` |
| `X-Styrigx-Account-Device` | `<deviceId>` | 审计 / 设备区分 | 同上 |
| `X-Styrigx-Account-Scopes` | `curio.write daymark.write` | 已授权 ∩ 已知作用域，空格分隔，按字母排序 | 同上 |
| `X-Styrigx-Account-Reauth` | `1` | 账号复验短票有效（本次请求需要时才问） | 同上 |
| `X-Styrigx-Client-Address` / `-Country` / `-City` | — | 客户端上下文 | `core/lock-identity.js`（不变） |

- `X-Styrigx-Account-*` 只写给 `styrigx-ai`（第 4 件；P4-2b 前还有过渡期的 `search-index`）。账号 Worker 自己验账号会话和作用域，网关只给它写 `X-Styrigx-Lock-*` 和 `X-Styrigx-Client-*`。
- RPC 结论 `AuthVerifier.conclusion(cookieHeader, clientContext, opts)` → `{ lock: { ok, by, tempkeyId, reason }, account: { ok, deviceId, scopes, reauth, reason } }`；`lock.ok=false` 时不问账号；账号绑定没配、RPC 出错、回了看不懂的东西 → `account.ok=false`。子站接口 Worker（curio-core、daymark-core）P2-2 起用它。
- 骨架阶段账号会话自动拥有全部作用域；第 3 件实现（P3-1）只换 `grantedScopes` 的数据源，函数签名、RPC 形状、结论头都不变，见下一节。
- 已删除：锁侧等级头在 P2-3 删（网关不再写，账号 Worker P2-2 起已不读）；旧前缀的等级头 P2-2 停写停读。
- P2-1 只新增，没有调用方，线上行为不变。

## 授权记录（第 3 件，P3-1）

授权是权限管控，与设备 / 浏览器无关：账号级、一个应用一行，存在账号库 D1 `styrigx-account` 的 `app_grant`（`workers/account/migrations/0004_app_grant.sql`，设计方案 2.5）。取消就删掉这一行，所有设备上这个应用立即失去这项权限；账号会话本身不受影响。

- 判断：`workers/account/src/core/authz.js grantedScopes` 读 `app_grant`（`core/app-grant.js`），返回 已授权 ∩ 作用域表；还没有种子标记时保持骨架行为（全部）。每次授权请求读一次 D1 主库（授权记录 + 账号纪元 + 设备黑名单），不缓存；`authorize` 只读不写。网关、下游和结论头都不变（取消后的写请求 403 scope、wellbeing 上报 204 丢弃，P2-2 已落地的写法）。
- 首次切换：表空且 `data_migration` 没有 `app-grant-seed-1` 时同一个 batch 写满全部应用 + 标记；之后取消到 0 行不再种。首次切换之后新增的应用按版本号补种（`SEED_SUPPLEMENTS`：`app-grant-seed-2` 补「个人资料」，2026-11-07），补种前那批应用按已授权算。
- 管理：授权卡页 `/account/apps/`（账号总览「设备」「账号安全」同卡一行进入），`POST /api/account` `grant-list` / `grant-revoke`（不要复验）/ `grant-add`（要账号复验）。
- 同意流程（OAuth 式，奇趣 / 日刻）：应用内点登录 → `/account/?return=<原页面>` → 登录完成后 `grant-list`（先种子再查记录）→ 有授权直接回原页面；没有 → 同意卡片 →「授权」`grant-add` /「拒绝」不写记录，都回原页面。刚完成的登录即视为已复验（登录带 reauth:true，Gray 2026-11-06 定 A）。回原页面走现有的网关回跳（`/api/lock-session-check?return=` 的 `next`，`workers/auth-gateway/src/core/return.js safeReturn`）。主站内功能（设置同步、数字健康、头像）只走管理页。

| 作用域 | 应用（授权卡） | 取消后 |
|---|---|---|
| `curio.write` | 奇趣 | 奇趣写接口 403 scope，页底「奇趣未获账号授权」链到 `/account/apps/`；读不变 |
| `daymark.write` | 日刻 | 同上（日刻） |
| `prefs.sync` | 设置同步 | `/api/prefs` 403 scope，云同步只存本机 |
| `wellbeing.write` | 数字健康 | `POST /api/wellbeing` 204 丢弃 |
| `avatar.write` | 头像 | `PUT` / `DELETE /api/avatar` 403 scope |
| `profile.write` | 个人资料（2026-11-07） | `PUT /api/profile` 403 scope；首次切换之后新增，按 `app-grant-seed-2` 补种 |

## 锁定与过期

1. 「立即锁定」只在 space 操作，服务端清除 `.styrigx.com` 会话，
   所有站点下一次请求时同时变已锁。
2. 会话过期时间对所有站点一致，由 space 签发时决定，分站只验签不延长。
3. 受保护页面返回 `Cache-Control: private, no-store`，防浏览器缓存绕过锁屏。

## 历史教训

- 2.4.0 H：`lock.js` 用 sessionStorage 按标签页判断，middleware 又把首页
  放进白名单，服务端和前端各有一套锁 → 新标签页重复弹锁屏（2026-10-10）。
  修复：L1 注入状态，L4 只负责显示（PR #27）。
- 2.4.1：旧版残留的同名 host-only `sgx-lock-session` cookie 导致验签取到旧值。
  修复：读取时遍历所有同名 cookie 任一通过即有效；签发时下发清除头（PR #25）。
