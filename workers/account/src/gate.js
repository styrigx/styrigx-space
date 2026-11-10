/**
 * @fileoverview 账号 Worker 的门（纵深防御的最小检查；门本身在网关 workers/space-core/src/gate.js：
 * 无会话 /api/* 401、头像文件公开）。
 * 只看网关写的规范身份头（lib/gateway.js readLockIdentity，白名单校验）判断「有没有进站会话」（X-Styrigx-Space-Session: 1），
 * 不看锁屏 cookie，也不验进站会话（网关已验过）。有进站会话之后能做什么由账号会话 + 作用域决定（core/authorize.js）。
 * 调用方：rpc/account-service.js serviceFetch。
 */
import { readLockIdentity } from './lib/gateway.js';
import { json, apiError } from './lib/http.js';
import { verifySession } from './core/session.js';
import { authorize } from './core/authorize.js';
import { admitRoute } from './core/admit.js';
import { STYRIGX_UID } from './core/groups.js';
import { SESSION_COOKIE } from './core/identity-session.js';
import { readCookie } from './lib/cookies.js';

/**
 * 按身份头和账号会话回答（context.auth）。
 * - gateway()：进站会话（身份头 X-Styrigx-Space-Session: 1）→ { ok:true, by, reason:'ok' }；没有 → { ok:false, by:'', reason:'no-identity' }
 * - session()：账号会话在本 Worker 自己验（core/session.js，账号库 D1_ACCOUNT），同一请求只验一次
 * - authorize(opts)：授权结论（core/authorize.js authorize：账号会话 + 作用域，opts.reauth 时再看挂在会话上的 reauth 票），
 *   { ok, reason, deviceId, scopes, reauth }；同一请求、同样的 reauth 只算一次
 * - v6(action?)：v6 新会话（sgx-session）对这条路由（给了 action 就按那个 action）的放行结论（core/admit.js admitRoute；判断只经
 *   core/groups.js permits）。没带 sgx-session → 不查库，{ allowed:false, reason:'no-cookie' }。同一请求、同一 action 只查一次。
 * - dataUid()：这个请求的数据归谁（ADR-0006 §2.12 (a)：uid 只取服务端会话，绝不取客户端参数 / 查询串 / 请求头 / 请求体）：
 *   v6 新会话放行 → 会话里的 uid；否则旧会话（进站 + 账号会话）→ styrigx（迁移对照：头像 / 偏好 / 设备 / 数字健康都归 styrigx）；
 *   都没有 → null。
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
  /** @type {Record<string, Promise<import('./core/authorize.js').Authorization>>} */
  const authP = {};
  /** @type {Record<string, Promise<any>>} */
  const v6P = {};
  const hasV6 = !!readCookie(request, SESSION_COOKIE);
  let pathname = '';
  try { pathname = new URL(request.url).pathname; } catch (e) {}
  const p = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const self = {
    identity: id,
    /** 请求带没带 v6 新会话 cookie */
    hasV6,
    /** @param {string} [action] */
    v6(action) {
      const k = typeof action === 'string' ? 'a:' + action : '-';
      if (!v6P[k]) {
        v6P[k] = hasV6
          ? admitRoute(env, request, String(request.method || 'GET').toUpperCase(), p, undefined, typeof action === 'string' ? { action } : undefined)
          : Promise.resolve({ allowed: false, reason: 'no-cookie', uid: null, root: false, rescue: false, renew: false, groups: [], name: '', via: '', level: null });
      }
      return v6P[k];
    },
    /** 已经算过的路由级 v6 结论（续期用；没算过 → null，不为续期多查一次库） */
    v6Computed() {
      return v6P['-'] || null;
    },
    /** @returns {Promise<number|null>} */
    async dataUid() {
      const v = await self.v6();
      if (v && v.allowed === true && Number.isInteger(v.uid)) return v.uid;
      const g = await self.gateway();
      if (!g.ok) return null;
      const a = await self.authorize();
      return a.ok ? STYRIGX_UID : null;
    },
    gateway() {
      return Promise.resolve(lock);
    },
    session() {
      if (!accP) {
        accP = verifySession(request, env).then(
          (a) => (a && a.ok ? { ok: true, reason: 'ok' } : { ok: false, reason: (a && a.reason) || 'denied' }),
          () => ({ ok: false, reason: 'error' }),
        );
      }
      return accP;
    },
    /** @param {{reauth?: boolean}} [opts] */
    authorize(opts) {
      const k = opts && opts.reauth === true ? 'reauth' : 'plain';
      if (!authP[k]) authP[k] = authorize(env, request, { reauth: k === 'reauth' });
      return authP[k];
    },
  };
  return self;
}

