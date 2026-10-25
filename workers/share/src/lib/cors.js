/**
 * @fileoverview /api/share 的跨源（2026-10-24）：三个子站顶栏的分享按钮从子站页面直接 POST https://styrigx.com/api/share。
 *
 * - 只认这几个 Origin（逐字相等，不认通配 / 后缀）：https://blog.styrigx.com、https://daymark.styrigx.com、https://curio.styrigx.com
 *   （主站 https://styrigx.com 是同源，不需要 CORS 头，这里也认，回同样的头无害）。
 * - 认的：Access-Control-Allow-Origin = 这个 Origin、Allow-Credentials: true（要带 Domain=styrigx.com 的会话 cookie）；
 *   预检（OPTIONS）只放行 POST + Content-Type，204 + Max-Age 600。不认的 Origin：预检 403、正式请求不带任何 Allow 头（浏览器读不到响应）。
 * - 每个 /api/* 响应都带 Vary: Origin（同一地址按 Origin 回不同的头，缓存不能混用；接口本身也是 no-store）。
 * - CORS 只决定浏览器能不能读响应；会话 / 管理员 / 账号 / CSRF 校验照旧（门 401 / 403，接口里跨源只许 create + reuse）。
 */

export const MAIN_ORIGIN = 'https://styrigx.com';
/** 能跨源调 /api/share 的子站（逐字比较） */
export const CORS_ORIGINS = Object.freeze(['https://blog.styrigx.com', 'https://daymark.styrigx.com', 'https://curio.styrigx.com']);

/** 请求的 Origin 如果是子站之一（或主站），返回它；否则 '' @param {Request} request */
export function corsOrigin(request) {
  const o = request.headers.get('Origin') || '';
  if (o === MAIN_ORIGIN || CORS_ORIGINS.includes(o)) return o;
  return '';
}

/** 是不是子站发来的跨源请求（主站同源不算） @param {Request} request */
export function isSubsiteOrigin(request) {
  return CORS_ORIGINS.includes(request.headers.get('Origin') || '');
}

/** @param {Headers} h @param {string} origin */
function allow(h, origin) {
  h.set('Access-Control-Allow-Origin', origin);
  h.set('Access-Control-Allow-Credentials', 'true');
}

/** @param {Headers} h */
function vary(h) {
  const v = h.get('Vary');
  if (!v) h.set('Vary', 'Origin');
  else if (!/(^|,)\s*origin\s*(,|$)/i.test(v)) h.set('Vary', v + ', Origin');
}

/**
 * OPTIONS /api/share 预检。
 * @param {Request} request
 * @returns {Response}
 */
export function preflight(request) {
  const origin = corsOrigin(request);
  const h = new Headers({ 'Cache-Control': 'private, no-store' });
  vary(h);
  const method = (request.headers.get('Access-Control-Request-Method') || '').toUpperCase();
  const reqHeaders = (request.headers.get('Access-Control-Request-Headers') || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!origin || method !== 'POST' || reqHeaders.some((x) => x !== 'content-type')) {
    return new Response(null, { status: 403, headers: h });
  }
  allow(h, origin);
  h.set('Access-Control-Allow-Methods', 'POST');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  h.set('Access-Control-Max-Age', '600');
  return new Response(null, { status: 204, headers: h });
}

/**
 * 正式响应补 CORS 头：认的 Origin → Allow-Origin + Allow-Credentials；都加 Vary: Origin。
 * @param {Response} res
 * @param {Request} request
 * @returns {Response}
 */
export function withCors(res, request) {
  const out = new Response(res.body, res);
  const origin = corsOrigin(request);
  if (origin) allow(out.headers, origin);
  vary(out.headers);
  return out;
}
