# styrigx-auth-gateway

主站鉴权网关：锁屏会话和锁屏凭证的全部后端代码在这里。承接 `styrigx.com/*` 和三个子站的整站请求：先验锁屏会话，页面验完回源 Pages 取静态文件，接口在本 Worker 回答或经服务绑定转给内部 Worker。Pages 本身只放静态文件（配置见 `web/wrangler.toml`）。

**账号不在这里**（账号拆分 PR3 起）：账号密码 / 账号通行密钥 / 已登录设备 / 账号会话 / 账号根密钥、头像、设置云同步、数字健康都在账号 Worker `styrigx-account`（`workers/account/`）。账号 Worker 没有任何公开路由，浏览器的账号请求一律先进网关，网关验门后经服务绑定 `ACCOUNT` 转发。网关源码里没有任何账号鉴权代码、账号绑定或账号钥匙（`scripts/check-layers.mjs` 规则 16 核对）。

```
src/         部署入口（worker.js）、公网请求（index.js）、接口路由表（routes.js）、账号转发表（forwarding.js）、Secrets Store 取值（secrets.js）、子站门禁（subsites.js）、给其他 Worker 的 RPC（rpc.js + verifier.js、share-issuer.js）
functions/   middleware（锁屏会话、角色、门）、接口（api/）、内核（_kernel/）
migrations/  D1 styrigx-auth-gateway 建表
```

## 请求怎么走

- 网关 fetch 第一步剥掉入站请求里所有 `x-styrigx-*` 和 `x-sgx-role` 头（下游只认网关自己写的）。
- 账号路径（转发表 `src/forwarding.js`）：`/api/account`、`/api/prefs*`、`/api/avatar*`、`/api/wellbeing*`、`/avatar/*`。`_middleware.js` 先验门（`/api/account`、`/api/prefs*` 只许管理员；`/api/avatar*`、`/api/wellbeing*` 要有会话；`/avatar/*` 公开），放行后经服务绑定 `ACCOUNT`（entrypoint `AccountService`）原样转给账号 Worker，并按验过的锁屏会话写规范身份头 `X-Styrigx-Lock-*` / `X-Styrigx-Client-*`。没绑定或绑定出错 → 503 upstream，不落回网关路由表、不回源静态文件。转发回来的响应保留 `X-SGX-Runtime: account`。
- 网关自己要知道「账号会话是否有效」时（临时钥匙管理 `/api/lock-tempkey`、短链签发 `ShareIssuer`、账号页首帧提示 `data-sgx-account-session`），只经服务绑定 `ACCOUNT_VERIFIER`（entrypoint `AccountVerifier`）调只读 RPC `accountSession(cookieHeader, clientContext)`（`functions/_kernel/account-rpc.js`），拿到的只是结论，网关不验账号票、不读账号库。
- 子站：`blog.styrigx.com`、`daymark.styrigx.com`、`curio.styrigx.com` 的路由（整站通配 `<域名>/*`）也登记在 `wrangler.toml`，网关验锁屏会话（admin、visitor 都放行）后回源子站 Pages；未登录 302 到主站锁屏，`/api/lock-session-check` 由网关直接回答。子站登记表在 `src/subsites.js`，新增子站要在那里加一项并登记路由。子站 Pages 不持任何钥匙。
- 后端拆出去的其他 Worker（都没有公开地址，只经本网关的服务绑定进来，网关先验会话）：全站搜索 `SEARCH` → `styrigx-search-index`、站点监测 `STATUS` → `styrigx-status`、聊天 `CHAT` → `styrigx-chat`（`/api/chat` 验同源 + 会话 + 只许管理员后转过去，回答原样流回；聊天钥匙 `SGX_CHAT_API_KEY` 和 `CHAT_*` 变量只在 `workers/chat/`，网关不绑）。
- 给其他 Worker 的 RPC：`AuthVerifier.lockSession(cookieHeader)` → `{ok, role}`（role 为 `admin` / `visitor`），只回答锁屏会话（PR3 起没有 `accountSession()`；账号会话问账号 Worker 的 `AccountVerifier`）。调用方：`styrigx-daymark-core`、`styrigx-curio-core`、`styrigx-share`；调用方 wrangler.toml 写 `[[services]] binding = "AUTH"`、`service = "styrigx-auth-gateway"`、`entrypoint = "AuthVerifier"`。`ShareIssuer` 只给 `styrigx-share`（签 / 作废短链钥匙、点开时换访客会话）。只能经服务绑定调用，公网进不来。

