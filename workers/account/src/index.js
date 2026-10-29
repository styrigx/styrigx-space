/**
 * @fileoverview styrigx-account：账号数据 Worker 入口（2026-10-24 从鉴权网关拆出来）。
 *
 * 管三样东西，都是「管理员账号名下的数据」：
 * - 头像：GET /avatar/<尺寸>.webp（公开）、PUT / DELETE /api/avatar（只许管理员）→ KV_PROFILE（styrigx-account 里的 avatar:*）
 * - 设置云同步（外观 / 主题 / 时区天气 / 搜索引擎等）：GET / POST /api/prefs（管理员 + 账号会话）→ D1_SETTINGS_SYNC（D1 styrigx-account 的 settings_sync）
 * - 数字健康：POST / GET /api/wellbeing → D1_WELLBEING（D1 styrigx-account 的 wb_daily）
 *
 * 前端地址不变：本 Worker 在 styrigx.com 上挂了比网关 styrigx.com/* 更具体的路由（wrangler.toml），这几条路径直接进这里。
 * 会话不在这里验：门（gate.js，照搬网关 middleware）和接口都问网关的 AuthVerifier（auth.js，服务绑定 AUTH）。
 *
 * 默认头像（没上传过）：读 Pages 上的静态文件 static/avatar/<尺寸>.webp。生产没有 env.ASSETS，发子请求到同一地址
 * （Worker 发往同一 zone 的子请求不再进任何 Worker，直接到 Pages，和网关以前回源一样）。
 *
 * 每个响应打 X-SGX-Runtime: account（不含敏感信息），部署后冒烟据此确认路径真的进了本 Worker。
 */
import { authFor } from './auth.js';
import { gate } from './gate.js';
import { withNoStore, apiError } from './lib/http.js';
import { applyMainSiteHeaders } from './lib/security-headers.js';
import * as avatar from './api/avatar.js';
import * as avatarFile from './api/avatar-file.js';
import * as prefs from './api/prefs.js';
import * as wellbeing from './api/wellbeing.js';

export const RUNTIME = 'account';

/** @type {Map<string, Record<string, Function>>} */
export const API_ROUTES = new Map([
  ['/api/avatar', avatar],
  ['/api/prefs', prefs],
  ['/api/wellbeing', wellbeing],
]);

/** /avatar/<文件名>（不认识的尺寸由处理函数回 404） */
export const AVATAR_PATH_RE = /^\/avatar\/([^/]+)$/;

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

/** /api/prefs/ 与 /api/prefs 等价（同网关） */
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

/**
 * 回源取静态文件（默认头像、不支持的方法）。有 env.ASSETS（测试）就直接读；否则发子请求，由 Pages 回。
 * @param {Request} req
 * @param {Record<string, any>} env
 */
export function fromOrigin(req, env) {
  if (env && env.ASSETS && typeof env.ASSETS.fetch === 'function') return env.ASSETS.fetch(req);
  return fetch(new Request(req, { redirect: 'manual' }));
}

function withAssets(env) {
  if (env.ASSETS && typeof env.ASSETS.fetch === 'function') return env;
  return Object.assign({}, env, {
    ASSETS: { fetch: (input, init) => fromOrigin(new Request(input, init), env) },
  });
}

/** @param {Response} res */
export function tagRuntime(res) {
  /* 安全响应头和网关主站同一套（workers/shared/security-headers.js，2026-10-25 PR D）；Referrer-Policy 已设过的（/s/<码> 的 no-referrer）不覆盖 */
  const out = applyMainSiteHeaders(res);
  out.headers.set('X-SGX-Runtime', RUNTIME);
  return out;
}

function makeContext(request, env, ctx, auth, functionPath, params) {
  return {
    request,
    env,
    auth,
    params: params || {},
    data: {},
    functionPath,
    waitUntil: (p) => { if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p); },
  };
}

/** 门放行后的去向 */
export async function route(request, env, ctx, auth) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) {
    const key = routeKey(url.pathname);
    const mod = API_ROUTES.get(key);
    if (!mod) return apiError(404, 'not-found');
    const handler = pickHandler(mod, request.method);
    if (!handler) return apiError(405, 'method');
    return handler(makeContext(request, env, ctx, auth, key));
  }
  const m = AVATAR_PATH_RE.exec(url.pathname);
  if (m) {
    const handler = pickHandler(avatarFile, request.method);
    if (!handler) return fromOrigin(request, env); /* 只有 GET 有处理函数，其他方法落到静态文件（同网关） */
    return handler(makeContext(request, withAssets(env), ctx, auth, '/avatar/[file]', { file: m[1] }));
  }
  /* 路由只登记了上面几条；万一进来别的路径，按网关的规矩回源，不在这里出页面 */
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
    try {
      isApi = new URL(request.url).pathname.startsWith('/api/');
      const auth = authFor(request, env);
      const denied = await gate(request, env, auth);
      const res = denied || (await route(request, env, ctx, auth));
      return tagRuntime(isApi ? withNoStore(res) : res);
    } catch (e) {
      console.error('[sgx-account] unhandled: ' + (e && /** @type {any} */ (e).name ? /** @type {any} */ (e).name : 'error'));
      return tagRuntime(apiError(500, 'internal'));
    }
  },
};
