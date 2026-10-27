# styrigx-auth-gateway

主站鉴权网关，也是主站会话和锁屏的全部后端代码所在。承接 `styrigx.com/api/*` 和主站全部页面目录：先验会话，页面验完回源 Pages 取静态文件。头像、设置云同步、数字健康（`/api/avatar*`、`/avatar/*`、`/api/prefs*`、`/api/wellbeing*`）2026-10-24 起在账号 Worker `styrigx-account`（`workers/account/`，挂更具体的路由，会话经本网关的 `AuthVerifier` 验）。Pages 本身只放静态文件（配置见 `web/wrangler.toml`）。

```
src/         部署入口（worker.js）、公网请求（index.js）、接口路由表（routes.js）、Secrets Store 取值（secrets.js）、子站门禁（subsites.js）、给其他 Worker 的验票 RPC（rpc.js + verifier.js）
functions/   middleware（会话、角色、锁屏）、接口（api/）、内核（_kernel/）
migrations/  D1 建表
```

- 子站：`blog.styrigx.com`、`daymark.styrigx.com`、`curio.styrigx.com` 的路由（整站通配 `<域名>/*`）也登记在 `wrangler.toml`，网关验会话（admin、visitor 都放行）后回源子站 Pages；未登录 302 到主站锁屏，`/api/lock-session-check` 由网关直接回答。子站登记表在 `src/subsites.js`，新增子站要在那里加一项并登记路由。子站 Pages 不持任何钥匙。
- 给其他 Worker 验票：服务绑定 RPC `AuthVerifier`（`lockSession(cookieHeader)` → `{ok, role}`（role 为 `admin` / `visitor`）；`accountSession(cookieHeader, meta)` → `{ok}` / `{ok:false, reason}`，账号会话，账号 Worker 的云同步用）。调用方：`styrigx-daymark-core`、`styrigx-account`。调用方 wrangler.toml 写 `[[services]] binding = "AUTH"`、`service = "styrigx-auth-gateway"`、`entrypoint = "AuthVerifier"`，自己不持任何钥匙。只能经服务绑定调用，公网进不来。
- 后端拆出去的 Worker（都没有公开地址，只经本网关的服务绑定进来，网关先验会话）：全站搜索 `SEARCH` → `styrigx-search-index`、站点监测 `STATUS` → `styrigx-status`、聊天 `CHAT` → `styrigx-chat`（`/api/chat` 验同源 + 会话 + 只许管理员后转过去，回答原样流回；聊天钥匙 `SGX_CHAT_API_KEY` 和 `CHAT_*` 变量只在 `workers/chat/`，网关不绑）。部署顺序：这些 Worker 先于网关。
- 4 个私密值（`SGX_LOCK_PRIVATE`、`SGX_ACCOUNT_PRIVATE`、`SGX_ROOT_KEY`、`SGX_PW_PEPPER`）+ 2 把公钥（`SGX_LOCK_PUBLIC`、`SGX_ACCOUNT_PUBLIC`）都在 Cloudflare Secrets Store；换钥只在后台改，不用改代码或重新部署（最多 60 秒生效）。
- 不开 `*.workers.dev`；只通过 `styrigx.com` 的路由访问。
- `functions/api/` 新增接口时，在 `src/routes.js` 登记一行（单测会检查）。
- 路由按域名整站通配（`styrigx.com/*` 等），新增页面目录不用加路由；新增子站时加一条 `<子站域名>/*`（`scripts/check-worker-routes.mjs` 会检查）。
- 部署顺序：main 上先部署网关并冒烟检查线上，通过后才部署 Pages。
- 回滚：Pages 上已经没有后端代码，不能靠删路由回滚（删了页面就不验会话）；revert 对应提交重新部署。
- 预览（passkey-e2e）：CI 把本目录打包成 Pages 的 `_worker.js`，部署到 `passkey-e2e.styrigx-space.pages.dev`，连预览用的空 D1；此时页面和默认头像读 `env.ASSETS`。预览没有账号 Worker：`/api/avatar`、`/api/prefs`、`/api/wellbeing` 回 404，头像是静态默认图。

## 存储（D1，2026-10-27 起不绑 KV）

网关只做鉴权 + 路由，认证状态全部在 D1 `styrigx-auth-gateway`（强一致，写完下一个请求就读到）。同一个库三个绑定名，按凭证域（`functions/_kernel/realms.js`）分：

| 绑定 | realm | 内容 |
|---|---|---|
| `D1_LOCK_AUTH` | `lock` | 纪元、锁屏密码 / 通行密钥、user handle、challenge、输错计数、临时钥匙；另外恢复开关 `recovery_switch`。`migrations_dir` 只写在这一块 |
| `D1_ACCOUNT_AUTH` | `account` | 纪元、账号密码 / 通行密钥、user handle、challenge、输错计数、已登录设备 |
| `D1_ROOT_AUTH` | `root` | 根凭证输错计数、使用审计 |

表：`migrations/0001_recovery_switch.sql`、`0005_lock_account_state.sql`（epoch、passkey、password、kv_migration，每张表有 realm 列）、`0006_auth_state.sql`（user_handle、challenge、attempt_limit、tempkey、device、audit）。代码在第一次遇到「no such table」时按 `functions/_kernel/d1-state.js` 的 SCHEMA 建表（幂等，单测核对与迁移文件一致），正式部署 job 不跑迁移。以前的认证库 KV（namespace `b796097c…`）已删掉绑定，namespace 保留不删，运行时不读。

## 上线顺序（KV → D1，一次性）

代码没有 KV 回落，**部署前必须先导入**，否则密码、通行密钥读不到，user handle 会重新生成，已登录设备和临时钥匙全丢。脚本：`scripts/migrate-kv-to-d1.mjs`（Cloudflare REST API，凭据只从环境变量 `CF_API_TOKEN`、`CF_ACCOUNT_ID` 读）。Token 权限：Account → Workers KV Storage: Read + D1: Edit。

1. `node scripts/migrate-kv-to-d1.mjs --dry-run`：读 KV 和 D1 的导入标记，打印计划（只有计数），核对一遍。
2. `node scripts/migrate-kv-to-d1.mjs`：建表 + 写入（幂等；中途失败再跑一次补齐，已写过标记的类跳过）。
3. `node scripts/migrate-kv-to-d1.mjs --verify`：核对计划里的每一行都在 D1。
4. 部署网关。

注意：

- 导入时纪元 = KV 值 + 1：上线后所有锁屏 / 账号会话失效一次，每个人重新解锁 / 登录一次。
- 不导入：输错计数、challenge、`*-configured`、旧审计、旧重置开关。要开恢复开关，在 D1 `styrigx-auth-gateway` 控制台插一行：
  `INSERT INTO recovery_switch (hash, first_seen, used) VALUES (lower(hex(randomblob(16))), 0, 0);`（首次读到起 24 小时内有效，用一次作废）。
- 密码哈希、WebAuthn user handle、credId 原样搬过去，不需要重新注册或重设密码。
- 预览加 `--preview --auth-kv <预览 KV id>`；`CF_API_BASE` 可指向 `tests/web/e2e/preview-emulator.cjs` 在本地演练。
