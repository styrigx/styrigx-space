# styrigx-auth-gateway

## 职责

主站鉴权网关：锁屏会话和锁屏凭证的全部后端代码在这里。承接 `styrigx.com` 和图志 `atlas.styrigx.com` 的整站请求：先验锁屏会话，页面验完回源 Pages 取静态文件，接口在本 Worker 回答或经服务绑定转给内部 Worker。Pages 本身只放静态文件（配置见 `web/atlas/wrangler.toml`）。

**账号不在这里**（账号拆分 PR3 起）：账号密码 / 账号通行密钥 / 已登录设备 / 账号会话 / 账号根密钥、头像、设置云同步、数字健康都在账号 Worker `styrigx-account`（`workers/account/`）。浏览器的账号请求一律先进网关，网关验门后经服务绑定 `ACCOUNT` 转发。网关源码里没有任何账号鉴权代码、账号绑定或账号钥匙（`scripts/check-layers.mjs` 规则 16 核对）。

## 入口

`src/index.js`（`wrangler.toml` 的 `main`）只接线：

| 导出 | 文件 | 做什么 |
|---|---|---|
| `default` | `src/app.js` | 公网请求的总流程：剥头 → 静态资源直通 → 取密钥 → 关口 → 路由 |
| `AuthVerifier` | `src/rpc/auth-verifier.js` | RPC `lockSession(cookieHeader)` → `{ ok, role }` 或 `{ ok:false, reason }`（逻辑在 `core/lock-session.js` `checkLockSession`）。调用方：`styrigx-daymark-core`、`styrigx-curio-core`（styrigx-atlas 仓库）、`styrigx-share`；调用方写 `[[services]] binding = "AUTH"`、`service = "styrigx-auth-gateway"`、`entrypoint = "AuthVerifier"` |
| `ShareIssuer` | `src/rpc/share-issuer.js` | 只给 `styrigx-share`：签 / 作废短链钥匙、点开时换访客会话（逻辑在 `core/link-keys.js`） |

请求在 `src/` 里的走向：

- `app.js` 第一步剥掉入站请求里所有 `x-styrigx-*` 和 `x-sgx-role` 头（下游只认网关自己写的）；主站静态资源（`/css/ /js/ /fonts/ /fav/ /images/` 和根目录几张公开图）原样回源，不验会话、不打 `X-SGX-Runtime`。
- `gate.js`：主站关口 `onRequest`（会话、角色、白名单、no-store、锁屏瘦身、HTML 会话标记）和图志关口 `handleSubsite`。
- `router.js`：主站关口放行后，转发表 `FORWARDING` → `/api/*` 路由表 `API_ROUTES`（`api/<名字>.js`）→ 回源。新增接口：加 `src/api/<名字>.js`，在 `API_ROUTES` 登记一行（单测核对两边一一对应）。
- `core/` 业务（会话、票据、凭证、D1 状态、限流、转发帮手、问账号 Worker 的 `account-rpc.js`），`lib/` 通用件，`secrets.js` 把 Secrets Store 绑定换成字符串。

## 路由

`wrangler.toml` 的 `[[routes]]` 是唯一登记处（`scripts/check-worker-routes.mjs` 在 CI 核对）：

| 路由 | 说明 |
|---|---|
| `styrigx.com/*` | 主站整站。短链 Worker 的 `styrigx.com/s/*`、`styrigx.com/api/share*` 更具体，不进网关 |
| `atlas.styrigx.com/*` | 图志整站（`/blog/`、`/curio/`、`/daymark/` 同一个 Pages）。`/curio/api/*`、`/daymark/api/*` 更具体，归 styrigx-atlas 仓库的两个接口 Worker；根上的 `/api/lock-session-check`（有效 204、无效 401）和 `/api/search` 由网关回答 |

- 账号路径（转发表 `src/router.js` 的 `FORWARDING`）：`/api/account`、`/api/prefs*`、`/api/avatar*`、`/api/wellbeing*`、`/avatar/*`。关口先验（`/api/account`、`/api/prefs*` 只许管理员；`/api/avatar*`、`/api/wellbeing*` 要有会话；`/avatar/*` 公开），放行后经 `ACCOUNT`（entrypoint `AccountService`）原样转给账号 Worker，按验过的锁屏会话写 `X-Styrigx-Lock-*` / `X-Styrigx-Client-*`。没绑定或绑定出错 → 503 upstream，不落回网关路由表、不回源。转发回来的响应保留 `X-SGX-Runtime: account`。
- 网关自己的接口：`src/router.js` 的 `API_ROUTES`（锁屏、锁屏凭证、根密钥、临时钥匙、`geo`，以及只做门再转出去的 `chat`、`search`、`status`）。接口分工见 `docs/status-apis.md`。
- 路由按域名整站通配，新增页面目录不用加路由。

## 绑定

