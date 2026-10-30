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
 * 账号拆分 PR1（零行为变化）：签 / 解析 / 验 / 发 / 重签 / 清的通用实现搬到 workers/auth-gateway/functions/_kernel/lib/tickets.js（按票配置对象工作，
 * 纪元由调用方给）；本文件按票名查 TICKETS 总表、按票所在的域读 D1 纪元，导出的名字和行为与以前完全相同。
 *
 * 只 import _kernel（realms / d1-state）和共享模块 workers/auth-gateway/functions/_kernel/lib/tickets.js，不 import 接口或 _middleware.js。
 */
import {
  TICKETS,
  LOCK_RESET_TICKET,
  LOCK_REAUTH_TICKET,
  ACCOUNT_RESET_TICKET,
  ACCOUNT_REAUTH_TICKET,
  REALMS,
} from './realms.js';
import { readEpoch } from './d1-state.js';
import {
  signShortTicket,
  parseShortTicket,
  verifyShortTicket,
  issueShortTicket,
  reissueShortTicketWithEpoch,
  clearShortTicket,
} from './lib/tickets.js';

/** 本文件管的四张短票 */
export const SHORT_TICKETS = Object.freeze([LOCK_RESET_TICKET, LOCK_REAUTH_TICKET, ACCOUNT_RESET_TICKET, ACCOUNT_REAUTH_TICKET]);

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
