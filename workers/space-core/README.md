# styrigx-space-core

## 职责

站点核心 Worker（进站 v3 L2 起，原鉴权网关 `styrigx-auth-gateway`；分享链接 Worker `styrigx-share` 并入）：进站会话、锁屏凭证和分享链接的全部后端代码在这里。承接 `styrigx.com` 整站请求（含子站 `/blog/`、`/curio/`、`/daymark/`，按路径前缀走子站关口）：先验进站会话，页面验完回源 Pages 取静态文件，接口在本 Worker 回答或经服务绑定转给内部 Worker。Pages 本身只放静态文件（配置见 `space/web/wrangler.toml`）。

**账号不在这里**（账号拆分 PR3 起）：账号密码 / 账号通行密钥 / 已登录设备 / 账号 session / 恢复密钥、头像、设置云同步、数字健康都在账号 Worker `styrigx-account`（`workers/account/`）。浏览器的账号请求一律先进网关，网关验门后经服务绑定 `ACCOUNT` 转发。网关源码里没有任何账号鉴权代码、账号绑定或账号钥匙（`space/scripts/check-layers.mjs` 规则 16 核对）。

## 入口

`src/index.js`（`wrangler.toml` 的 `main`）只接线：

| 导出 | 文件 | 做什么 |
|---|---|---|
| `default` | `src/app.js` | 公网请求的总流程：剥头 → 静态资源直通 → 取密钥 → 关口 → 路由 |
| `SpaceVerifier` | `src/rpc/space-verifier.js` | RPC `session(cookieHeader)` → `{ ok, reason }`（逻辑在 `core/lock-session.js` `checkLockSession`）；`conclusion(cookieHeader, clientContext, opts)` → 结论（见下文「结论」，逻辑在 `core/conclusion.js`）。调用方：`styrigx-daymark-core`、`styrigx-curio-core`（只用 `conclusion()`）；调用方写 `[[services]] binding = "SPACE"`、`service = "styrigx-space-core"`、`entrypoint = "SpaceVerifier"` |
| `ShareJanitor` | `src/rpc/share-janitor.js` | RPC `purgeShareLinks(at)` → `{ ok:true, deleted }` / `{ ok:false }`（不抛错；逻辑在 `core/share-links.js` `purgeDeadLinks`）。v5 S2：只给 `styrigx-status` 的服务绑定 `JOB_SPACE`，每天 03:41 CST 那轮调一次；单独一个入口，不挂在 SpaceVerifier 上（那个绑给了奇趣、日刻） |

分享链接（原 `styrigx-share`）没有新建 / 管理的 RPC 入口（只有上面那个清理入口）：点开时签链接会话（v5 S1：`by=link`，票里 `linkId` = `share_link.id`，验票时每次查这一行）、新建 / 管理的门槛都是 `core/link-keys.js` 的内部函数；作废直接写 `share_link.revoked_at`。清理入口 `core/share-links.js` `purgeDeadLinks`（v5 S2 起由 styrigx-status 每日 03:41 CST 那轮经服务绑定 `JOB_SPACE` 调命名入口 `ShareJanitor`）。

请求在 `src/` 里的走向：

- `app.js` 第一步剥掉入站请求里所有 `x-styrigx-*` 和旧前缀 `x-sgx-*` 头（下游只认网关自己写的）；主站静态资源（`/css/ /js/ /fonts/ /fav/ /images/` 和根目录几张公开图）原样回源，不验会话、不打 `X-SGX-Runtime`。
- `gate.js`：访问表 `ROUTE_ACCESS`（v5 S3：页面一律公开；接口只有表里逐条写出的「方法 + 路径」不要进站会话，其余默认要）、主站关口 `onRequest`（域名、会话、no-store、HTML 会话标记）和子站关口 `handleSubsite`（`styrigx.com/blog/`、`/curio/`、`/daymark/` 按路径前缀），两边同一个放行函数 `admit`。旧图志域名的 301（`atlasRedirect`）已于 P4-3 PR-1 删除。
- `router.js`：分享链接 `/s/<码>`、`/api/share` 在关口之前由 `routeShare` 接走（`core/share-open.js` 打开短链、`api/share.js` 管理接口，`/s/<码>` 谁都能开，`/api/share` 要进站会话、list / revoke 另要 reauth）；主站关口放行后，转发表 `FORWARDING` → `/api/*` 路由表 `API_ROUTES`（`api/<名字>.js`）→ 回源。新增接口：加 `src/api/<名字>.js`，在 `API_ROUTES` 登记一行（单测核对两边一一对应）。
- `core/` 业务（会话、票据、凭证、D1 状态、限流、转发帮手、问账号 Worker 的 `account-rpc.js`、组装结论的 `conclusion.js`），`lib/` 通用件，`secrets.js` 把 Secrets Store 绑定换成字符串。