## 绑定和密钥

| 类别 | 名字 | 说明 |
|---|---|---|
| 服务绑定 | `ACCOUNT`（AccountService）、`ACCOUNT_VERIFIER`（AccountVerifier） | 账号 Worker `styrigx-account`：转发 / 只读会话 RPC |
| 服务绑定 | `SEARCH`、`STATUS`、`CHAT` | 搜索、监测、聊天 Worker |
| D1 | `D1_LOCK_AUTH` | D1 `styrigx-auth-gateway`，只读写 `realm='lock'` 的行和恢复开关表 `lock_reset_switch` |
| 限流 | `ANON_LIMITER` | 无会话写接口按 IP 每 60 秒 20 次 |
| Secrets Store | `SGX_LOCK_PRIVATE` / `SGX_LOCK_PUBLIC` | 锁屏三张票的签名钥匙对 |
| Secrets Store | `SGX_ADMIN_KEY` | 锁屏根密钥（`/api/root-auth`、`/api/lock-reset` 比对） |
| Secrets Store | `SGX_PW_PEPPER` | 密码哈希 pepper；与账号 Worker 绑同一个密值（有意共用，Sloan 2026-10-30 确认不拆） |

- 网关只有这 4 个密钥（`SGX_LOCK_*`、`SGX_ADMIN_KEY`、`SGX_PW_PEPPER`）。账号钥匙 `SGX_ACCOUNT_PRIVATE` / `SGX_ACCOUNT_PUBLIC` 和账号根密钥 `SGX_ACCOUNT_ROOT_KEY` 只绑在账号 Worker；网关不绑 `D1_ACCOUNT_AUTH` / `D1_ROOT_AUTH`，代码里也没有 `REALM_ACCOUNT` / `REALM_ROOT`。
- `SGX_ADMIN_KEY` 在部署 PR3 之前在 Secrets Store 新建，值等于原 `SGX_ROOT_KEY`（Secrets Store 不能直接改名）。旧的 `SGX_ROOT_KEY` 已在 PR4 从 Secrets Store 删除，任何 Worker 都不再绑定它。
- 换钥只在 Cloudflare 后台改，不用改代码或重新部署（最多 60 秒生效）。
- 不开 `*.workers.dev`、不开预览地址；只通过 `styrigx.com` 等路由访问。

## 维护规则

- `functions/api/` 新增接口时，在 `src/routes.js` 登记一行（单测会检查）。账号的接口不进网关路由表，在账号 Worker 加，网关只在 `src/forwarding.js` 登记转发路径。
- 路由按域名整站通配（`styrigx.com/*` 等），新增页面目录不用加路由；新增子站时加一条 `<子站域名>/*`（`scripts/check-worker-routes.mjs` 会检查，也核对账号 Worker 没有任何路由、转发表里的路径都归网关）。
- 分层：`scripts/check-layers.mjs`（CI 必过）。网关只能 import 自己目录下的文件，不许 import 任何别的 Worker（包括账号 Worker），也没有 `workers/shared` 这类公共目录；网关源码（注释除外）不许出现账号鉴权标识，见 `docs/architecture.md`「Worker 边界」。

## 部署和回滚

