/**
 * 内部请求头：网关写的一侧（方案第 3 节；各 Worker 各自一份，不互相 import）。读的一侧只有账号 Worker：
 * workers/account/src/lib/lock-identity.js（readClientContext，同一份白名单）。
 *
 * v6 P4（定稿 v5.2 §十三）起进站会话删除，锁屏身份头（X-Styrigx-Space-Session / By / Link-Id）不再写；只剩客户端上下文头，
 * 只用在 router.js 转发表里的路径（router.js forward → core/forward.js forwardToService）。
 * 头名大小写不敏感（Headers 会统一小写）；剥离外来同名头时按 INTERNAL_HEADER_PREFIX（小写）匹配前缀。
 *
 * - stripInternalHeaders(headers)：删掉所有 x-styrigx-* 和旧前缀 x-sgx-*（网关 fetch 第一步剥浏览器带来的；writeClientContext 写之前再剥一次）
 * - writeClientContext(headers, clientContext)：先剥，再写客户端上下文头（只写白名单里的值）
 *
 * 不带会话 id、不签名（方案第 3 节）：靠三道保险——网关剥头、账号 Worker 只在命名入口读头（默认 fetch 一律 404）、账号 Worker 没有公开路由。
 * 不 import 任何东西。
 */

/** 客户端上下文：地址、国家、城市 */
export const CLIENT_CONTEXT_HEADERS = Object.freeze({
  address: 'X-Styrigx-Client-Address',
  country: 'X-Styrigx-Client-Country',
  city: 'X-Styrigx-Client-City',
});

/** 所有内部头的公共前缀（小写） */
export const INTERNAL_HEADER_PREFIX = 'x-styrigx-';

/** 旧内部头前缀（小写）：P2-2 起网关不再写、下游也不再读任何 x-sgx-* 请求头；浏览器带来的同前缀头仍在网关 fetch 第一步剥掉
 *  （留着这道保险），不会经回源 / 转发带到任何下游。 */
const LEGACY_HEADER_PREFIX = 'x-sgx-';

/* 白名单 */
const ADDRESS_RE = /^[0-9A-Fa-f:.]{1,64}$/;
const MAX_COUNTRY = 4;
const MAX_CITY = 40;

/** 这个头名要剥吗（大小写不敏感） @param {string} name */
function isInternalHeader(name) {
  const n = String(name || '').toLowerCase();
  return n.startsWith(INTERNAL_HEADER_PREFIX) || n.startsWith(LEGACY_HEADER_PREFIX);
}

/**
 * 就地删掉所有内部头（x-styrigx-* 任意大小写、旧前缀 x-sgx-*），返回同一个对象。
 * @param {Headers|null|undefined} headers
 */
export function stripInternalHeaders(headers) {
  if (!headers) return headers;
  const drop = [];
  for (const [k] of headers) if (isInternalHeader(k)) drop.push(k);
  for (const k of drop) headers.delete(k);
  return headers;
}

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
 * 先剥掉所有内部头，再按客户端上下文写上下文头（只写白名单里的非空值）。
 * @param {Headers} headers 要写的头（就地改）
 * @param {any} clientContext { address, country, city }
 * @returns {Headers}
 */
export function writeClientContext(headers, clientContext) {
  stripInternalHeaders(headers);
  const c = normalizeClientContext(clientContext);
  if (c.address) headers.set(CLIENT_CONTEXT_HEADERS.address, c.address);
  if (c.country) headers.set(CLIENT_CONTEXT_HEADERS.country, c.country);
  if (c.city) headers.set(CLIENT_CONTEXT_HEADERS.city, c.city);
  return headers;
}
