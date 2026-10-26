/**
 * @fileoverview 接口公共小工具：同源校验、no-store。直接用网关那一份（同账号 Worker 的 lib/http.js），CSRF 判断各处一致。
 */
export { json, apiError, clientIp, NO_STORE, isSameOrigin, originDenied, withNoStore } from '../../../auth-gateway/functions/_kernel/http.js';
