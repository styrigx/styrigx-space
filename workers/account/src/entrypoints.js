/**
 * @fileoverview 账号 Worker 的命名入口（方案第 2、3、4、10.2 节）：
 * - AccountService（WorkerEntrypoint，fetch）：网关经服务绑定 ACCOUNT 转发过来的请求（转发表 workers/auth-gateway/src/forwarding.js）。
 *   读网关写的规范身份头（lib/lock-identity.js readLockIdentity，白名单校验）→ 路由表 index.js API_ROUTES（/api/account、头像、
 *   设置云同步、数字健康）+ 头像文件 /avatar/<尺寸>.webp。
 * - AccountVerifier（WorkerEntrypoint，RPC）：accountSession(cookieHeader, clientContext) 只回账号会话的校验结论，不签发任何东西
 *   （网关的临时钥匙管理、短链签发、账号页首帧提示，短链 Worker 的短链列表用）。
 *
 * 信任边界：本入口无条件信任 x-styrigx-* 头。它只能经服务绑定进来（没有公网路由能到命名入口），
 * 而网关 fetch 第一步剥掉入站请求里所有 x-styrigx-* 头，再按验过的锁屏会话重写（方案第 3 节第一道保险）。
 * 默认 fetch（index.js）一律 404，不读这些头（第二道保险）；wrangler.toml 没有 [[routes]]（第三道保险）。
 *
 * 门在网关（_middleware.js：无会话 /api/* 401、访客调 /api/account、/api/prefs 403、头像文件公开）。
 * 这里只留纵深防御的最小检查（lockIdentityDenial）：/api/* 没有身份头 → 401 {ok:false}；访客调 /api/prefs → 403 role。
 * cloudflare:workers 只在 Workers 里有：部署入口 worker.js 导出这里的类；node 单测用 tests/workers/account/_cf-workers.mjs 的替身。
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { MAX_COOKIE_HEADER } from './lib/cookies.js';
import { CLIENT_CONTEXT_HEADERS, readLockIdentity } from './lib/lock-identity.js';
import { API_ROUTES, route, tagRuntime } from './index.js';
import { withNoStore, json, apiError } from './lib/http.js';
import { resolveSecrets } from './secrets.js';
import { verifyAccountSession } from './identity/account-session.js';

/** AccountService 的接口路由表（= index.js API_ROUTES：/api/account、/api/avatar、/api/prefs、/api/wellbeing） */
export const SERVICE_API_ROUTES = API_ROUTES;

const MAX_UA = 512;

/* 管理员专属接口：访客身份 → 403 role（网关 ADMIN_ONLY_APIS 里的 /api/prefs；纵深防御）。
   /api/account 不在这里：访客身份由 identity/account.js 自己拒（401 session，logout / reauth-clear 除外）。 */
const ADMIN_ONLY_APIS = ['/api/prefs'];

/**
 * 按身份头回答会话（context.auth：现有接口用 lockSession() / accountSession()）。
 * - lockSession()：身份头白名单校验通过 → { ok:true, role }；没有 / 不认识 → { ok:false, role:null, reason:'no-identity' }
 * - accountSession()：账号会话在本 Worker 自己验（identity/account-session.js，账号库 D1_ACCOUNT_AUTH），同一请求只验一次
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
 * 纵深防御的最小门（门本身在网关 _middleware.js，结论相同）：/api/* 没有身份头 → 401 {ok:false}；访客调 /api/prefs → 403 role。
 * 访客调 /api/account 交给 identity/account.js（401 session）；头像文件 /avatar/* 不要身份。
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

/**
 * AccountService.fetch 的实现（单测直接调）。
 * @param {Request} request
 * @param {Record<string, any>} env
 * @param {{ waitUntil(p: Promise<any>): void }} [ctx]
 */
export async function serviceFetch(request, env, ctx) {
  let isApi = false;
  try {
    isApi = new URL(request.url).pathname.startsWith('/api/');
    const e = await resolveSecrets(env || {});
    const auth = headerAuth(request, e);
    const denied = lockIdentityDenial(request, auth.identity);
    const res = denied || (await route(request, e, ctx, auth, SERVICE_API_ROUTES));
    return tagRuntime(isApi ? withNoStore(res) : res);
  } catch (err) {
    console.error('[sgx-account] service unhandled: ' + (err && /** @type {any} */ (err).name ? /** @type {any} */ (err).name : 'error'));
    return tagRuntime(apiError(500, 'internal'));
  }
}

/**
 * 把 RPC 参数还原成一个只带 Cookie / User-Agent / 地点头的内部请求（账号会话验证和设备 lastSeen 刷新读这些）。
 * @param {string} cookieHeader
 * @param {{ua?:string, country?:string, city?:string}} [clientContext]
 */
export function verifierRequest(cookieHeader, clientContext) {
  /** @type {Record<string,string>} */
  const headers = {};
  const c = typeof cookieHeader === 'string' ? cookieHeader.slice(0, MAX_COOKIE_HEADER) : '';
  if (c) headers.Cookie = c;
  const m = clientContext && typeof clientContext === 'object' ? clientContext : {};
  if (typeof m.ua === 'string' && m.ua) headers['User-Agent'] = m.ua.slice(0, MAX_UA);
  if (typeof m.country === 'string' && m.country) headers[CLIENT_CONTEXT_HEADERS.country] = m.country;
  if (typeof m.city === 'string' && m.city) headers[CLIENT_CONTEXT_HEADERS.city] = m.city;
  return new Request('https://internal.invalid/', { headers });
}

/**
 * AccountVerifier.accountSession 的实现：{ ok: true } 或 { ok: false, reason }。
 * 只验不签：不写 cookie、不签票、不推纪元（验证通过时照旧刷新设备 lastSeen，同网关）。
 * @param {Record<string, any>} env
 * @param {string} cookieHeader
 * @param {{ua?:string, country?:string, city?:string}} [clientContext]
 */
export async function checkAccountSession(env, cookieHeader, clientContext) {
  try {
    const a = await verifyAccountSession(verifierRequest(cookieHeader, clientContext), await resolveSecrets(env || {}));
    return a && a.ok ? { ok: true } : { ok: false, reason: (a && a.reason) || 'denied' };
  } catch (e) {
    console.error('[sgx-account] verifier unhandled: ' + (e && /** @type {any} */ (e).name ? /** @type {any} */ (e).name : 'error'));
    return { ok: false, reason: 'error' };
  }
}

/** 网关转发入口（服务绑定 ACCOUNT） */
export class AccountService extends WorkerEntrypoint {
  /** @param {Request} request */
  async fetch(request) {
    return serviceFetch(request, this.env, this.ctx);
  }
}

/** 账号会话只读校验（服务绑定 ACCOUNT_VERIFIER：网关的临时钥匙管理、短链签发、首帧提示；短链 Worker 的短链列表） */
export class AccountVerifier extends WorkerEntrypoint {
  /**
   * @param {string} cookieHeader 浏览器发来的 Cookie 头
   * @param {{ua?:string, country?:string, city?:string}} [clientContext]
   */
  async accountSession(cookieHeader, clientContext) {
    return checkAccountSession(this.env, cookieHeader, clientContext);
  }
}
