/**
 * @fileoverview styrigx-auth-gateway：主站鉴权 Worker 入口。
 *
 * 承接 styrigx.com 整站（路由 styrigx.com/*，见 wrangler.toml）：/api/*、/avatar/*、全部页面；
 * 静态资源目录（MAIN_STATIC_PREFIXES）第一行就原样回源，不验会话、不改响应。
 * 子站（blog.styrigx.com、daymark.styrigx.com）的页面会话检查也在这里（src/subsites.js），子站 Pages 不持钥匙。
 * 主站的后端代码只在这里（workers/auth-gateway/functions/），Pages 只放静态文件：
 *   1. Secrets Store 的私密值换成字符串（secrets.js）
 *   2. 先跑 functions/_middleware.js（会话、角色、白名单、no-store、锁屏瘦身）
 *   3. middleware 放行后：
 *      - /api/*：按路由表交给 functions/api/<名字>.js
 *      - /avatar/<尺寸>.webp：functions/avatar/[file].js（主人上传的头像在 KV，没有就用静态默认图）
 *      - 其他（页面）：回源取静态文件
 *
 * 回源：生产上发子请求到同一地址（Worker 发往自己路由的子请求不会再进 Worker，直接到 Pages）；
 * passkey-e2e 预览把本文件打包成 Pages 的 _worker.js，这时有 env.ASSETS，直接读静态文件。
 * 不在路由表里的 /api 路径 → 404；方法不支持 → 405。
 * 静态资源（/css/ /js/ /fonts/ /fav/）不挂路由，不过 Worker。
 */
import { onRequest as middleware } from '../functions/_middleware.js';
import * as avatarFile from '../functions/avatar/[file].js';
import { API_ROUTES } from './routes.js';
import { resolveSecrets } from './secrets.js';
import { subsiteFor, handleSubsite, isStaticAsset as isSubsiteStaticAsset } from './subsites.js';

/* 主站静态资源目录：内容带指纹或公开（css/js/字体/收藏图标），不含任何正文。
   2026-10-21 路由改成整站通配前这些路径不过 Worker；现在进来也原样回源，行为不变。 */
export const MAIN_STATIC_PREFIXES = ['/css/', '/js/', '/fonts/', '/fav/', '/images/'];

/** @param {URL} url */
/* 根目录公开文件：路由改成整站通配后它们也进了 Worker（#159），这里同样原样回源、不打标记。
   只放这两个：内容公开且固定；sitemap.xml / files-index.json 列出页面地址，仍走网关。 */
export const MAIN_PUBLIC_ROOT_FILES = new Set(['/robots.txt', '/favicon.ico']);

export function isMainStaticPassthrough(url) {
  if (url.hostname !== 'styrigx.com') return false;
  if (MAIN_PUBLIC_ROOT_FILES.has(url.pathname)) return true;
  return MAIN_STATIC_PREFIXES.some((p) => url.pathname.startsWith(p));
}

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

/** /avatar/<文件名>（不认识的尺寸由处理函数回 404） */
export const AVATAR_PATH_RE = /^\/avatar\/([^/]+)$/;

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

/** 头像的默认图要读静态文件（Pages 上的写法是 env.ASSETS.fetch）；生产没有 ASSETS，换成回源 */
function withAssets(env) {
  if (env.ASSETS && typeof env.ASSETS.fetch === 'function') return env;
  return Object.assign({}, env, {
    ASSETS: { fetch: (input, init) => fromOrigin(new Request(input, init)) },
  });
}

/** middleware 放行后的去向 */
export async function route(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return dispatch(request, env, ctx);
  const m = AVATAR_PATH_RE.exec(url.pathname);
  if (m) {
    const handler = pickHandler(avatarFile, request.method);
    if (!handler) return fromOrigin(request, env); /* 只有 GET 有处理函数，其他方法照 Pages 的规则落到静态文件 */
    const c = makeContext(request, withAssets(env), ctx, '/avatar/[file]', () => fromOrigin(request, env));
    c.params = { file: m[1] };
    return handler(c);
  }
  return fromOrigin(request, env);
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
    const url0 = new URL(request.url);
    /* 静态资源：原样回源，不验会话、不打 X-SGX-Runtime（与以前不登记路由时一致；子站 CI 冒烟据此确认静态资源不验会话） */
    if (isMainStaticPassthrough(url0)) return fromOrigin(request, rawEnv);
    if (subsiteFor(url0.hostname) && isSubsiteStaticAsset(url0.pathname) && url0.pathname !== '/api/session-check') {
      return fromOrigin(request, rawEnv);
    }
    const env = await resolveSecrets(rawEnv);
    try {
      if (subsiteFor(url0.hostname)) {
        return tagRuntime(await handleSubsite(request, env, (req) => fromOrigin(req, env)));
      }
      const next = (req) => route(req, env, ctx);
      return tagRuntime(await middleware(makeContext(request, env, ctx, '/', next)));
    } catch (e) {
      console.error('[sgx-auth] unhandled: ' + (e && e.name ? e.name : 'error'));
      return tagRuntime(json(500, { ok: false, error: 'internal' }));
    }
  },
};
