/**
 * 再验证（sudo root reauth；票 TICKET.reauth，cookie sgx-account-reauth）：某个会话上的 3 分钟提权。
 *
 * 票内容 by.epoch.iat.exp.deviceId（lib/ticket.js）：
 * - 只能从 /api/account/reauth 拿（登录不再顺手签它），要先有有效 session；deviceId = 那个 session 的设备
 * - 验的时候要求同一台设备的 session 也有效（verifyReauth 收 session 的验证结果）：会话没了，reauth 跟着没了
 * - 纪元 = session 纪元：改钥匙后由 reissueReauth 按新纪元重签（不延长剩余时间）
 * - 3 分钟、不续期；/api/account/reauth { end } 只清它，/api/account/session { end } 连它一起清
 *
 * 只 import workers/account/src/lib/ 和本目录。
 */
import { readEpoch } from '../lib/db.js';
import { signTicket, verifyTicket, ticketCookie, clearTicketCookie } from '../lib/ticket.js';
import { TICKET, EPOCH, SIGNING_PRIVATE, SIGNING_PUBLIC } from './config.js';
import { signingReady } from './session.js';

const CONF = TICKET.reauth;

/**
 * reauth 票值（测试和重签用）。iat 默认现在，exp = iat + 3 分钟。
 * @param {string} privatePem @param {{by:string, epoch:number, deviceId:string, iat?:number}} t
 */
export function signReauthTicket(privatePem, t) {
  const iat = t.iat || Date.now();
  return signTicket(privatePem, CONF, { by: t.by, epoch: t.epoch, at: iat, exp: iat + CONF.maxAge * 1000, deviceId: t.deviceId });
}

/**
 * 验请求里的 reauth 票，并要求它挂在当前这个有效 session 上（同一 deviceId）。
 * @param {any} request @param {any} env @param {{ok:boolean, deviceId?:string}} session verifySession 的结果
 * @returns {Promise<{ok:boolean, reason:string, by?:string, exp?:number, iat?:number}>}
 *   reason：no-session（本机没有有效 session）/ other-device / 以及 lib/ticket.js verifyTicket 的原因
 */
export async function verifyReauth(request, env, session) {
  if (!session || !session.ok) return { ok: false, reason: 'no-session' };
  const v = await verifyTicket(request, env, CONF, SIGNING_PUBLIC, () => readEpoch(env, EPOCH.session));
  if (!v.ok) return { ok: false, reason: v.reason };
  if (v.deviceId !== session.deviceId) return { ok: false, reason: 'other-device' };
  return { ok: true, reason: 'ok', by: v.by, exp: v.exp, iat: v.at };
}

/**
 * 签发 reauth 票（永不抛错）。成功 null；失败 { status, body }。
 * @param {any} env @param {Headers} headers @param {string} by @param {string} deviceId 本机 session 的设备
 * @returns {Promise<{status:number, body:object}|null>}
 */
export async function issueReauth(env, headers, by, deviceId) {
  if (!signingReady(env)) return { status: 503, body: { ok: false, error: 'config' } };
  let epoch;
  try { epoch = await readEpoch(env, EPOCH.session); } catch (e) { return { status: 503, body: { ok: false, error: 'server' } }; }
  try {
    headers.append('Set-Cookie', ticketCookie(CONF, await signReauthTicket(env[SIGNING_PRIVATE], { by, epoch, deviceId })));
  } catch (e) {
    return { status: 500, body: { ok: false, error: 'sign-failed' } };
  }
  return null;
}

/**
 * session 纪元推进后按原到期时间重签本机的 reauth 票（延续 by 和 deviceId，不延长剩余时间）。没有有效票就什么都不做。
 * @param {any} env @param {Headers} headers @param {{ok:boolean, by?:string, exp?:number}|null} rv verifyReauth 的结果
 * @param {string} deviceId @param {number} newEpoch
 */
export async function reissueReauth(env, headers, rv, deviceId, newEpoch) {
  if (!rv || !rv.ok || !rv.by || !rv.exp || !env || !env[SIGNING_PRIVATE]) return;
  const left = rv.exp - Date.now();
  if (left <= 0) return;
  try {
    const iat = rv.exp - CONF.maxAge * 1000;
    const v = await signTicket(env[SIGNING_PRIVATE], CONF, { by: rv.by, epoch: newEpoch, at: iat, exp: rv.exp, deviceId });
    headers.append('Set-Cookie', ticketCookie(CONF, v, Math.ceil(left / 1000)));
  } catch (e) {}
}

/** 清 reauth 票（只清它） @param {Headers} headers */
export function endReauth(headers) {
  headers.append('Set-Cookie', clearTicketCookie(CONF));
}
