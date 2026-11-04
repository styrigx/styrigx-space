# styrigx-ai

## 职责

站内对话助手的后端（P4-1，方案 5.2）：先在全站索引里召回（`core/recall.js`，内部函数），再把前几条作为上下文交给 Workers AI，流式回答。两档召回：没有账号会话只召回公开条目；网关写了账号结论头 `X-Styrigx-Account-Session: 1` 才加上私密条目。过滤在召回阶段做，私密条目进不了来源列表，也进不了给模型的上下文（方案 5.4、风险 R-8）。

不提供对外的搜索端点（定案第 2 条：搜索只作 AI 内部召回）。不存对话、不写 KV、不联网搜索、不调外部模型。

## 入口

`src/index.js` 只再导出 `src/app.js` 的默认 handler；`src/router.js` 登记两个端点。逻辑：`api/ask.js`（请求校验、SSE）、`api/healthz.js`；`core/recall.js`（读索引、60 秒内存缓存、两档过滤、正文截 600 字）、`core/rank.js`（拷自 `workers/search-index/src/rank.js`，Worker 之间不许 import）、`core/prompt.js`（系统提示、上下文、历史截断）、`core/think.js`（去掉模型的思考段）；`lib/http.js`。

## 路由

没有公开地址（`workers_dev = false`、`preview_urls = false`、没有路由；`scripts/check-worker-routes.mjs` 断言 0 条）。只经服务绑定进来：

| 路径 | 谁调 | 结果 |
|---|---|---|
| `POST /ask` `{ q, lang, history }` | 网关 `styrigx-auth-gateway` 的服务绑定 `AI_SERVICE`（浏览器请求 `POST /api/ai`，网关验同源、进门、过两档 AI 限流、写账号结论头后转进来） | 200 `text/event-stream`：`event: hits` → `event: delta`（0 到多次）→ `event: done`；已开始流后出错发 `event: error`。响应头 `X-Styrigx-AI-Scope: private\|public`。召回为空不调模型。400 `bad_request` / `too-long`（`q` 超 200 字）、413 `too-large`、503 `config`（没绑 AI）/ `index` |
| `GET /healthz` | P4-2 起 `styrigx-status` 的服务绑定 `AI_SERVICE` | 有 AI 绑定且至少一个站的索引读得到 200 `{ ok, sites, missing }`；否则 503。不调模型 |
| 其他 | | 404 `not-found`；方法不对 405 `method` |

单次封顶（方案 5.6）：`AI_MAX_TOKENS`（默认 512）、上下文 `AI_CONTEXT_HITS` 条（默认 5）× 600 字、历史最多 6 条且总长 2000 字。浏览器断开时上游的流一起取消。

## 绑定

| 绑定 | 类型 | 资源 |
|---|---|---|
| `AI` | Workers AI | 模型 `AI_MODEL`（`[vars]`，默认 `@cf/qwen/qwen3-30b-a3b-fp8`，合并前 Gray 确认） |
| `KV_SEARCH_INDEX` | KV（只读） | `styrigx-search-index`，键 `site:space`、`site:blog`、`site:daymark`、`site:curio` |

`[vars]`：`AI_MODEL`、`AI_MAX_TOKENS = "512"`、`AI_CONTEXT_HITS = "5"`。

## 钥匙

没有。没有 Secrets Store 绑定。

## 数据与迁移

没有 D1、R2，没有 `migrations/`。索引由各站 CI 写（本仓库 `deploy-search-worker` 写 `site:space`；P4-2 搬到这里的部署 job）。部署 job `deploy-ai-worker` 复用 GitHub 环境 `STYRIGX_SEARCH_INDEX_DEPLOY` 的 token，排在网关之前（网关的服务绑定 `AI_SERVICE` 指向它）；首次部署若报 Workers AI 权限错，由 Gray 给 token 加权限后重跑。测试：`tests/workers/ai/`、`tests/workers/auth-gateway/ai-api.test.mjs`（网关的门、限流和转发）。
