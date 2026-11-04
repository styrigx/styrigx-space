/**
 * @fileoverview styrigx-daymark-core：日刻接口 Worker（路由 styrigx.com/daymark/api/*，过渡期兼 atlas.styrigx.com/daymark/api/*，见 wrangler.toml）。
 *
 * 数据接口都在这里，D1（D1_QUOTES）只绑在本 Worker 上；Pages 只放静态文件。
 * 本 Worker 不持任何钥匙：会话交给主站鉴权网关验（服务绑定 AUTH，见 src/api/_auth.js）。
 *
 * 请求顺序（下面的 /api/* 都是去掉 /daymark 前缀后的路径，公开地址是 styrigx.com/daymark/api/*）：
 *   1. GET /api/today：今日一句，主站首页 / 锁屏跨站调用的公开只读接口（带 CORS），不验会话；只给北京时间的今天（?d= 别的日期 400），
 *      边缘缓存最多 60 秒、不跨过换天（见 api/today.js）；
 *      PUT /api/today（余响「设为今日」）和其他写接口一样先问网关，接口里再要账号会话 + daymark.write + 同源
 *   2. 其余 /api/*：先问网关要结论（AUTH.conclusion()，方案 4.6）；没进门 → 401 unauthorized（不 302，fetch 不跟跳转）。
 *      结论放进 context.data.conclusion，handler 用 conclusionOf(context) 直接取，每个请求只问网关一次。
 *   3. 按路由表交给 src/api/<路径>.js；读私密（私密句子、随手一笔）要账号会话（account.ok），
 *      写要账号会话 + 作用域 daymark.write + 同源（_auth.js requireScope）
 * 不在路由表里的路径 → 404；方法不支持 → 405。
 *
 * 全站搜索索引（src/search-index.js）：写接口成功后用 ctx.waitUntil 重建 KV site:daymark；
 * Cron（wrangler.toml [triggers]）每小时兜底重建，内容没变不写 KV。重建出错只打日志，不影响接口响应。
 */
import { API_ROUTES } from './routes.js';
import { askConclusion } from './api/_auth.js';
import { rebuildSearchIndex, isMutation } from './search-index.js';
import { purgeTodayCache } from './api/today.js';

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
const NO_STORE = 'private, no-store';

/** /api/quotes/ 与 /api/quotes 等价（Pages 也这样匹配） */
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

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': NO_STORE },
  });
}

/** 公开接口（不验会话）：只有 /api/today 的读（GET / HEAD / OPTIONS） */
export function isPublic(pathname, method = 'GET') {
  return routeKey(pathname) === '/api/today' && ['GET', 'HEAD', 'OPTIONS'].includes(String(method || 'GET').toUpperCase());
}

/** 找处理模块：{ mod, params, functionPath } 或 null */
export function resolve(pathname) {
  const key = routeKey(pathname);
  const mod = API_ROUTES.get(key);
  return mod ? { mod, params: {}, functionPath: key } : null;
}

function makeContext(request, env, ctx, params, functionPath, conclusion) {
  return {
    request,
    env,
    params,
    data: conclusion ? { conclusion, conclusionReauth: false } : {},
    functionPath,
    waitUntil: (p) => { if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p); },
    passThroughOnException: () => {},
    next: async () => json(404, { ok: false, error: 'not-found' }),
  };
}

/* 接口直接由本 Worker 回答，不经过网关，网关加的 HSTS 到不了这里：自己补（值同主站网关，1 年、不带 includeSubDomains） */
const HSTS = 'max-age=31536000';

/**
 * 响应打上 X-Daymark-Runtime: worker，部署后能从外部确认接口真的走了本 Worker（不含敏感信息）；
 * 统一补 X-Content-Type-Options: nosniff 和 Strict-Transport-Security（公开的 /api/today 也一样）。
 */
function tag(res) {
  const out = new Response(res.body, res);
  out.headers.set('X-Daymark-Runtime', 'worker');
  out.headers.set('X-Content-Type-Options', 'nosniff');
  out.headers.set('Strict-Transport-Security', HSTS);
  return out;
}

/** 本站在主域名（styrigx.com；旧图志 atlas.styrigx.com 同一前缀）下的前缀：接口公开地址是 {BASE}/api/*，路由表按去掉前缀后的 /api/* 登记 */
export const BASE = '/daymark';

/** 公开地址 → 路由表里的路径（/daymark/api/x → /api/x）；不是本站接口返回 '' */
export function apiPath(pathname) {
  return pathname.startsWith(BASE + '/api/') ? pathname.slice(BASE.length) : '';
}

export async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = apiPath(url.pathname);
  if (!path) return json(404, { ok: false, error: 'not-found' });

  let conclusion = null;
  if (!isPublic(path, request.method)) {
    conclusion = await askConclusion(request, env);
    if (!conclusion.lock.ok) return json(401, { ok: false, error: 'unauthorized' });
  }

  const hit = resolve(path);
  if (!hit) return json(404, { ok: false, error: 'not-found' });
  const handler = pickHandler(hit.mod, request.method);
  if (!handler) return json(405, { ok: false, error: 'method' });
  const res = await handler(makeContext(request, env, ctx, hit.params, hit.functionPath, conclusion));
  /* 设为今日不改句子本身，不用重建搜索索引（它自己清今日缓存） */
  if (res && isMutation(request.method, res.status) && hit.functionPath !== '/api/today') {
    scheduleRebuild(env, ctx);
    /* 句子被删 / 改私密 / 改了字：今天那句可能跟着变，清掉本机房的今日边缘缓存 */
    const purge = purgeTodayCache(request);
    if (purge && ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(purge);
  }
  return res;
}

/** 写接口成功后，响应先回，索引在后台重建（rebuildSearchIndex 自己吞错） */
function scheduleRebuild(env, ctx) {
  try {
    const p = rebuildSearchIndex(env);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
  } catch (e) {
    console.error('[daymark-search] schedule failed');
  }
}

export default {
  /**
   * @param {Request} request
   * @param {Record<string, any>} env
   * @param {{ waitUntil(p: Promise<any>): void }} ctx
   */
  async fetch(request, env, ctx) {
    try {
      return tag(await handle(request, env, ctx));
    } catch (e) {
      console.error('[daymark-core] unhandled: ' + (e && e.name ? e.name : 'error'));
      return tag(json(500, { ok: false, error: 'internal' }));
    }
  },

  /**
   * Cron 兜底：每小时重建一次搜索索引（首次部署后也靠它填上）；内容和 KV 里那份一样就不写（省账号共享的 KV 写额度）。
   * @param {any} controller
   * @param {Record<string, any>} env
   * @param {{ waitUntil(p: Promise<any>): void }} ctx
   */
  async scheduled(controller, env, ctx) {
    const p = rebuildSearchIndex(env, Date.now(), { skipUnchanged: true });
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
    await p;
  },
};
