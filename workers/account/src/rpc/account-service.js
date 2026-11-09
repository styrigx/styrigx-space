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
import { headerAuth, lockIdentityDenial } from '../gate.js';
import { withNoStore, apiError } from '../lib/http.js';
import { resolveSecrets } from '../secrets.js';

/** AccountService 的接口路由表（= router.js API_ROUTES：/api/account[/*]、/api/avatar、/api/prefs、/api/profile、/api/wellbeing） */
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
    const denied = lockIdentityDenial(request, auth.identity);
    const res = denied || (await route(request, e, ctx, auth, SERVICE_API_ROUTES));
    return tagRuntime(isApi ? withNoStore(res) : res);
  } catch (err) {
    console.error('[sgx-account] service unhandled: ' + (err && /** @type {any} */ (err).name ? /** @type {any} */ (err).name : 'error'));
    return tagRuntime(apiError(500, 'internal'));
  }
}

/** 网关转发入口（服务绑定 ACCOUNT） */
export class AccountService extends WorkerEntrypoint {
  /** @param {Request} request */
  async fetch(request) {
    return serviceFetch(request, this.env, this.ctx);
  }
}
