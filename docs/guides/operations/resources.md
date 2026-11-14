# Cloudflare 资源清单

| 项 | 值 |
|---|---|
| 文档编号 | SGX-OPS-002 |
| 版本 | 1.0 |
| 日期 | 2026-11-09 |
| 状态 | 现行 |

## 1. 范围与规则

1.1 本表只列**名字**（资源名、绑定名、Secret 名），来源是各 `wrangler.toml`。资源 id、namespace id、Secrets Store id、token 值 MUST NOT 出现在文档里；需要时查对应的 `wrangler.toml` 或 Cloudflare 后台。

1.2 命名约定：站点 = Pages 项目 + `<站>-core` Worker + 同名 D1（`styrigx-space` / `styrigx-space-core`，`styrigx-curio-core`，`styrigx-daymark-core`）。绑定名 = `<类型前缀>_<存放的内容>`（`D1_QUOTES`、`R2_PHOTOS`、`KV_SEARCH_INDEX`）。

1.3 预览 / 测试资源所有 Worker 只用一个 `styrigx-test-preview`（`tests/workers/space-core/preview-resources.test.mjs` 守卫）。

1.4 Cloudflare 后台的账单 / 付款页面不在自动化操作范围内。

## 2. Pages

| 项目 | 构建产物 | 绑定 |
|---|---|---|
| `styrigx-space` | `space/web/public` | 生产：无；`preview` 环境：`D1_SPACE`、`D1_ACCOUNT` → `styrigx-test-preview`（只给 passkey-e2e） |

## 3. Workers

| Worker | 路由 / 入口 | 定时任务 |
|---|---|---|
| `styrigx-space-core` | 路由 `styrigx.com/*` | — |
| `styrigx-account` | 无路由；命名入口 `AccountService`、`AccountVerifier` | — |
| `styrigx-ai` | 无路由；placement `gcp:us-east4` | `41 * * * *`（语义索引同步） |
| `styrigx-status` | 无路由 | `* * * * *`（监测）、`41 * * * *`（用量） |
| `styrigx-curio-core` | 路由 `styrigx.com/curio/api/*`；命名入口 `CurioReader` | `23 * * * *` |
| `styrigx-daymark-core` | 路由 `styrigx.com/daymark/api/*` | `17 * * * *` |
| `styrigx-proxy` | 自定义域名 `proxy.styrigx.com` | D1 `styrigx-proxy`、Secrets Store `SGX_PROXY_DB_KEY`、Rate Limiting `RL_SUB`、自绑 `SELF`；cron 每 6 小时 |

全部 Worker：`workers_dev = false`、`preview_urls = false`，开启 observability。

## 4. 存储与绑定

### 4.1 D1

| 数据库 | 绑定（Worker） | 内容 |
|---|---|---|
| `styrigx-space-core` | `D1_SPACE`（space-core） | 进站：纪元、解锁密码、通行密钥、user handle、challenge、输错计数、恢复钥匙审计；分享链接 `share_*`；AI 全站限流计数。迁移表 `d1_migrations_core` |
| `styrigx-account` | `D1_ACCOUNT`（account） | `account_*` 表、`settings_sync`（`wb_daily` v6 P4 删除，见 `docs/architecture/archive/ops/v6-p4-drop-wellbeing.sql`） |
| `styrigx-status` | `D1_UPTIME_MONITOR`、`D1_CLOUDFLARE_USAGE`（status） | `status_*` 表。迁移表 `d1_migrations_status` |
| `styrigx-curio-core` | `D1_FINDS`、`D1_DEVICES`、`D1_GAMES`、`D1_MOVIES`、`D1_MUSIC`（curio-core） | 收藏、设备、游戏、电影、音乐 |
| `styrigx-daymark-core` | `D1_QUOTES`（daymark-core） | 句子、专题、`daily_pick` |
| `styrigx-proxy` | `D1_PROXY`（proxy-rules） | 代理订阅：`meta`（公钥、令牌哈希与封存的令牌、UA）、`sources`（机场链接与节点密文、成品 age 密文）、`lock` |
| `styrigx-test-preview` | 各 Worker 的 `env.preview` | 预览 / 测试共用 |