| 类别 | 名字 | 说明 |
|---|---|---|
| 服务绑定 | `ACCOUNT`（AccountService）、`ACCOUNT_VERIFIER`（AccountVerifier） | 账号 Worker `styrigx-account`：转发 / 只读账号会话 RPC（只给账号页首帧提示 `data-sgx-account-session` 用，`core/account-rpc.js`） |
| 服务绑定 | `SEARCH`、`STATUS`、`CHAT` | `styrigx-search-index`、`styrigx-status`、`styrigx-chat`：都没有公开地址，网关先验会话再转（`/api/chat` 验同源 + 会话 + 只许管理员，回答原样流回） |
| D1 | `D1_LOCK_AUTH` | D1 `styrigx-auth-gateway`，只读写 `realm='lock'` 的行和恢复开关表 `lock_reset_switch` |
| 限流 | `ANON_LIMITER` | 无会话写接口按 IP 每 60 秒 20 次（`core/anon-limit.js`，绑定缺失时放行） |

明文变量：`SGX_ENV = "production"`、`SGX_SITE = "space"`、`SGX_ORIGIN`、`SGX_RP_ID`。不开 `*.workers.dev`、不开预览地址。

## 钥匙

只有 4 个，都在 Secrets Store（`src/secrets.js` 是唯一读取的地方）：

| 名字 | 用途 |
|---|---|
| `SGX_LOCK_PRIVATE` / `SGX_LOCK_PUBLIC` | 锁屏会话和两张锁屏短票的签名钥匙对 |
| `SGX_ADMIN_KEY` | 锁屏根密钥（`/api/root-auth`、`/api/lock-reset` 比对） |
| `SGX_PW_PEPPER` | 密码哈希 pepper；与账号 Worker 绑同一个密值（有意共用，Sloan 2026-10-30 确认不拆） |

账号钥匙 `SGX_ACCOUNT_PRIVATE` / `SGX_ACCOUNT_PUBLIC`、账号根密钥 `SGX_ACCOUNT_ROOT_KEY` 只绑在账号 Worker；聊天钥匙 `SGX_CHAT_API_KEY` 只绑在 `styrigx-chat`。换钥只在 Cloudflare 后台改，不用改代码或重新部署（最多 60 秒生效）。

## 数据与迁移

认证状态全部在 D1 `styrigx-auth-gateway`（强一致，不绑 KV），只有一个绑定名 `D1_LOCK_AUTH`（凭证域 `core/realms.js` 的 `REALM_LOCK`）：纪元、锁屏密码 / 通行密钥、user handle、challenge、密码 / 临时码 / 锁屏根密钥输错计数、临时钥匙、锁屏根密钥审计（都是 `realm='lock'`），另外恢复开关表 `lock_reset_switch`。

| 迁移 | 内容 |
|---|---|
| `0001_recovery_switch.sql` | 旧恢复开关表 `recovery_switch`（已由 0009 删除） |
| `0003_bookmarks.sql` | 主站书签三张表 `bm_*`（书签 2026-10-21 下线，已由 0004 删除） |
| `0004_drop_bookmarks.sql` | 删 `bm_*` 三张表 |
| `0005_lock_account_state.sql` | epoch、passkey、password、kv_migration（每张表有 realm 列） |
| `0006_auth_state.sql` | user_handle、challenge、attempt_limit、tempkey、device、audit |
| `0007_user_handle_legacy_handle.sql` | user_handle 加 legacy_handle 列（预览共库兼容） |
| `0008_lock_reset_switch.sql` | 恢复开关表 `lock_reset_switch`，并拷过旧表的行 |
| `0009_drop_recovery_switch.sql` | 删旧表 `recovery_switch`（只对走迁移的预览库生效；正式库已由 `--cleanup` 删） |

没有 0002。正式部署 job 不跑迁移：代码在第一次遇到「no such table」时按 `core/d1-state.js` 的 SCHEMA 建表（幂等，单测核对与迁移文件一致）。恢复开关：在 D1 控制台插一行即可开启（首次读到起 24 小时内有效，用一次作废）：
`INSERT INTO lock_reset_switch (hash, first_seen, used) VALUES (lower(hex(randomblob(16))), 0, 0);`

部署和回滚（`.github/workflows/deploy.yml`）：搜索、聊天 → 监测 → 账号 ∥ 短链（两者并行）→ **网关** → Pages。网关冒烟通过后才部署 Pages。Pages 上已经没有后端代码，不能靠删路由回滚；main 部署冒烟失败时 CI 自动 `wrangler rollback` 到部署前的版本（`scripts/deploy-rollback.mjs`，只换代码版本，D1 数据和路由都不回滚；回滚下限见 `scripts/deploy-rollback-floor.json`）。预览（passkey-e2e）用组合入口 `tests/web/e2e/preview-worker.js`，预览资源只用一个 `styrigx-test-preview`。

遗留项：网关发给 chat / search 的内部请求仍写旧头 `X-Sgx-Role`（`src/api/chat.js`、`src/api/search.js`），那两个 Worker 也仍认它；统一留待以后。
