/**
 * @fileoverview 接口公共小工具：同源校验、no-store。
 * 直接用网关的同一份（workers/auth-gateway/functions/_kernel/http.js），不复制：CSRF 判断两边永远一致。
 */
export { isSameOrigin, originDenied, withNoStore } from '../../../auth-gateway/functions/_kernel/http.js';
