# styrigx-ai

## 职责

站内对话助手的后端（P4-1，方案 5.2；P4-2 并入原 styrigx-chat 的外部模型）：先在全站索引里召回（`core/recall.js`，内部函数），再把前几条作为上下文交给模型，流式回答。模型两类：自营（Workers AI，不走网关）和外部（Gemini API，钥匙 `SGX_CHAT_API_KEY`）；可选模型和默认模型从 KV 读（`core/models.js`），换模型改 KV 值即可。两档召回：没有账号会话只召回公开条目；网关写了账号结论头 `X-Styrigx-Account-Session: 1` 才加上私密条目。过滤在召回阶段做，私密条目进不了来源列表，也进不了给模型的上下文（方案 5.4、风险 R-8）。

**语义召回（2026-11）**：每小时 Cron（`41 * * * *`，`core/vector-sync.js`）把各站 KV 索引（`site:space/blog/curio/daymark`）切段（`core/chunk.js`）、用 `@cf/baai/bge-m3`（1024 维，`core/embed.js`）嵌入、upsert 进 Vectorize `styrigx-ai-recall`，删掉多余段，状态记在 KV `ai:recall:<站名>`（内容指纹没变就整站跳过、不写 KV）。`/ask` 三路召回并行：奇趣只读固定查询（`core/fixed.js` → 服务绑定 `CURIO` = curio-core 的 RPC 入口 `CurioReader`，「最近 N 部电影」「专辑曲目」，模型不写 SQL）放最前；语义召回（`core/semantic.js`，topK 20、相似度门槛 `AI_RECALL_MIN_SCORE`、同页去重）在前、关键词召回补后，合计最多 `AI_CONTEXT_HITS` 条。语义出错退回关键词。两档过滤同样适用于语义召回（查询 filter `private:false` + 结果再过滤）。Cron 只读 KV、不绑任何 D1：各库仍只由各自的 core 读写，账号库从不进索引。

不提供对外的搜索端点（定案第 2 条：搜索只作 AI 内部召回）。不存对话。KV 只在 Cron 同步向量时写状态键。外部模型（gemini）带 Google 搜索（`google_search` 工具，`AI_GEMINI_SEARCH = "0"` 关），联网来源以 `event: sources` 发给前端按可点链接显示；工具被拒不带工具重试一次。Gemini 上游错误由 `core/gemini.js describeUpstream` 分类并脱敏记日志（`[ai] gemini upstream`，reason：location / key / quota / model / tool / safety / server）；`[placement] region = "gcp:us-east4"` 把 Worker 固定在美国区执行（推测 2026-10-28 起的故障是地区不支持，部署后看日志验证）。回答规则（P4-3 PR-2，`core/prompt.js`）：站内内容能答就只按站内答并列链接；本站功能、设置、账号的问题只按站内答，站内没有就直说；其他问题站内答不了时用模型自己的通用知识直接答，不加前缀句（2026-11-06 起）。切模型只认有账号会话的请求，进站一律默认模型。

## 入口

`src/index.js` 只再导出 `src/app.js` 的默认 handler；`src/router.js` 登记三个端点。逻辑：`api/ask.js`（请求校验、选模型、SSE）、`api/models.js`、`api/healthz.js`；`core/models.js`（模型登记：KV → vars → 内置）、`core/gemini.js`（外部模型调用，搬自 `workers/chat/src/chat.js`）；`core/recall.js`（读索引、60 秒内存缓存、两档过滤、正文截 600 字）、`core/rank.js`（拷自 `workers/search-index/src/rank.js`，Worker 之间不许 import）、`core/prompt.js`（系统提示、上下文、历史截断）、`core/think.js`（去掉模型的思考段）；`lib/http.js`。

## 路由

没有公开地址（`workers_dev = false`、`preview_urls = false`、没有路由；`space/scripts/check-worker-routes.mjs` 断言 0 条）。只经服务绑定进来：

