/**
 * @fileoverview 接口公共小工具：同源校验、no-store。
 * 直接用和网关同一份共享模块（workers/shared/http.js），不复制：CSRF 判断两边永远一致。
 */
export { json, apiError, clientIp, NO_STORE, isSameOrigin, originDenied, withNoStore } from '../../../shared/http.js';
