# ADR-0004：AI 模型选择

| 项 | 值 |
|---|---|
| 状态 | 已采纳（已实施） |
| 日期 | 2026-11-09（#347 合并） |
| 决策者 | Sloan Gray |
| 代码 | `workers/ai/src/core/models.js`、`workers/ai/src/core/gemini.js`、`workers/ai/wrangler.toml` |

## 1. 背景

1.1 站内对话助手 `styrigx-ai`（P4-1）先在站内索引里召回，再交给模型流式回答。模型分两类：自营（Cloudflare Workers AI，绑定 `AI`）与外部（Google Gemini API，key `SGX_CHAT_API_KEY`）。

1.2 Gemini 只有免费档 key。2026-11-09 实测与官方说明：
- `gemini-2.5-flash` 对新用户不再可用（上游 404）；
- Gemini 3.x 默认会思考，思考也计入 `maxOutputTokens`，1024 的额度会被耗尽导致空回答；
- 免费档每日额度：3.x Flash 每天 20 次（每分钟 5 次），3.5 / 3.1 Flash-Lite 每天 500 次（每分钟 15 次），Pro 为 0；
- **免费档不提供 Google Search grounding**，带搜索工具的请求可能被拒（不一定是 400）。

## 2. 决定

2.1 **默认模型：Gemma 4（Workers AI，`@cf/google/gemma-4-26b-a4b-it`）**，关闭思考，输出额度 1024。另一个自营选项 GPT-OSS 20B（`@cf/openai/gpt-oss-20b`）。

2.2 **外部模型主力：`gemini-3.5-flash-lite`**（Gemini 3.5 Flash Lite），思考档 `minimal`；**第二选项：`gemini-3.8-flash`**（Gemini 3.8 Flash），思考档 `low`。外部模型输出额度至少 4096、封顶 8192。

2.3 **429 回退**：3.x 非 Lite 模型遇到 429 时直接换 Flash-Lite 重试一次（日志 `[ai] gemini fallback`）；Flash-Lite 也 429 → 回 `daily_limit`（错误体明确是每分钟限额时回 `rate_limited` 并退避重试）。首字前对 503 与每分钟限额的 429 最多重试 2 次（退避 0.8 s、2 s），单次首字超时 20 秒，总时限 60 秒。

2.4 **搜索 grounding**：配置上仍带 `google_search` 工具（`AI_GEMINI_SEARCH = "1"`）；被拒时不带工具重试一次，并在本 isolate 内 10 分钟不再带工具（按整把 key 记忆，免费档所有模型都没有 grounding）。

2.5 **退役 id 映射**：`gemini-2.5-flash` 等退役 id 在解析时展开为当前两条（Flash Lite 主力 + 3.8 Flash），KV 里的旧登记、浏览器里存的旧选择照常可用。

2.6 **模型登记在 KV**（`KV_SEARCH_INDEX` 的 `ai:models`，60 秒缓存），换模型改 KV 值即可；KV 缺失或无效时退回 `wrangler.toml` 的 `AI_MODELS`，再退回代码内置 `FALLBACK`。线上 KV 的实际值不在代码里，以后台为准。

2.7 **谁能选模型**：只有带账号结论头 `X-Styrigx-Account-Session: 1` 的请求，`body.model` 才生效；只进站、未登录账号的请求一律用默认模型。

2.8 **响应头 `X-Styrigx-AI-Model` 是选中的模型**：在开流前就定下，流中途因 429 换到 Flash-Lite 时响应头仍是选中的那条（例如 3.8 Flash），不反映实际用的模型。按现状追认（#300–#400 偏离收尾定稿 v3.2 R-21，2026-11-14）。

2.8 Worker placement 固定在美国区（`gcp:us-east4`），避免 Gemini「User location is not supported」。

## 3. 实施记录

| 日期 | 变更 | PR |
|---|---|---|
| 2026-11-05 | 原 styrigx-chat 的外部模型并入 styrigx-ai；自营模型换 Gemma 4 + GPT-OSS 20B；模型名从 KV 读 | #271 |
| 2026-11-05 | Gemma 4 关思考、默认额度 1024，空回答报 `empty` 并记日志 | #275 |
| 2026-11-08 | 语义召回（Vectorize `styrigx-ai-recall`，`@cf/baai/bge-m3`）、奇趣只读固定查询、Markdown 渲染、Gemini 联网搜索 | #307 |
| 2026-11-09 | `gemini-2.5-flash` → `gemini-3.8-flash`：低思考、首字前重试、搜索被拒去工具、空回答兜底、key 脱敏 | #344 |
| 2026-11-09 | 主力换 `gemini-3.5-flash-lite`，3.8 Flash 429 时回退 Lite | #347 |

## 4. 后果

4.1 默认路径不消耗 Gemini 免费额度；外部模型只给已登录账号的拥有者按需选择。

4.2 免费档没有搜索 grounding，外部模型的回答通常不带网页来源；若换成付费 key，2.4 的回退会自动失效、工具重新生效，无需改代码。

4.3 Gemini 模型 id 与额度会变化：变化时 MUST 先核对官方模型页，再改 `gemini.js` 的 `GEMINI_LITE` / `GEMINI_FLASH` 与本 ADR。
