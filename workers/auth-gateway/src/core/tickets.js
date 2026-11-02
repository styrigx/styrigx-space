/**
 * 锁屏 reset / reauth 短票（2026-11-02 Worker 骨架统一：原 _kernel/tickets.js 和 _kernel/lib/tickets.js 合成这一份）。
 * - 上半部分：通用签发、验证（*ShortTicket）。不认识具体的票：每个函数都接一个票配置对象 conf（realms.js TICKETS 里的一项）：
 *   { cookie, privateKey, publicKey, maxAge, cookieAttrs, bys }；纪元由调用方给（readEpoch：() => Promise<number>，出错抛错）。
 * - 下半部分：两张锁屏短票的具名入口（按票名查 realms.js 总表、按票所在的域读纪元，再调上半部分）。
 *
 * 票内容：by.epoch.iat.exp，最后一段是签名：
 *   sig = Ed25519(<该票的私钥>, "<cookie 名>|by.epoch.iat.exp")
 * 签名串带 cookie 名前缀做域隔离：同一把私钥签的票（会话、reset、reauth）互相冒充不了。
 *
 * cookie：每张票各自一个 cookie，属性取 conf.cookieAttrs（网关：只发主站、HttpOnly、Secure、SameSite=Strict），
 * Max-Age = conf.maxAge。不续期：到点就失效，前端倒计时以服务端返回的 expiresAt 为准。
 */
import { ed25519Sign, ed25519Verify } from '../lib/crypto.js';
import { readCookie, COOKIE_EXPIRED } from '../lib/cookies.js';
import { readEpoch } from './d1-state.js';
import { TICKETS, LOCK_RESET_TICKET, LOCK_REAUTH_TICKET, REALMS } from './realms.js';

/**
 * 签短票值。
 * @param {string} privatePem
 * @param {any} conf 票配置
 * @param {string} by
 * @param {number} epoch
 * @param {number} [now] iat，毫秒（测试 / 纪元推进后重签用）
 */
export async function signShortTicket(privatePem, conf, by, epoch, now) {
  if (conf.bys.indexOf(by) === -1) throw new Error('signTicket: bad by ' + JSON.stringify(by));
  const iat = now || Date.now();
  const exp = iat + conf.maxAge * 1000;
  const payload = by + '.' + epoch + '.' + iat + '.' + exp;
  const sig = await ed25519Sign(privatePem, conf.cookie + '|' + payload);
  return payload + '.' + sig;
}

/**
 * 解析短票值（不验签）。
 * @param {any} conf 票配置
 * @param {string} val
 * @returns {{by:string, epoch:number, iat:number, exp:number, sig:string}|null}
 */