## 结论

授权骨架（P2-1，设计方案 2.3、4.3）：网关验门；需要授权时经 `ACCOUNT_VERIFIER` 问账号 Worker（`core/account-rpc.js` `askAuthorize` → `AccountVerifier.authorize()`）；再把结论交给下游——RPC 调用回结论对象，HTTP 转发写结论头。下游只信结论。网关不读账号库、不持账号钥匙，作用域只认字符串格式，不 import 账号的作用域表（规则 14、16）。

- **RPC 结论** `SpaceVerifier.conclusion(cookieHeader, clientContext, opts)`（`core/conclusion.js` `conclusionFor`）：

  ```
  { space:   { ok, by, linkId, reason },
    account: { ok, deviceId, scopes: string[], reauth, reason } }
  // opts: { reauth?: boolean }  只有需要账号复验结论的接口才传 true（账号侧多读一张票）
  ```

  - `space.ok=false` 时不问账号：`account = { ok:false, reason:'no-space' }`（进门是前置；进站 v3 Q17 前是 `lock` / `no-lock`）。
  - 账号绑定没配（`no-verifier`）、RPC 抛错（`rpc-error`）、回了看不懂的东西（`bad-reply`）→ `account.ok=false`（fail closed）。
  - 白名单：`space.by` 只认 `password` / `passkey` / `link`，`linkId` 只在 `by=link` 时有；`deviceId` 只认 `[A-Za-z0-9_-]{8,32}`；作用域只认 `<应用>.<动作>`（`[a-z.]`），不合格式的丢掉，去重、按字母排序；`reauth` 只认 `true`。
  - 下游写法（P2-2 起）：要作用域 = `account.ok && account.scopes.includes('<站>.write')`；读私密 = `account.ok`；敏感 = 再加 `account.reauth`。
- **HTTP 结论头**：`core/conclusion.js` `writeAccountConclusion(headers, account)` 先剥掉所有 `X-Styrigx-Account-*`，再只写白名单值，某一项没有就不写（不写 `0`）。表见 `docs/architecture/overview.md`「网关结论」。浏览器带来的同名头在 `app.js` 第一步（剥所有 `x-styrigx-*`）就没了。
- **锁侧转发头**：`core/lock-identity.js` 转发给账号 Worker 时，有锁屏身份就写 `X-Styrigx-Space-Session: 1`（和进门方式 `X-Styrigx-Space-By`）；P2-3 起没有等级头。
- 命名：网关代码里只用 `account.reauth` / `X-Styrigx-Account-Reauth` 这类字段名，不出现账号票名（`space/scripts/check-layers.mjs` 规则 16）。
- 现状（P2-1）：只新增，没有调用方，现有判断一行没改。P2-2 起子站接口 Worker 改调 `conclusion()`；结论头只写给 `styrigx-ai`（第 4 件；P4-2b 起 search-index 退役）。
- 测试：`tests/workers/space-core/conclusion.test.mjs`、`verifier.test.mjs`、`lock-identity.test.mjs`。

## 路由

`wrangler.toml` 的 `[[routes]]` 是唯一登记处（`space/scripts/check-worker-routes.mjs` 在 CI 核对；只登记 `styrigx.com`，旧图志域名的路由和 301 已于 P4-3 PR-1 删除）：

