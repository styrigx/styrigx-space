/**
 * @fileoverview 网关的部署入口（wrangler.toml 的 main）：只接线，不放逻辑。
 * - default：公网请求（app.js）
 * - AuthVerifier：给其他 Worker 的服务绑定 RPC（rpc/auth-verifier.js）
 * - ShareIssuer：只给分享短链 Worker styrigx-share 的服务绑定 RPC（rpc/share-issuer.js）
 * 单测 import app.js / router.js / gate.js / core/*，不经过这里（cloudflare:workers 只在 Workers 里有）。
 */
export { default } from './app.js';
export { AuthVerifier } from './rpc/auth-verifier.js';
export { ShareIssuer } from './rpc/share-issuer.js';
