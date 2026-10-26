# styrigx-chat

主站聊天页（`/chat/`）的后端，2026-10-22 从鉴权网关拆出来。只做「联网检索 + 回答」：把浏览器发来的整段对话转给模型（默认 Gemini 2.5 Flash + Google 搜索接地，也可以接 OpenAI 兼容接口），把回答以 SSE 流回去，不存任何对话。

```
src/index.js  入口：只认 GET /models、POST /chat，只认网关写的 X-Sgx-Role: admin
src/chat.js   内核：请求校验、模型白名单（CHAT_MODELS）、上游调用、SSE 转换、错误映射
```

- 没有公开地址：`workers_dev = false`、`preview_urls = false`、没有路由。唯一入口是网关 `styrigx-auth-gateway` 的服务绑定 `CHAT`：浏览器请求 `/api/chat`，网关先验同源 + 锁屏会话 + 只许管理员，再转进来，回答原样流回。接口约定（GET / POST `/api/chat` 的响应、`503 no_key`、错误码）见 `src/chat.js` 顶部。
- 配置：`wrangler.toml` 的 `CHAT_PROVIDER`、`CHAT_API_BASE`、`CHAT_MODEL`、`CHAT_SEARCH`、`CHAT_MODELS`。
- 钥匙：Secrets Store 的 `SGX_CHAT_API_KEY`（和网关同一个 store），只绑在本 Worker。部署前要先建好（作用域含 workers），否则部署失败；CI 这时退一步部署不带钥匙绑定的版本（`GET /models` 回 `configured: false`，聊天页一打开就显示「聊天还没配置」卡；`POST` 回 `503 no_key`），网关照常部署。意外错误回 `500 internal`（JSON，不带堆栈）。
- 部署：`.github/workflows/deploy.yml` 的 `deploy-chat-worker`，先于网关；token `styrigx-chat-deploy`（GitHub 环境 `STYRIGX_CHAT_DEPLOY`，只允许 main）。
- 测试：`tests/workers/chat/`（内核）、`tests/workers/auth-gateway/chat-api.test.mjs`（网关的门、转发、端到端）。
