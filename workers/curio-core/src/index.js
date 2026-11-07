/**
 * @fileoverview styrigx-curio-core 部署入口：只接线（workers/README.md 骨架）。
 * - default：接口 + Cron（app.js）
 * - CurioReader：给 styrigx-ai 的服务绑定 RPC，只读固定查询（rpc/reader.js，2026-11 AI 语义召回）
 * 单测 import app.js / reader.js，不经过这里（cloudflare:workers 只在 Workers 里有）。
 */
export { default } from './app.js';
export { CurioReader } from './rpc/reader.js';
