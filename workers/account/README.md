# styrigx-account

## 职责

账号 Worker：主人账号的完整账号系统（账号拆分 PR3 起）。账号身份（账号密码、账号通行密钥、已登录设备、账号会话 / reauth / reset 三张票、Account 纪元、账号根密钥、账号审计）和账号名下的数据（头像、设置云同步、数字健康）都在这里；网关 `styrigx-auth-gateway` 里没有任何账号鉴权代码。本 Worker 不调网关、不绑任何锁屏数据或钥匙（没有 `[[services]]`）。

## 入口

`src/index.js`（`wrangler.toml` 的 `main`）只接线：

| 导出 | 文件 | 做什么 |
|---|---|---|
| `default` | `src/app.js` | 默认 fetch 一律 404（第二道保险：即使线上残留公开路由，伪造的头也碰不到任何接口） |
| `AccountService` | `src/rpc/account-service.js` | 网关经服务绑定 `ACCOUNT` 转发来的请求：`serviceFetch` → `gate.js` → `router.js` |
| `AccountVerifier` | `src/rpc/account-verifier.js` | 只读 RPC，不签任何东西，调用方只有网关（服务绑定 `ACCOUNT_VERIFIER`）：`accountSession(cookieHeader, clientContext)` → `{ ok }` 或 `{ ok:false, reason }`（账号页首帧提示）；`authorize(cookieHeader, clientContext, opts)` → 授权结论（见下文「结论」） |

- `src/gate.js`：只有 `AccountService` 读身份头——网关写的 `X-Styrigx-Lock-*`（Session / By / Tempkey-Id；P2-2 起不读 Role）、`X-Styrigx-Client-*`（Address / Country / City），`src/lib/lock-identity.js` 白名单校验。纵深防御：没进门（没有 `X-Styrigx-Lock-Session: 1`）的 `/api/*` → 401；进门之后 `/api/prefs`、`/api/avatar` 要账号会话 + 作用域（`gate.js scopeDenial`：401 account / 403 scope），`/api/account` 由 `api/account.js` 自己回 401 session。
- `src/router.js`：接口路由表 `API_ROUTES` 和头像文件 `/avatar/<尺寸>.webp`。
- `src/api/account.js`：`/api/account` 单入口 + action；账号身份的其余部分在 `src/core/`（`scopes.js` 作用域表、`authz.js` 授权判断、`app-grant.js` 授权记录、`account-session.js` 账号会话与两张短票、`account-devices.js` 已登录设备、`account-root.js` 账号根密钥与审计、`account-store.js` 账号库域对象、`realm.js` 的 `REALM_ACCOUNT` 与三张账号票）。
- `src/lib/`：本 Worker 自己的一份通用件和账号域实现（crypto、cookies、http、d1-state、passkey-verify、password*、root-*、tickets、lock-identity、avatar、security-headers、csp-hashes），不 import 网关或任何别的 Worker。

## 结论

授权骨架（P2-1，设计方案 2.3.3、2.4、4.2）：本 Worker 是授权的唯一来源。作用域表和授权判断只在这里有一份，网关和下游只认字符串，不 import。

- 作用域表 `src/core/scopes.js`：按应用（= 数据域）各一个写作用域；读私密跟账号会话走，不要作用域；敏感操作另要账号复验（`sgx-account-reauth`），不再多拆作用域。id 规则 `<应用>.<动作>`，全小写，只用 `[a-z.]`；以后加应用只在这里加一行。

  | 作用域 | 应用（授权卡，中 / 英） | 另要账号复验的敏感操作 |
  |---|---|---|
  | `curio.write` | 奇趣 / Curio | `POST /curio/api/import` |
  | `daymark.write` | 日刻 / Daymark | — |
  | `prefs.sync` | 设置同步 / Settings sync | — |
  | `wellbeing.write` | 数字健康 / Digital wellbeing | — |
  | `avatar.write` | 头像 / Avatar | — |
  | `profile.write` | 个人资料 / Profile（2026-11-07） | — |

