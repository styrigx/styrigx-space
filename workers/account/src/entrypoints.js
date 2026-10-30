/**
 * @fileoverview 账号 Worker 的命名入口（账号拆分 PR2c，方案第 2、3、4、10.2 节）：
 * - AccountService（WorkerEntrypoint，fetch）：网关经服务绑定 ACCOUNT 转发过来的请求。
 *   读网关写的规范身份头（workers/account/src/lib/lock-identity.js 的头名；白名单校验复用 identity/account.js 的 readLockIdentity）
 *   → 现有账号路由表（头像、设置云同步、数字健康）+ 新的 /api/account（identity/account.js）。
 * - AccountVerifier（WorkerEntrypoint，RPC）：accountSession(cookieHeader, clientContext) 只回账号会话的校验结论，不签发任何东西。
 *
 * 信任边界：本入口无条件信任 x-styrigx-* 头。它只能经服务绑定进来（没有公网路由能到命名入口），
 * 而网关 fetch 第一步会剥掉入站请求里所有 x-styrigx-* 头（方案第 3 节第一道保险，PR3 实施），再按验过的锁屏会话重写。
 * 公网请求进的是默认 fetch（index.js）：那里不读这些头，会话照旧问网关 AuthVerifier（服务绑定 AUTH），伪造的头不起作用，
 * 也没有 /api/account。
 *
 * PR2 暗上线：网关还没有 ACCOUNT / ACCOUNT_VERIFIER 绑定，没有流量进这两个入口；公开路由和 [[services]] AUTH 暂留，
 * 默认 fetch 行为与 PR2 前完全一致。PR3 切流：网关开始转发、账号删公开路由，默认 fetch 改为一律 404。
 *
 * 门：仍用 gate.js（与默认 fetch 同一套结论，只是会话来源从 AUTH RPC 换成身份头）；PR3 把门收回网关后删 gate.js。
 * cloudflare:workers 只在 Workers 里有：部署入口 worker.js 导出这里的类；node 单测用 tests/workers/account/_cf-workers.mjs 的替身。
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { MAX_COOKIE_HEADER } from './lib/cookies.js';
import { CLIENT_CONTEXT_HEADERS } from './lib/lock-identity.js';
import { API_ROUTES, route, tagRuntime } from './index.js';
import { gate } from './gate.js';
import { withNoStore, apiError } from './lib/http.js';
import { resolveSecrets } from './secrets.js';
import { readLockIdentity } from './identity/account.js';
import { verifyAccountSession } from './identity/account-session.js';
import * as accountApi from './identity/account.js';

/** AccountService 的接口路由表：现有三条 + /api/account（默认 fetch 用的 API_ROUTES 不变） */
export const SERVICE_API_ROUTES = new Map([...API_ROUTES, ['/api/account', accountApi]]);

const MAX_UA = 512;

/**
 * 按身份头回答会话（与 auth.js authFor 同形状，现有接口和 gate.js 直接用）。
 * - lockSession()：身份头白名单校验通过 → { ok:true, role }；没有 / 不认识 → { ok:false, role:null, reason:'no-identity' }
 * - accountSession()：账号会话在本 Worker 自己验（identity/account-session.js，账号库 D1_ACCOUNT_AUTH），同一请求只验一次
 * @param {Request} request
 * @param {Record<string, any>} env 已换好密钥字符串的 env
 */
export function headerAuth(request, env) {
  const id = readLockIdentity(request);
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
    const denied = await gate(request, e, auth);
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
 * AccountVerifier.accountSession 的实现：{ ok: true } 或 { ok: false, reason }（与网关 AuthVerifier.accountSession 同形状）。
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

/** 网关转发入口（服务绑定 ACCOUNT，PR3 起由网关使用） */
export class AccountService extends WorkerEntrypoint {
  /** @param {Request} request */
  async fetch(request) {
    return serviceFetch(request, this.env, this.ctx);
  }
}

/** 账号会话只读校验（服务绑定 ACCOUNT_VERIFIER，PR3 起网关的临时钥匙管理、短链签发、首帧提示用） */
export class AccountVerifier extends WorkerEntrypoint {
  /**
   * @param {string} cookieHeader 浏览器发来的 Cookie 头
   * @param {{ua?:string, country?:string, city?:string}} [clientContext]
   */
  async accountSession(cookieHeader, clientContext) {
    return checkAccountSession(this.env, cookieHeader, clientContext);
  }
}
