/**
 * 内部请求头：账号 Worker 读的一侧（方案第 3 节；本 Worker 自己一份，写的一侧在网关）。
 *
 * 只在命名入口 AccountService 的请求上读网关写的锁屏身份和客户端上下文；头名大小写不敏感（Headers 会统一小写）。
 * - readLockIdentity(headers)：白名单校验；没有 / 不认识的值 → null（= 无会话）
 * - readClientContext(headers)：读客户端上下文；格式不对的项当作没有（''）
 *
 * 不 import 任何东西。
 */

/** 锁屏身份：角色、凭什么解的锁、临时钥匙 id */
export const LOCK_IDENTITY_HEADERS = Object.freeze({
  role: 'X-Styrigx-Lock-Role',
  by: 'X-Styrigx-Lock-By',
  tempkeyId: 'X-Styrigx-Lock-Tempkey-Id',
});

/** 客户端上下文：地址、国家、城市 */
export const CLIENT_CONTEXT_HEADERS = Object.freeze({
  address: 'X-Styrigx-Client-Address',
  country: 'X-Styrigx-Client-Country',
  city: 'X-Styrigx-Client-City',
});

/* 白名单 */
const ROLES = Object.freeze(['admin', 'visitor']);
const BYS = Object.freeze(['password', 'passkey', 'tempkey']);
const TEMPKEY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
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
 * 规范化锁屏会话（网关 verifyLockSession 的结论）：ok 且 role 在白名单里才算有身份；by 不认识 → ''；
 * tempkeyId 只给访客且格式合规。没有身份 → null。
 * @param {any} s
 * @returns {{role:string, by:string, tempkeyId:string}|null}
 */
function normalizeLockIdentity(s) {
  if (!s || typeof s !== 'object') return null;
  const role = typeof s.role === 'string' ? s.role.trim() : '';
  if (ROLES.indexOf(role) === -1) return null;
  const byRaw = typeof s.by === 'string' ? s.by.trim() : '';
  const by = BYS.indexOf(byRaw) !== -1 ? byRaw : '';
  const tk = typeof s.tempkeyId === 'string' ? s.tempkeyId.trim() : '';
  const tempkeyId = role === 'visitor' && TEMPKEY_ID_RE.test(tk) ? tk : '';
  return { role, by, tempkeyId };
}

/**
 * 读网关写的锁屏身份（白名单校验）。没有 / 不认识的值 → null（= 无会话）。
 * role 区分大小写（只认小写 admin / visitor）；by 不认识 → ''；tempkeyId 只给访客。
 * @param {Headers|null|undefined} headers
 * @returns {{role:string, by:string, tempkeyId:string}|null}
 */
export function readLockIdentity(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  return normalizeLockIdentity({
    role: String(headers.get(LOCK_IDENTITY_HEADERS.role) || ''),
    by: String(headers.get(LOCK_IDENTITY_HEADERS.by) || ''),
    tempkeyId: String(headers.get(LOCK_IDENTITY_HEADERS.tempkeyId) || ''),
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