- 部署顺序（`.github/workflows/deploy.yml`）：搜索 / 聊天 / 监测 → **账号 → 短链 → 网关 → Pages**。账号先上（网关要转发给它的命名入口）；短链在网关之前（短链已改问账号 Worker 的 `AccountVerifier`，网关上线那一刻短链不会出现 401 窗口）；网关冒烟通过后才部署 Pages。
- 回滚：Pages 上已经没有后端代码，不能靠删路由回滚（删了页面就不验会话）。main 部署时冒烟失败，CI 自动 `wrangler rollback` 到部署前的版本（`scripts/deploy-rollback.mjs`，只换代码版本，D1 / KV 数据和路由都不回滚）。部署前的版本低于回滚下限（`scripts/deploy-rollback-floor.json`：本 Worker 要求目标版本带 `D1_LOCK_AUTH`、`ACCOUNT`、`SGX_ADMIN_KEY` 绑定，即账号拆分 PR3 之后的代码）就不记、不自动回滚。要回到更早的代码就 revert 对应提交重新部署。
- 预览（passkey-e2e）：CI 把组合入口 `tests/web/e2e/preview-worker.js`（网关 + 账号 Worker 两边的真实代码，env 按正式绑定拆开）打包成 Pages 的 `_worker.js`，部署到 `passkey-e2e.styrigx-space.pages.dev`。预览资源只用一个 `styrigx-test-preview`（D1 / KV 都是这个名字；网关、账号、短链共用，PR3b 单测守卫）；测试用的 `SGX_ADMIN_KEY`、`SGX_ACCOUNT_ROOT_KEY`（两把不同）和 `SGX_PW_PEPPER` 每次运行现生成，不进 toml、不进 GitHub Secrets。

## 存储（D1 `styrigx-auth-gateway`，不绑 KV）

网关的认证状态全部在 D1 `styrigx-auth-gateway`（强一致，写完下一个请求就读到），只有一个绑定名 `D1_LOCK_AUTH`（凭证域见 `functions/_kernel/realms.js` 的 `REALM_LOCK`）：纪元、锁屏密码 / 通行密钥、user handle、challenge、密码 / 临时码 / 锁屏根密钥输错计数、临时钥匙、锁屏根密钥审计（都是 `realm='lock'`），另外恢复开关表 `lock_reset_switch`（方案 9.4 由 `recovery_switch` 改名，网关代码不再读写旧表）。

表：`migrations/0005_lock_account_state.sql`（epoch、passkey、password、kv_migration，每张表有 realm 列）、`0006_auth_state.sql`（user_handle、challenge、attempt_limit、tempkey、device、audit）、`0007_user_handle_legacy_handle.sql`、`0008_lock_reset_switch.sql`（恢复开关表）、`0009_drop_recovery_switch.sql`（删 `0001_recovery_switch.sql` 建的旧表，只对走迁移的预览库生效）。代码在第一次遇到「no such table」时按 `functions/_kernel/lib/d1-state.js` 的 SCHEMA 建表（幂等，单测核对与迁移文件一致），正式部署 job 不跑迁移。

恢复开关：在 D1 `styrigx-auth-gateway` 控制台插一行即可开启（首次读到起 24 小时内有效，用一次作废）：
`INSERT INTO lock_reset_switch (hash, first_seen, used) VALUES (lower(hex(randomblob(16))), 0, 0);`

## 遗留项（照实记录）

- `X-Sgx-Role`：网关发给 chat / search 的内部请求仍写旧头 `X-Sgx-Role`（`functions/api/chat.js`、`search.js`），那两个 Worker 也仍认它；账号 Worker 只认 `X-Styrigx-Lock-*`。统一留待以后。
- 账号拆分已完成（PR4）：D1 `styrigx-auth-gateway` 只剩锁屏数据（`realm='lock'` 的行和 `lock_reset_switch`）。账号数据在 D1 `styrigx-account`（`scripts/migrate-account-auth.mjs` 拷过去）；网关库里 `realm='account'` / `'root'` 的旧行和旧开关表 `recovery_switch` 已由 `--cleanup --confirm` 删除；Secrets Store 里的旧 `SGX_ROOT_KEY` 已删除。恢复开关表改名（方案 9.4）的生产顺序当时是：`--lock-reset-switch` 拷行 → 部署改名代码 → `--verify` → `--cleanup --confirm`。
- 历史：2026-10-27 认证状态从 KV 搬到 D1（`scripts/migrate-kv-to-d1.mjs`，一次性，已完成），旧认证库 KV namespace 2026-10-29 已删除。
