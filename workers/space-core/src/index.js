/**
 * @fileoverview styrigx-space-core（站点核心 Worker）的部署入口（wrangler.toml 的 main）：只接线，不放逻辑。
 * - default：公网请求（app.js；整站页面、接口；v6 P4 起进站会话与分享链接删除）
 * - SpaceVerifier：给其他 Worker 的服务绑定 RPC（rpc/space-verifier.js；奇趣、日刻绑定 SPACE）
 * v6 P4：ShareJanitor（每日清理过期分享链接）随分享短链删除，styrigx-status 的 JOB_SPACE 绑定一并删。
 * 单测 import app.js / router.js / gate.js / core/*，不经过这里（cloudflare:workers 只在 Workers 里有）。
 */
export { default } from './app.js';
export { SpaceVerifier } from './rpc/space-verifier.js';
