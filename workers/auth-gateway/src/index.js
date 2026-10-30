/**
 * @fileoverview styrigx-auth-gateway：主站鉴权 Worker 入口。
 *
 * 承接 styrigx.com 整站（路由 styrigx.com/*，见 wrangler.toml）：/api/*、全部页面。
 * fetch 第一步剥掉入站请求里所有 x-styrigx-* 和旧的 x-sgx-role（主站、子站回源、静态直通都剥；方案第 3 节第一道保险）。
 * 客户端上下文（IP、cf 国家城市）从原请求取（_kernel/forward.js clientContextOf），放进 middleware context.data.clientContext。
 * 账号（/api/account、/api/prefs*、/api/avatar*、/api/wellbeing*、/avatar/*）：middleware 放行后按转发表 src/forwarding.js
 * 经服务绑定 ACCOUNT（styrigx-account / AccountService）转发，写全套身份头（forwardToService）；账号的响应保留 X-SGX-Runtime: account。
 * 转发表里的路径只转发：没绑定 ACCOUNT 或绑定出错 → 503 upstream。
 * 静态资源目录（MAIN_STATIC_PREFIXES）第一行就原样回源，不验会话、不改响应。
 * 子站（blog.styrigx.com、daymark.styrigx.com、curio.styrigx.com）的页面会话检查也在这里（src/subsites.js），子站 Pages 不持钥匙。
 * 主站的后端代码只在这里（workers/auth-gateway/functions/），Pages 只放静态文件：
 *   1. Secrets Store 的私密值换成字符串（secrets.js）
 *   2. 先跑 functions/_middleware.js（会话、角色、白名单、no-store、锁屏瘦身）
 *   3. middleware 放行后：
 *      - /api/*：按路由表交给 functions/api/<名字>.js
 *      - 其他（页面）：回源取静态文件
 *
 * 回源：生产上发子请求到同一地址（Worker 发往自己路由的子请求不会再进 Worker，直接到 Pages）；
 * passkey-e2e 预览把本文件打包成 Pages 的 _worker.js，这时有 env.ASSETS，直接读静态文件。
 * 不在路由表里的 /api 路径 → 404；方法不支持 → 405。
 * 静态资源（/css/ /js/ /fonts/ /fav/ /images/ 和根目录几张公开图）整站通配路由下也进 Worker，但第一行就原样回源（isMainStaticPassthrough），不验会话。
 *
 * 安全响应头（workers/auth-gateway/functions/_kernel/lib/security-headers.js，2026-10-25 PR D）：
 *   - 主站经过网关的每个响应（页面、锁屏首页、所有 302/301、/api/*、500）→ applyMainSiteHeaders
 *     （HSTS、nosniff、X-Frame-Options、Referrer-Policy、Permissions-Policy、只含非脚本指令的强制 CSP、完整的 Report-Only CSP）
 *   - 子站经过网关的响应（页面、302 到锁屏、401）→ applySubsiteHeaders（HSTS + 低风险的几项，没有才补；完整 CSP 各自审计后再加）
 *   - 子站静态资源直通 → applySubsiteStaticHeaders（只补 HSTS、nosniff）
 *   - 原样回源的静态资源不改（不打 X-SGX-Runtime 也不加头），由 Pages 的 _headers 加同一套
 */
import { onRequest as middleware } from '../functions/_middleware.js';
import { API_ROUTES } from './routes.js';
import { resolveSecrets } from './secrets.js';
import { subsiteFor, handleSubsite, isStaticAsset as isSubsiteStaticAsset } from './subsites.js';
import { applyMainSiteHeaders, applySubsiteHeaders, applySubsiteStaticHeaders } from '../functions/_kernel/lib/security-headers.js';
import { apiError } from '../functions/_kernel/lib/http.js';
import { verifyLockSession } from '../functions/_kernel/lock-session.js';
import { matchForwarding, forwardToService, stripRequest, clientContextOf } from './forwarding.js';

/* 主站静态资源目录：内容带指纹或公开（css/js/字体/收藏图标），不含任何正文。
   2026-10-21 路由改成整站通配前这些路径不过 Worker；现在进来也原样回源，行为不变。 */
export const MAIN_STATIC_PREFIXES = ['/css/', '/js/', '/fonts/', '/fav/', '/images/'];

/* 根目录公开文件：路由改成整站通配后它们也进了 Worker（#159），这里同样原样回源、不打标记。
   只放这些：内容公开且固定（robots、标签页图标 ico / svg、分享卡片图 og.png，2026-10-21）；
   sitemap.xml / files-index.json 列出页面地址，仍走网关。 */
