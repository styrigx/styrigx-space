/**
 * 进站会话（LockSessionTicket，cookie sgx-lock-session）：签发、解析、验证、Lock 纪元。
 *
 * 票内容（v2，5 段）：by.epoch.exp.tempkeyId，最后一段是签名：
 *   sig = Ed25519(SGX_LOCK_PRIVATE, "sgx-lock-session|by.epoch.exp.tempkeyId")
 * 进门二值（设计方案 2.2.1、3.1）：票里没有等级，有效就是进门了。by 只记进门方式、只作审计，不分等级：
 * - by：password | passkey（锁屏密码 / 锁屏通行密钥，12 小时）| tempkey（临时钥匙：锁屏输临时码 min(钥匙剩余时间, 12 小时)；
 *   分享短链按短链的会话档位，同样不超过钥匙剩余时间）。进站凭证（SpaceKey）不拥有会话，by 永远没有 space。
 * - tempkeyId：by=tempkey 时是哪把临时钥匙换来的（lock-tempkey.js）；验票时查这把钥匙有没有被作废，
 *   作废后下一个请求就进不来。by=password / passkey 时这一段固定为空串（票里就是连着的两个点 "<exp>..<sig>"）。
 *   by=tempkey ⇔ tempkeyId 合法非空：这只是格式一致性检查，不是放行依据。
 * - epoch：Lock 纪元（D1 epoch 表 realm='lock' 那一行，见 d1-state.js；改锁屏凭证 / 退出所有设备 +1，旧票随即失效）
 * v1 的 6 段票（by.role.epoch.exp.tempkeyId.sig）一律 bad-format，和没有 cookie 一样（方案 3.8：上线即作废）。
 *
 * cookie 属性见 realms.js TICKETS.LockSessionTicket：Domain=.styrigx.com; SameSite=Lax（子站要读）。
 * 纪元、临时钥匙是否还在都每次读 D1 主库（不缓存），读出错一律 fail closed（签发返回 503、验证无效 d1-error）。
 */
import { ed25519Sign, ed25519Verify } from '../lib/crypto.js';
import { readAllCookies, MAX_COOKIE_HEADER } from '../lib/cookies.js';
import {
  REALM_LOCK,
  TICKETS,
  LOCK_SESSION_TICKET,
  LOCK_SESSION_COOKIE,
  COOKIE_EXPIRED,
  BY_PASSWORD,
  BY_PASSKEY,
  BY_TEMPKEY,
  realmPrivateKey,
  realmPublicKey,
} from './realms.js';
import { isTempkeyId, isTempkeyRevoked } from './lock-tempkey.js';
import { readEpoch, bumpEpoch } from './d1-state.js';

export { LOCK_SESSION_COOKIE };
const CONF = TICKETS[LOCK_SESSION_TICKET];
/* cookie 属性：只定义一处（realms.js），这里转出给 diag / 测试对账 */
export const LOCK_SESSION_COOKIE_ATTRS = CONF.cookieAttrs;
export const LOCK_SESSION_MAX_AGE = CONF.maxAge; /* 锁屏密码 / 通行密钥进门 12 小时 */
const SIG_PREFIX = LOCK_SESSION_COOKIE + '|';
const LOCKKEY_BYS = Object.freeze([BY_PASSWORD, BY_PASSKEY]);

/**
 * by / tempkeyId 格式是否一致：by∈{password,passkey} ⇔ tempkeyId=''；by=tempkey ⇔ tempkeyId 合法非空。
 * 只是格式校验，不是放行依据（进门不分等级）。
 * @param {string} by @param {string} tempkeyId
 */
function validCombo(by, tempkeyId) {
  if (LOCKKEY_BYS.indexOf(by) !== -1) return tempkeyId === '';
  if (by === BY_TEMPKEY) return isTempkeyId(tempkeyId);
  return false;
}

/**
 * 写进站会话 cookie。
 * @param {Headers} headers @param {string} value 票值 @param {number} maxAge 秒
 */
export function setLockSessionCookie(headers, value, maxAge) {
  headers.append('Set-Cookie', LOCK_SESSION_COOKIE + '=' + value + '; ' + CONF.cookieAttrs + '; Max-Age=' + (maxAge || CONF.maxAge));
}

/** 清进站会话 cookie @param {Headers} headers */
export function clearLockSessionCookie(headers) {
  headers.append('Set-Cookie', LOCK_SESSION_COOKIE + '=; ' + CONF.cookieAttrs + '; ' + COOKIE_EXPIRED);
}

/**
 * 签进站会话票值。
 * @param {string} privatePem SGX_LOCK_PRIVATE
 * @param {{by:string, epoch:number, exp:number, tempkeyId?:string}} t
 */