| 路径 | 谁调 | 结果 |
|---|---|---|
| `POST /ask` `{ q, lang, history, model? }`（`model` 只在有账号结论头时生效，不在登记里 400 `bad_model`） | 网关 `styrigx-space-core` 的服务绑定 `AI_SERVICE`（浏览器请求 `POST /api/ai`，网关验同源、进门、过两档 AI 限流、写账号结论头后转进来） | 200 `text/event-stream`：`event: delta`（0 到多次，2026-11-06 起不再发 `event: hits`）→ `event: done`；已开始流后出错发 `event: error`。响应头 `X-Styrigx-AI-Scope: private\|public`。召回为空不调模型。400 `bad_request` / `too-long`（`q` 超 200 字）、413 `too-large`、503 `config`（选中自营模型但没绑 AI）/ `no_key`（选中外部模型但钥匙读不到）/ `index`。外部模型流中出错 `event: error` 的 code 可能是 `rate_limited` / `model_unavailable` / `upstream`。响应头 `X-Styrigx-AI-Model` 是这次用的模型 id |
| `GET /models` | 网关 `GET /api/ai`（进门即可，不计限流） | 200 `{ ok, default, models: [{ id, label, provider }], canChoose }`；`canChoose` = 有账号结论头 |
| （Cron `41 * * * *`） | Cloudflare | 同步语义召回的向量（见上） |
| `GET /healthz` | P4-2 起 `styrigx-status` 的服务绑定 `AI_SERVICE` | 有 AI 绑定且至少一个站的索引读得到 200 `{ ok, sites, missing }`；否则 503。不调模型 |
| 其他 | | 404 `not-found`；方法不对 405 `method` |

单次封顶（方案 5.6）：`AI_MAX_TOKENS`（默认 1024，上限 2048；Gemma 4 关思考，见 api/ask.js 的 runExtras）、上下文 `AI_CONTEXT_HITS` 条（默认 5）× 600 字、历史最多 6 条且总长 2000 字。浏览器断开时上游的流一起取消。

## 绑定

| 绑定 | 类型 | 资源 |
|---|---|---|
| `AI` | Workers AI | 自营模型：`@cf/google/gemma-4-26b-a4b-it`（Gemma 4，默认）、`@cf/openai/gpt-oss-20b`（GPT-OSS 20B） |
| `VECTORIZE` | Vectorize | `styrigx-ai-recall`（1024 维、cosine；元数据索引 `private` 布尔），语义召回（2026-11） |
| `CURIO` | 服务绑定（RPC） | `styrigx-curio-core` 的 `CurioReader`：只读固定查询（2026-11） |
| `KV_SEARCH_INDEX` | KV（读；只写 `ai:recall:<站名>`） | `styrigx-space-gateway`（2026-11 前是 `styrigx-search-index`），键 `site:space`、`site:blog`、`site:daymark`、`site:curio`；模型登记 `ai:models` |
| `SGX_CHAT_API_KEY` | Secrets Store | 外部模型（Gemini）钥匙，原 styrigx-chat 那把，复用，不新建 |

`[vars]`：`AI_MODELS`（模型登记的退路，KV 没有 / 坏时用）、`AI_MAX_TOKENS = "1024"`、`AI_CONTEXT_HITS = "6"`、`AI_RECALL_MIN_SCORE = "0.42"`、`AI_GEMINI_SEARCH = "1"`。

模型登记 `ai:models` 的值：`{ "default": "<id>", "models": [{ "id", "label", "provider": "workers-ai" | "gemini" }] }`（workers-ai 的 id 必须以 `@cf/` 开头；最多 8 条；坏条目跳过）。60 秒内存缓存。默认模型以站内真实内容的中文实测为准，Gray 实测后改 `default`。

## 钥匙

只有一把：Secrets Store `SGX_CHAT_API_KEY`（外部模型，用到才读，不打印、不回给浏览器）。

## 数据与迁移

没有 D1、R2，没有 `migrations/`。Vectorize 索引 `styrigx-ai-recall` 需在 Cloudflare 先建好（`wrangler vectorize create styrigx-ai-recall --dimensions=1024 --metric=cosine` + `wrangler vectorize create-metadata-index styrigx-ai-recall --property-name=private --type=boolean`），否则部署失败。索引由各站 CI 写（本仓库 `deploy-search-worker` 写 `site:space`；P4-2 搬到这里的部署 job）。部署 job `deploy-ai-worker` 用 GitHub 环境 `STYRIGX_AI_DEPLOY` 的 token（Cloudflare 上 styrigx-ai-deploy，含 Secrets Store 编辑），排在网关之前（网关的服务绑定 `AI_SERVICE` 指向它）；首次部署若报 Workers AI 权限错，由 Gray 给 token 加权限后重跑。测试：`tests/workers/ai/`、`tests/workers/space-core/ai-api.test.mjs`（网关的门、限流和转发）。