| 路由 | 说明 |
|---|---|
| `styrigx.com/*` | 主站整站，含子站 `/blog/`、`/curio/`、`/daymark/`（同一个 Pages、一棵树；按路径前缀走子站关口 `handleSubsite`，子站页面用的 `/api/lock-session-check` 就是主站根上的同一个接口）。分享链接 `/s/*`、`/api/share` 也在这条里（原 `styrigx-share` 的两条更具体路由 L2 第一次部署时删除；部署后 `space/scripts/verify-core-routes.mjs` 核对它们不再出现）；接口 Worker 的 `styrigx.com/curio/api/*`、`styrigx.com/daymark/api/*` 更具体，不进本 Worker |

- 账号路径（转发表 `src/router.js` 的 `FORWARDING`）：`/api/account`、`/api/prefs*`、`/api/avatar*`、`/api/wellbeing*`、`/api/profile*`、`/avatar/*`。关口先验（`/api/account`、`/api/prefs*`、`/api/profile*` 要进门；`/api/avatar*`、`/api/wellbeing*` 要有会话；`/avatar/*` 公开），放行后经 `ACCOUNT`（entrypoint `AccountService`）原样转给账号 Worker，按验过的进站会话写 `X-Styrigx-Space-*` / `X-Styrigx-Client-*`。没绑定或绑定出错 → 503 upstream，不落回网关路由表、不回源。转发回来的响应保留 `X-SGX-Runtime: account`。
- 网关自己的接口：`src/router.js` 的 `API_ROUTES`（锁屏、锁屏凭证、进站凭证、`geo`，以及只做门再转出去的 `ai`、`status`；`chat`、`search` 在 P4-2b 删除，回 404）。接口分工见 `docs/specs/status-apis.md`。
- 路由按域名整站通配，新增页面目录不用加路由。

## 绑定

| 类别 | 名字 | 说明 |
|---|---|---|
| 服务绑定 | `ACCOUNT`（AccountService）、`ACCOUNT_VERIFIER`（AccountVerifier） | 账号 Worker `styrigx-account`：转发 / 只读授权结论 RPC `authorize()`（`core/account-rpc.js`，`core/conclusion.js` 组装结论时用）；命名 v2 删了账号页首帧提示（`data-sgx-account-session`、`askSessionFor`），网关不问账号 session |
| 服务绑定 | `STATUS`、`AI_SERVICE` | `styrigx-status`、`styrigx-ai`：都没有公开地址，网关先验会话再转（`/api/ai` 验同源 + 进门 + 两档限流，回答原样流回）；`SEARCH`、`CHAT` 已在 P4-2b 删除 |
| 服务绑定 | `AI_SERVICE` | `styrigx-ai`（P4-1）：没有公开地址；`POST /api/ai`（`src/api/ai.js`）验同源、进门、两档 AI 限流、写账号结论头后转给它的 `POST /ask`，SSE 原样流回 |
| D1 | `D1_SPACE` | D1 `styrigx-space-core`：`realm='lock'` 的行、分享链接 `share_*`、AI 全站限流计数（`realm='ai'`）；基线里的恢复开关表 `lock_reset_switch` 已无运行时读者（进站 v3 L1 起 reset 只要恢复钥匙） |
| 限流 | `ANON_LIMITER` | 无会话写接口按 IP 每 60 秒 20 次（`core/anon-limit.js`，绑定缺失时 fail-closed 503 `config`；限流器调用本身出错时放行并记日志） |
| 限流 | `AI_LIMITER`（namespace 2802） | `/api/ai` 第一档：每 IP 每 60 秒 6 次，超了 429 `cooldown`（`core/ai-limit.js`，绑定缺失时放行）。第二档全站总闸每分钟 60 次不用绑定：`D1_SPACE` 的 `attempt_limit` 里 `realm='ai'`、`kind='global'`、bucket = 当前分钟的一行，单条 upsert 判断 + 计数，超了或 D1 出错 429 `busy`（不改表结构、不加迁移） |

明文变量：`SGX_ENV = "production"`、`SGX_SITE = "space"`、`SGX_ORIGIN`、`SGX_RP_ID`。不开 `*.workers.dev`、不开预览地址。

