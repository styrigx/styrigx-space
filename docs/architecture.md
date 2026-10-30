# Styrigx Space 架构：分层规范

> 2026-10-10 定稿（Gray 确认）。3.0 起长期生效。
> 参照 Linux：上层只能调用下层，不能跨层，也不能自己重新实现下层的职责。

## 模型

space（styrigx.com）相当于 One UI，blog、daymark、curio 等子站相当于其中的 App。
锁屏属于系统层，管住所有站点。

## 唯一状态源

是否已解锁，只由服务端签发的 `sgx-lock-session` 会话决定
（`Domain=.styrigx.com; Path=/`）。
任何站点、任何页面都不得用 sessionStorage、localStorage、
前端内存或标签页状态另做判断。

## 分层

### L0 内核·凭证：`workers/auth-gateway/functions/_kernel/`（`realms.js`、`lock-session.js`、`tickets.js` 等）
- 负责 Ed25519 签名/验签、锁屏会话格式（`by.role.epoch.exp.tempkeyId.sig`）和锁屏三张票的 cookie 名（`realms.js`，只有 `REALM_LOCK`）。
- 账号拆分 PR3 起这里没有账号的东西：账号会话、账号短票、`REALM_ACCOUNT` 都在账号 Worker `workers/account/src/identity/`；网关要知道账号会话是否有效时只经 `_kernel/account-rpc.js` 调账号 Worker 的 `AccountVerifier.accountSession()`。
- 不碰任何页面逻辑。
- 与域无关的通用实现（`crypto.js`、`cookies.js`、`http.js`、`d1-state.js`、`tickets.js`、`root-*.js` 等）在网关自己的 `_kernel/lib/`。
  2026-10-30 起没有跨 Worker 的共享目录：账号（`workers/account/src/lib/`）、分享（`workers/share/src/lib/`）、chat / search-index 各自一份，
  每份只留本 Worker 用得上的部分；每个 Worker 只能 import 自己目录下的文件，账号和网关互相不许 import（`scripts/check-layers.mjs` 规则 14、15，见下面「Worker 边界」）。

### L1 内核·权限：`workers/auth-gateway/functions/_middleware.js`
- **唯一决定是否已解锁的地方**。每个页面请求都在这里判断会话。
- 首页 `/` 和 `/en/` **不再无条件白名单**：照常返回页面，但把
  已锁/已解锁状态注入 HTML（`<html data-sgx-lock-session="valid|locked">`），
  前端不用猜。
- 受保护页面返回 `Cache-Control: private, no-store`（防浏览器缓存绕过锁屏）。
- `/api/*` 不走锁屏跳转，未登录返回 401 JSON。

### L2 系统调用：`workers/auth-gateway/functions/api/*`
- 解锁：`lock-password`、`lock-passkey`（admin 会话）、`lock-tempkey-unlock`（临时码 → visitor 会话，by=tempkey）。
- 查询：`lock-session-check`、`lock-credentials`、`lock-entry`（锁屏上显示哪些入口，无需会话）、`root-audit`（锁屏根密钥使用记录）。`layer-status` 已删除（PR3，前端无调用方）。
- 账号：`/api/account`、`/api/prefs*`、`/api/avatar*`、`/api/wellbeing*`、`/avatar/*` 不在这一层：网关 `_middleware.js` 验门后经服务绑定 `ACCOUNT` 转给账号 Worker（转发表 `src/forwarding.js`，见下面「账号会话」）。
- 锁屏凭证页的再验证：`lock-reauth`（LockReauthTicket 状态 / 清票）；由 `lock-passkey`/`lock-password`（`reauth:true`）或 `root-auth`（`purpose:'lock-reauth'`）签 3 分钟 LockReauthTicket `sgx-lock-reauth`（SGX_LOCK_* 签）。
- 锁屏根密钥（`SGX_ADMIN_KEY`）：`root-auth { key, purpose }`，purpose 只有 `lock-reauth` / `lock-reset`，各签一张 3 分钟锁屏短票（by=root），不签任何会话；`root-audit` 只读锁屏根密钥使用记录。账号根密钥 `SGX_ACCOUNT_ROOT_KEY` 在账号 Worker（`POST /api/account { action:'root-reauth' | 'root-reset' }`），两套互不相干、各自计数。
- 重置与临时钥匙：`lock-reset`（丢了锁屏凭证：先交锁屏根密钥，再按重置开关或锁屏凭证（`needLock` / `lockProof`）签 LockResetTicket；不读账号的任何东西）、`lock-tempkey`（账号页临时钥匙的列表 / 新建 / 作废；账号会话经 `ACCOUNT_VERIFIER` 问账号 Worker）。
- 网关只有 4 个密钥：锁屏签名钥匙 `SGX_LOCK_PRIVATE` / `SGX_LOCK_PUBLIC`、锁屏根密钥 `SGX_ADMIN_KEY`、密码 pepper `SGX_PW_PEPPER`（与账号 Worker 共用同一个密值）。账号签名钥匙 `SGX_ACCOUNT_*` 和 `SGX_ACCOUNT_ROOT_KEY` 只在账号 Worker（stepup、应用凭证已删除）。
- 锁定：`lock-now`（清除 `Domain=.styrigx.com` 的 `sgx-lock-session`，子站一起上锁）、`lock-all-devices`（Lock 纪元 +1，所有设备一起上锁；要 LockReauthTicket）。
- 其他：`geo`（Cloudflare 给的城市 / 坐标 / 时区）；`chat`、`search`、`status` 只做门，验锁屏会话后经服务绑定转给 styrigx-chat / styrigx-search-index / styrigx-status。
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

