/**
 * @fileoverview 账号 Worker 的部署入口（wrangler.toml 的 main；账号拆分 PR2c，照网关 workers/auth-gateway/src/worker.js）。
 * - default：公开路由的请求（index.js，PR2 暗上线期间行为不变）
 * - AccountService：网关经服务绑定转发的请求（entrypoints.js）
 * - AccountVerifier：账号会话只读校验 RPC（entrypoints.js）
 * 单测直接 import index.js（cloudflare:workers 只在 Workers 里有）；入口测试用 tests/workers/account/_cf-workers.mjs 的替身。
 */
export { default } from './index.js';
export { AccountService, AccountVerifier } from './entrypoints.js';
