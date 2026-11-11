/**
 * @fileoverview 网关的路由（门放行之后的去向，L2）：
 * - API_ROUTES：/api/<名字> → api/<名字>.js（代替 Pages 的「按文件路由」）。api/ 新增或删除文件时这里要同步，
 *   tests/workers/space-core/auth-worker.test.mjs 会检查两边一致，漏了 CI 会红。/api/layer-status 已删（前端无调用方）。
 * - FORWARDING：转发表（账号拆分 PR3，方案第 4 节），这些路径验完门后经服务绑定原样转给账号 Worker styrigx-account，不在 API_ROUTES 里。
 * - route()：转发表 → /api/* 路由表 → 回源（fromOrigin）。
 * 2026-11-02 Worker 骨架统一：原 src/routes.js、src/forwarding.js 和 src/index.js 里的分发函数合成这一份。
 *
 * 转发表：
 * 放行后经服务绑定原样转给账号 Worker styrigx-account（ACCOUNT = AccountService），网关路由表 router.js 里不再有它们。
 *
 * | 路径            | 绑定    | 进门之后（要不要进站会话只看 gate.js 的访问表 ROUTE_ACCESS）              |
 * |-----------------|---------|---------------------------------------------------------------------------|
 * | /api/account    | ACCOUNT | logout / reauth-clear 账号 Worker 自己放行；其余要账号会话                  |
 * | /api/prefs*     | ACCOUNT | 账号会话 + prefs.sync 在账号 Worker 里查                                    |
 * | /api/avatar*    | ACCOUNT | PUT / DELETE 在账号 Worker 里查账号会话 + avatar.write                      |
 * | /api/wellbeing* | ACCOUNT | GET 公开（合计；明细要账号会话）；POST 要进站（账号未登录时 204）            |
 * | /api/profile*   | ACCOUNT | GET 公开（v6 P2c），PUT 在账号 Worker 里查账号会话 + profile.write / v6 站长 + root |
 * | /api/identity   | ACCOUNT | v6 身份命令（P2）：公开入口，每个 action 的档在账号 Worker 判（permits）       |
 * | /avatar/*       | ACCOUNT | 页面路径，公开                                                              |
 *
 * 匹配（只决定转给谁，不决定能不能进）：/api/* 条目 = 路径本身或其子路径（p 或 p + '/…'；
 * /api/prefsX 这类不转发，落到网关路由表 → 404）；/avatar/ = 前缀。
 * 转发时用浏览器的原请求构造（URL 仍是 styrigx.com、Origin / Cookie 原样，账号侧 isSameOrigin 成立），见 core/forward.js forwardToService。
 * 表里的路径只转发：没绑定 ACCOUNT 或绑定出错 → 503 upstream（router.js forward），不落回网关路由表、不回源静态文件。
 * space/scripts/check-worker-routes.mjs 和单测都读这张表。

 */
import { apiError } from './lib/http.js';
import { forwardToService, clientContextOf } from './core/forward.js';
import * as ai from './api/ai.js';
import * as find from './api/find.js';
import * as geo from './api/geo.js';
import * as spaceAudit from './api/space-audit.js';
import * as status from './api/status.js';

/** @type {Map<string, Record<string, Function>>} */
export const API_ROUTES = new Map([
  ['/api/ai', ai],
  ['/api/find', find],
  ['/api/geo', geo],
  ['/api/space-audit', spaceAudit],
  ['/api/status', status],
]);

/** @typedef {{path:string, binding:string}} ForwardRule */

/** @type {ReadonlyArray<Readonly<ForwardRule>>} */
export const FORWARDING = Object.freeze([
  Object.freeze({ path: '/api/account', binding: 'ACCOUNT' }),
  Object.freeze({ path: '/api/prefs', binding: 'ACCOUNT' }),
  Object.freeze({ path: '/api/avatar', binding: 'ACCOUNT' }),
  Object.freeze({ path: '/api/wellbeing', binding: 'ACCOUNT' }),
  Object.freeze({ path: '/api/profile', binding: 'ACCOUNT' }),
  Object.freeze({ path: '/api/identity', binding: 'ACCOUNT' }),
  Object.freeze({ path: '/avatar/', binding: 'ACCOUNT' }),
]);

