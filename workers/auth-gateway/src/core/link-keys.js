/**
 * @fileoverview 分享短链要网关做的三件事（服务绑定 RPC ShareIssuer 调用，入口见 rpc/share-issuer.js；node 单测直接测这里）。
 *
 * 短链本身（码、目标地址、列表、限速、D1 存储）在分享短链 Worker styrigx-share（workers/share）。
 * 它不持任何钥匙、不碰认证库；短链钥匙和短链进门的进站会话只在这里、只用网关原来那一份代码：
 * - createLinkKey(cookie, p)：签一把「短链钥匙」（core/lock-tempkey.js createTempkey，link=true：没有临时码、锁屏上输不进来、
 *   不占 20 把上限、不出现在临时钥匙列表里）。网关自己再验一次：要进门 + 锁侧复验（cookie 是浏览器带来的原样 Cookie 头，
 *   里面要有有效的 sgx-lock-reauth，只能由锁屏密码 / 锁屏通行密钥 / 进站凭证签出；临时钥匙或短链进门的会话本身不算复验；
 *   没有 → { ok:false, error:'reauth' }，由 styrigx-share 原样转成 401 reauth；不问账号会话；定案第 7 条，选 C）。
 * - revokeLinkKey(cookie, id)：作废这把钥匙（revokeTempkey：D1 tempkey 行写 revoked_at，强一致）→ 拿它进门的人下一个请求就进不来
 *   （验进站会话时查 tempkeyId 是否被作废，原样生效）。同样要进门 + 锁侧复验；只认 link 钥匙。
 * - checkLinkReauth(cookie)：只做「进门 + 锁侧复验」这一道判断，不签任何东西。styrigx-share 在不经 createLinkKey 的生成路径
 *   （普通短链、reuse:true 命中已有短链）和作废前先问它，所有 create / revoke 都过同一道门（方案 3.6）。
 * - openLinkSession(id, sessionSec)：点开带会话的短链 → 签进站会话（sgx-lock-session：by=tempkey，tempkeyId=钥匙 id，lock 私钥），
 *   和锁屏输临时码进门（api/lock-tempkey-unlock.js）完全同一套；Max-Age = min(会话时长, 钥匙剩余时间)。
 *   只回 Set-Cookie 头的值（由 styrigx-share 原样放进这次 302），不回任何钥匙或签名材料。
 *   钥匙不存在 / 不是 link 钥匙 / 已作废 / 已过期 / 时长不在档位里 → { ok:false }，绝不签发。
 * ShareIssuer 是单独的入口（不是 AuthVerifier 的方法）：只有 styrigx-share 绑定它，daymark / account 等拿到的 AuthVerifier 调不到。
 * 公网进不来：RPC 入口没有路由，wrangler 只把 default 挂到 styrigx.com/*。
 */
import { checkLockSession, issueLockSession } from './lock-session.js';
import { verifyTicket } from './tickets.js';
import { BY_TEMPKEY, LOCK_REAUTH_TICKET } from './realms.js';
import { MAX_COOKIE_HEADER } from '../lib/cookies.js';
import {
  createTempkey, revokeTempkey, getTempkey, durationMs, cleanName, isTempkeyId,
} from './lock-tempkey.js';
import { getPepper } from './password.js';
import { REALM_LOCK } from './realms.js';

/** 短链进门会话时长档位（秒）：30 分钟、1 / 3 / 12 小时、1 / 3 / 7 天（styrigx-share 用同一张表，单测核对两边一致） */
export const LINK_SESSION_OPTS = Object.freeze([1800, 3600, 3 * 3600, 12 * 3600, 86400, 3 * 86400, 7 * 86400]);

/**
 * 要进门（有效进站会话，任何进门方式）+ 锁侧复验（有效 sgx-lock-reauth），否则返回错误码 session / reauth。
 * @param {string} cookie
 * @param {Record<string, any>} env
 */