export async function signLockSessionTicket(privatePem, t) {
  const tempkeyId = (t && t.tempkeyId) || '';
  if (!t || !validCombo(t.by, tempkeyId)) {
    throw new Error('signLockSessionTicket: bad by/tempkeyId ' + JSON.stringify([t && t.by, tempkeyId]));
  }
  if (!Number.isFinite(t.epoch) || !Number.isFinite(t.exp)) throw new Error('signLockSessionTicket: bad epoch/exp');
  const payload = t.by + '.' + t.epoch + '.' + t.exp + '.' + tempkeyId;
  const sig = await ed25519Sign(privatePem, SIG_PREFIX + payload);
  return payload + '.' + sig;
}

/**
 * 解析进站会话票值（不验签）。五段：by.epoch.exp.tempkeyId.sig；v1 的 6 段票返回 null（bad-format）。
 * @param {string} val
 * @returns {{by:string, epoch:number, exp:number, tempkeyId:string, sig:string, payload:string}|null}
 */
export function parseLockSessionTicket(val) {
  if (!val || typeof val !== 'string') return null;
  const parts = val.split('.');
  if (parts.length !== 5) return null;
  const [by, epochStr, expStr, tempkeyId, sig] = parts;
  if (!validCombo(by, tempkeyId)) return null;
  if (!/^\d+$/.test(epochStr) || !/^\d+$/.test(expStr) || !sig) return null;
  return {
    by,
    epoch: parseInt(epochStr, 10),
    exp: parseInt(expStr, 10),
    tempkeyId,
    sig,
    payload: parts.slice(0, 4).join('.'),
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
 * 签发进站会话 cookie（fail closed，永不抛错）。成功返回 null；失败返回 { status, body }。
 * - SGX_LOCK_PRIVATE 为空 → 500 no-session-key
 * - 读纪元出错 → 503 server
 * - by / tempkeyId 组合不对 → 500 invalid-by
 * - 签名出错 → 500 session-sign-failed
 * @param {any} env
 * @param {Headers} headers
 * @param {{by:string, maxAge?:number, tempkeyId?:string}} o
 *   maxAge：秒；锁屏密码 / 通行密钥默认 12 小时；by=tempkey 必须传（按钥匙剩余时间算好）
 */
export async function issueLockSession(env, headers, o) {
  const tempkeyId = (o && o.tempkeyId) || '';
  if (!o || !validCombo(o.by, tempkeyId)) {
    return { status: 500, body: { ok: false, error: 'invalid-by' } };
  }
  const priv = realmPrivateKey(env, REALM_LOCK); /* SGX_LOCK_PRIVATE */
  if (!priv) return { status: 500, body: { ok: false, error: 'no-session-key' } };
  let epoch;
  try {
    epoch = await getLockEpoch(env);
  } catch (e) {
    return { status: 503, body: { ok: false, error: 'server' } };
  }
  /* by=tempkey 的时长由调用方按钥匙剩余时间算好传进来（锁屏输临时码：上限 TEMPKEY_SESSION_MAX；分享短链：按短链档位） */
  if (o.by === BY_TEMPKEY && !o.maxAge) return { status: 500, body: { ok: false, error: 'invalid-by' } };
  const maxAge = o.maxAge || CONF.maxAge;
  let v;
  try {
    v = await signLockSessionTicket(priv, { by: o.by, epoch, exp: Date.now() + maxAge * 1000, tempkeyId });
  } catch (e) {
    return { status: 500, body: { ok: false, error: 'session-sign-failed' } };
  }
  setLockSessionCookie(headers, v, maxAge);
  return null;
}

/**
 * 纪元推进后重签当前设备的进站会话（删锁屏钥匙 / 改密码后保持当前设备不掉线）。
 * 一律保留原 exp，不看进门方式、不延长（方案 2.2.1）。失败静默（调用方已返回业务成功）。
 * 没有会话（如重置锁屏）时 sess 为 null，不做任何事。
 * @param {any} env
 * @param {Headers} headers
 * @param {{ok:boolean, by?:string|null, exp?:number, tempkeyId?:string}|null} sess verifyLockSession 的结果
 * @param {number} newEpoch
 */
export async function reissueLockSessionWithEpoch(env, headers, sess, newEpoch) {
  if (!sess || !sess.ok || !sess.by) return;
  const priv = realmPrivateKey(env, REALM_LOCK);
  if (!priv) return;
  try {
    const now = Date.now();
    const exp = sess.exp || 0;
    if (exp <= now) return;
    const v = await signLockSessionTicket(priv, { by: sess.by, epoch: newEpoch, exp, tempkeyId: sess.tempkeyId || '' });
    setLockSessionCookie(headers, v, Math.ceil((exp - now) / 1000));
  } catch (e) {}
}

/**
 * 验单个进站会话票值（签名、到期、Lock 纪元；tempkeyId 非空时另查这把钥匙是否被作废）。
 * @param {string} val
 * @param {any} env
 * @returns {Promise<{status:string, by:string|null, exp?:number, tempkeyId?:string}>}
 *   status: ok / bad-format / expired / no-pubkey / bad-sig / d1-error / epoch-low / tempkey-revoked
 */
export async function verifyLockSessionTicket(val, env) {
  const p = parseLockSessionTicket(val);
  if (!p) return { status: 'bad-format', by: null };
  if (p.exp < Date.now()) return { status: 'expired', by: null };
  const pub = realmPublicKey(env, REALM_LOCK); /* SGX_LOCK_PUBLIC */
  if (!pub) return { status: 'no-pubkey', by: null };
  let sigOk = false;
  try { sigOk = await ed25519Verify(pub, SIG_PREFIX + p.payload, p.sig); } catch (e) { sigOk = false; }
  if (!sigOk) return { status: 'bad-sig', by: null };
  let cur;
  try {
    cur = await getLockEpoch(env);
  } catch (e) {
    return { status: 'd1-error', by: null };
  }
  /* 纪元只认相等：比当前小是旧票；比当前大同样不认（纪元不会回退，除非存储出了事故，那时也不让票复活） */
  if (p.epoch !== cur) return { status: 'epoch-low', by: null };
  if (!p.tempkeyId) return { status: 'ok', by: p.by, exp: p.exp, tempkeyId: '' };
  try {
    /* 临时钥匙换来的会话：钥匙到期由票自己的 exp 管（不晚于钥匙到期）；作废按「钥匙是否还有效」每个请求读一次 D1 主库，不缓存 */
    if (await isTempkeyRevoked(env, p.tempkeyId)) {
      return { status: 'tempkey-revoked', by: null };
    }
  } catch (e) {
    return { status: 'd1-error', by: null };
  }
  return { status: 'ok', by: p.by, exp: p.exp, tempkeyId: p.tempkeyId };
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
 * 验请求里的进站会话（网关页面、接口、子站 RPC 共用这一个实现）。任一同名值验过即有效。
 * 每次失败打 [sgx-verify] fail: <原因> 日志（只记原因，不记密钥和 cookie 值）。
 * @param {any} request
 * @param {any} env
 * @returns {Promise<{ok:boolean, by:string|null, exp?:number, tempkeyId?:string, reason:string}>}
 */
export async function verifyLockSession(request, env) {
  const vals = allLockSessionCookies(request);
  if (!vals.length) return { ok: false, by: null, reason: 'no-cookie' };
  let reason = 'bad-format';
  for (const val of vals) {
    const r = await verifyLockSessionTicket(val, env);
    if (r.status === 'ok') return { ok: true, by: r.by, exp: r.exp, tempkeyId: r.tempkeyId, reason: 'ok' };
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
  return { ok: false, by: null, reason };
}

/* ---------------- 给其他 Worker 的验票（原 src/verifier.js） ---------------- */

/**
 * @fileoverview 给其他 Worker 用的验票函数（服务绑定 RPC AuthVerifier 调用，入口见 rpc/auth-verifier.js）。
 *
 * 其他 Worker（如 daymark 仓库的 styrigx-daymark-core）不持任何钥匙，把浏览器带来的 Cookie 头原样交给网关，
 * 网关用自己 Secrets Store 里的公钥验签、用 D1 里的纪元核对（每次读主库，不缓存），只回答结论，不回任何密钥或 cookie 内容。
 * 与网关自己验页面、验接口用的是同一套代码（verifyLockSession）。
 * 账号会话不在网关验（账号拆分 PR3）：要账号会话的 Worker 绑账号 Worker 的 AccountVerifier（styrigx-account）。

 */
/**
 * @param {string} cookieHeader
 */
function cookieRequest(cookieHeader) {
  const h = typeof cookieHeader === 'string' ? cookieHeader.slice(0, MAX_COOKIE_HEADER) : '';
  /** @type {Record<string,string>} */
  const headers = h ? { Cookie: h } : {};
  return new Request('https://internal.invalid/', { headers });
}

/**
 * 会话：{ ok: true } 或 { ok: false, reason }（reason 只是原因代号）。进门二值：不回 by 以外的等级（方案 3.4 R11）。
 * @param {string} cookieHeader 浏览器发来的 Cookie 头
 * @param {Record<string, any>} env 已换好密钥字符串的 env
 */
export async function checkLockSession(cookieHeader, env) {
  const s = await verifyLockSession(cookieRequest(cookieHeader), env);
  return s.ok ? { ok: true, reason: 'ok' } : { ok: false, reason: s.reason };
}

/**
 * /api/* 处理函数取进站会话：先用关口（gate.js）验过、放进 context.data.lockSession 的结论（一次请求只验一次）；
 * 没有（非生产关口不验、图志关口直接调用、单测直接调用）就回落到自己验。
 * @param {{ request: Request, env: any, data?: any }} context
 */
export async function lockSessionOf(context) {
  const d = context && context.data;
  const s = d && d.lockSession;
  if (s && typeof s === 'object' && typeof s.ok === 'boolean') return s;
  return verifyLockSession(context.request, context.env);
}
