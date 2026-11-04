/**
 * @fileoverview 账号 Worker 的门（纵深防御的最小检查；门本身在网关 workers/auth-gateway/src/gate.js：
 * 无会话 /api/* 401、头像文件公开）。
 * 只看网关写的规范身份头（lib/lock-identity.js readLockIdentity，白名单校验）判断「进门」（X-Styrigx-Lock-Session: 1），
 * 不看锁屏 cookie，也不验锁屏会话（网关已验过）。进门之后能做什么由账号会话 + 作用域决定（core/authz.js，方案 2.4、3.4 R12）。
 * 调用方：rpc/account-service.js serviceFetch。
 */
import { readLockIdentity } from './lib/lock-identity.js';
import { json, apiError } from './lib/http.js';
import { verifyAccountSession } from './core/account-session.js';
import { authorize } from './core/authz.js';

/**
 * 按身份头和账号会话回答（context.auth）。
 * - lockSession()：进门（身份头 X-Styrigx-Lock-Session: 1）→ { ok:true, by, reason:'ok' }；没有 → { ok:false, by:'', reason:'no-identity' }
 * - accountSession()：账号会话在本 Worker 自己验（core/account-session.js，账号库 D1_ACCOUNT_AUTH），同一请求只验一次
 * - authorize(opts)：授权结论（core/authz.js authorize：账号会话 + 作用域，opts.reauth 时再看账号复验票），
 *   { ok, reason, deviceId, scopes, reauth }；同一请求、同样的 reauth 只算一次
 * @param {Request} request
 * @param {Record<string, any>} env 已换好密钥字符串的 env
 */
export function headerAuth(request, env) {
  const id = readLockIdentity(request && request.headers);
  const lock = id
    ? { ok: true, by: id.by, reason: 'ok' }
    : { ok: false, by: '', reason: 'no-identity' };
  /** @type {Promise<{ok:boolean, reason:string}>|null} */
  let accP = null;
  /** @type {Record<string, Promise<import('./core/authz.js').Authorization>>} */
  const authzP = {};
  return {
    identity: id,
    lockSession() {
      return Promise.resolve(lock);
    },
    accountSession() {
      if (!accP) {
        accP = verifyAccountSession(request, env).then(
          (a) => (a && a.ok ? { ok: true, reason: 'ok' } : { ok: false, reason: (a && a.reason) || 'denied' }),
          () => ({ ok: false, reason: 'error' }),
        );
      }
      return accP;
    },
    /** @param {{reauth?: boolean}} [opts] */
    authorize(opts) {
      const k = opts && opts.reauth === true ? 'reauth' : 'plain';
      if (!authzP[k]) authzP[k] = authorize(env, request, { reauth: k === 'reauth' });
      return authzP[k];
    },
  };
}

/**
 * 进门 + 账号会话 + 作用域（方案 3.4 R12：/api/avatar、/api/prefs 的写法）：通过 → null；否则错误响应。
 * 顺序：没进门 401 session → 没账号会话 401 account（带 reason）→ 没作用域 403 scope（带 scope）。
 * @param {ReturnType<typeof headerAuth>} auth context.auth
 * @param {string} scope 作用域 id（core/scopes.js）
 * @param {Record<string, string>} [headers] 错误响应的额外头（头像接口要 no-store）
 * @returns {Promise<Response|null>}
 */
export async function scopeDenial(auth, scope, headers) {
  const lock = await auth.lockSession();
  if (!lock.ok) return apiError(401, 'session', undefined, headers);
  const a = await auth.authorize();
  if (!a.ok) return apiError(401, 'account', { reason: a.reason }, headers);
  if (!a.scopes.includes(scope)) return apiError(403, 'scope', { scope }, headers);
  return null;
}

/**
 * 按网关写的锁屏身份（readLockIdentity 的结论）算出这个请求该被拒的响应；放行 → null。
 * 纵深防御的最小门（门本身在网关 src/gate.js，结论相同）：/api/* 没进门（没有 X-Styrigx-Lock-Session: 1）→ 401 {ok:false}。
 * 进门之后的判断在各接口（/api/account 自己验账号会话 / 复验票；/api/prefs、/api/avatar 要账号会话 + 作用域）；头像文件 /avatar/* 不要身份。
 * 不按进门方式拦（P2-3 起网关也不再分等级）：进门之后能做什么由账号会话 + 作用域决定。
 * 只看身份头、不看 cookie，也不验任何会话（锁屏会话网关已验过）。
 * @param {Request} request
 * @param {{session:true, by:string, tempkeyId:string}|null} identity readLockIdentity(request.headers)
 * @returns {Response|null}
 */
export function lockIdentityDenial(request, identity) {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith('/api/')) return null;
  if (!identity || identity.session !== true) return json(401, { ok: false });
  return null;
}
