/**
 * @fileoverview styrigx-curio-core：奇趣接口 Worker（路由 styrigx.com/curio/api/*，见 wrangler.toml）。
 *
 * 数据接口都在这里，D1（D1_FINDS / D1_DEVICES / D1_GAMES / D1_MOVIES / D1_MUSIC，同一个库）和 R2（R2_PHOTOS：图标缓存、导入原文备份、设备照片、电影海报；
 * R2_MUSIC：私人音乐的音频和封面，同一个桶的 music/ 前缀）只绑在本 Worker 上；Pages 只放静态文件。
 * 本 Worker 不持任何钥匙：会话交给主站鉴权网关验（服务绑定 SPACE，见 src/api/_auth.js）。
 *
 * 请求顺序（下面的 /api/* 都是去掉 /curio 前缀后的路径，公开地址是 styrigx.com/curio/api/*）：
 *   1. 访问档（v5 S3）：routes.js ROUTE_ACCESS 按「方法 + 路径」给出 public / entry / music（不在表里 = entry），
 *      在这里套上那一档的守卫（api/_auth.js GUARDS：publicRead / requireEntry / requireMusic），entry / music 档在守卫里问网关（SPACE.conclusion()，方案 4.6；
 *      POST /api/import 这一问带上 reauth: true，见 REAUTH_ROUTES），public 档要私密行 / canWrite 的 handler 自己问；每个请求最多问一次。没进门 → 401 unauthorized（不 302，fetch 不跟跳转）。
 *      结论放进 context.data.conclusion，handler 用 conclusionOf(context) 直接取。
 *   2. 按路由表交给 src/api/<路径>.js；读私密要账号会话（account.ok），写要账号会话 + 作用域 curio.write + 同源（handler 里查）；
 *      音乐：歌单 / 封面公开（不含音频地址），听要进站（播放令牌 + /api/music-stream），上传 / 管理要 music 档，批量导入另要账号复验
 * 不在路由表里的路径 → 404；方法不支持 → 405。
 *
 * 全站搜索：改内容的写接口成功后 ctx.waitUntil 重建 KV site:curio；每小时兜底（status 的 Cron 经服务绑定调 rpc/hourly-job.js），见 src/search-index.js。
 */
import { API_ROUTES, accessOf } from './routes.js';
import { GUARDS } from './api/_auth.js';
import { rebuildSearchIndex, isContentMutation } from './search-index.js';
import { sweepPhotos, isSweepHour } from './photo-sweep.js';

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
const NO_STORE = 'private, no-store';

/** /api/links/ 与 /api/links 等价（Pages 也这样匹配） */
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

/** 要账号复验结论的接口（网关那一问带 reauth: true，账号侧多读一张票）：方法 + 路由表路径 */
export const REAUTH_ROUTES = new Set(['POST /api/import']);

/** 这个请求要不要复验结论 */
export function wantsReauth(pathname, method) {
  return REAUTH_ROUTES.has(String(method || 'GET').toUpperCase() + ' ' + routeKey(pathname));
}

/** 找处理模块：{ mod, params, functionPath } 或 null */
export function resolve(pathname) {
  const key = routeKey(pathname);
  const mod = API_ROUTES.get(key);
  return mod ? { mod, params: {}, functionPath: key } : null;
}

function makeContext(request, env, ctx, params, functionPath) {
  return {
    request,
    env,
    params,
    data: {},
    functionPath,
    waitUntil: (p) => { if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p); },
    passThroughOnException: () => {},
    next: async () => json(404, { ok: false, error: 'not-found' }),
  };
}

/* 接口直接由本 Worker 回答，不经过网关，网关加的 HSTS 到不了这里：自己补（值同主站网关，1 年、不带 includeSubDomains） */
const HSTS = 'max-age=31536000';

/**
 * 响应打上 X-Curio-Runtime: worker，部署后能从外部确认接口真的走了本 Worker（不含敏感信息）；
 * 统一补 X-Content-Type-Options: nosniff 和 Strict-Transport-Security。
 */
function tag(res) {
  const out = new Response(res.body, res);
  out.headers.set('X-Curio-Runtime', 'worker');
  out.headers.set('X-Content-Type-Options', 'nosniff');
  out.headers.set('Strict-Transport-Security', HSTS);
  return out;
}

/** 本站在主域名 styrigx.com 下的前缀：接口公开地址是 {BASE}/api/*，路由表按去掉前缀后的 /api/* 登记 */
export const BASE = '/curio';

/** 公开地址 → 路由表里的路径（/curio/api/x → /api/x）；不是本站接口返回 '' */
export function apiPath(pathname) {
  return pathname.startsWith(BASE + '/api/') ? pathname.slice(BASE.length) : '';
}

export async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = apiPath(url.pathname);
  if (!path) return json(404, { ok: false, error: 'not-found' });

  const hit = resolve(path);
  const context = makeContext(request, env, ctx, hit ? hit.params : {}, hit ? hit.functionPath : path);
  /* 先过访问档（不在路由表里的路径也是 entry：没进门 401，进了门才 404，不让陌生人探路由表） */
  const denied = await GUARDS[accessOf(request.method, path)](context, { reauth: wantsReauth(path, request.method) });
  if (denied) return denied;
  if (!hit) return json(404, { ok: false, error: 'not-found' });
  const handler = pickHandler(hit.mod, request.method);
  if (!handler) return json(405, { ok: false, error: 'method' });
  const res = await handler(context);
  if (res && isContentMutation(hit.functionPath, request.method, res.status) && ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(rebuildSearchIndex(env));
  }
  return res;
}

/**
 * 每小时任务（2026-11-10 起由 styrigx-status 的 Cron 经服务绑定调 rpc/hourly-job.js，本 Worker 不再自带 Cron；scheduled 保留给手动 / 本地触发）。
 * 兜底重建：内容和 KV 里那份一样就不写（省账号共享的 KV 写额度）；清扫时段顺带清照片。
 * @param {Record<string, any>} env @param {number} at
 */
export function runHourly(env, at) {
  const jobs = [rebuildSearchIndex(env, Date.now(), { skipUnchanged: true })];
  if (isSweepHour(at)) jobs.push(sweepPhotos(env, at).catch(() => {}));
  return Promise.all(jobs);
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
      console.error('[curio-core] unhandled: ' + (e && e.name ? e.name : 'error'));
      return tag(json(500, { ok: false, error: 'internal' }));
    }
  },

  /**
   * Cron 入口（2026-11-10 起 wrangler.toml 不再挂 Cron，每小时由 status 调 HourlyJob；这里保留给手动触发）：每小时兜底重建全站搜索索引（内容没变不写 KV）；每天一次（UTC 19 点那轮）顺带清扫没人引用的照片（src/photo-sweep.js）。出错只打日志。
   * @param {any} controller
   * @param {Record<string, any>} env
   * @param {{ waitUntil(p: Promise<any>): void }} ctx
   */
  async scheduled(controller, env, ctx) {
    const at = controller && controller.scheduledTime ? Number(controller.scheduledTime) : Date.now();
    const p = runHourly(env, at);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
    await p;
  },
};
