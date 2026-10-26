/**
 * 四张 reset / reauth 短票：按 realms.js 的 TICKETS 总表通用签发、验证（两张 session 票在 lock-session.js、account-session.js）。
 *
 * - LockResetTicket     （sgx-lock-reset）    重置锁屏（丢了锁屏凭证，没有会话）—— 只能设置解锁密码 / 增删锁屏通行密钥；
 *                        by = root（RootKey + 重置开关，或锁屏从零设置）| account（RootKey + AccountKey 双验）
 * - LockReauthTicket    （sgx-lock-reauth）   进「安全与隐私 → 锁屏凭证」前再验一次；by = password | passkey | root
 * - AccountResetTicket  （sgx-account-reset） 重置账号登录方式（RootKey 验过，没有账号会话）；by = root
 * - AccountReauthTicket （sgx-account-reauth）进「账号 → 账号安全」前再验一次；by = password | passkey | root
 *
 * 票内容：by.epoch.iat.exp，最后一段是签名：
 *   sig = Ed25519(<该票的私钥>, "<cookie 名>|by.epoch.iat.exp")
 * 签名串带 cookie 名前缀做域隔离：同一把私钥签的票（会话、reset、reauth）互相冒充不了。
 * 纪元按域：Lock 三张票共用 Lock 纪元，Account 三张票共用 Account 纪元（改凭证 +1，旧票随即失效）。
 *
 * cookie：每张票各自一个 cookie（Lock / Account 的 reset、reauth 互不覆盖），只发主站（不带 Domain）、
 * HttpOnly、Secure、SameSite=Strict、Max-Age=180。不续期：3 分钟到点就失效，前端倒计时以服务端返回的 expiresAt 为准。
 *
 * 叶子模块：只 import _kernel（crypto / realms），不 import 接口或 _middleware.js。
 */
import { ed25519Sign, ed25519Verify } from './crypto.js';
import { readCookie } from './cookies.js';
import {
  TICKETS,
  COOKIE_EXPIRED,
  SHORT_TICKET_MAX_AGE,
  LOCK_RESET_TICKET,
  LOCK_REAUTH_TICKET,
  ACCOUNT_RESET_TICKET,
  ACCOUNT_REAUTH_TICKET,
} from './realms.js';

/** 本文件管的四张短票 */
export const SHORT_TICKETS = Object.freeze([LOCK_RESET_TICKET, LOCK_REAUTH_TICKET, ACCOUNT_RESET_TICKET, ACCOUNT_REAUTH_TICKET]);

/** @param {string} name 票名 */
function ticketConf(name) {
  return SHORT_TICKETS.indexOf(name) !== -1 ? TICKETS[name] : null;
}

/**
 * 票的纪元键在哪个 KV 绑定（总表 kvBinding）。没绑 → null（getTicketEpoch 抛错，调用方 fail closed）。
 * @param {any} env @param {string} name
 */
export function ticketKv(env, name) {
  const c = TICKETS[name];
  if (!env || !c) return null;
  return env[c.kvBinding] || null;
}

/**
 * 读票所在域的纪元（键不存在当 0；KV 出错抛错，调用方 fail closed）。
 * @param {any} kv @param {string} name
 */
export async function getTicketEpoch(kv, name) {
  const c = TICKETS[name];
  if (!c) throw new Error('getTicketEpoch: bad ticket');
  const v = await kv.get(c.epochKey);
  if (v === null || v === undefined) return 0;
  return parseInt(v, 10) || 0;
}

/**
 * 签短票值。
 * @param {string} privatePem
 * @param {string} name 票名
 * @param {string} by
 * @param {number} epoch
 * @param {number} [now] iat，毫秒（测试 / 纪元推进后重签用）
 */
export async function signTicket(privatePem, name, by, epoch, now) {
  const c = ticketConf(name);
  if (!c) throw new Error('signTicket: bad ticket ' + JSON.stringify(name));
  if (c.bys.indexOf(by) === -1) throw new Error('signTicket: bad by ' + JSON.stringify(by));
  const iat = now || Date.now();
  const exp = iat + c.maxAge * 1000;
  const payload = by + '.' + epoch + '.' + iat + '.' + exp;
  const sig = await ed25519Sign(privatePem, c.cookie + '|' + payload);
  return payload + '.' + sig;
}

/**
 * 解析短票值（不验签）。
 * @param {string} name 票名
 * @param {string} val
 * @returns {{by:string, epoch:number, iat:number, exp:number, sig:string}|null}
 */
export function parseTicket(name, val) {
  const c = ticketConf(name);
  if (!c || !val || typeof val !== 'string') return null;
  const parts = val.split('.');
  if (parts.length !== 5) return null;
  const by = parts[0];
  if (c.bys.indexOf(by) === -1) return null;
  const epoch = parseInt(parts[1], 10);
  const iat = parseInt(parts[2], 10);
  const exp = parseInt(parts[3], 10);
  if (!Number.isFinite(epoch) || !Number.isFinite(iat) || !Number.isFinite(exp)) return null;
  if (!parts[4]) return null;
  return { by, epoch, iat, exp, sig: parts[4] };
}

/**
 * 验请求里的某张短票（只读这张票自己的 cookie）。fail closed：任何异常都无效。
 * @param {any} request
 * @param {any} env
 * @param {string} name 票名
 * @returns {Promise<{ok:boolean, reason:string, by?:string, exp?:number}>}
 *   reason: ok / no-cookie / bad-format / expired / not-yet / no-pubkey / kv-error / epoch-changed / bad-sig
 */
