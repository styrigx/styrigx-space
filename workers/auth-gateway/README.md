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
- 预览（passkey-e2e）：CI 把本目录打包成 Pages 的 `_worker.js`，部署到 `passkey-e2e.styrigx-space.pages.dev`，连预览用的空 KV/D1；此时页面和默认头像读 `env.ASSETS`。预览没有账号 Worker：`/api/avatar`、`/api/prefs`、`/api/wellbeing` 回 404，头像是静态默认图。

## KV 键名迁移（第 5 层，一次性）

`KV_LOCK_DOOR` 与 `KV_ACCOUNT_LOGIN` 指向同一个 namespace，键名统一为 `<域>-<对象>[:<编号>]`（新键名表见 `functions/_kernel/realms.js`）。代码只读写新键，没有旧键回退，所以**部署本版本前必须先迁移**。脚本：`scripts/migrate-kv-names.mjs`（Cloudflare REST API，凭据只从环境变量 `CF_API_TOKEN`、`CF_ACCOUNT_ID` 读，可选 `SGX_KV_NAMESPACE_ID`）。

执行顺序：

1. `node scripts/migrate-kv-names.mjs`：dry-run，备份整个 namespace 到 `~/.sgx-kv-backups/`（明文，0600；`--backup-dir` 可改，但不许在仓库里）并打印计划，核对一遍。
2. `node scripts/migrate-kv-names.mjs --apply`：写新键（保留原过期时间）并逐键校验；目标键已存在的不覆盖。
3. 部署本版本。
4. 实测：锁屏密码、锁屏通行密钥、账号密码、账号通行密钥、设备列表；重新签发全部临时钥匙（旧临时钥匙不迁移，码哈希的域串已改为 `lock-tempkey|`）。
5. `node scripts/migrate-kv-names.mjs --delete-old`：确认新键都在后删除全部旧键，包括已作废的旧通行密钥索引、应用凭证旧记录和旧临时钥匙（完整清单见脚本开头注释）。

注意：

- `--apply` 不覆盖已存在的新键，重跑或部署后误跑不会用旧值盖掉新代码写的纪元、设备、通行密钥计数；但部署后本来也不需要再跑。
- 备份是整个 namespace 的明文（密码哈希、通行密钥、user handle），迁移收尾（`--delete-old` 成功、实测无误）后自己删掉。
- `--verify` 只在部署前有意义，部署后新旧值本来就可能不同。
- 后台手写的重置开关由脚本复制为 `lock-reset-switch`；以后开关重置都写这个新名。
- 密码哈希、WebAuthn user handle、credId 原样不变，不需要重新注册或重设密码。Secrets Store 密钥名（含 `SGX_PW_PEPPER`）不变。
- 迁移完成后本脚本可在后续 PR 删除。
