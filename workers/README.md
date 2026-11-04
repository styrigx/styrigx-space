# workers/：Worker 骨架契约

本目录一个 Worker 一个子目录，目录名 = Cloudflare 上的 Worker 名去掉 `styrigx-` 前缀（`workers/auth-gateway/` ↔ `styrigx-auth-gateway`）。这份文件是 Worker 骨架的唯一出处：新 Worker 照它起步，大 Worker 照它对齐。各 Worker 自己的 `README.md` 只写本 Worker（职责 / 入口 / 路由 / 绑定 / 钥匙 / 数据与迁移），不复述这里。系统分层（L0–L6）、锁屏和账号的整体设计见 [`docs/architecture.md`](../docs/architecture.md)，这里不重复。

## 1. 骨架

```
workers/<name>/
├─ wrangler.toml      必需。name = "styrigx-<name>"，main = "src/index.js"
├─ package.json       必需。{"name":"styrigx-<name>","private":true,"type":"module"}
├─ README.md          必需。本 Worker 的职责 / 入口 / 路由 / 绑定 / 钥匙 / 数据与迁移
├─ migrations/        按需：绑了 D1 才有；NNNN_snake_case.sql，已上线的文件不改名、不重新编号
└─ src/
   ├─ index.js        必需。部署入口：只接线，不放逻辑——export { default } 和命名入口（RPC 类）的再导出
   │                  （还没对齐的小 Worker 逻辑仍在 index.js，见第 3 节）
   ├─ app.js          按需。默认 handler { fetch?, scheduled? }
   ├─ router.js       按需。路径 → handler 的登记表和分发（只有一个路径的 Worker 可以不要）
   ├─ gate.js         按需。访问关口：谁能进来（会话、角色、同源、身份头）；Worker 没有关口就不要
   ├─ secrets.js      按需。读取 Secrets Store 绑定的地方
   ├─ api/            按需。一个接口一个文件，文件名 = 路径最后一段（/api/lock-entry ↔ api/lock-entry.js）；
   │                  最后一段是变量时用固定段加用途（/avatar/<尺寸>.webp ↔ api/avatar-file.js）
   ├─ rpc/            按需。WorkerEntrypoint 类，一个类一个文件，文件名 = 类名转 kebab（AuthVerifier ↔ rpc/auth-verifier.js）
   ├─ core/           按需。业务逻辑：会话、身份、票据、存储、限流……
   └─ lib/            按需。和业务无关的通用工具：http、cookies、crypto、security-headers、csp-hashes……
```

- 同一个 Worker 里，一个概念只有一个文件。不同 Worker 里同名的 `lib/*.js` 必须同名同义（安全头、CSP 由 `scripts/gen-csp.mjs` 生成或单测做同值核对）。
- 单测在 `tests/workers/<name>/`。按骨架对齐的 Worker（网关、账号），单测 import `app.js`、`router.js`、`gate.js` 和 `api/ rpc/ core/ lib/` 里的文件，不 import `src/index.js`（入口只核对源码里的再导出，例如 `tests/workers/auth-gateway/verifier.test.mjs`）；还没对齐的小 Worker 逻辑在 `index.js` 里，单测直接 import 它。`rpc/` 里的类 import 了 `cloudflare:workers`，单测先装替身 `tests/workers/account/_cf-workers.mjs`。

## 2. 依赖链

```
index.js → app.js / rpc/* → router.js → gate.js → api/ → core/ → lib/
```

- 只沿箭头往右 import，可以跳过中间的层（`app.js` 直接 import `gate.js`、`core/`、`lib/` 都行），不许往左：`lib/` 只 import `lib/`；`core/` 只 import `core/`、`lib/`；`api/` 不 import `gate.js`、`router.js`、`app.js`。跨 Worker 的 import 一律禁止（规则 14）。
- `app.js` 和 `rpc/*` 是同一层（都是 `index.js` 导出的入口），可以互相取用：账号 `rpc/account-service.js` 用 `app.js` 的 `tagRuntime`。
- `secrets.js` 谁都能 import。
- 服务绑定：`api/` 可以经 `core/` 调，也可以直接用 `env` 上的绑定。现状：网关 `api/chat.js`、`api/search.js`、`api/status.js` 直接调 `CHAT` / `SEARCH` / `STATUS`；`ACCOUNT_VERIFIER` 经 `core/account-rpc.js`；`ACCOUNT` 由 `router.js` 经 `core/forward.js` 转发。
- `gate.js` 是粗粒度的门（有没有会话、什么角色、哪些路径公开）；handler 里可以按角色再验，例如网关 `api/lock-tempkey.js` 自己再要求一次管理员锁屏会话。
- 同层的横向 import（现有两处）：网关 `gate.js` 的图志关口直接用 `api/search.js`（和主站路由表里的 `/api/search` 同一个处理函数）；账号 `api/avatar.js`、`api/prefs.js`、`api/wellbeing.js` 从 `api/account.js` 取 `ROLE_ADMIN`。
- 依赖方向不进 CI（`scripts/check-layers.mjs` 不查 Worker 内部的方向），靠评审守住。

