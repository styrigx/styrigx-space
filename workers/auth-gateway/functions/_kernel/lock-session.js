/**
 * 锁屏会话（LockSessionTicket，cookie sgx-lock-session）：签发、解析、验证、Lock 纪元。
 *
 * 票内容：by.role.epoch.exp.tempkeyId，最后一段是签名：
 *   sig = Ed25519(SGX_LOCK_PRIVATE, "sgx-lock-session|by.role.epoch.exp.tempkeyId")
 * - role：admin（锁屏密码 / 锁屏通行密钥，12 小时）| visitor（临时钥匙：锁屏输临时码 min(钥匙剩余时间, 12 小时)；
 *   分享短链按短链的会话档位，同样不超过钥匙剩余时间）
 * - by：admin → password | passkey；visitor → tempkey。RootKey 不拥有会话，by 永远没有 root。
 * - tempkeyId：visitor 会话是哪把临时钥匙换来的（lock-tempkey.js）；验票时查这把钥匙有没有被作废，
 *   作废后访客下一个请求就进不来。admin 会话这一段固定为空串（票里就是连着的两个点 "<exp>..<sig>"），
 *   空串只对 admin 合法、非空只对 visitor 合法，解析时两边都卡死。
 * - epoch：Lock 纪元（D1 epoch 表 realm='lock' 那一行，见 d1-state.js；改锁屏凭证 / 退出所有设备 +1，旧票随即失效）
 * 验票只认 role=admin / visitor，其它格式一律无效。
 *
 * cookie 属性见 realms.js TICKETS.LockSessionTicket：Domain=.styrigx.com; SameSite=Lax（子站要读）。
 * 纪元、临时钥匙是否还在都每次读 D1 主库（不缓存），读出错一律 fail closed（签发返回 503、验证无效 d1-error）。
 */
import { ed25519Sign, ed25519Verify } from '../../../shared/crypto.js';
import { readAllCookies } from '../../../shared/cookies.js';
import {
  REALM_LOCK,
  TICKETS,
  LOCK_SESSION_TICKET,
  LOCK_SESSION_COOKIE,
  COOKIE_EXPIRED,
  ROLE_ADMIN,
  ROLE_VISITOR,
  BY_PASSWORD,
  BY_PASSKEY,
  BY_TEMPKEY,
  realmPrivateKey,
  realmPublicKey,
} from './realms.js';
import { isTempkeyId, isTempkeyRevoked } from './lock-tempkey.js';
import { readEpoch, bumpEpoch } from './d1-state.js';

export { LOCK_SESSION_COOKIE, ROLE_ADMIN, ROLE_VISITOR };
const CONF = TICKETS[LOCK_SESSION_TICKET];
/* cookie 属性：只定义一处（realms.js），这里转出给 diag / 测试对账 */
export const LOCK_SESSION_COOKIE_ATTRS = CONF.cookieAttrs;
export const LOCK_SESSION_MAX_AGE = CONF.maxAge; /* admin 12 小时 */
const SIG_PREFIX = LOCK_SESSION_COOKIE + '|';
const ADMIN_BYS = Object.freeze([BY_PASSWORD, BY_PASSKEY]);

/**
 * by / role / tempkeyId 组合是否合法：admin ⇔ by∈{password,passkey} 且 tempkeyId=''；visitor ⇔ by=tempkey 且 tempkeyId 合法。
 * @param {string} by @param {string} role @param {string} tempkeyId
 */
function validCombo(by, role, tempkeyId) {
  if (role === ROLE_ADMIN) return ADMIN_BYS.indexOf(by) !== -1 && tempkeyId === '';
  if (role === ROLE_VISITOR) return by === BY_TEMPKEY && isTempkeyId(tempkeyId);
  return false;
}

/**
 * 写锁屏会话 cookie。
 * @param {Headers} headers @param {string} value 票值 @param {number} maxAge 秒
 */
export function setLockSessionCookie(headers, value, maxAge) {
  headers.append('Set-Cookie', LOCK_SESSION_COOKIE + '=' + value + '; ' + CONF.cookieAttrs + '; Max-Age=' + (maxAge || CONF.maxAge));
}

/** 清锁屏会话 cookie @param {Headers} headers */
export function clearLockSessionCookie(headers) {
  headers.append('Set-Cookie', LOCK_SESSION_COOKIE + '=; ' + CONF.cookieAttrs + '; ' + COOKIE_EXPIRED);
}

/**
 * 签锁屏会话票值。
 * @param {string} privatePem SGX_LOCK_PRIVATE
 * @param {{by:string, role:string, epoch:number, exp:number, tempkeyId?:string}} t
 */
