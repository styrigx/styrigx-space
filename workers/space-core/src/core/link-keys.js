/**
 * @fileoverview 分享链接的会话与门槛（v5 S1：临时钥匙整块删除，链接会话直接绑 share_link 这一行；api/share.js、core/share-open.js 直接调，node 单测直接测这里）。
 *
 * 短链本身（码、目标地址、列表、限速、D1 share_* 表）在 core/share-links.js / core/share-open.js / api/share.js；这里只管三件事：
 * - checkLinkCreate(cookie, env)：新建分享链接的门槛——要进门，而且不是分享链接进来的会话（by=link 不能发分享）。不要 reauth、不问账号会话。
 * - checkLinkReauth(cookie, env)：管理（list / revoke）的门槛——进门 + 锁侧复验（有效 sgx-space-reauth），而且会话不是 by=link。
 *   reauth 票本身只认解锁密码 / 通行密钥签（api/lock-password.js、api/lock-passkey.js 对 by=link 的会话拒签），这里再拒一次（纵深防御）。
 * - openLinkSession(linkId, sessionSec, expiresAt, env)：点开带会话的短链 → 签进站会话（sgx-space-session：by=link，linkId = share_link.id，
 *   SGX_SPACE_PRIVATE）；Max-Age = min(会话时长, 链接剩余时间)。share-open.js 刚读过这一行、确认有效，把 (id, session_sec, expires_at) 传进来，
 *   签发时不再读一次 D1。只回 Set-Cookie 头的值（core/share-open.js 原样放进这次 302），不回任何签名材料。
 *   id 格式不对 / 时长不在档位里 / 链接已到期 → { ok:false }，绝不签发。
 * 作废不在这里：share rm / rm --all 直接写 share_link.revoked_at（api/share.js），拿它进门的人下一个请求验票时就过不去（core/lock-session.js）。
 * 这些都不是 RPC：SpaceVerifier（奇趣、日刻绑定）上没有签会话的方法。
 */
import { verifyLockSession, issueLockSession } from './lock-session.js';
import { verifyTicket } from './tickets.js';
import { BY_LINK, LOCK_REAUTH_TICKET, REALM_LOCK } from './realms.js';
import { MAX_COOKIE_HEADER } from '../lib/cookies.js';
import { isLinkId } from './share-links.js';

/** 短链进门会话时长档位（秒）：30 分钟、1 / 3 / 12 小时、1 / 3 / 7 天（core/share-links.js SESSION_OPTS 同一张表，单测核对两边一致） */
export const LINK_SESSION_OPTS = Object.freeze([1800, 3600, 3 * 3600, 12 * 3600, 86400, 3 * 86400, 7 * 86400]);

/** 把 Cookie 头还原成一个只带 Cookie 的内部请求 @param {string} cookie */
function cookieRequest(cookie) {
  const h = typeof cookie === 'string' ? cookie.slice(0, MAX_COOKIE_HEADER) : '';
  return new Request('https://internal.invalid/', { headers: h ? { Cookie: h } : {} });
}

/**
 * 要进门且不是 by=link；needReauth 时还要锁侧复验。返回错误码：session（没进门）/ link（分享链接进来的会话）/ reauth（没有有效 reauth 票）/ ''。
 * @param {string} cookie
 * @param {Record<string, any>} env
 * @param {boolean} needReauth
 */
async function gateError(cookie, env, needReauth) {
  const req = cookieRequest(cookie);
  const s = await verifyLockSession(req, env);
  if (!s.ok) return 'session';
  if (s.by === BY_LINK) return 'link';
  if (!needReauth) return '';
  const tv = await verifyTicket(req, env, LOCK_REAUTH_TICKET);
  if (!tv.ok) return 'reauth';
  return '';
}

/**
 * 新建分享链接前问（api/share.js create，含 reuse:true）：进门 + 不是 by=link。
 * @param {string} cookie
 * @param {Record<string, any>} env
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function checkLinkCreate(cookie, env) {
  if (!(env && env[REALM_LOCK.d1Binding])) return { ok: false, error: 'config' };
  const err = await gateError(cookie, env, false);
  return err ? { ok: false, error: err } : { ok: true };
}

/**
 * 管理（list / revoke）前问：进门 + 不是 by=link + 锁侧复验。
 * @param {string} cookie
 * @param {Record<string, any>} env
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function checkLinkReauth(cookie, env) {
  if (!(env && env[REALM_LOCK.d1Binding])) return { ok: false, error: 'config' };
  const err = await gateError(cookie, env, true);
  return err ? { ok: false, error: err } : { ok: true };
}

/**
 * @param {string} linkId share_link.id
 * @param {number} sessionSec 会话时长（秒，必须在 LINK_SESSION_OPTS 里）
 * @param {number} expiresAt 链接到期（毫秒，share_link.expires_at）
 * @param {Record<string, any>} env
 * @returns {Promise<{ok:true, cookies:string[], maxAge:number}|{ok:false}>}
 */
export async function openLinkSession(linkId, sessionSec, expiresAt, env) {
  if (!isLinkId(linkId) || !LINK_SESSION_OPTS.includes(sessionSec)) return { ok: false };
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return { ok: false };
  try {
    const left = Math.floor((expiresAt - Date.now()) / 1000);
    if (left < 1) return { ok: false };
    const maxAge = Math.max(1, Math.min(sessionSec, left));
    const headers = new Headers();
    const e = await issueLockSession(env, headers, { by: BY_LINK, maxAge: maxAge, linkId: linkId });
    if (e) return { ok: false };
    return { ok: true, cookies: headers.getSetCookie(), maxAge: maxAge };
  } catch (e) {
    return { ok: false };
  }
}
