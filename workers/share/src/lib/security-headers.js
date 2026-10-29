/**
 * @fileoverview 安全响应头：和网关同一份（workers/shared/security-headers.js），本 Worker 的每个响应都加。
 */
export { applyMainSiteHeaders } from '../../../shared/security-headers.js';
