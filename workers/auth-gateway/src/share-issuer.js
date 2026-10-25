/**
 * @fileoverview 分享短链要网关做的三件事（服务绑定 RPC ShareIssuer 调用，入口见 rpc.js；node 单测直接测这里）。
 *
 * 短链本身（码、目标地址、列表、限速、D1 存储）在分享短链 Worker styrigx-share（workers/share）。
 * 它不持任何钥匙、不碰认证库；临时钥匙和访客会话只在这里、只用网关原来那一份代码：
 * - createLinkKey(cookie, p)：签一把「短链钥匙」（_kernel/lock-tempkey.js createTempkey，link=true：没有临时码、锁屏上输不进来、
 *   不占 20 把上限、不出现在临时钥匙列表里）。网关自己再验一次：必须是站长锁屏会话 + 账号会话（cookie 是浏览器带来的原样 Cookie 头）。
 * - revokeLinkKey(cookie, id)：作废这把钥匙（revokeTempkey：写作废标记）→ 拿它进来的访客下一个请求就进不来
 *   （middleware「visitor 必须带有效钥匙票且钥匙没被作废」原样生效）。同样要站长 + 账号会话；只认 link 钥匙。
 * - openLinkSession(id, sessionSec)：访客点开带会话的短链 → 签 visitor 会话（sgx-verified，by=owner，lock 私钥）+ 钥匙票 sgx-tk，
 *   和锁屏输临时码进门（api/lock-tempkey-unlock.js）完全同一套；Max-Age = min(会话时长, 钥匙剩余时间)。
 *   只回 Set-Cookie 头的值（由 styrigx-share 原样放进这次 302），不回任何钥匙或签名材料。
 *   钥匙不存在 / 不是 link 钥匙 / 已作废 / 已过期 / 时长不在档位里 → { ok:false }，绝不签发。
 * ShareIssuer 是单独的入口（不是 AuthVerifier 的方法）：只有 styrigx-share 绑定它，daymark / account 等拿到的 AuthVerifier 调不到。
 * 公网进不来：RPC 入口没有路由，wrangler 只把 default 挂到 styrigx.com/*。
 */
import { checkLockSession, checkAccountSession } from './verifier.js';
import { ROLE_OWNER, ROLE_VISITOR, issueSessionCookie } from '../functions/_kernel/lock-session.js';
import {
  createTempkey, revokeTempkey, isTempkeyRevoked, signTk, setTkCookie, durationMs, cleanName, isTempkeyId, TEMPKEY_PREFIX,
} from '../functions/_kernel/lock-tempkey.js';
import { getPepper } from '../functions/_kernel/password.js';

/** 访客会话时长档位（秒）：30 分钟、1 / 3 / 12 小时、1 / 3 / 7 天（styrigx-share 用同一张表，单测核对两边一致） */
export const LINK_SESSION_OPTS = Object.freeze([1800, 3600, 3 * 3600, 12 * 3600, 86400, 3 * 86400, 7 * 86400]);

/**
 * 站长 + 账号会话，否则返回错误码。
 * @param {string} cookie
 * @param {Record<string, any>} env
 * @param {any} [meta]
 */
async function adminError(cookie, env, meta) {
  const s = await checkLockSession(cookie, env);
  if (!s.ok || s.role !== ROLE_OWNER) return 'session';
  const a = await checkAccountSession(cookie, env, meta);
  if (!a.ok) return 'account';
  return '';
}

/**
 * @param {string} cookie 浏览器发来的 Cookie 头
 * @param {{hours?:number, days?:number, name?:string, meta?:any}} p
 * @param {Record<string, any>} env 已换好密钥字符串的 env
 * @returns {Promise<{ok:true, key:{id:string, expiresAt:number}}|{ok:false, error:string}>}
 */
export async function createLinkKey(cookie, p, env) {
  const kv = env && env.KV_LOCK_DOOR;
  if (!kv) return { ok: false, error: 'config' };
  const q = p && typeof p === 'object' ? p : {};
  const err = await adminError(cookie, env, q.meta);
  if (err) return { ok: false, error: err };
  const ms = durationMs({ hours: q.hours, days: q.days });
  if (!ms) return { ok: false, error: 'duration' };
  const name = cleanName(q.name);
  if (name === null) return { ok: false, error: 'name' };
  const pepper = getPepper(env);
  if (!pepper) return { ok: false, error: 'config' };
  try {
    const r = await createTempkey(kv, pepper, { name: name, ms: ms, link: true });
    return { ok: true, key: { id: r.key.id, expiresAt: r.key.expiresAt } };
  } catch (e) {
    return { ok: false, error: 'server' };
  }
}

/**
 * @param {string} cookie
 * @param {string} id
 * @param {Record<string, any>} env
 * @param {any} [meta]
 * @returns {Promise<{ok:boolean, error?:string}>} 钥匙已经不在（到期 / 作废过）也算 ok
 */
export async function revokeLinkKey(cookie, id, env, meta) {
  const kv = env && env.KV_LOCK_DOOR;
  if (!kv) return { ok: false, error: 'config' };
  const err = await adminError(cookie, env, meta);
  if (err) return { ok: false, error: err };
  if (!isTempkeyId(id)) return { ok: false, error: 'params' };
  try {
    const v = await kv.get(TEMPKEY_PREFIX + id, 'json');
    if (!v) return { ok: true };
    if (!v.link) return { ok: false, error: 'params' }; /* 普通临时钥匙只在临时钥匙页作废 */
    await revokeTempkey(kv, id);
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
  const kv = env && env.KV_LOCK_DOOR;
  if (!kv || !isTempkeyId(id) || !LINK_SESSION_OPTS.includes(sessionSec)) return { ok: false };
  try {
    if (await isTempkeyRevoked(kv, id)) return { ok: false };
    const v = await kv.get(TEMPKEY_PREFIX + id, 'json');
    if (!v || !v.link || !(v.expiresAt > Date.now())) return { ok: false };
    const left = Math.floor((v.expiresAt - Date.now()) / 1000);
    if (left < 1) return { ok: false };
    const maxAge = Math.max(1, Math.min(sessionSec, left));
    const tk = await signTk(env, id, Date.now() + maxAge * 1000);
    const headers = new Headers();
    const e = await issueSessionCookie(env, headers, ROLE_VISITOR, 'owner', maxAge);
    if (e) return { ok: false };
    setTkCookie(headers, tk, maxAge);
    return { ok: true, cookies: headers.getSetCookie(), maxAge: maxAge };
  } catch (e) {
    return { ok: false };
  }
}