### 依赖方向（`scripts/check-layers.mjs`，CI 必过）
- 前端：`lib` ← `auth` ← `shell` ← `apps` ← `entries`，只能向左 import；前端不 import `web/assets/js/` 以外的文件。
- 网关：`_kernel/` 只 import `_kernel/`；`api/*` 和 `_middleware.js` 只 import `_kernel/`（api 之间不互相 import）；
  `src/` 只 import `src/` 和 `_kernel/`，例外是路由表 `src/routes.js` import `api/`、入口 `src/index.js` import `_middleware.js`。
- 相对 import 解析不到文件也算失败。

### Worker 边界（`scripts/check-layers.mjs` 规则 14-17，CI 必过）
- 14：每个 Worker 只能相对 import 自己目录 `workers/<名字>/` 下的文件，Worker 之间（账号 ↔ 网关、短链、chat 等）一律不许 import；非相对 import 只认 `cloudflare:workers`。
- 15：不许出现 `workers/shared` 目录（2026-10-30 删除；通用件每个 Worker 各自一份）。
- 16：网关源码（`workers/auth-gateway/` 下的 `.js` / `.mjs` / `.cjs` 和 `wrangler.toml`，注释除外）不许出现账号鉴权标识：`SGX_ACCOUNT_*`、`SGX_ROOT_KEY`、`D1_ACCOUNT_AUTH`、`D1_ROOT_AUTH`、`REALM_ACCOUNT`、`REALM_ROOT`、`checkAccountSession`、`verifyAccountSession`、`Account*Ticket` / `ACCOUNT_*_TICKET` 等（完整列表在脚本的 `GATEWAY_ACCOUNT_AUTH_RE`）。网关只经 `ACCOUNT_VERIFIER.accountSession()` 拿账号会话结论。
- 17：账号 Worker 的 `workers/account/wrangler.toml` 不许有路由（`[[routes]]`、`route = …`、非空的 `routes = [...]`；`[env.preview]` 的 `routes = []` 允许），账号请求只经网关的服务绑定进来。

### L4 桌面环境·One UI：nav、goodlock、lock.js、sheet、capsule
- 锁屏拆两块（2026-10-26）：`lock-guard.js` 在每页的 core 里，只读 L1 给出的状态（`data-sgx-lock-session`）、
  绑自动锁定、做去处判定；locked / unknown 时先同步盖不透明遮罩（fail closed），再 `import()` 锁屏界面 `lock.js`
  （加载失败遮罩不撤，只给重新加载）。访客升级层 `upgrade.js` 同样按需加载。
- `lock.js` 只负责两件事：
  1. 画锁屏；
  2. 把密码或通行密钥提交给 L2。
- 删除 `sessionStorage['sgx-lock-shown']` 及所有按标签页判断的逻辑。

### L5 应用：`apps/*.js` + `entries/entry-*.js`
- 一个页面一个入口，不碰鉴权。
- 打包（2026-10-24）：所有入口在 `layouts/partials/sgx-js-batch.html` 里一次 `js.Batch`（esbuild ESM + 代码分割），
  共享代码（core 及其依赖）拆成一个内容哈希命名的 chunk，各页共用、换页走缓存；入口 fingerprint，静态依赖的 chunk 由 baseof 输出 `modulepreload`。
  新加入口要登记进 baseof 的入口列表（`tests/web/ui/js-split.test.mjs` 检查）。
  顶栏三栏各一个入口 `entry-tab-<id>.js`：当前栏静态带上，另两栏 `import('./lazy-<id>.js')` 按需取。
  首帧前必须跑的（主题、语言、布局、防闪）仍是 `<head>` 里的同步内联脚本，不进模块。

### L6 外部 App：blog、daymark、curio
- 子站页面由网关（`workers/auth-gateway/src/subsites.js`）验同一份锁屏会话，子站 Pages 不持任何钥匙。
- 未解锁时 302 到 space 锁屏并带完整 return。
- 子站自己的管理员专属接口（daymark 记句子、curio 改收藏）由子站接口 Worker 经服务绑定 `AuthVerifier` 再问网关。

