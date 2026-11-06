# styrigx-status

## 职责

站点监测：每分钟检查一轮主站、规则集、AI（`src/targets.js`；旧图志那项 P4-3 PR-1 删除），连续 3 次失败开故障；每小时读一次 Cloudflare 用量；按需查当天免费额度的操作次数。结果给设置 → 服务状态页。

## 入口

`src/index.js`（`wrangler.toml` 的 `main`）：`default` 有 `fetch` 和 `scheduled`。检查逻辑 `src/monitor.js`，用量 `src/usage.js`，额度 `src/quota.js`，监测目标 `src/targets.js`。

## 路由

没有公开地址（`workers_dev = false`、`preview_urls = false`、没有路由）。

| 入口 | 谁调 | 做什么 |
|---|---|---|
| `GET /summary` | 网关 `styrigx-auth-gateway` 的服务绑定 `STATUS`（浏览器请求 `/api/status`，网关先验会话） | 200 站点状态 + 用量 + 额度；库不可用 503 `{ ok:false, error:'db' }`；其他路径 404、方法不对 405 |
| Cron `* * * * *` | Cloudflare | 每分钟一轮检查（`monitor.js runOnce`） |
| Cron `41 * * * *` | Cloudflare | 每小时读一次 Cloudflare 用量（`usage.js runUsage`） |

## 绑定

| 绑定 | 类型 | 资源 |
|---|---|---|
| `D1_UPTIME_MONITOR` | D1 | `styrigx-status`（检查记录、故障、状态） |
| `D1_CLOUDFLARE_USAGE` | D1 | 同一个库 `styrigx-status`（用量快照、额度缓存） |
| `AI_SERVICE` | 服务绑定 | `styrigx-ai`，测它的 `/healthz`（P4-2 起取代 `SEARCH` / `CHAT`） |

`wrangler.toml` 还开了 `compatibility_flags = ["global_fetch_strictly_public"]` 和 `placement.mode = "smart"`。

## 钥匙

- `SGX_CF_USAGE_TOKEN`：Secrets Store（和网关同一个 store），只读 API token，用量和额度都用它。
- `CF_ACCOUNT_ID`：账号 id，普通 Worker secret（`wrangler secret put CF_ACCOUNT_ID`）。

没配或值为空时不请求 Cloudflare API，`/summary` 里 `usage = null`、`usage_reason = 'not-configured'`。

## 数据与迁移

D1 `styrigx-status`，迁移在 `migrations/`，部署 job `deploy-status-worker` 先跑 `d1 migrations apply styrigx-status --remote` 再部署：

| 迁移 | 内容 |
|---|---|
| `0001_init.sql` | 初始表：`checks`（每次检查一行，留 7 天）、`daily`、`state`、`incidents` |
| `0002_usage.sql` | 用量快照表 `usage`（一行） |
| `0003_cut_reads.sql` | 降低 D1 读取量：`state` 记下这一串失败的第一次时间，加 `hourly` 表 |
| `0004_quota.sql` | 免费额度缓存表 `quota`（一行） |

部署排在搜索、聊天之后、网关之前；部署后的健康闸门见 `space/scripts/health-gate.mjs`。测试：`tests/workers/status/`。
