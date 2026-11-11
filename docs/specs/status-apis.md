# 只读状态接口

> 已被 v6 定稿取代（见 `docs/decisions/ADR-0006-identity-v6.md`）。

| 项 | 值 |
|---|---|
| 文档编号 | SGX-SPEC-002 |
| 版本 | 2.0 |
| 日期 | 2026-11-09 |
| 状态 | 现行 |
| 取代 | `docs/status-apis.md`（2026-11-06） |

## 1. 范围

本规范列出只回答「是否已设置 / 是否有效 / 当前状态」的接口：谁回答、鉴权要求、返回口径与调用方。写接口不在本文范围。

## 2. 共同约束

2.1 状态接口 MUST 只返回「是否已设置」及到期时间一类的元数据，MUST NOT 返回密码哈希、公钥、私钥、cookie 值、challenge 原文。

2.2 读取凭证失败时 MUST fail closed：`lock-entry` 按「已配置」回答，其余回 503，绝不按「未设置」回答。

2.3 新增调用方前 SHOULD 先更新本表。调用方以 `grep space/web/assets/js/` 为准。

## 3. 接口表

| 接口 | 回答方 | 鉴权 | 返回 | 调用方 |
|---|---|---|---|---|
| `GET /api/lock-entry` | 站点核心 | 无（公开） | `{ ok, passkey, password }`：解锁密码 / 进站通行密钥是否设置；读失败按都已设置 | `shell/space/api.js`（锁屏 `sudo styrigx` 列可选方式） |
| `GET /api/lock-session-check[?return=]` | 站点核心 | 无（自检） | 有效：200 `{ ok:true, by, exp, next }`（`next` 为 `resolveReturn` 校验后的去处，不带 `return` 时为 `null`）；无效：401 `{ ok:false }`。子站页面请求的是主域名根上的同一个接口 | `shell/space/guard.js`（主站；v5 S3 起子站页面公开，不再有自己的复查脚本） |
| `POST /api/lock-reauth { action:'status' }` | 站点核心 | 进站会话，或有效 reset 票 | `{ ok, valid, ticket?, by?, expiresAt?, password, passkey }`：当前有效的是 `lock-reauth` 还是 `lock-reset` 票、到期时刻（ms），以及进站凭证是否设置 | `shell/space/api.js`（盾牌头部 reauth 倒计时、进站凭证层） |
| `GET /api/lock-credentials` | 站点核心 | 进站会话，或有效 reset 票 | `{ ok, password, passkey }`；读失败 503 | 当前前端无调用方（接口保留） |
| `GET /api/space-audit` | 站点核心 | 进站会话 + 账号会话（缺前者 401 `session`，缺后者 401 `account`）；不要 reauth | `{ ok, items:[{ ts, ipPrefix, ok }] }`：恢复钥匙最近的使用记录，新的在前，最多 50 条 | `apps/space-status.js`（旷野 `#status` 页底折叠区，展开时才请求） |
| `GET /api/status` | 站点核心验门 → `styrigx-status` | 进站会话 | `{ ok, now, today, all_up, sites, incidents, usage, usage_reason, quota, quota_reason }`，原样转发，不缓存；监测不可用 503 | 状态页 `/status/`、导航面板 STATUS、首页状态胶囊 |
| `GET /api/account` | 站点核心验门 → `styrigx-account` | 进站会话（账号 Worker 只认站点核心写的 `X-Styrigx-Space-Session: 1`）；不要求账号会话 | `{ ok, configured:{ password, passkey }, signing, session, reauth, reset }`：`session` = `{ by, authAt, expiresAt, device }` 或 `null`；`reauth`、`reset` = `{ by, expiresAt }` 或 `null`；D1 失败 503；转发失败 503 `upstream` | `shell/account/api.js` |

## 4. 口径

4.1 `lock-*` 只看**进站侧**（D1 `styrigx-space-core`），`/api/account` 只看**账号侧**（D1 `styrigx-account`）。两侧的 `password` / `passkey` 字段名相同而含义不同（解锁密码 vs 账号密码；进站通行密钥 vs 账号通行密钥），调用方 MUST NOT 混用。

4.2 `lock-entry` 与 `lock-credentials` 不合并：前者必须无鉴权（锁屏上调用），后者必须鉴权。

4.3 `lock-session-check` 只回答进站会话，MUST NOT 反映账号会话；账号会话只由 `GET /api/account` 的 `session` 字段报告。

## 5. 不是状态接口但相关

5.1 `GET` / `POST /api/prefs`（账号 Worker）：设置云同步，要进站会话 + 账号会话 + `prefs.sync`；存 D1 `styrigx-account` 的 `settings_sync`，逐项 `{ v, t }` 新的赢；只同步 `sgx-` 开头、在 `lib/cloud-sync.js` 白名单里的键。

5.2 `GET /api/geo`：Cloudflare 提供的城市 / 坐标 / 时区，无需会话。

5.3 `GET /api/find?q=&lang=`（v5 S4）：关键词搜索，无需会话（访客也能用），不走模型。站点核心按 IP 限流后转给 `styrigx-ai` 的 `GET /find`，读四站 KV 索引；只回公开页面的 `{ title, url, site, snippet }`，私密条目、监测数据、音频、账号数据都不在里面。索引读不了时 200 `degraded: true`（空结果），不回 5xx；超限 429 `cooldown`。终端命令 `find <词>`（访客 `man` 里列它；进站后搜索走 `ask`）。