export async function signLockSessionTicket(privatePem, t) {
  const tempkeyId = (t && t.tempkeyId) || '';
  if (!t || !validCombo(t.by, t.role, tempkeyId)) {
    throw new Error('signLockSessionTicket: bad by/role/tempkeyId ' + JSON.stringify([t && t.by, t && t.role, tempkeyId]));
  }
  if (!Number.isFinite(t.epoch) || !Number.isFinite(t.exp)) throw new Error('signLockSessionTicket: bad epoch/exp');
  const payload = t.by + '.' + t.role + '.' + t.epoch + '.' + t.exp + '.' + tempkeyId;
  const sig = await ed25519Sign(privatePem, SIG_PREFIX + payload);
  return payload + '.' + sig;
}

/**
 * 解析锁屏会话票值（不验签）。六段：by.role.epoch.exp.tempkeyId.sig。
 * @param {string} val
 * @returns {{by:string, role:string, epoch:number, exp:number, tempkeyId:string, sig:string, payload:string}|null}
 */
export function parseLockSessionTicket(val) {
  if (!val || typeof val !== 'string') return null;
  const parts = val.split('.');
  if (parts.length !== 6) return null;
  const [by, role, epochStr, expStr, tempkeyId, sig] = parts;
  if (!validCombo(by, role, tempkeyId)) return null;
  if (!/^\d+$/.test(epochStr) || !/^\d+$/.test(expStr) || !sig) return null;
  return {
    by,
    role,
    epoch: parseInt(epochStr, 10),
    exp: parseInt(expStr, 10),
    tempkeyId,
    sig,
    payload: parts.slice(0, 5).join('.'),
  };
}

/**
 * 读 Lock 纪元（D1，强一致）。出错时抛错（调用方必须返回 503，绝不继续写入）。
 * @param {any} env
 * @returns {Promise<number>}
 */
export async function getLockEpoch(env) {
  return readEpoch(env, REALM_LOCK);
}

/**
 * Lock 纪元 +1（改锁屏凭证 / 退出所有设备时调用）。D1 原子自增：两次推进一定拿到两个不同的值；
 * 出错抛错，绝不写入一个更小的值（杜绝「旧 cookie 复活」）。
 * @param {any} env
 * @returns {Promise<number>} 新纪元
 */
export async function bumpLockEpoch(env) {
  return bumpEpoch(env, REALM_LOCK);
}

/**
 * 签发锁屏会话 cookie（fail closed，永不抛错）。成功返回 null；失败返回 { status, body }。
 * - SGX_LOCK_PRIVATE 为空 → 500 no-session-key
 * - 读纪元出错 → 503 server
 * - by / role / tempkeyId 组合不对 → 500 invalid-role
 * - 签名出错 → 500 session-sign-failed
 * @param {any} env
 * @param {Headers} headers
 * @param {{by:string, role:string, maxAge?:number, tempkeyId?:string}} o
 *   maxAge：秒；admin 默认 12 小时；visitor 必须传（按钥匙剩余时间算好）
 */
export async function issueLockSession(env, headers, o) {
  const tempkeyId = (o && o.tempkeyId) || '';
  if (!o || !validCombo(o.by, o.role, tempkeyId)) {
    return { status: 500, body: { ok: false, error: 'invalid-role' } };
  }
  const priv = realmPrivateKey(env, REALM_LOCK); /* SGX_LOCK_PRIVATE */
  if (!priv) return { status: 500, body: { ok: false, error: 'no-session-key' } };
  let epoch;
  try {
    epoch = await getLockEpoch(env);
  } catch (e) {
    return { status: 503, body: { ok: false, error: 'server' } };
  }
  /* visitor 的时长由调用方按钥匙剩余时间算好传进来（锁屏输临时码：上限 TEMPKEY_SESSION_MAX；分享短链：按短链档位） */
  if (o.role === ROLE_VISITOR && !o.maxAge) return { status: 500, body: { ok: false, error: 'invalid-role' } };
  const maxAge = o.maxAge || CONF.maxAge;
  let v;
  try {
    v = await signLockSessionTicket(priv, { by: o.by, role: o.role, epoch, exp: Date.now() + maxAge * 1000, tempkeyId });
  } catch (e) {
    return { status: 500, body: { ok: false, error: 'session-sign-failed' } };
  }
  setLockSessionCookie(headers, v, maxAge);
  return null;
}

/**
 * 纪元推进后重签当前设备的锁屏会话（删锁屏钥匙 / 改密码后保持当前设备不掉线）。
 * admin 按默认时长重签；visitor 不延长（沿用原 exp）。失败静默（调用方已返回业务成功）。
 * 没有会话（如重置锁屏）时 sess 为 null，不做任何事。
 * @param {any} env
 * @param {Headers} headers
 * @param {{ok:boolean, by?:string, role?:string, exp?:number, tempkeyId?:string}|null} sess verifyLockSession 的结果
 * @param {number} newEpoch
 */
export async function reissueLockSessionWithEpoch(env, headers, sess, newEpoch) {
  if (!sess || !sess.ok || !sess.by || !sess.role) return;
  const priv = realmPrivateKey(env, REALM_LOCK);
  if (!priv) return;
  try {
    const now = Date.now();
    const exp = sess.role === ROLE_ADMIN ? now + CONF.maxAge * 1000 : (sess.exp || 0);
    if (exp <= now) return;
    const v = await signLockSessionTicket(priv, { by: sess.by, role: sess.role, epoch: newEpoch, exp, tempkeyId: sess.tempkeyId || '' });
    setLockSessionCookie(headers, v, Math.ceil((exp - now) / 1000));
  } catch (e) {}
}