## 钥匙

5 个 `SGX_SPACE_*`（进站 v3 Q18），都在 Secrets Store（`src/secrets.js` 是唯一读取的地方）：

| 名字 | 用途 |
|---|---|
| `SGX_SPACE_PRIVATE` / `SGX_SPACE_PUBLIC` | 进站会话和两张锁屏短票的签名钥匙对 |
| `SGX_SPACE_RECOVERY_KEY` | 恢复钥匙（`/api/lock-reset` 比对，只签 reset 票；`/api/space-auth` 只剩 `purpose:'lock-reset'`，前端不再调用） |
| `SGX_SPACE_PASSWORD_PEPPER` | 解锁密码的哈希 pepper；账号密码用账号 Worker 自己的 `SGX_ACCOUNT_PASSWORD_PEPPER` |
| `SGX_SPACE_TEMPKEY_PEPPER` | 原临时钥匙码的哈希 pepper：v5 S1 删掉临时钥匙后没有代码读它，绑定和密钥在收尾 PR 删 |

账号钥匙 `SGX_ACCOUNT_PRIVATE` / `SGX_ACCOUNT_PUBLIC`、恢复密钥 `SGX_ACCOUNT_RECOVERY_KEY`、账号密码 pepper `SGX_ACCOUNT_PASSWORD_PEPPER` 只绑在账号 Worker；外部模型钥匙 `SGX_CHAT_API_KEY` 只绑在 `styrigx-ai`（P4-2a 起；之前在 `styrigx-chat`）。换钥只在 Cloudflare 后台改，不用改代码或重新部署（最多 60 秒生效）。

## 数据与迁移

认证状态全部在 D1 `styrigx-space-core`（强一致，不绑 KV），只有一个绑定名 `D1_SPACE`（凭证域 `core/realms.js` 的 `REALM_LOCK`）：纪元、锁屏密码 / 通行密钥、user handle、challenge、密码 / 临时码 / 进站凭证输错计数、临时钥匙、恢复钥匙审计（都是 `realm='lock'`）。基线里还有恢复开关表 `lock_reset_switch`，进站 v3 L1 起没有运行时代码读它（`core/lock-reset-switch.js` 只剩测试引用）。

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

没有 0002。以上是旧迁移，L2b 起在 `migrations-archive/` 只留史；正式部署 job（`deploy-space-core`）只跑一份基线 `migrations/0001_baseline.sql`（`D1_SPACE` → `d1_migrations_core`）；代码在第一次遇到「no such table」时按 `core/d1-state.js` 的 SCHEMA 建表（幂等，单测核对与迁移文件一致）。

部署和回滚（`.github/workflows/deploy.yml` 的 `deploy-space-core`，环境 / token `STYRIGX_SPACE_CORE_DEPLOY`）：ai → 监测 → 账号 → **站点核心** → 奇趣接口 ∥ 日刻接口 → Pages（两个接口 Worker 的服务绑定 `SPACE` 要它先在）；冒烟通过后才部署 Pages。部署后 `space/scripts/verify-core-routes.mjs` 只读核对路由（L2 第一次部署时的一次性路由接管和旧 Worker 已于 L3 删除，见 git 历史）。Pages 上已经没有后端代码，不能靠删路由回滚；main 部署冒烟失败时 CI 自动 `wrangler rollback` 到部署前的版本（`space/scripts/deploy-rollback.mjs`，只换代码版本，D1 数据和路由都不回滚；回滚下限见 `space/scripts/deploy-rollback-floor.json`）。预览（passkey-e2e）用组合入口 `tests/space/e2e/helpers/preview-worker.js`，预览资源只用一个 `styrigx-test-preview`。

下游的身份头：`src/api/ai.js` 改写账号结论头（`X-Styrigx-Account-*`，styrigx-ai 只认 `X-Styrigx-Account-Session: 1`）。`src/api/search.js`、`src/api/chat.js` 在 P4-2b 连同 /chat/ 页退役。入站的旧前缀 `x-sgx-*` 头仍照剥。