## 一致性规则

1. **已锁**（无/无效/过期会话）：打开主站或任一分站任意页面，都先出锁屏。
   分站 302 到 space 锁屏，保留完整 return 地址。
2. **已解锁**（会话有效）：打开主站或任一分站任意页面，都直接进入；
   新标签页、刷新、内页都不再出锁屏。
3. 不允许同一浏览器同一时刻，一个站要解锁、另一个站直接进。

## 账号会话（账号域）

原「管理员凭证」升级为账号体系，账号会话与锁屏会话**是两套独立的票据**：

- 锁屏会话 `sgx-lock-session`（`Domain=.styrigx.com`）只回答「是否已解锁」，
  是唯一的解锁状态源；它**从不**被当作账号认证。
- 账号会话 `sgx-account-session`（无 Domain，只发给主站；`HttpOnly; Secure; SameSite=Strict`；400 天，不点退出就一直登录）
  由账号 Worker 的 `workers/account/src/identity/account-session.js` 签发与验证，格式 `by.epoch.authAt.exp.deviceId.sig`，
  用 `SGX_ACCOUNT_PRIVATE / SGX_ACCOUNT_PUBLIC`（Ed25519，PKCS8 / SPKI PEM，只绑在账号 Worker）签名。
  凭证域定义在 `workers/account/src/identity/realm.js` 的 `REALM_ACCOUNT`。
- 请求路径（账号拆分 PR3）：浏览器 → 网关（验锁屏门、剥外来 `x-styrigx-*` / `x-sgx-role` 头、按验过的锁屏会话写 `X-Styrigx-Lock-*` / `X-Styrigx-Client-*`）
  → 服务绑定 `ACCOUNT` → 账号 Worker 命名入口 `AccountService`。账号 Worker 没有公开路由，默认 fetch 一律 404。
  网关和短链 Worker 需要账号会话结论时经 `ACCOUNT_VERIFIER`（`AccountVerifier.accountSession()`）问账号 Worker。
- 登录入口两者平级：账号通行密钥、账号密码；前置条件是已解锁的 admin 锁屏会话。账号根密钥不签账号会话。
- 敏感操作（注册/删除账号通行密钥、修改账号密码）要求有效的 3 分钟 AccountReauthTicket `sgx-account-reauth`
  （进「账号安全」子页前再验一次，离开即作废；会话还在时也认 AccountResetTicket），没有票返回 403 `reauth`，前端重新验证。
- 改账号密码 / 删账号通行密钥时 `account-epoch` +1，其他设备的账号会话失效，当前设备重签。
- 存储（账号拆分 PR3 起在 D1 `styrigx-account`，账号 Worker 的绑定 `D1_ACCOUNT_AUTH`，各表 `realm = 'account'`；网关库里遗留的旧行 PR4 清理）：
  `password`、`passkey`、`user_handle`、`challenge`、`epoch`、`device`（已退出的 `revoked_at > 0`）；
  「已配置」由凭证推出；账号密码登录限速在 `attempt_limit`（`kind = 'password'`，规则同锁屏密码）。
- 缺账号钥匙 → 账号登录 503 `config`，只影响账号登录与进门，网站其余部分不受影响。
- 敏感操作还包括重命名账号通行密钥（`rename`，同样要 AccountReauthTicket，不推纪元）。
- 概念名 `AccountKey`（原 `OwnerKey`）：账号通行密钥注册时 WebAuthn `user.name = AccountKey`；
  通行密钥记录不再有 class 字段（键名已表明域）。`list` 返回账号 handle，
  前端支持时调 `PublicKeyCredential.signalCurrentUserDetails` 让密码管理器把旧条目改名
  （只对当前 handle `account-user-id`；旧 handle 与 LockKey 共用，不发）。
- 前端：账号页 `/account/`（`apps/account.js`），顶栏头像链接到它；登录后是三星式总览
  （账号卡 + 头像编辑、已登录卡、「安全与隐私」一行）；账号密码和账号通行密钥在子页
  `/account/security/`（`apps/account-security.js`）。顶栏没有 ‹ 返回（2026-10-20 删除），
  返回走浏览器 / 系统返回。原管理员凭证页（`security-owner`）已删除。
- 遗留项（照实记录）：网关发给 chat / search 的内部请求仍写旧头 `X-Sgx-Role`（那两个 Worker 仍认它，统一留待以后）；
  恢复开关表仍叫 `recovery_switch`（改名 `lock_reset_switch` 留待以后，且必须在 PR4 `--cleanup` 之前完成，因为 `--cleanup` 会 DROP 它）；
  网关库里 `realm='account'` / `'root'` 的旧行和 Secrets Store 里不再被绑定的 `SGX_ROOT_KEY` 到 PR4 才清理。

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
