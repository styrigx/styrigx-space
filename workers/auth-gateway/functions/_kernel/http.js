/**
 * @fileoverview API 公共小工具：同源校验、no-store。
 */

/**
 * 写操作的 CSRF 防护：Origin 必须存在、可解析，且 host 与请求一致。
 * 缺失或解析失败一律视为不同源。
 * @param {Request} request
 * @returns {boolean}
 */
export function isSameOrigin(request) {
  const origin = request.headers.get('Origin') || '';
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch (e) {
    return false;
  }
}

/** 不同源时统一返回的 403 */
export function originDenied() {
  return Response.json({ ok: false, error: 'origin' }, { status: 403, headers: { 'Cache-Control': 'private, no-store' } });
}

/**
 * /api/* 响应兜底加 Cache-Control: private, no-store（接口自己设过的不动）。
 * Response 的 headers 可能是只读的（如 next() 透传的响应），那就复制一份再改。
 * @param {Response} res
 * @returns {Response}
 */
export function withNoStore(res) {
  if (!res || res.headers.has('Cache-Control')) return res;
  try {
    res.headers.set('Cache-Control', 'private, no-store');
    return res;
  } catch (e) {
    const copy = new Response(res.body, res);
    copy.headers.set('Cache-Control', 'private, no-store');
    return copy;
  }
}