export const MAIN_PUBLIC_ROOT_FILES = new Set(['/robots.txt', '/favicon.ico', '/favicon.svg', '/og.png']);

/** @param {URL} url */
export function isMainStaticPassthrough(url) {
  if (url.hostname !== 'styrigx.com') return false;
  if (MAIN_PUBLIC_ROOT_FILES.has(url.pathname)) return true;
  return MAIN_STATIC_PREFIXES.some((p) => url.pathname.startsWith(p));
}

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

/** /api/lock-now/ 与 /api/lock-now 等价（Pages 也这样匹配） */
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

/** 账号 Worker 写的运行时标记：转发回来的响应保留，不覆盖成 worker（部署冒烟据此确认请求真的进了账号 Worker） */
const ACCOUNT_RUNTIME = 'account';

/** 每个响应都打上 X-SGX-Runtime: worker，切流后能从外部确认请求真的走了 Worker（不含任何敏感信息）；账号转发的响应保留 account */
export function tagRuntime(res) {
  const out = new Response(res.body, res);
  if (out.headers.get('X-SGX-Runtime') !== ACCOUNT_RUNTIME) out.headers.set('X-SGX-Runtime', 'worker');
  return out;
}

/**
 * 转发给账号（转发表 src/forwarding.js）。路径不在转发表里 → null（调用方按 /api/* 路由表或回源处理）。
 * 在表里就只转发：没有这条绑定或绑定抛错 → 503 upstream（不落回网关路由表、不回源静态文件）。
 * 锁屏会话用 middleware 验过的结论（data.lockSession）；没有（非生产 middleware 不验）就在这里验一次。
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
  const lockSession = d.lockSession !== undefined ? d.lockSession : await verifyLockSession(request, env);
  const clientContext = d.clientContext || clientContextOf(request);
  try {
    return await forwardToService(svc, request, lockSession, clientContext);
  } catch (e) {
    console.error('[sgx-auth] forward ' + rule.binding + ' failed: ' + (e && /** @type {any} */ (e).name ? /** @type {any} */ (e).name : 'error'));
    return apiError(503, 'upstream');
  }
}

/** 交给 functions/api 的处理函数（middleware 的 next） */
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
 * data：middleware 的 context.data（lockSession、clientContext），转发给账号时写身份头用（不重验锁屏会话）。
 */
export async function route(request, env, ctx, data) {
  const fwd = await forward(request, env, data);
  if (fwd) return fwd;
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return dispatch(request, env, ctx, data);
  return fromOrigin(request, env);
}

function makeContext(request, env, ctx, functionPath, next, data) {
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

export default {
  /**
   * @param {Request} request
   * @param {Record<string, any>} rawEnv
   * @param {{ waitUntil(p: Promise<any>): void }} ctx
   */
  async fetch(rawRequest, rawEnv, ctx) {
    /* 第一道保险：客户端上下文先从原请求取，再剥掉所有外来的 x-styrigx-* / x-sgx-role（下游只认网关写的） */
    const clientContext = clientContextOf(rawRequest);
    const request = stripRequest(rawRequest);
    const url0 = new URL(request.url);
    /* 静态资源：原样回源，不验会话、不打 X-SGX-Runtime（与以前不登记路由时一致；子站 CI 冒烟据此确认静态资源不验会话） */
    if (isMainStaticPassthrough(url0)) return fromOrigin(request, rawEnv);
    if (subsiteFor(url0.hostname) && isSubsiteStaticAsset(url0.pathname) && url0.pathname !== '/api/lock-session-check') {
      return applySubsiteStaticHeaders(await fromOrigin(request, rawEnv));
    }
    const env = await resolveSecrets(rawEnv);
    const isSub = !!subsiteFor(url0.hostname);
    const secure = isSub ? applySubsiteHeaders : applyMainSiteHeaders;
    try {
      if (isSub) {
        return secure(tagRuntime(await handleSubsite(request, env, (req) => fromOrigin(req, env))));
      }
      const data = { clientContext };
      const next = (req) => route(req, env, ctx, data);
      return secure(tagRuntime(await middleware(makeContext(request, env, ctx, '/', next, data))));
    } catch (e) {
      console.error('[sgx-auth] unhandled: ' + (e && e.name ? e.name : 'error'));
      return secure(tagRuntime(apiError(500, 'internal')));
    }
  },
};