/**
 * 进站会话 + 账号会话 + 作用域（方案 3.4 R12：/api/avatar、/api/prefs 的写法）：通过 → null；否则错误响应。
 * 顺序：没有进站会话 401 session → 没账号会话 401 account（带 reason）→ 没作用域 403 scope（带 scope）。
 * @param {ReturnType<typeof headerAuth>} auth context.auth
 * @param {string} scope 作用域 id（core/scopes.js）
 * @param {Record<string, string>} [headers] 错误响应的额外头（头像接口要 no-store）
 * @returns {Promise<Response|null>}
 */
export async function scopeDenial(auth, scope, headers) {
  /* v6 新会话：这条路由的档够（permits 判过）就放行；不够就照旧会话的规则判（旧会话不受影响） */
  if (auth.hasV6 && typeof auth.v6 === 'function') {
    const v = await auth.v6();
    if (v && v.allowed === true && Number.isInteger(v.uid)) return null;
  }
  const lock = await auth.gateway();
  if (!lock.ok) return apiError(401, 'session', undefined, headers);
  const a = await auth.authorize();
  if (!a.ok) return apiError(401, 'account', { reason: a.reason }, headers);
  if (!a.scopes.includes(scope)) return apiError(403, 'scope', { scope }, headers);
  return null;
}

/**
 * 不要进站会话的接口（方法 + 路径，精确匹配）。必须是网关访问表（workers/space-core/src/gate.js ROUTE_ACCESS）里
 * 转发到本 Worker 的 public 条目的同一份；tests/workers/account/service.test.mjs 核对两边一致。
 */
export const PUBLIC_API = Object.freeze(['POST /api/identity', 'GET /api/wellbeing']);

/**
 * 按网关写的锁屏身份（readLockIdentity 的结论）算出这个请求该被拒的响应；放行 → null。
 * 纵深防御的最小门（门本身在网关 src/gate.js 访问表，结论相同）：/api/* 没有进站会话（没有 X-Styrigx-Space-Session: 1）→ 401 {ok:false}，
 * PUBLIC_API 里的除外（接口自己只给公开部分）。
 * 有进站会话之后的判断在各接口（/api/account/* 自己验账号会话 / reauth / reset 票；/api/prefs、/api/avatar 要账号会话 + 作用域）；头像文件 /avatar/* 不要身份。
 * 只看身份头、不看 cookie，也不验任何会话（进站会话网关已验过）。
 * @param {Request} request
 * @param {{session:true, by:string, linkId?:string}|null} identity readLockIdentity(request.headers)
 * @returns {Response|null}
 */
export function lockIdentityDenial(request, identity) {
  return lockIdentityDenialSync(request, identity);
}

/**
 * 同 lockIdentityDenial，再加 v6 新会话：没有进站会话、但请求带有效的 sgx-session（有 uid）且这条路由的档够（auth.v6()）→ 放行。
 * @param {Request} request @param {ReturnType<typeof headerAuth>} auth
 * @returns {Promise<Response|null>}
 */
export async function identityDenial(request, auth) {
  const denied = lockIdentityDenialSync(request, auth.identity);
  if (!denied || !auth.hasV6) return denied;
  const v = await auth.v6();
  return v && v.allowed === true && Number.isInteger(v.uid) ? null : denied; /* 要真有一个 v6 身份：坏 cookie 走 public 档不算进门 */
}

/** @param {Request} request @param {{session:true, by:string, linkId?:string}|null} identity */
function lockIdentityDenialSync(request, identity) {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith('/api/')) return null;
  if (identity && identity.session === true) return null;
  const p = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (PUBLIC_API.includes(String(request.method || 'GET').toUpperCase() + ' ' + p)) return null;
  return json(401, { ok: false });
}
