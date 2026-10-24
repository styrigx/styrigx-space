/**
 * @fileoverview 网关的部署入口（wrangler.toml 的 main）。
 * - default：公网请求（index.js）
 * - SessionVerifier：给其他 Worker 的服务绑定 RPC（rpc.js）
 * - ShareIssuer：只给分享短链 Worker styrigx-share 的服务绑定 RPC（rpc.js → share-issuer.js）
 * 单测直接 import index.js / verifier.js，不经过这里（cloudflare:workers 只在 Workers 里有）。
 */
export { default } from './index.js';
export { SessionVerifier, ShareIssuer } from './rpc.js';
