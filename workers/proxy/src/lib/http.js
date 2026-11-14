/**
 * @fileoverview styrigx-proxy 的 HTTP 小工具（和业务无关）。各 Worker 各自一份 lib/http.js。
 */

/**
 * 纯文本响应（健康检查、404 / 405 / 502）：不缓存。
 * @param {string} body
 * @param {number} [status]
 * @param {Record<string, string>} [extra]
 */
export const text = (body, status = 200, extra = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra } });
