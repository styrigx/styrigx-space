/**
 * @fileoverview 账号 Worker 的门（纵深防御的最小检查；门本身在网关 workers/auth-gateway/src/gate.js：
 * 无会话 /api/* 401、访客调 /api/account、/api/prefs 403、头像文件公开）。
 * 只看网关写的规范身份头（lib/lock-identity.js readLockIdentity，白名单校验），不看 cookie，也不验锁屏会话（网关已验过）。
 * 调用方：rpc/account-service.js serviceFetch。
 */
import { readLockIdentity } from './lib/lock-identity.js';
import { json, apiError } from './lib/http.js';
import { verifyAccountSession } from './core/account-session.js';

/* 管理员专属接口：访客身份 → 403 role（网关 ADMIN_ONLY_APIS 里的 /api/prefs；纵深防御）。
   /api/account 不在这里：访客身份由 api/account.js 自己拒（401 session，logout / reauth-clear 除外）。 */
const ADMIN_ONLY_APIS = ['/api/prefs'];

/**
 * 按身份头回答会话（context.auth：现有接口用 lockSession() / accountSession()）。
 * - lockSession()：身份头白名单校验通过 → { ok:true, role }；没有 / 不认识 → { ok:false, role:null, reason:'no-identity' }
 * - accountSession()：账号会话在本 Worker 自己验（core/account-session.js，账号库 D1_ACCOUNT_AUTH），同一请求只验一次
 * @param {Request} request
 * @param {Record<string, any>} env 已换好密钥字符串的 env
 */
export function headerAuth(request, env) {
  const id = readLockIdentity(request && request.headers);
  const lock = id
    ? { ok: true, role: id.role, reason: 'ok' }
    : { ok: false, role: null, reason: 'no-identity' };
  /** @type {Promise<{ok:boolean, reason:string}>|null} */
  let accP = null;
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
  };
}

/**
 * 按网关写的锁屏身份（readLockIdentity 的结论）算出这个请求该被拒的响应；放行 → null。
 * 纵深防御的最小门（门本身在网关 src/gate.js，结论相同）：/api/* 没有身份头 → 401 {ok:false}；访客调 /api/prefs → 403 role。
 * 访客调 /api/account 交给 api/account.js（401 session）；头像文件 /avatar/* 不要身份。
 * 只看身份头、不看 cookie，也不验任何会话（锁屏会话网关已验过）。
 * @param {Request} request
 * @param {{role:string, by:string, tempkeyId:string}|null} identity readLockIdentity(request.headers)
 * @returns {Response|null}
 */
export function lockIdentityDenial(request, identity) {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith('/api/')) return null;
  const under = (list) => list.some((p) => pathname === p || pathname.startsWith(p + '/'));
  if (!identity) return json(401, { ok: false });
  if (identity.role !== 'admin' && under(ADMIN_ONLY_APIS)) return apiError(403, 'role');
  return null;
}
