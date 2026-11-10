/**
 * @fileoverview styrigx-space-core（站点核心 Worker）的部署入口（wrangler.toml 的 main）：只接线，不放逻辑。
 * - default：公网请求（app.js；含进站会话、整站页面、分享链接 /s/* 和 /api/share）
 * - SpaceVerifier：给其他 Worker 的服务绑定 RPC（rpc/space-verifier.js；奇趣、日刻绑定 SPACE）
 * - ShareJanitor：给 styrigx-status 的服务绑定 JOB_SPACE，每日清理过期分享链接（rpc/share-janitor.js，v5 S2）
 * 进站 v3 L2：给短链 Worker 的 RPC 入口删除（分享链接并入本 Worker；v5 S1 起链接会话直接绑 share_link，core/link-keys.js）。
 * 单测 import app.js / router.js / gate.js / core/*，不经过这里（cloudflare:workers 只在 Workers 里有）。
 */
export { default } from './app.js';
export { SpaceVerifier } from './rpc/space-verifier.js';
export { ShareJanitor } from './rpc/share-janitor.js';