## 3. 对齐现状（2026-11-02）

| Worker | 状态 |
|---|---|
| `auth-gateway` | 全量对齐：`index.js` / `app.js` / `router.js` / `gate.js` / `secrets.js` + `api/` `rpc/` `core/` `lib/`。原 Pages Functions 时代的 `functions/`（`_middleware.js`、`api/`、`_kernel/`、`_kernel/lib/`）全部并进 `src/`，`_kernel` 与 `_kernel/lib` 的同名文件（d1-state、tickets、space-audit / space-check / space-limit）各合成一份 |
| `account` | 全量对齐入口和身份：`worker.js` → `index.js`，原 `index.js` 拆成 `app.js` + `router.js`，`entrypoints.js` 拆成 `rpc/account-service.js`、`rpc/account-verifier.js`、`gate.js`，`identity/account.js` → `api/account.js`，`identity/` 其余 → `core/`。`lib/` 原样保留：里面还有 d1-state、password*、root-*、tickets、lock-identity、avatar 这类业务文件 |
| `share`、`chat`、`search-index`、`status`、`proxy-rules` | `main` 本来就是 `src/index.js`，这次只补齐 README，不搬家、不改 import。share 已有 `gate.js`、`api/`、`lib/`，另有两个文件在 `src/` 顶层（`auth.js` 会话判断、`open.js` 打开短链）；chat 的 `chat.js`、search-index 的 `rank.js`、status 的 `monitor.js` / `quota.js` / `targets.js` / `usage.js` 也在顶层；chat、status 读 Secrets Store 不经 `secrets.js` |
| `curio-core`、`daymark-core` | 2026-11-02 从 styrigx-atlas 搬来（`sites/<站>/workers/core/` → `workers/<站>-core/`，合并 PR1），代码不动；`main` 本来就是 `src/index.js`，只补 `README.md`、`package.json`（规则 20、21）。路由表在 `src/routes.js`、接口在 `src/api/`（`_` 开头的是接口共用模块）、索引和清扫在 `src/` 顶层。合并 PR3 起由本仓库 `.github/workflows/deploy.yml` 部署（`deploy-curio-core` / `deploy-daymark-core`，在网关之前），路由 `styrigx.com/<站>/api/*`（`atlas.styrigx.com/<站>/api/*` 旧路由保留一个版本） |

小 Worker 什么时候再对齐：要给它加第二个接口或第二个入口、要加关口或 RPC 类、单个文件大到要拆、或者要给它加 `migrations/` 的时候，顺手按上面的骨架搬一次（同一个提交里只搬结构，不改行为）。在那之前不为对齐而搬。

## 4. 防回退规则（`scripts/check-layers.mjs`，CI 必过）

| 规则 | 管什么 |
|---|---|
| 14 | 每个 Worker 只能相对 import 自己目录下的文件；非相对 import 只认 `cloudflare:workers` |
| 15 | 不许有 `workers/shared` |
| 16 | 网关源码和 `wrangler.toml`（注释除外）不许出现账号鉴权标识 |
| 17 | 账号 Worker 的 `wrangler.toml` 不许有路由 |
| 18 | `workers/**` 下不许有 `functions/` 或 `_kernel/` 目录 |
| 19 | 每个 Worker 的 `wrangler.toml` 顶层 `main` 必须是 `"src/index.js"` |
| 20 | 每个 Worker 目录必须有 `README.md` |
| 21 | 每个 Worker 的 `package.json` 必须有 `name` |

规则 19–21 认的 Worker 目录 = `workers/` 下有 `wrangler.toml` 的子目录；`tests/web/ui/check-layers.test.mjs` 另外核对 `workers/` 下每个子目录都有 `wrangler.toml`。规则 10–13（网关旧目录之间的方向）随 `functions/` 一起退役，编号不复用。

## 5. 新增 Worker

1. 建 `workers/<name>/`：`wrangler.toml`（`name = "styrigx-<name>"`、`main = "src/index.js"`、`workers_dev` / `preview_urls` 按需关）、`package.json`（上面三个键）、`README.md`（六个小节）、`src/index.js`。其余文件按需加。
2. 有路由就写进它自己 `wrangler.toml` 的 `[[routes]]`，再在 `scripts/check-worker-routes.mjs` 里登记它的路径，确认不抢网关的路由；没有公开地址的 Worker 经网关的服务绑定进来，在网关 `wrangler.toml` 加 `[[services]]`。
3. 绑 D1 就加 `migrations/0001_<名字>.sql`；预览 / 测试资源只用共用的 `styrigx-test-preview`（`tests/workers/auth-gateway/preview-resources.test.mjs` 守卫）。
4. 单测放 `tests/workers/<name>/*.test.mjs`；在 `.github/workflows/deploy.yml` 的 Unit tests 步骤加上这个目录，加一步 `wrangler deploy --dry-run` 打包检查和部署 job。
5. 本地跑 `node scripts/check-layers.mjs`、`node scripts/check-worker-routes.mjs` 和单测。