export function parseShortTicket(conf, val) {
  if (!conf || !val || typeof val !== 'string') return null;
  const parts = val.split('.');
  if (parts.length !== 5) return null;
  const by = parts[0];
  if (conf.bys.indexOf(by) === -1) return null;
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
 * @param {any} conf 票配置（null → bad-format）
 * @param {() => Promise<number>} readEpoch 读票所在域的当前纪元（出错抛错 → d1-error）
 * @returns {Promise<{ok:boolean, reason:string, by?:string, exp?:number}>}
 *   reason: ok / no-cookie / bad-format / expired / not-yet / no-pubkey / d1-error / epoch-changed / bad-sig
 */
export async function verifyShortTicket(request, env, conf, readEpoch) {
  try {
    const c = conf;
    if (!c) return { ok: false, reason: 'bad-format' };
    const val = readCookie(request, c.cookie);
    if (!val) return { ok: false, reason: 'no-cookie' };
    const p = parseShortTicket(c, val);
    if (!p) return { ok: false, reason: 'bad-format' };
    const now = Date.now();
    if (p.exp <= now) return { ok: false, reason: 'expired' };
    if (p.iat > now + 60000) return { ok: false, reason: 'not-yet' };
    if (p.exp - p.iat > c.maxAge * 1000) return { ok: false, reason: 'bad-format' };
    const pub = (env && env[c.publicKey]) || '';
    if (!pub) return { ok: false, reason: 'no-pubkey' };
    let cur;
    try {
      cur = await readEpoch();
    } catch (e) {
      return { ok: false, reason: 'd1-error' };
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
 * @param {any} conf 票配置（null → 500 server）
 * @param {string} by
 * @param {object|undefined} opts
 * @param {number} [opts.epoch] 默认 readEpoch() 读当前值（纪元刚推进时传新值）
 * @param {() => Promise<number>} readEpoch 读票所在域的当前纪元（出错抛错 → 503 server）
 */
export async function issueShortTicket(env, headers, conf, by, opts, readEpoch) {
  const c = conf;
  if (!c) return { status: 500, body: { ok: false, error: 'server' } };
  const priv = (env && env[c.privateKey]) || '';
  if (!priv || !(env && env[c.publicKey])) return { status: 503, body: { ok: false, error: 'config' } };
  let epoch = opts && typeof opts.epoch === 'number' ? opts.epoch : null;
  if (epoch === null) {
    try {
      epoch = await readEpoch();
    } catch (e) {
      return { status: 503, body: { ok: false, error: 'server' } };
    }
  }
  try {
    const v = await signShortTicket(priv, c, by, epoch);
    headers.append('Set-Cookie', c.cookie + '=' + v + '; ' + c.cookieAttrs + '; Max-Age=' + c.maxAge);
  } catch (e) {
    return { status: 500, body: { ok: false, error: 'sign-failed' } };
  }
  return null;
}

/**
 * 纪元推进后重签短票（保持连续操作）：延续 by，不延长剩余时间
 * （iat 取 原 exp − 时长，新票的 exp 与原票相同）。
 * @param {any} env @param {Headers} headers @param {any} conf 票配置（null → 什么都不做）
 * @param {{ok:boolean, by?:string, exp?:number}|null} tv verifyShortTicket 的结果
 * @param {number} newEpoch
 */
export async function reissueShortTicketWithEpoch(env, headers, conf, tv, newEpoch) {
  if (!tv || !tv.ok || !tv.by || !tv.exp) return;
  const c = conf;
  if (!c) return;
  const priv = (env && env[c.privateKey]) || '';
  if (!priv) return;
  const left = tv.exp - Date.now();
  if (left <= 0) return;
  try {
    const iat = tv.exp - c.maxAge * 1000;
    const v = await signShortTicket(priv, c, tv.by, newEpoch, iat);
    headers.append('Set-Cookie', c.cookie + '=' + v + '; ' + c.cookieAttrs + '; Max-Age=' + Math.ceil(left / 1000));
  } catch (e) {}
}

/** 清某张短票 @param {Headers} headers @param {any} conf 票配置（null → 什么都不做） */
export function clearShortTicket(headers, conf) {
  const c = conf;
  if (!c) return;
  headers.append('Set-Cookie', c.cookie + '=; ' + c.cookieAttrs + '; ' + COOKIE_EXPIRED);
}

/* ---------------- 锁屏短票（原 _kernel/tickets.js） ---------------- */

/**
 * 两张锁屏短票：按 realms.js 的 TICKETS 总表通用签发、验证（LockSessionTicket 在 lock-session.js）。
 * - LockResetTicket  （sgx-lock-reset） 重置锁屏（丢了锁屏凭证，没有会话）—— 只能设置解锁密码 / 增删锁屏通行密钥；
 *                     by = root（锁屏根密钥 + 重置开关，或锁屏从零设置）| password | passkey（锁屏根密钥 + 锁屏凭证双验）
 * - LockReauthTicket （sgx-lock-reauth）进「安全与隐私 → 锁屏凭证」前再验一次；by = password | passkey | root
 * 账号的 AccountResetTicket / AccountReauthTicket 在账号 Worker（账号拆分 PR3），网关不签、不验。
 *
 * 票内容：by.epoch.iat.exp，最后一段是签名：sig = Ed25519(SGX_LOCK_PRIVATE, "<cookie 名>|by.epoch.iat.exp")。
 * 签名串带 cookie 名前缀做域隔离：同一把私钥签的票（会话、reset、reauth）互相冒充不了。
 * 纪元：Lock 三张票共用 Lock 纪元（改凭证 +1，旧票随即失效）。
 * cookie：只发主站（不带 Domain）、HttpOnly、Secure、SameSite=Strict、Max-Age=180。不续期。
 * 通用实现在本文件上半部分（按票配置对象工作，纪元由调用方给）。
 */

/** 本文件管的两张锁屏短票 */
export const SHORT_TICKETS = Object.freeze([LOCK_RESET_TICKET, LOCK_REAUTH_TICKET]);

/** @param {string} name 票名 */
function ticketConf(name) {
  return SHORT_TICKETS.indexOf(name) !== -1 ? TICKETS[name] : null;
}

/**
 * 读票所在域的纪元（D1，见 d1-state.js；出错抛错，调用方 fail closed）。
 * @param {any} env @param {string} name 票名
 * @returns {Promise<number>}
 */
export async function getTicketEpoch(env, name) {
  const c = TICKETS[name];
  if (!c) throw new Error('getTicketEpoch: bad ticket');
  return readEpoch(env, REALMS[c.realm]);
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
  return signShortTicket(privatePem, c, by, epoch, now);
}

/**
 * 解析短票值（不验签）。
 * @param {string} name 票名
 * @param {string} val
 * @returns {{by:string, epoch:number, iat:number, exp:number, sig:string}|null}
 */
export function parseTicket(name, val) {
  return parseShortTicket(ticketConf(name), val);
}

/**
 * 验请求里的某张短票（只读这张票自己的 cookie）。fail closed：任何异常都无效。
 * @param {any} request
 * @param {any} env
 * @param {string} name 票名
 * @returns {Promise<{ok:boolean, reason:string, by?:string, exp?:number}>}
 *   reason: ok / no-cookie / bad-format / expired / not-yet / no-pubkey / d1-error / epoch-changed / bad-sig
 */
export async function verifyTicket(request, env, name) {
  return verifyShortTicket(request, env, ticketConf(name), () => getTicketEpoch(env, name));
}

/**
 * 签发短票并写入 headers（fail closed，永不抛错）。成功返回 null，失败返回 { status, body }。
 * @param {any} env
 * @param {Headers} headers
 * @param {string} name 票名
 * @param {string} by
 * @param {object} [opts]
 * @param {number} [opts.epoch] 默认读 D1 当前值（纪元刚推进时传新值）
 */
export async function issueTicket(env, headers, name, by, opts) {
  return issueShortTicket(env, headers, ticketConf(name), by, opts, () => getTicketEpoch(env, name));
}

/**
 * 纪元推进后重签短票（保持连续操作）：延续 by，不延长剩余时间
 * （iat 取 原 exp − 时长，新票的 exp 与原票相同）。
 * @param {any} env @param {Headers} headers @param {string} name 票名
 * @param {{ok:boolean, by?:string, exp?:number}|null} tv verifyTicket 的结果
 * @param {number} newEpoch
 */
export async function reissueTicketWithEpoch(env, headers, name, tv, newEpoch) {
  return reissueShortTicketWithEpoch(env, headers, ticketConf(name), tv, newEpoch);
}

/** 清某张短票 @param {Headers} headers @param {string} name 票名 */
export function clearTicket(headers, name) {
  clearShortTicket(headers, ticketConf(name));
}

/* ---------- 每张票的具名入口：sign<Ticket>() / verify<Ticket>() ---------- */

/** @param {string} privatePem @param {string} by @param {number} epoch @param {number} [now] */
export function signLockResetTicket(privatePem, by, epoch, now) { return signTicket(privatePem, LOCK_RESET_TICKET, by, epoch, now); }
/** @param {string} privatePem @param {string} by @param {number} epoch @param {number} [now] */
export function signLockReauthTicket(privatePem, by, epoch, now) { return signTicket(privatePem, LOCK_REAUTH_TICKET, by, epoch, now); }

/** @param {any} request @param {any} env */
export function verifyLockResetTicket(request, env) { return verifyTicket(request, env, LOCK_RESET_TICKET); }
/** @param {any} request @param {any} env */
export function verifyLockReauthTicket(request, env) { return verifyTicket(request, env, LOCK_REAUTH_TICKET); }