async function gateError(cookie, env) {
  const s = await checkLockSession(cookie, env);
  if (!s.ok) return 'session';
  const h = typeof cookie === 'string' ? cookie.slice(0, MAX_COOKIE_HEADER) : '';
  const tv = await verifyTicket(new Request('https://internal.invalid/', { headers: h ? { Cookie: h } : {} }), env, LOCK_REAUTH_TICKET);
  if (!tv.ok) return 'reauth';
  return '';
}

/**
 * 进门 + 锁侧复验（styrigx-share 在 create / revoke 之前问）。
 * @param {string} cookie
 * @param {Record<string, any>} env
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function checkLinkReauth(cookie, env) {
  if (!(env && env[REALM_LOCK.d1Binding])) return { ok: false, error: 'config' };
  const err = await gateError(cookie, env);
  return err ? { ok: false, error: err } : { ok: true };
}

/**
 * @param {string} cookie 浏览器发来的 Cookie 头
 * @param {{hours?:number, days?:number, name?:string}} p
 * @param {Record<string, any>} env 已换好密钥字符串的 env
 * @returns {Promise<{ok:true, key:{id:string, expiresAt:number}}|{ok:false, error:string}>}
 */
export async function createLinkKey(cookie, p, env) {
  if (!(env && env[REALM_LOCK.d1Binding])) return { ok: false, error: 'config' };
  const q = p && typeof p === 'object' ? p : {};
  const err = await gateError(cookie, env);
  if (err) return { ok: false, error: err };
  const ms = durationMs({ hours: q.hours, days: q.days });
  if (!ms) return { ok: false, error: 'duration' };
  const name = cleanName(q.name);
  if (name === null) return { ok: false, error: 'name' };
  const pepper = getPepper(env);
  if (!pepper) return { ok: false, error: 'config' };
  try {
    const r = await createTempkey(env, pepper, { name: name, ms: ms, link: true });
    return { ok: true, key: { id: r.key.id, expiresAt: r.key.expiresAt } };
  } catch (e) {
    return { ok: false, error: 'server' };
  }
}

/**
 * @param {string} cookie
 * @param {string} id
 * @param {Record<string, any>} env
 * @returns {Promise<{ok:boolean, error?:string}>} 钥匙已经不在（到期 / 作废过）也算 ok
 */
export async function revokeLinkKey(cookie, id, env) {
  if (!(env && env[REALM_LOCK.d1Binding])) return { ok: false, error: 'config' };
  const err = await gateError(cookie, env);
  if (err) return { ok: false, error: err };
  if (!isTempkeyId(id)) return { ok: false, error: 'params' };
  try {
    const v = await getTempkey(env, id);
    if (!v) return { ok: true };
    if (!v.link) return { ok: false, error: 'params' }; /* 普通临时钥匙只在临时钥匙页作废 */
    await revokeTempkey(env, id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'server' };
  }
}

/**
 * @param {string} id 短链钥匙 id
 * @param {number} sessionSec 会话时长（秒，必须在 LINK_SESSION_OPTS 里）
 * @param {Record<string, any>} env
 * @returns {Promise<{ok:true, cookies:string[], maxAge:number}|{ok:false}>}
 */
export async function openLinkSession(id, sessionSec, env) {
  if (!isTempkeyId(id) || !LINK_SESSION_OPTS.includes(sessionSec)) return { ok: false };
  try {
    const v = await getTempkey(env, id); /* 作废 / 过期 → null；D1 主库，强一致 */
    if (!v || !v.link || !(v.expiresAt > Date.now())) return { ok: false };
    const left = Math.floor((v.expiresAt - Date.now()) / 1000);
    if (left < 1) return { ok: false };
    const maxAge = Math.max(1, Math.min(sessionSec, left));
    const headers = new Headers();
    const e = await issueLockSession(env, headers, { by: BY_TEMPKEY, maxAge: maxAge, tempkeyId: id });
    if (e) return { ok: false };
    return { ok: true, cookies: headers.getSetCookie(), maxAge: maxAge };
  } catch (e) {
    return { ok: false };
  }
}