- 授权判断 `src/core/authz.js`：
  - `grantedScopes(env, accountSession)`：P3-1（第 3 件）起读授权记录 `app_grant`（`src/core/app-grant.js`）：账号会话无效 → `[]`；还没有种子标记 → 保持骨架行为（全部作用域，上线到种子写入之间写接口不 403）；有标记 → 已授权 ∩ 作用域表。签名和结论形状不变（P2-1 定的）。每次授权读一次 D1 主库，不缓存（取消后下次请求即拦截）；只读不写。
  - `authorize(env, request, opts)` → `{ ok, reason, deviceId, scopes, reauth }`：验账号会话（过期、纪元变了、设备已退出都是 `ok:false`，`reason` 是原因代号）→ `deviceId` 取自票 → `scopes` 按字母排序 → 只有 `opts.reauth === true` 才读 `sgx-account-reauth`。只读不签，永不抛错。
- RPC：`AccountVerifier.authorize(cookieHeader, clientContext, opts)` 原样回上面的结论；网关 `core/account-rpc.js` 的 `askAuthorize` 问它，再由网关 `core/conclusion.js` 交给下游（RPC 结论 / 结论头，见网关 README「结论」）。
- 现状（P2-3）：`/api/prefs`（prefs.sync）、`/api/avatar`（avatar.write）、`/api/wellbeing`（POST 要 wellbeing.write，否则 204；GET 明细只给账号会话，响应带 `detail`）用同一份 `core/authz.js` 判断；进门只认 `X-Styrigx-Lock-Session: 1`（P2-3 起网关不再写锁侧等级头，`lib/lock-identity.js` 也不读）。
- 测试：`tests/workers/account/authz.test.mjs`、`account-entrypoints.test.mjs`。

## 授权记录（P3-1）

账号级、一个应用一行（设计方案 2.5、4.1）：D1 `styrigx-account` 的 `app_grant`（`migrations/0004_app_grant.sql`；Gray 2026-11-05 书面批准，长期约束「不新增数据迁移」的例外）。

- 表：`app`（应用 id = 授权卡 id）、`record`（JSON `{"v":1,"scopes":[...],"deviceId","by"}`，`deviceId` / `by` 只作审计和展示）、`granted_at`（毫秒）。取消 = DELETE；没有过期，不归设备清扫（`sweepExpired`）管。
- 首次切换的种子（`core/app-grant.js ensureSeed`）：表空且 `data_migration` 没有 `app-grant-seed-1` → 同一个 `db.batch` 写满全部应用 + 标记（条件写在 SQL 里，并发也只种一次）；之后取消到 0 行也不再种。触发点：授权卡页 `grant-list`、登录完成后的授权检查（同意流程也走 `grant-list`）；`grant-revoke` / `grant-add` 改之前也先跑一次（同一份幂等逻辑，防止直接调它们时别的应用掉成未授权）。以后加应用：`scopes.js` 加一行，在 `SEED_SUPPLEMENTS` 按版本号补种（只种新增的应用；`app-grant-seed-2` 补「个人资料」`profile`，2026-11-07）；补种标记还没写之前，那批新应用按已授权算（`readGrantState` 的 `pending`），上线后不会先 403。
- 接口（`/api/account`，进门 + 账号会话，不认 reset 票）：`grant-list` → `{ ok, grants:[{ app, name, scopes, sensitive, granted, grantedAt, by, device:{ name, gone }|null }] }`；`grant-revoke { app }`（不要复验）；`grant-add { app }`（要 `sgx-account-reauth`，没有 → 401 reauth）。后两个回新列表；未知应用 400 params。
- 前端：授权卡页 `/account/apps/`（`space/web/assets/js/apps/account-apps.js`）；同意流程在账号页登录区（`apps/account.js`：应用内点登录 → `/account/?return=<原页面>` → 登录（带 reauth:true）→ `grant-list` → 有授权回原页面 / 没有弹同意卡片）。
- 回滚：revert 后 `grantedScopes` 回到骨架版；表留着没人读；要不要 `DROP TABLE app_grant` 由 Gray 决定并在后台执行。

## 路由

没有公开路由（第一道保险）：`wrangler.toml` 没有任何 `[[routes]]` / `route`（`[env.preview]` 只写 `routes = []`），`workers_dev = false`、`preview_urls = false`。`space/scripts/check-worker-routes.mjs` 核对 0 条路由，`space/scripts/check-layers.mjs` 规则 17 禁止这个 toml 出现非空的 routes。