### 4.2 KV

| 命名空间 | 绑定（Worker） | 内容 |
|---|---|---|
| `styrigx-space-core` | `KV_SEARCH_INDEX`（ai 读、curio-core / daymark-core 写） | 搜索索引 `site:space`、`site:blog`、`site:curio`、`site:daymark`；模型登记 `ai:models`；语义同步状态 `ai:recall:<站>` |
| 账号 KV（命名空间名不在代码中） | `KV_PROFILE`（account） | 只放公开数据：头像 `avatar:*`、个人资料 `profile` |

### 4.3 R2

| 桶 | 绑定（Worker） | 内容 |
|---|---|---|
| `styrigx-curio-core` | `R2_PHOTOS`、`R2_MUSIC`（curio-core） | 照片 `photos/`、音乐 `music/`、书签导入备份 |

### 4.4 其他

| 资源 | 绑定（Worker） |
|---|---|
| Vectorize 索引 `styrigx-ai-recall` | `VECTORIZE`（ai） |
| Workers AI | `AI`（ai） |
| Rate Limiting `ANON_LIMITER`（每 IP 每分钟 20 次） | space-core |
| Rate Limiting `AI_LIMITER`（每 IP 每分钟 6 次） | space-core |
| Rate Limiting `FIND_LIMITER`（`/api/find`，每 IP 每分钟 10 次） | space-core |

### 4.5 服务绑定

| 调用方 | 绑定 | 目标（入口） |
|---|---|---|
| space-core | `ACCOUNT` | `styrigx-account`（`AccountService`） |
| space-core | `ACCOUNT_VERIFIER` | `styrigx-account`（`AccountVerifier`） |
| space-core | `STATUS` | `styrigx-status` |
| space-core | `AI_SERVICE` | `styrigx-ai` |
| status | `AI_SERVICE` | `styrigx-ai` |
| ai | `CURIO` | `styrigx-curio-core`（`CurioReader`） |
| curio-core、daymark-core | `SPACE` | `styrigx-space-core`（`SpaceVerifier`） |

## 5. Secrets Store

| Secret 名 | 绑定在 | 用途 |
|---|---|---|
| `SGX_SPACE_PRIVATE` / `SGX_SPACE_PUBLIC` | space-core | 进站票签名钥匙对 |
| `SGX_SPACE_RECOVERY_KEY` | space-core | 恢复钥匙 |
| `SGX_SPACE_PASSWORD_PEPPER` | space-core | 解锁密码 pepper |
| `SGX_ACCOUNT_PRIVATE` / `SGX_ACCOUNT_PUBLIC` | account | 账号票签名钥匙对 |
| `SGX_ACCOUNT_RECOVERY_KEY` | account | 恢复密钥 |
| `SGX_ACCOUNT_PASSWORD_PEPPER` | account | 账号密码 pepper |
| `SGX_ACCOUNT_RESCUE_KEY` | account | v6 救援钥匙（只管 root；Gray 在 dashboard 设值 / 换值） |
| `SGX_CHAT_API_KEY` | ai | Gemini API key |
| `SGX_CF_USAGE_TOKEN` | status | 读取 Cloudflare 用量的只读 token |

5.1 Secret 的值由拥有者创建与轮换；自动化流程 MUST NOT 读取、打印或写入任何 Secret 值。

## 6. 普通变量（`[vars]`，非机密）

| Worker | 变量 |
|---|---|
| space-core | `SGX_ENV`、`SGX_SITE`、`SGX_ORIGIN`、`SGX_RP_ID` |
| account | `SGX_ENV`、`SGX_RP_ID`、`SGX_ORIGIN` |
| ai | `AI_MODELS`（KV `ai:models` 不可用时的模型登记）、`AI_MAX_TOKENS`、`AI_CONTEXT_HITS`、`AI_RECALL_MIN_SCORE`、`AI_GEMINI_SEARCH` |

## 7. GitHub

部署 environment 与 secret 名见 SGX-OPS-001 §7。