/**
 * 这个路径归哪条转发规则；不在表里 → null。
 * @param {string} pathname
 * @returns {Readonly<ForwardRule>|null}
 */
export function matchForwarding(pathname) {
  const p = String(pathname || '');
  for (const r of FORWARDING) {
    if (r.path.endsWith('/') ? p.startsWith(r.path) : (p === r.path || p.startsWith(r.path + '/'))) return r;
  }
  return null;
}

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

/** /api/geo/ 与 /api/geo 等价（Pages 也这样匹配） */
export function routeKey(pathname) {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

/** 按 Pages 规则挑处理函数：onRequest<Method> 优先，其次 onRequest */
export function pickHandler(mod, method) {
  if (!mod) return null;
  const m = String(method || 'GET').toUpperCase();
  if (!METHODS.includes(m)) return null;
  const name = 'onRequest' + m.charAt(0) + m.slice(1).toLowerCase();
  if (typeof mod[name] === 'function') return mod[name];
  if (typeof mod.onRequest === 'function') return mod.onRequest;
  return null;
}

/**
 * 转发给账号（src/router.js 的转发表 FORWARDING）。路径不在转发表里 → null（调用方按 /api/* 路由表或回源处理）。
 * 在表里就只转发：没有这条绑定或绑定抛错 → 503 upstream（不落回网关路由表、不回源静态文件）。
 * @param {Request} request @param {Record<string, any>} env @param {Record<string, any>} [data]
 * @returns {Promise<Response|null>}
 */
export async function forward(request, env, data) {
  const url = new URL(request.url);
  const rule = matchForwarding(url.pathname);
  if (!rule) return null;
  const svc = env && env[rule.binding];
  if (!svc || typeof svc.fetch !== 'function') {
    console.error('[sgx-auth] forward ' + rule.binding + ' not bound');
    return apiError(503, 'upstream');
  }
  const d = data || {};
  const clientContext = d.clientContext || clientContextOf(request);
  try {
    return await forwardToService(svc, request, clientContext);
  } catch (e) {
    console.error('[sgx-auth] forward ' + rule.binding + ' failed: ' + (e && /** @type {any} */ (e).name ? /** @type {any} */ (e).name : 'error'));
    return apiError(503, 'upstream');
  }
}

/** 交给 api 的处理函数（middleware 的 next） */
async function dispatch(request, env, ctx, data) {
  const url = new URL(request.url);
  const key = routeKey(url.pathname);
  const mod = API_ROUTES.get(key);
  if (!mod) return apiError(404, 'not-found');
  const handler = pickHandler(mod, request.method);
  if (!handler) return apiError(405, 'method');
  return handler(makeContext(request, env, ctx, key, () => apiError(404, 'not-found'), data));
}

/**
 * 回源取静态文件。有 env.ASSETS（预览里作为 Pages 的 _worker.js 运行）就直接读；
 * 否则（生产）发子请求到同一地址，由 Pages 回静态文件。
 * redirect: manual —— Pages 的 301/308（补尾斜杠、_redirects）原样交回浏览器。
 * @param {Request} req
 * @param {Record<string, any>} [env]
 */
export function fromOrigin(req, env) {
  if (env && env.ASSETS && typeof env.ASSETS.fetch === 'function') return env.ASSETS.fetch(req);
  return fetch(new Request(req, { redirect: 'manual' }));
}

/**
 * middleware 放行后的去向：转发表 → /api/* 路由表 → 回源。
 * data：middleware 的 context.data（clientContext），转发给账号时写客户端上下文头。
 * v6 P4：分享链接 /s/<码>、/api/share（原 styrigx-share）整套删除（定稿 §二第 19 行）；/s/<码> 现在是普通页面路径，回源由 Pages 回 404。
 */
export async function route(request, env, ctx, data) {
  const fwd = await forward(request, env, data);
  if (fwd) return fwd;
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return dispatch(request, env, ctx, data);
  return fromOrigin(request, env);
}

export function makeContext(request, env, ctx, functionPath, next, data) {
  return {
    request,
    env,
    params: {},
    data: data || {},
    functionPath,
    waitUntil: (p) => { if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p); },
    passThroughOnException: () => {},
    next: async (input, init) => {
      const req = input === undefined ? request : (input instanceof Request ? input : new Request(input, init));
      return next(req);
    },
  };
}
