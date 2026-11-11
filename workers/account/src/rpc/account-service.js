/**
 * @fileoverview 账号 Worker 的命名入口 AccountService（WorkerEntrypoint，fetch；方案第 2、3、4、10.2 节）：
 * 网关经服务绑定 ACCOUNT 转发过来的请求（转发表 workers/space-core/src/router.js FORWARDING）。
 * 读网关写的规范身份头（gate.js headerAuth / lockIdentityDenial）→ 路由表 router.js API_ROUTES（/api/account/*、头像、
 * 设置云同步、数字健康）+ 头像文件 /avatar/<尺寸>.webp。
 *
 * 信任边界：本入口无条件信任 x-styrigx-* 头。它只能经服务绑定进来（没有公网路由能到命名入口），
 * 而网关 fetch 第一步剥掉入站请求里所有 x-styrigx-* 头，再按验过的进站会话重写（方案第 3 节第一道保险）。
 * 默认 fetch（app.js）一律 404，不读这些头（第二道保险）；wrangler.toml 没有 [[routes]]（第三道保险）。
 * cloudflare:workers 只在 Workers 里有：部署入口 index.js 导出这里的类；node 单测用 tests/workers/account/_cf-workers.mjs 的替身。
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { API_ROUTES, route } from '../router.js';
import { tagRuntime } from '../app.js';
import { headerAuth, identityDenial } from '../gate.js';
import { readCookie } from '../lib/cookies.js';
import { SESSION_COOKIE } from '../core/identity-session.js';
import { renewSession as renewV6Session } from '../core/identity-stack.js';
import { withNoStore, apiError } from '../lib/http.js';
import { resolveSecrets } from '../secrets.js';

/** AccountService 的接口路由表（= router.js API_ROUTES：/api/account[/*]、/api/avatar、/api/prefs、/api/profile、/api/identity） */
export const SERVICE_API_ROUTES = API_ROUTES;

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
    const denied = await identityDenial(request, auth);
    let res = denied || (await route(request, e, ctx, auth, SERVICE_API_ROUTES));
    if (isApi && !denied) res = await withV6Renewal(request, e, auth, res);
    return tagRuntime(isApi ? withNoStore(res) : res);
  } catch (err) {
    console.error('[sgx-account] service unhandled: ' + (err && /** @type {any} */ (err).name ? /** @type {any} */ (err).name : 'error'));
    return tagRuntime(apiError(500, 'internal'));
  }
}

/**
 * v6 新会话的滑动续期（P2，定稿 v4 §六：admit 只读，剩余不足一半才续写，每会话每天至多一次；救援永不续）：
 * 只在这次请求已经算过路由级 v6 结论、结论说该续（renew）时才写；响应自己设过 sgx-session（su / exit / lock）就不碰；5xx 不碰。
 * @param {Request} request @param {Record<string, any>} env @param {any} auth @param {Response} res
 * @returns {Promise<Response>}
 */
export async function withV6Renewal(request, env, auth, res) {
  if (!res || res.status >= 500 || !auth || typeof auth.v6Computed !== 'function') return res;
  const p = auth.v6Computed();
  if (!p) return res;
  const v = await p;
  if (!v || v.allowed !== true || v.renew !== true || !v.sessionId) return res;
  const sets = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('Set-Cookie') || ''];
  if (sets.some((c) => c.startsWith(SESSION_COOKIE + '='))) return res;
  const cookie = await renewV6Session(env, v.sessionId, readCookie(request, SESSION_COOKIE));
  if (!cookie) return res;
  const out = new Response(res.body, res);
  out.headers.append('Set-Cookie', cookie);
  return out;
}

/** 网关转发入口（服务绑定 ACCOUNT） */
export class AccountService extends WorkerEntrypoint {
  /** @param {Request} request */
  async fetch(request) {
    return serviceFetch(request, this.env, this.ctx);
  }
}
