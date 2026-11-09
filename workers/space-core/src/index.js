/**
 * @fileoverview styrigx-space-core（站点核心 Worker）的部署入口（wrangler.toml 的 main）：只接线，不放逻辑。
 * - default：公网请求（app.js；含进站会话、整站页面、分享链接 /s/* 和 /api/share）
 * - SpaceVerifier：给其他 Worker 的服务绑定 RPC（rpc/space-verifier.js；奇趣、日刻绑定 SPACE）
 * 进站 v3 L2：给短链 Worker 的 RPC 入口删除（分享链接并入本 Worker，签 / 作废短链钥匙是 core/link-keys.js 的内部函数）。
 * 单测 import app.js / router.js / gate.js / core/*，不经过这里（cloudflare:workers 只在 Workers 里有）。
 */
export { default } from './app.js';
export { SpaceVerifier } from './rpc/space-verifier.js';
