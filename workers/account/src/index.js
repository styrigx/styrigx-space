/**
 * @fileoverview 账号 Worker 的部署入口（wrangler.toml 的 main）：只接线，不放逻辑。
 * - default：公开路由的请求（app.js，一律 404）
 * - AccountService：网关经服务绑定 ACCOUNT 转发的请求（rpc/account-service.js）
 * - AccountVerifier：账号会话只读校验 RPC（rpc/account-verifier.js）
 * - AccountJanitor：到期用户满宽限期自动删除（rpc/account-janitor.js；styrigx-status 每日一轮经 JOB_ACCOUNT 调，v6 P2c）
 * 单测 import app.js / router.js / gate.js / rpc/* / api/* / core/* / lib/*，不经过这里；入口测试用 tests/workers/account/_cf-workers.mjs 的替身。
 */
export { default } from './app.js';
export { AccountService } from './rpc/account-service.js';
export { AccountVerifier } from './rpc/account-verifier.js';
export { AccountJanitor } from './rpc/account-janitor.js';
