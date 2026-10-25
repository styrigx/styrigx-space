/**
 * @fileoverview API 公共小工具：同源校验、no-store、限速分桶。
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

/**
 * 限速用的客户端分桶：IPv4 按单个地址；IPv6 按 /64（一台机器通常能随意换同一 /64 里的地址）。
 * IPv4 映射地址（::ffff:a.b.c.d）按其中的 IPv4。解析不了的原样返回。
 * @param {string} ip
 * @returns {string}
 */
export function ipBucket(ip) {
  const s = String(ip || '').trim().toLowerCase();
  if (s.indexOf(':') < 0) return s;
  const v4 = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) return v4[1];
  const halves = s.split('::');
  if (halves.length > 2) return s;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (tail.length && tail[tail.length - 1].indexOf('.') >= 0) tail.splice(-1, 1, '0', '0'); /* 末尾内嵌 IPv4：只占位，/64 用不到 */
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return s;
  const parts = head.concat(new Array(halves.length === 2 ? fill : 0).fill('0'), tail);
  const out = [];
  for (let i = 0; i < 4; i++) {
    if (!/^[0-9a-f]{1,4}$/.test(parts[i])) return s;
    out.push(parseInt(parts[i], 16).toString(16));
  }
  return out.join(':') + '::/64';
}
