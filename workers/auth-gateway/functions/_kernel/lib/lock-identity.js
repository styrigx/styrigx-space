/**
 * 内部请求头：网关写的一侧（方案第 3 节；各 Worker 各自一份，不互相 import）。读的一侧只有账号 Worker：
 * workers/account/src/lib/lock-identity.js（readLockIdentity / readClientContext，同一份白名单）。
 *
 * 网关把锁屏身份、客户端上下文转给账号 Worker 时用的头名和写法：只用在转发表 src/forwarding.js 里的路径
 * （src/index.js forward → _kernel/forward.js forwardToService）。chat / search 不用这套头：api/chat.js、api/search.js
 * 新建内部请求、自己写 X-Sgx-Role（styrigx-chat / styrigx-search-index 仍只认它，改名留待以后）；api/status.js 不带任何身份头。
 * 头名大小写不敏感（Headers 会统一小写）；剥离外来同名头时按 INTERNAL_HEADER_PREFIX（小写）匹配前缀。
 *
 * - stripInternalHeaders(headers)：删掉所有 x-styrigx-* 和 x-sgx-role（网关 fetch 第一步剥浏览器带来的；writeLockIdentity 写之前再剥一次）
 * - writeLockIdentity(headers, lockSession, clientContext)：先剥，再按验过的锁屏会话写身份头和客户端上下文头（只写白名单里的值）
 *
 * 不带会话 id、不签名（方案第 3 节）：靠三道保险——网关剥头、账号 Worker 只在命名入口读头（默认 fetch 一律 404）、账号 Worker 没有公开路由
 * （wrangler.toml 无 [[routes]]；PR3 前的 4 条旧路由 wrangler deploy 不会自动删，部署后手动删，删之前进来的请求也只碰到默认 fetch 的 404）。
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

/** 所有内部头的公共前缀（小写） */
export const INTERNAL_HEADER_PREFIX = 'x-styrigx-';

/** X-Sgx-Role：网关新建发给 chat / search 的内部请求时自己写（api/chat.js、api/search.js），那两个 Worker 仍认它；
 *  浏览器带来的同名头在网关 fetch 第一步剥掉，不会经回源 / 转发带到任何下游。转发给账号 Worker 的请求里也没有它（账号只读 X-Styrigx-*）。 */
const LEGACY_ROLE_HEADER = 'x-sgx-role';

/* 白名单 */
const ROLES = Object.freeze(['admin', 'visitor']);
const BYS = Object.freeze(['password', 'passkey', 'tempkey']);
const TEMPKEY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ADDRESS_RE = /^[0-9A-Fa-f:.]{1,64}$/;
const MAX_COUNTRY = 4;
const MAX_CITY = 40;

/** 这个头名要剥吗（大小写不敏感） @param {string} name */
function isInternalHeader(name) {
  const n = String(name || '').toLowerCase();
  return n.startsWith(INTERNAL_HEADER_PREFIX) || n === LEGACY_ROLE_HEADER;
}

/**
 * 就地删掉所有内部头（x-styrigx-* 任意大小写、旧 x-sgx-role），返回同一个对象。
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
 * 规范化锁屏会话（verifyLockSession 的结论）：ok 且 role 在白名单里才算有身份；by 不认识 → ''；
 * tempkeyId 只给访客且格式合规。没有身份 → null。
 * @param {any} s
 * @returns {{role:string, by:string, tempkeyId:string}|null}
 */
function normalizeLockIdentity(s) {
  if (!s || typeof s !== 'object') return null;
  if (s.ok === false) return null;
  const role = typeof s.role === 'string' ? s.role.trim() : '';
  if (ROLES.indexOf(role) === -1) return null;
  const byRaw = typeof s.by === 'string' ? s.by.trim() : '';
  const by = BYS.indexOf(byRaw) !== -1 ? byRaw : '';
  const tk = typeof s.tempkeyId === 'string' ? s.tempkeyId.trim() : '';
  const tempkeyId = role === 'visitor' && TEMPKEY_ID_RE.test(tk) ? tk : '';
  return { role, by, tempkeyId };
}

/**
 * 先剥掉所有内部头，再按验过的锁屏会话写身份头、按客户端上下文写上下文头（只写白名单里的非空值）。
 * 没有锁屏会话 → 不带任何 X-Styrigx-Lock-* 头（= 下游看到的是无会话）。
 * @param {Headers} headers 要写的头（就地改）
 * @param {any} lockSession verifyLockSession 的结论 { ok, role, by?, tempkeyId? }
 * @param {any} clientContext { address, country, city }
 * @returns {Headers}
 */
export function writeLockIdentity(headers, lockSession, clientContext) {
  stripInternalHeaders(headers);
  const id = normalizeLockIdentity(lockSession);
  if (id) {
    headers.set(LOCK_IDENTITY_HEADERS.role, id.role);
    if (id.by) headers.set(LOCK_IDENTITY_HEADERS.by, id.by);
    if (id.tempkeyId) headers.set(LOCK_IDENTITY_HEADERS.tempkeyId, id.tempkeyId);
  }
  const c = normalizeClientContext(clientContext);
  if (c.address) headers.set(CLIENT_CONTEXT_HEADERS.address, c.address);
  if (c.country) headers.set(CLIENT_CONTEXT_HEADERS.country, c.country);
  if (c.city) headers.set(CLIENT_CONTEXT_HEADERS.city, c.city);
  return headers;
}
