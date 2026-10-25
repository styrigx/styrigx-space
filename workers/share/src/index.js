/**
 * @fileoverview styrigx-share：分享短链 Worker 入口（2026-10-24，照账号 Worker styrigx-account 的拆法）。
 *
 * - GET / HEAD /s/<码>（谁都能开）：open.js —— 普通短链只 302；带临时会话的请网关签访客会话后 302（去掉码）
 * - POST /api/share（只许管理员 + 账号会话）：api/share.js —— 列表 / 生成 / 作废
 *   三个子站顶栏的分享按钮跨源调它：OPTIONS 预检在门之前回（预检不带 cookie），每个 /api/* 响应补 CORS 头（lib/cors.js）
 * 数据：D1 styrigx-share（绑定 D1_SHARE_LINK，migrations/）。不持任何钥匙、不绑认证库：
 * - 会话判断问网关 AuthVerifier（服务绑定 AUTH，和账号 Worker 同一份 auth.js）
 * - 签 / 作废短链钥匙、换访客会话问网关 ShareIssuer（服务绑定 ISSUER）；临时钥匙和会话的逻辑只在网关里一份
 * 路由（wrangler.toml）：styrigx.com/s/*、styrigx.com/api/share*，比网关的 styrigx.com/* 更具体。
 * 每个响应打 X-SGX-Runtime: share（不含敏感信息），部署后冒烟据此确认路径真的进了本 Worker。
 */
import { authFor } from './auth.js';
import { gate } from './gate.js';
import { withNoStore, apiError } from './lib/http.js';
import { applyMainSiteHeaders } from './lib/security-headers.js';
import { SHARE_PATH_RE } from './lib/links.js';
import { openShare, failResponse } from './open.js';
import { preflight, withCors } from './lib/cors.js';
import * as share from './api/share.js';

export const RUNTIME = 'share';

/** @type {Map<string, Record<string, Function>>} */
export const API_ROUTES = new Map([['/api/share', share]]);

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

/** /api/share/ 与 /api/share 等价（同网关） */
export function routeKey(pathname) {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

/** 同网关：onRequest<Method> 优先，其次 onRequest */
export function pickHandler(mod, method) {
  if (!mod) return null;
  const m = String(method || 'GET').toUpperCase();
  if (!METHODS.includes(m)) return null;
  const name = 'onRequest' + m.charAt(0) + m.slice(1).toLowerCase();
  if (typeof mod[name] === 'function') return mod[name];
  if (typeof mod.onRequest === 'function') return mod.onRequest;
  return null;
}

/** 路由只登记了 /s/* 和 /api/share*；万一进来别的路径，按网关的规矩回源，不在这里出页面 @param {Request} req @param {any} env */
export function fromOrigin(req, env) {
  if (env && env.ASSETS && typeof env.ASSETS.fetch === 'function') return env.ASSETS.fetch(req);
  return fetch(new Request(req, { redirect: 'manual' }));
}

/** @param {Response} res */
export function tagRuntime(res) {
  /* 安全响应头和网关主站同一套（_kernel/security-headers.js，2026-10-25 PR D）；Referrer-Policy 已设过的（/s/<码> 的 no-referrer）不覆盖 */
  const out = applyMainSiteHeaders(res);
  out.headers.set('X-SGX-Runtime', RUNTIME);
  return out;
}

/** 门放行后的去向 */
export async function route(request, env, ctx, auth) {
  const url = new URL(request.url);
  const m = SHARE_PATH_RE.exec(url.pathname);
  if (m) return openShare(request, env, ctx, auth, m[1]);
  if (url.pathname.startsWith('/api/')) {
    const key = routeKey(url.pathname);
    const mod = API_ROUTES.get(key);
    if (!mod) return apiError(404, 'not-found');
    const handler = pickHandler(mod, request.method);
    if (!handler) return apiError(405, 'method');
    return handler({ request, env, auth, params: {}, data: {}, functionPath: key,
      waitUntil: (p) => { if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p); } });
  }
  return fromOrigin(request, env);
}

export default {
  /**
   * @param {Request} request
   * @param {Record<string, any>} env
   * @param {{ waitUntil(p: Promise<any>): void }} ctx
   */
  async fetch(request, env, ctx) {
    let isApi = false;
    let isOpen = false;
    try {
      isOpen = SHARE_PATH_RE.test(new URL(request.url).pathname);
      const pathname = new URL(request.url).pathname;
      isApi = pathname.startsWith('/api/');
      if (isApi && request.method === 'OPTIONS' && routeKey(pathname) === '/api/share') return tagRuntime(preflight(request));
      const auth = authFor(request, env);
      const denied = await gate(request, env, auth);
      const res = denied || (await route(request, env, ctx, auth));
      return tagRuntime(isApi ? withCors(withNoStore(res), request) : res);
    } catch (e) {
      console.error('[sgx-share] unhandled: ' + (e && /** @type {any} */ (e).name ? /** @type {any} */ (e).name : 'error'));
      /* /s/<码> 出错也只回统一的失败响应，不露 500 */
      if (isOpen) return tagRuntime(failResponse());
      return tagRuntime(isApi ? withCors(apiError(500, 'internal'), request) : apiError(500, 'internal'));
    }
  },
};