浏览器请求只能先进网关：网关验锁屏门、剥掉外来的 `x-styrigx-*` / `x-sgx-*` 头，再经 `ACCOUNT` 转进 `AccountService`。转发的路径登记在网关 `workers/auth-gateway/src/router.js` 的 `FORWARDING`，和这里一一对应：

| 路径 | 处理 |
|---|---|
| `GET` / `POST /api/account` | `api/account.js` |
| `PUT` / `DELETE /api/avatar` | `api/avatar.js`（要进门） |
| `GET /avatar/<32\|96\|192\|512>.webp` | `api/avatar-file.js`（公开；没上传过回 Pages 上的默认头像） |
| `GET` / `PUT /api/profile` | `api/profile.js`（个人资料：GET 进门即可，只回可公开的字段 + 头像版本号，没改过的字段 null；PUT 进门 + 账号会话 + `profile.write`，同源，校验长度 / 单行 / 邮箱格式，存 `KV_PROFILE` 的 `profile` 键） |
| `GET` / `POST /api/prefs` | `api/prefs.js`（设置云同步，进门 + 账号会话 + `prefs.sync`） |
| `POST` / `GET /api/wellbeing` | `api/wellbeing.js`（数字健康；没有 `wellbeing.write` 的上报 204 丢弃） |

## 绑定

| 类别 | 名字 | 说明 |
|---|---|---|
| D1 `styrigx-account` | `D1_ACCOUNT_AUTH` | 账号鉴权状态：epoch、password、passkey、user_handle、challenge、attempt_limit、device、audit（`realm='account'`）；应用授权记录 app_grant（P3-1，没有 realm 列） |
| D1 `styrigx-account` | `D1_SETTINGS_SYNC`、`D1_WELLBEING` | 设置云同步 `settings_sync`、数字健康 `wb_daily`（同一个库） |
| KV | `KV_PROFILE` | 只放公开数据：头像 `avatar:*` + 个人资料 `profile`（姓名、昵称、签名、联系邮箱，JSON，2026-11-07） |

明文变量：`SGX_ENV = "production"`、`SGX_RP_ID`、`SGX_ORIGIN`；`placement.mode = "smart"`。

## 钥匙

Secrets Store（`src/secrets.js` 换成字符串，60 秒缓存）：

| 名字 | 用途 |
|---|---|
| `SGX_ACCOUNT_PRIVATE` / `SGX_ACCOUNT_PUBLIC` | 账号三张票的签名钥匙对 |
| `SGX_ACCOUNT_ROOT_KEY` | 账号根密钥（`POST /api/account { action:'root-reauth' \| 'root-reset', key }`），与进站凭证 `SGX_LOCK_SPACE_KEY` 是不同的值、各自计数 |
| `SGX_PW_PEPPER` | 密码哈希 pepper，与网关同一个密值（有意共用的例外） |

## 数据与迁移

D1 `styrigx-account`，迁移在 `migrations/`：`0001_wellbeing.sql`（数字健康 `wb_daily`）、`0002_settings_sync.sql`（设置云同步 `settings_sync`）、`0003_account_auth.sql`（账号鉴权各表）、`0004_app_grant.sql`（应用授权记录，P3-1）。部署 job `deploy-account-worker` 先跑 `d1 migrations apply styrigx-account --remote`，再部署，再冒烟（核对线上版本 + 伪造身份头碰不到接口）。

- 部署顺序：搜索、聊天 → 监测 → **账号** ∥ 短链（两者并行）→ 网关 → Pages。账号要在网关之前（网关要转发给它的命名入口）。回滚下限：`space/scripts/deploy-rollback-floor.json` 要求目标版本带 `D1_ACCOUNT_AUTH`、`D1_SETTINGS_SYNC`。
- 预览：不部署单独的预览 Worker。`[env.preview]` 只登记测试资源，KV / D1 都是所有 Worker 共用的 `styrigx-test-preview`（迁移记录表 `d1_migrations_account`）；预览里的账号代码由组合入口 `tests/space/e2e/helpers/preview-worker.js` 在进程内跑。
- 历史：2026-10-28 云同步从 KV 搬到 D1，运行时不读 KV。账号鉴权数据 2026-10-30 由 `space/scripts/migrate-account-auth.mjs` 从网关库拷到本库；网关库里的旧行已在 PR4 删除。
- 测试：`tests/workers/account/`。
