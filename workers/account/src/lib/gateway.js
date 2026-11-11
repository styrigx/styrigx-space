/**
 * 网关写的内部请求头：账号 Worker 读的一侧（本 Worker 自己一份，写的一侧在网关）。
 *
 * v6 P4（定稿 v5.2 §十三）起进站会话删除：网关不再写 X-Styrigx-Space-* 身份头，这里也不读（readLockIdentity / passedGateway 删除）；
 * 身份只看 v6 会话（gate.js headerAuth）。
 *
 * 只在命名入口 AccountService 的请求上读；头名大小写不敏感（Headers 会统一小写）。
 * - readClientContext(headers)：读客户端上下文；格式不对的项当作没有（''）
 *
 * 不 import 任何东西。
 */

/** 客户端上下文：地址、国家、城市 */
export const CLIENT_CONTEXT_HEADERS = Object.freeze({
  address: 'X-Styrigx-Client-Address',
  country: 'X-Styrigx-Client-Country',
  city: 'X-Styrigx-Client-City',
});

/* 白名单 */
const ADDRESS_RE = /^[0-9A-Fa-f:.]{1,64}$/;
const MAX_COUNTRY = 4;
const MAX_CITY = 40;

/** 去掉控制字符、截长；不合规 → '' @param {any} v @param {number} max */
function cleanText(v, max) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > max) return '';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) return '';
  return s;
}

/**
 * 规范化客户端上下文：address 只认 IP 字符（≤64），country ≤4、city ≤40 且无控制字符；不合规的项 → ''。
 * @param {any} c
 * @returns {{address:string, country:string, city:string}}
 */
function normalizeClientContext(c) {
  const m = c && typeof c === 'object' ? c : {};
  const address = typeof m.address === 'string' && ADDRESS_RE.test(m.address.trim()) ? m.address.trim() : '';
  return { address, country: cleanText(m.country, MAX_COUNTRY), city: cleanText(m.city, MAX_CITY) };
}

/**
 * 读网关写的客户端上下文；没有 / 不合规的项 → ''。
 * @param {Headers|null|undefined} headers
 * @returns {{address:string, country:string, city:string}}
 */
export function readClientContext(headers) {
  if (!headers || typeof headers.get !== 'function') return normalizeClientContext(null);
  return normalizeClientContext({
    address: headers.get(CLIENT_CONTEXT_HEADERS.address) || '',
    country: headers.get(CLIENT_CONTEXT_HEADERS.country) || '',
    city: headers.get(CLIENT_CONTEXT_HEADERS.city) || '',
  });
}
