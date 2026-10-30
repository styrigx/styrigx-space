# styrigx-account

账号 Worker：管理员账号的完整账号系统（账号拆分 PR3 起）。账号身份（账号密码、账号通行密钥、已登录设备、账号会话 / reauth / reset 三张票、Account 纪元、账号根密钥、账号审计）和账号名下的数据（头像、设置云同步、数字健康）都在这里；网关 `styrigx-auth-gateway` 里没有任何账号鉴权代码。

```
src/worker.js            部署入口（wrangler.toml 的 main）：default = index.js，另导出命名入口 AccountService / AccountVerifier
src/index.js             路由表（API_ROUTES：/api/account、/api/avatar、/api/prefs、/api/wellbeing；/avatar/<尺寸>.webp）；默认 fetch 一律 404
src/entrypoints.js       命名入口：AccountService（网关转发的请求，读身份头）、AccountVerifier（只读 RPC accountSession()）
src/secrets.js           Secrets Store 绑定换成字符串（60 秒缓存）
src/identity/            账号身份：account.js（/api/account 单入口 + action）、account-session.js（账号会话与两张短票）、
                         account-devices.js（已登录设备）、account-root.js（账号根密钥 root-reauth / root-reset、审计）、
                         account-store.js（账号库域对象、通行密钥 / user handle 读写）、realm.js（REALM_ACCOUNT 与三张账号票）
src/api/                 avatar.js（PUT / DELETE /api/avatar）、avatar-file.js（GET /avatar/<32|96|192|512>.webp）、
                         prefs.js（GET / POST /api/prefs 设置云同步）、wellbeing.js（POST / GET /api/wellbeing 数字健康）
src/lib/                 本 Worker 自己的一份通用件（crypto、cookies、http、d1-state、passkey-verify、password*、root-*、tickets、
                         lock-identity、security-headers、csp-hashes 等）；不 import 网关或任何别的 Worker
migrations/              D1 styrigx-account：0001_wellbeing.sql、0002_settings_sync.sql、0003_account_auth.sql
```

## 入口和信任边界（三道保险）

1. **没有公开路由**：`wrangler.toml` 没有任何 `[[routes]]` / `route`（`[env.preview]` 只写 `routes = []`），`workers_dev = false`、`preview_urls = false`。`scripts/check-worker-routes.mjs` 核对本 Worker 0 条路由，`scripts/check-layers.mjs` 规则 17 禁止这个 toml 出现非空的 routes。浏览器请求只能先进网关：网关验锁屏门、剥掉外来的 `x-styrigx-*` / `x-sgx-role` 头，再经服务绑定 `ACCOUNT` 转进命名入口 `AccountService`，转发路径见网关的 `workers/auth-gateway/src/forwarding.js`（`/api/account`、`/api/prefs*`、`/api/avatar*`、`/api/wellbeing*`、`/avatar/*`）。
2. **默认 fetch 一律 404**：即使线上残留公开路由，伪造的头也碰不到任何接口。
3. **只有 `AccountService` 读身份头**：网关写的 `X-Styrigx-Lock-*`（Role / By / Tempkey-Id）、`X-Styrigx-Client-*`（Address / Country / City）（`src/lib/lock-identity.js` 白名单校验）。纵深防御：没有身份头的 `/api/*` → 401，访客调 `/api/prefs` → 403。

`AccountVerifier.accountSession(cookieHeader, clientContext)` 只回账号会话的校验结论、不签任何东西。调用方：网关（服务绑定 `ACCOUNT_VERIFIER`：临时钥匙管理、短链签发、账号页首帧提示）、短链 Worker `styrigx-share`（同名绑定：短链列表）。

本 Worker 不调网关、不绑任何锁屏数据或钥匙（没有 `[[services]] AUTH`）。

## 绑定和密钥

| 类别 | 名字 | 说明 |
|---|---|---|
| D1 `styrigx-account` | `D1_ACCOUNT_AUTH` | 账号鉴权状态：epoch、password、passkey、user_handle、challenge、attempt_limit、device、audit（`realm='account'`） |
| D1 `styrigx-account` | `D1_SETTINGS_SYNC`、`D1_WELLBEING` | 设置云同步 `settings_sync`、数字健康 `wb_daily`（同一个库） |
| KV `styrigx-account` | `KV_PROFILE` | 只放公开头像 `avatar:*` |
| Secrets Store | `SGX_ACCOUNT_PRIVATE` / `SGX_ACCOUNT_PUBLIC` | 账号三张票的签名钥匙对（切换前网关绑的就是这一对密值，现有账号票继续有效） |
| Secrets Store | `SGX_ACCOUNT_ROOT_KEY` | 账号根密钥（`POST /api/account { action:'root-reauth' \| 'root-reset', key }`），与锁屏根密钥 `SGX_ADMIN_KEY` 是不同的值、各自计数 |
| Secrets Store | `SGX_PW_PEPPER` | 密码哈希 pepper，与网关同一个密值（有意共用的例外） |

账号钥匙只在这里：网关只有 `SGX_LOCK_*` / `SGX_ADMIN_KEY` / `SGX_PW_PEPPER`。

## 部署

- `.github/workflows/deploy.yml` 的 `deploy-account-worker`，顺序 **账号 → 短链 → 网关 → Pages**（账号最先：网关要转发给它的命名入口）。先跑 `d1 migrations apply styrigx-account --remote`，再部署，再冒烟（核对线上版本 + 伪造身份头碰不到接口）。token `styrigx-account-deploy`（GitHub 环境 `STYRIGX_ACCOUNT_DEPLOY`，只允许 main）。
- 回滚下限：`scripts/deploy-rollback-floor.json` 要求目标版本带 `D1_ACCOUNT_AUTH`、`D1_SETTINGS_SYNC`。CI 自动回滚只换代码版本，不恢复路由。
- 预览：不部署单独的预览 Worker。`[env.preview]` 只登记测试资源，KV / D1 都是所有 Worker 共用的 `styrigx-test-preview`（迁移记录表 `d1_migrations_account`），passkey-e2e 部署前对它跑这套迁移；预览里的账号代码由组合入口 `tests/web/e2e/preview-worker.js` 在进程内跑。

## 分层与边界

- 只 import 自己目录 `workers/account/` 下的文件和 `cloudflare:workers`；不 import 网关，网关也不 import 这里（`scripts/check-layers.mjs` 规则 14）。不存在 `workers/shared`（规则 15），需要的通用件在 `src/lib/` 各自一份。
- 账号的数据：2026-10-28 云同步从 KV（`account-prefs`）搬到 D1，运行时不读 KV、没有回落。账号鉴权数据 2026-10-30 由 `scripts/migrate-account-auth.mjs` 从网关库拷到本库；网关库里的旧行 PR4 `--cleanup` 才删（7 天观察期后）。
- 测试：`tests/workers/account/`。
