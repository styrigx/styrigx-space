/**
 * @fileoverview API 公共小工具：JSON 响应、错误响应、客户端 IP、同源校验、no-store、限速分桶。
 * 网关（functions/、src/）和账号 / 分享 Worker（各自 lib/http.js 转出）都用这一份。
 */

/** /api/* 默认的缓存头（middleware 兜底加的也是这个） */
export const NO_STORE = 'private, no-store';

/**
 * JSON 响应的唯一写法。Content-Type: application/json；没给 Cache-Control 就是 private, no-store。
 * headers 可以是普通对象或 Headers（带 Set-Cookie 时传 Headers，原样保留多条 Set-Cookie）。
 * @param {number} status
 * @param {any} body
 * @param {HeadersInit} [headers]
 * @returns {Response}
 */
export function json(status, body, headers) {
  const h = headers instanceof Headers ? headers : new Headers(headers || undefined);
  if (!h.has('Content-Type')) h.set('Content-Type', 'application/json');
  if (!h.has('Cache-Control')) h.set('Cache-Control', NO_STORE);
  return new Response(JSON.stringify(body), { status, headers: h });
}

/**
 * 错误响应：{ ok:false, error:<code>, ...extra }。code 必须登记在 ERROR_CODES（tests/workers/auth-gateway/error-codes.test.mjs 核对）。
 * 状态码按各接口原样（前端和测试依赖），这里不改写。
 * @param {number} status
 * @param {string} code
 * @param {Record<string, any>} [extra]
 * @param {HeadersInit} [headers]
 */
export function apiError(status, code, extra, headers) {
  return json(status, Object.assign({ ok: false, error: code }, extra || {}), headers);
}

/**
 * 网关 / 账号 / 分享 Worker 返回的全部 error 码和各自用到的 HTTP 状态（只登记，不改写）。
 * 新加一个码要在这里登记；前端怎么显示见 tests/workers/auth-gateway/error-codes.test.mjs。
 */
export const ERROR_CODES = Object.freeze({
  /* 请求本身 */
  method: [405],
  body: [400],
  params: [400],
  action: [400],
  origin: [403],
  purpose: [400],
  bad_request: [400],
  'too-long': [400],
  /* 会话 / 票 / 角色 */
  session: [401, 400], /* 400：分享 Worker 的 session（有效天数）参数不对 */
  unauthorized: [401],
  account: [401],
  denied: [401],
  role: [403],
  admin_only: [403],
  reauth: [403],
  challenge: [403],
  /* 凭证 */
  auth: [401],
  wrong: [403],
  verify: [403],
  'unknown-key': [403],
  'not-set': [403],
  exists: [403],
  'last-key': [403],
  'same-as-lock': [403],
  'same-as-account': [403],
  short: [400],
  password: [400],
  cooldown: [429],
  /* 临时钥匙 / 账号设备 */
  code: [400],
  name: [400],
  duration: [400],
  full: [409],
  current: [400],
  'not-found': [404],
  /* 账号 Worker 头像、分享 Worker 短链 */
  'bad-form': [400],
  missing: [400],
  'too-large': [413],
  'bad-type': [415],
  target: [400],
  /* 服务端 / 配置 */
  server: [500, 503],
  config: [500, 503],
  epoch: [503],
  internal: [500],
  upstream: [502, 503],
  no_key: [503],
  'sign-failed': [500],
  'session-sign-failed': [500],
  'invalid-role': [500],
  'no-session-key': [500],
});

/**
 * 客户端 IP（限速分桶用）：只认 Cloudflare 填的 CF-Connecting-IP；没有就是 'unknown'。
 * 不认 X-Forwarded-For（客户端可以伪造）。
 * @param {Request} request
 * @returns {string}
 */
export function clientIp(request) {
  return (request && request.headers && request.headers.get('CF-Connecting-IP')) || 'unknown';
}

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
  return apiError(403, 'origin');
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
    res.headers.set('Cache-Control', NO_STORE);
    return res;
  } catch (e) {
    const copy = new Response(res.body, res);
    copy.headers.set('Cache-Control', NO_STORE);
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
