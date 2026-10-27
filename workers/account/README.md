# styrigx-account

主站「管理员账号名下的数据」的后端，2026-10-24 从鉴权网关 `styrigx-auth-gateway` 拆出来：头像、设置云同步、数字健康。

```
src/index.js        入口：路由表（/api/avatar、/api/prefs、/api/wellbeing、/avatar/<尺寸>.webp）、回源、X-SGX-Runtime: account
src/gate.js         门：照搬网关 middleware 对这几条路径的判断（域名、访客调管理员接口 403、没会话 401 / 302、头像文件公开）
src/auth.js         会话：全部问网关的 AuthVerifier（服务绑定 AUTH，RPC），本 Worker 不持钥匙
src/api/avatar.js        PUT / DELETE /api/avatar（只许管理员、同源）→ KV_PROFILE
src/api/avatar-file.js   GET /avatar/<32|96|192|512>.webp（公开；没上传过 → Pages 上的静态默认图）
src/api/prefs.js         GET / POST /api/prefs 设置云同步（管理员 + 账号会话）→ D1_SETTINGS_SYNC 的 settings_sync（逐项新的赢，SQL 里原子完成）
src/api/wellbeing.js     POST / GET /api/wellbeing 数字健康 → D1_WELLBEING 的 wb_daily
src/lib/            avatar.js（尺寸、键名、格式识别）、http.js（同源校验 / no-store，直接用网关那份）
migrations/         D1 styrigx-account 的表结构（0001_wellbeing.sql、0002_settings_sync.sql）
```

- 路由：`wrangler.toml` 的 `[[routes]]`，四条都比网关的 `styrigx.com/*` 更具体，前端地址不变。`scripts/check-worker-routes.mjs` 核对这几条路径归本 Worker、网关的接口和页面没被抢走。
- 会话：门和接口都问网关（`lockSession()` = 锁屏会话，访客还要有效的临时钥匙票；`accountSession()` = 账号会话），和这些接口还在网关里时是同一套验签代码。网关不可达 → 当作无会话（fail closed）。
- 数据：KV `styrigx-account`（`KV_PROFILE`，只放公开头像 `avatar:*`）；D1 `styrigx-account`（`D1_WELLBEING` 数字健康、`D1_SETTINGS_SYNC` 云同步，同一个库）。2026-10-28 云同步从 KV（`KV_SETTINGS_SYNC` 的 `account-prefs`）搬到 D1，运行时不读 KV、没有回落；部署前用 `scripts/migrate-prefs-kv-to-d1.mjs`（`--dry-run` → 导入 → `--verify`）一次性导入旧值。预览 KV `styrigx-account-preview` 已登记在 `[env.preview]`；预览 D1 还没建（`wrangler.toml` 里留了注释掉的占位），在那之前预览 Worker 的云同步没有存储（`/api/prefs` 登录后 500 config）。
- 部署：`.github/workflows/deploy.yml` 的 `deploy-account-worker`，在网关之后（要先有带 `accountSession()` 的 AuthVerifier）；先跑 `d1 migrations apply styrigx-account --remote`，再部署，再冒烟。token `styrigx-account-deploy`（GitHub 环境 `STYRIGX_ACCOUNT_DEPLOY`，只允许 main）。
- 测试：`tests/workers/account/`。
