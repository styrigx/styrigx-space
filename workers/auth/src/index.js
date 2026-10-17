/**
 * @fileoverview styrigx-auth-gateway：主站鉴权 Worker 入口。
 *
 * 承接 styrigx.com/api/*（PR3 起整体切流），代码直接复用 functions/（不复制、不改写）：
 *   1. Secrets Store 的私密值换成字符串（secrets.js）
 *   2. 先跑主站原有的 functions/_middleware.js（会话、角色、白名单、no-store 全部照旧）
 *   3. middleware 放行后，按路由表交给 functions/api/<名字>.js
 *
 * 行为与 Pages 上完全一致：同域名（styrigx.com）、同 cookie、同 KV/D1。
 * 不在路由表里的 /api 路径 → 404；方法不支持 → 405。
 */
import { onRequest as middleware } from '../../../functions/_middleware.js';
import { API_ROUTES } from './routes.js';
import { resolveSecrets } from './secrets.js';

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

/** /api/lock/ 与 /api/lock 等价（Pages 也这样匹配） */
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

/** 每个响应都打上 X-SGX-Runtime: worker，切流后能从外部确认请求真的走了 Worker（不含任何敏感信息） */
export function tagRuntime(res) {
  const out = new Response(res.body, res);
  out.headers.set('X-SGX-Runtime', 'worker');
  return out;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** 交给 functions/api 的处理函数（middleware 的 next） */
async function dispatch(request, env, ctx) {
  const url = new URL(request.url);
  const key = routeKey(url.pathname);
  const mod = API_ROUTES.get(key);
  if (!mod) return json(404, { ok: false, error: 'not-found' });
  const handler = pickHandler(mod, request.method);
  if (!handler) return json(405, { ok: false, error: 'method' });
  return handler(makeContext(request, env, ctx, key, () => json(404, { ok: false, error: 'not-found' })));
}

function makeContext(request, env, ctx, functionPath, next) {
  return {
    request,
    env,
    params: {},
    data: {},
    functionPath,
    waitUntil: (p) => { if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p); },
    passThroughOnException: () => {},
    next: async (input, init) => {
      const req = input === undefined ? request : (input instanceof Request ? input : new Request(input, init));
      return next(req);
    },
  };
}

export default {
  /**
   * @param {Request} request
   * @param {Record<string, any>} rawEnv
   * @param {{ waitUntil(p: Promise<any>): void }} ctx
   */
  async fetch(request, rawEnv, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      /* 这个 Worker 只接 /api/*；别的路径不该路由过来 */
      return tagRuntime(json(404, { ok: false, error: 'not-found' }));
    }
    const env = await resolveSecrets(rawEnv);
    try {
      return tagRuntime(await middleware(makeContext(request, env, ctx, '/', (req) => dispatch(req, env, ctx))));
    } catch (e) {
      console.error('[sgx-auth] unhandled: ' + (e && e.name ? e.name : 'error'));
      return tagRuntime(json(500, { ok: false, error: 'internal' }));
    }
  },
};