export async function verifyTicket(request, env, name) {
  try {
    const c = ticketConf(name);
    if (!c) return { ok: false, reason: 'bad-format' };
    const val = readCookie(request, c.cookie);
    if (!val) return { ok: false, reason: 'no-cookie' };
    const p = parseTicket(name, val);
    if (!p) return { ok: false, reason: 'bad-format' };
    const now = Date.now();
    if (p.exp <= now) return { ok: false, reason: 'expired' };
    if (p.iat > now + 60000) return { ok: false, reason: 'not-yet' };
    if (p.exp - p.iat > c.maxAge * 1000) return { ok: false, reason: 'bad-format' };
    const pub = (env && env[c.publicKey]) || '';
    if (!pub) return { ok: false, reason: 'no-pubkey' };
    let cur;
    try {
      cur = await getTicketEpoch(ticketKv(env, name), name);
    } catch (e) {
      return { ok: false, reason: 'kv-error' };
    }
    if (p.epoch !== cur) return { ok: false, reason: 'epoch-changed' };
    const payload = p.by + '.' + p.epoch + '.' + p.iat + '.' + p.exp;
    const ok = await ed25519Verify(pub, c.cookie + '|' + payload, p.sig);
    if (!ok) return { ok: false, reason: 'bad-sig' };
    return { ok: true, reason: 'ok', by: p.by, exp: p.exp };
  } catch (e) {
    return { ok: false, reason: 'bad-format' };
  }
}

/**
 * 签发短票并写入 headers（fail closed，永不抛错）。成功返回 null，失败返回 { status, body }。
 * @param {any} env
 * @param {Headers} headers
 * @param {string} name 票名
 * @param {string} by
 * @param {object} [opts]
 * @param {number} [opts.epoch] 默认读 KV（纪元刚推进时传新值）
 */
export async function issueTicket(env, headers, name, by, opts) {
  const c = ticketConf(name);
  if (!c) return { status: 500, body: { ok: false, error: 'server' } };
  const priv = (env && env[c.privateKey]) || '';
  if (!priv || !(env && env[c.publicKey])) return { status: 503, body: { ok: false, error: 'config' } };
  let epoch = opts && typeof opts.epoch === 'number' ? opts.epoch : null;
  if (epoch === null) {
    try {
      epoch = await getTicketEpoch(ticketKv(env, name), name);
    } catch (e) {
      return { status: 503, body: { ok: false, error: 'server' } };
    }
  }
  try {
    const v = await signTicket(priv, name, by, epoch);
    headers.append('Set-Cookie', c.cookie + '=' + v + '; ' + c.cookieAttrs + '; Max-Age=' + c.maxAge);
  } catch (e) {
    return { status: 500, body: { ok: false, error: 'sign-failed' } };
  }
  return null;
}

/**
 * 纪元推进后重签短票（保持连续操作）：延续 by，不延长剩余时间
 * （iat 取 原 exp − 时长，新票的 exp 与原票相同）。
 * @param {any} env @param {Headers} headers @param {string} name 票名
 * @param {{ok:boolean, by?:string, exp?:number}|null} tv verifyTicket 的结果
 * @param {number} newEpoch
 */
export async function reissueTicketWithEpoch(env, headers, name, tv, newEpoch) {
  if (!tv || !tv.ok || !tv.by || !tv.exp) return;
  const c = ticketConf(name);
  if (!c) return;
  const priv = (env && env[c.privateKey]) || '';
  if (!priv) return;
  const left = tv.exp - Date.now();
  if (left <= 0) return;
  try {
    const iat = tv.exp - c.maxAge * 1000;
    const v = await signTicket(priv, name, tv.by, newEpoch, iat);
    headers.append('Set-Cookie', c.cookie + '=' + v + '; ' + c.cookieAttrs + '; Max-Age=' + Math.ceil(left / 1000));
  } catch (e) {}
}

/** 清某张短票 @param {Headers} headers @param {string} name 票名 */
export function clearTicket(headers, name) {
  const c = ticketConf(name);
  if (!c) return;
  headers.append('Set-Cookie', c.cookie + '=; ' + c.cookieAttrs + '; ' + COOKIE_EXPIRED);
}

/* ---------- 每张票的具名入口：sign<Ticket>() / verify<Ticket>() ---------- */

/** @param {string} privatePem @param {string} by @param {number} epoch @param {number} [now] */
export function signLockResetTicket(privatePem, by, epoch, now) { return signTicket(privatePem, LOCK_RESET_TICKET, by, epoch, now); }
/** @param {string} privatePem @param {string} by @param {number} epoch @param {number} [now] */
export function signLockReauthTicket(privatePem, by, epoch, now) { return signTicket(privatePem, LOCK_REAUTH_TICKET, by, epoch, now); }
/** @param {string} privatePem @param {string} by @param {number} epoch @param {number} [now] */
export function signAccountResetTicket(privatePem, by, epoch, now) { return signTicket(privatePem, ACCOUNT_RESET_TICKET, by, epoch, now); }
/** @param {string} privatePem @param {string} by @param {number} epoch @param {number} [now] */
export function signAccountReauthTicket(privatePem, by, epoch, now) { return signTicket(privatePem, ACCOUNT_REAUTH_TICKET, by, epoch, now); }

/** @param {any} request @param {any} env */
export function verifyLockResetTicket(request, env) { return verifyTicket(request, env, LOCK_RESET_TICKET); }
/** @param {any} request @param {any} env */
export function verifyLockReauthTicket(request, env) { return verifyTicket(request, env, LOCK_REAUTH_TICKET); }
/** @param {any} request @param {any} env */
export function verifyAccountResetTicket(request, env) { return verifyTicket(request, env, ACCOUNT_RESET_TICKET); }
/** @param {any} request @param {any} env */
export function verifyAccountReauthTicket(request, env) { return verifyTicket(request, env, ACCOUNT_REAUTH_TICKET); }

export { SHORT_TICKET_MAX_AGE };
