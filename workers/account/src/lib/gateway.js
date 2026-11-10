/**
 * 网关写的内部请求头：账号 Worker 读的一侧（本 Worker 自己一份，写的一侧在网关）。
 *
 * 进站会话：网关签发的那张凭证（cookie 由网关验），账号 Worker 只读网关验完写下的结论头，从不自己验。
 * 中文统一叫「进站会话」，和账号自己的 session（sudo root 登录）分开；跨 Worker 的头名 X-Styrigx-Space-* 不变。
 *
 * 只在命名入口 AccountService 的请求上读；头名大小写不敏感（Headers 会统一小写）。
 * - readLockIdentity(headers)：X-Styrigx-Space-Session: 1（= 有进站会话）才算有身份，By / Link-Id 白名单校验（只作审计）；没有 → null
 *   只有这一个结论；过了网关之后能做什么由账号 session + 作用域决定（core/authorize.js）。
 * - passedGateway(headers)：有没有进站会话（api/account/* 的门）
 * - readClientContext(headers)：读客户端上下文；格式不对的项当作没有（''）
 *
 * 不 import 任何东西。
 */

/** 进站会话的结论头：有效、凭什么进的站、分享链接 id（by=link；v5 起取代临时钥匙 id） */
export const LOCK_IDENTITY_HEADERS = Object.freeze({
  session: 'X-Styrigx-Space-Session',
  by: 'X-Styrigx-Space-By',
  linkId: 'X-Styrigx-Space-Link-Id',
});

/** 客户端上下文：地址、国家、城市 */
export const CLIENT_CONTEXT_HEADERS = Object.freeze({
  address: 'X-Styrigx-Client-Address',
  country: 'X-Styrigx-Client-Country',
  city: 'X-Styrigx-Client-City',
});

/* 白名单 */
const BYS = Object.freeze(['password', 'passkey', 'link']);
const LINK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
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
 * 规范化锁屏身份：session 必须是 '1'（网关验过的进站会话）才算有身份；by 不认识 → ''；
 * linkId 只在 by=link 且格式合规时给。没有身份 → null。
 * @param {any} s
 * @returns {{session:true, by:string, linkId:string}|null}
 */
function normalizeLockIdentity(s) {
  if (!s || typeof s !== 'object') return null;
  if (s.session !== '1') return null;
  const byRaw = typeof s.by === 'string' ? s.by.trim() : '';
  const by = BYS.indexOf(byRaw) !== -1 ? byRaw : '';
  const lk = typeof s.linkId === 'string' ? s.linkId.trim() : '';
  const linkId = by === 'link' && LINK_ID_RE.test(lk) ? lk : '';
  return { session: true, by, linkId };
}

/**
 * 读网关写的锁屏身份（白名单校验）。没有 X-Styrigx-Space-Session: 1 → null（= 没有进站会话 / 无会话）。
 * session 只认 '1'；by 不认识 → ''（v5 起 tempkey 不认）；linkId 只在 by=link 时给。
 * @param {Headers|null|undefined} headers
 * @returns {{session:true, by:string, linkId:string}|null}
 */
export function readLockIdentity(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  return normalizeLockIdentity({
    session: String(headers.get(LOCK_IDENTITY_HEADERS.session) || '').trim(),
    by: String(headers.get(LOCK_IDENTITY_HEADERS.by) || ''),
    linkId: String(headers.get(LOCK_IDENTITY_HEADERS.linkId) || ''),
  });
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

/**
 * 有没有进站会话（网关写的 X-Styrigx-Space-Session: 1）。
 * @param {any} headers
 */
export function passedGateway(headers) {
  const id = readLockIdentity(headers);
  return !!(id && id.session === true);
}