/**
 * 验单个锁屏会话票值（签名、到期、Lock 纪元；visitor 另查临时钥匙是否被作废）。
 * @param {string} val
 * @param {any} env
 * @returns {Promise<{status:string, role:string|null, by:string|null, exp?:number, tempkeyId?:string}>}
 *   status: ok / bad-format / expired / no-pubkey / bad-sig / d1-error / epoch-low / tempkey-revoked
 */
export async function verifyLockSessionTicket(val, env) {
  const p = parseLockSessionTicket(val);
  if (!p) return { status: 'bad-format', role: null, by: null };
  if (p.exp < Date.now()) return { status: 'expired', role: null, by: null };
  const pub = realmPublicKey(env, REALM_LOCK); /* SGX_LOCK_PUBLIC */
  if (!pub) return { status: 'no-pubkey', role: null, by: null };
  let sigOk = false;
  try { sigOk = await ed25519Verify(pub, SIG_PREFIX + p.payload, p.sig); } catch (e) { sigOk = false; }
  if (!sigOk) return { status: 'bad-sig', role: null, by: null };
  let cur;
  try {
    cur = await getLockEpoch(env);
  } catch (e) {
    return { status: 'd1-error', role: null, by: null };
  }
  /* 纪元只认相等：比当前小是旧票；比当前大同样不认（纪元不会回退，除非存储出了事故，那时也不让票复活） */
  if (p.epoch !== cur) return { status: 'epoch-low', role: null, by: null };
  if (p.role !== ROLE_VISITOR) return { status: 'ok', role: p.role, by: p.by, exp: p.exp, tempkeyId: p.tempkeyId };
  try {
    /* visitor：钥匙到期由票自己的 exp 管（不晚于钥匙到期）；作废每个请求读一次 D1 主库，不缓存 */
    if (await isTempkeyRevoked(env, p.tempkeyId)) {
      return { status: 'tempkey-revoked', role: null, by: null };
    }
  } catch (e) {
    return { status: 'd1-error', role: null, by: null };
  }
  return { status: 'ok', role: p.role, by: p.by, exp: p.exp, tempkeyId: p.tempkeyId };
}

/**
 * 取 Cookie 头里所有 sgx-lock-session 的值（同名 cookie 可能并存，浏览器会都发过来）。
 * @param {any} request
 * @returns {string[]}
 */
function allLockSessionCookies(request) {
  return readAllCookies(request, LOCK_SESSION_COOKIE);
}

/**
 * 请求是不是带着访客会话（只看格式和 role 段，不验签、不读存储）。
 * 访客假入口（root-auth / lock-reset / lock-password / lock-passkey）用它在读任何存储之前直接返回写死的失败，
 * 走真路径前再完整验票。格式按 parseLockSessionTicket（六段，visitor 必须带合法 tempkeyId）。
 * @param {any} request
 * @returns {boolean}
 */
export function looksVisitor(request) {
  try {
    for (const val of allLockSessionCookies(request)) {
      const p = parseLockSessionTicket(val);
      if (p && p.role === ROLE_VISITOR) return true;
    }
  } catch (e) {}
  return false;
}

/**
 * 验请求里的锁屏会话（网关页面、接口、子站 RPC 共用这一个实现）。任一同名值验过即有效。
 * 每次失败打 [sgx-verify] fail: <原因> 日志（只记原因，不记密钥和 cookie 值）。
 * @param {any} request
 * @param {any} env
 * @returns {Promise<{ok:boolean, role:string|null, by:string|null, exp?:number, tempkeyId?:string, reason:string}>}
 */
export async function verifyLockSession(request, env) {
  const vals = allLockSessionCookies(request);
  if (!vals.length) return { ok: false, role: null, by: null, reason: 'no-cookie' };
  let reason = 'bad-format';
  for (const val of vals) {
    const r = await verifyLockSessionTicket(val, env);
    if (r.status === 'ok') return { ok: true, role: r.role, by: r.by, exp: r.exp, tempkeyId: r.tempkeyId, reason: 'ok' };
    /* 记录最有信息量的失败原因：优先非 bad-format */
    if (reason === 'bad-format' || r.status !== 'bad-format') reason = r.status;
  }
  const pub = realmPublicKey(env, REALM_LOCK);
  if (reason === 'no-pubkey') {
    console.log('[sgx-verify] fail: no-pubkey pubkey_len=0');
  } else if (reason === 'bad-sig') {
    console.log('[sgx-verify] fail: bad-sig pubkey_len=' + pub.length + ' pubkey_prefix=' + JSON.stringify(pub.slice(0, 27)));
  } else {
    console.log('[sgx-verify] fail: ' + reason);
  }
  return { ok: false, role: null, by: null, reason };
}
