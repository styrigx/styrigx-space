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
- 查询：`session-check`、`owner-status`。
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
