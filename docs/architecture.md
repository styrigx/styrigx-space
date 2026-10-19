# Styrigx Space 架构：分层规范

> 2026-10-10 定稿（Gray 确认）。3.0 起长期生效。
> 参照 Linux：上层只能调用下层，不能跨层，也不能自己重新实现下层的职责。

## 模型

space（styrigx.com）相当于 One UI，blog/book 等分站相当于其中的 App。
锁屏属于系统层，管住所有站点。

## 唯一状态源

是否已解锁，只由服务端签发的 `sgx-verified` 会话决定
（`Domain=.styrigx.com; Path=/`）。
任何站点、任何页面都不得用 sessionStorage、localStorage、
前端内存或标签页状态另做判断。

## 分层

### L0 内核·凭证：`functions/_kernel/crypto.js`、`functions/_kernel/session.js`
- 负责 Ed25519 签名/验签、会话格式（`epoch.exp.sig`）和 cookie 名。
- 不碰任何页面逻辑。

### L1 内核·权限：`functions/_middleware.js`
- **唯一决定是否已解锁的地方**。每个页面请求都在这里判断会话。
- 首页 `/` 和 `/en/` **不再无条件白名单**：照常返回页面，但把
  已锁/已解锁状态注入 HTML（`<html data-sgx-session="valid|locked">`），
  前端不用猜。
- 受保护页面返回 `Cache-Control: private, no-store`（防浏览器缓存绕过锁屏）。
- `/api/*` 不走锁屏跳转，未登录返回 401 JSON。

### L2 系统调用：`functions/api/*`
- 解锁：`owner-password`、`owner-passkey`、`verify`（Turnstile）。
- 查询：`session-check`、`lock-status`、`account`（账号凭证状态 + 当前账号会话；原 `owner-status` 已删除）。
- 账号：`account`（账号密码/账号通行密钥登录与管理）、`root-auth`（`target:'account'` 时作为账号登录第三入口）、`stepup`（`enter`：近期账号登录换管理门票据）。
- 锁定：`lock`（清除 `Domain=.styrigx.com` 的 `sgx-verified`，blog/book 一起上锁）。
- 前端改变会话只能通过这些接口。

### L3 共享库：`assets/js/lib/ + assets/js/shell/ + assets/js/apps/` 的 core、util、storage、events、scheduler、i18n、theme
- 通用能力，不得包含鉴权逻辑。
- `storage` 只存偏好（主题、天气等），**禁止存解锁状态**。

### L4 桌面环境·One UI：nav、goodlock、lock.js、sheet、capsule
- `lock.js` 只负责两件事：
  1. 按 L1 给出的状态（`data-sgx-session`）画锁屏；
  2. 把密码或通行密钥提交给 L2。
- 删除 `sessionStorage['sgx-lock-shown']` 及所有按标签页判断的逻辑。

### L5 应用：`page-*.js` + `entries/entry-*.js`
- 一个页面一个入口，不碰鉴权。

### L6 外部 App：blog、book
- 只用公钥验签同一份会话。
- 未解锁时 302 到 space 锁屏并带完整 return。
- book 自己的 D1 绑定保持不动。

## 一致性规则

1. **已锁**（无/无效/过期会话）：打开主站或任一分站任意页面，都先出锁屏。
   分站 302 到 space 锁屏，保留完整 return 地址。
2. **已解锁**（会话有效）：打开主站或任一分站任意页面，都直接进入；
   新标签页、刷新、内页都不再出锁屏。
3. 不允许同一浏览器同一时刻，一个站要解锁、另一个站直接进。

## 账号会话（账号域）

原「站长凭证」升级为账号体系，账号会话与锁屏会话**是两套独立的票据**：

- 锁屏会话 `sgx-verified`（`Domain=.styrigx.com`）只回答「是否已解锁」，
  是唯一的解锁状态源；它**从不**被当作账号认证。
- 账号会话 `sgx-account`（无 Domain，只发给主站；`HttpOnly; Secure; SameSite=Strict`；12 小时）
  由 `_kernel/account-session.js` 签发与验证，格式 `by.epoch.authAt.exp.sig`，
  用 `SGX_ACCOUNT_PRIVATE / SGX_ACCOUNT_PUBLIC`（Ed25519，PKCS8 / SPKI PEM）签名。
  凭证域定义在 `_kernel/realms.js` 的 `REALM_ACCOUNT`。
- 登录入口三者平级：账号通行密钥、账号密码、根凭证；前置条件是已解锁的 owner 锁屏会话。
- 敏感操作（「管理凭证」进门、注册/删除账号通行密钥、修改账号密码）要求 `authAt` 在 10 分钟内，
  过旧返回 403 `account-stale`，前端回账号页重新登录。
- 改账号密码 / 删账号通行密钥时 `account-epoch` +1，其他设备的账号会话失效，当前设备重签。
- 存储沿用原站长凭证（`owner-pw`、`owner-passkey:*` class=owner、`owner-user-id:owner`），
  不搬数据、无需重新注册；新增 KV 键 `account-challenge:*`、`account-epoch`。
- 缺账号钥匙 → 账号登录 503 `config`，只影响账号登录与进门，网站其余部分不受影响。
- 敏感操作还包括重命名账号通行密钥（`rename`，同样要求近期登录，不推纪元）。
- 概念名 `accountkey`（原 `ownerkey`）：账号通行密钥注册时 WebAuthn `user.name = accountkey`；
  存储层不变（class 仍是 `owner`，KV 仍是 `owner-pw` / `owner-passkey:*`）。`list` 返回账号 handle，
  前端支持时调 `PublicKeyCredential.signalCurrentUserDetails` 让密码管理器把旧条目改名
  （只对当前 handle `owner-user-id:owner`；旧 handle 与 lockkey 共用，不发）。
- 前端：账号页 `/settings/account/`（`apps/account.js`），顶栏头像链接到它；登录后是三星式总览
  （账号卡 + 头像编辑、已登录卡、「安全与隐私」一行）；账号密码和账号通行密钥在子页
  `/settings/account/security/`（`apps/account-security.js`）。从头像进入时，总览的返回回到点头像时的页面
  （`shell/navhistory.js`）。原站长凭证页（`security-owner`）已删除。

## 锁定与过期

1. 「立即锁定」只在 space 操作，服务端清除 `.styrigx.com` 会话，
   所有站点下一次请求时同时变已锁。
2. 会话过期时间对所有站点一致，由 space 签发时决定，分站只验签不延长。
3. 受保护页面返回 `Cache-Control: private, no-store`，防浏览器缓存绕过锁屏。

## 历史教训

- 2.4.0 H：`lock.js` 用 sessionStorage 按标签页判断，middleware 又把首页
  放进白名单，服务端和前端各有一套锁 → 新标签页重复弹锁屏（2026-10-10）。
  修复：L1 注入状态，L4 只负责显示（PR #27）。
- 2.4.1：旧版残留的同名 host-only `sgx-verified` cookie 导致验签取到旧值。
  修复：读取时遍历所有同名 cookie 任一通过即有效；签发时下发清除头（PR #25）。
