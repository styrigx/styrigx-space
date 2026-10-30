/**
 * @fileoverview styrigx-account：账号 Worker 的路由表与默认 fetch（账号拆分 PR3：完整的账号系统）。
 *
 * 管管理员账号的全部身份和数据：
 * - 账号身份：POST / GET /api/account（identity/account.js：账号密码、账号 Passkey、设备、账号会话 / reauth / reset、
 *   账号根密钥 SGX_ACCOUNT_ROOT_KEY、账号审计）
 * - 头像：GET /avatar/<尺寸>.webp（公开）、PUT / DELETE /api/avatar（只许管理员）→ KV_PROFILE
 * - 设置云同步：GET / POST /api/prefs（管理员 + 账号会话）→ D1_SETTINGS_SYNC
 * - 数字健康：POST / GET /api/wellbeing → D1_WELLBEING
 *
 * 请求只经网关进来（浏览器 → 网关验锁屏、剥外部 x-styrigx-* 头、写规范身份头 → 服务绑定 ACCOUNT → 命名入口 AccountService，
 * 见 entrypoints.js）。本 Worker 没有任何公开路由（wrangler.toml 无 [[routes]]、workers_dev = false、preview_urls = false），
 * 默认导出的 fetch 一律 404（方案第 3 节第二道保险：即使线上残留公开路由，伪造的头也碰不到任何接口）。
 *
 * 默认头像（没上传过）：读 Pages 上的静态文件 static/avatar/<尺寸>.webp。生产没有 env.ASSETS，发子请求到同一地址
 * （Worker 发往同一 zone 的子请求不再进任何 Worker，直接到 Pages）。
 *
 * 每个响应打 X-SGX-Runtime: account（不含敏感信息）：网关转发时保留，部署后冒烟据此确认路径真的进了本 Worker。
 * 部署入口是 worker.js（wrangler.toml 的 main）：默认导出就是这里的 default，另导出命名入口 AccountService / AccountVerifier（entrypoints.js）。
 */
import { apiError } from './lib/http.js';
import { applyMainSiteHeaders } from './lib/security-headers.js';
import * as avatar from './api/avatar.js';
import * as avatarFile from './api/avatar-file.js';
import * as prefs from './api/prefs.js';
import * as wellbeing from './api/wellbeing.js';
import * as account from './identity/account.js';

export const RUNTIME = 'account';

/** 接口路由表（只经 AccountService 用；网关转发表 workers/auth-gateway/src/forwarding.js 里的 /api/* 路径与这里一一对应） */
/** @type {Map<string, Record<string, Function>>} */
export const API_ROUTES = new Map([
  ['/api/account', account],
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
  /* 安全响应头和网关主站同值（本 Worker 自己的 lib/security-headers.js，gen-csp 与网关那份一起生成，单测核对同值）；Referrer-Policy 已设过的不覆盖 */
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

/**
 * AccountService 放行后的去向（entrypoints.js serviceFetch 调）。
 * routes：接口路由表，默认 API_ROUTES。
 */
export async function route(request, env, ctx, auth, routes = API_ROUTES) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) {
    const key = routeKey(url.pathname);
    const mod = routes.get(key);
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
  /* 网关只转发表里的路径；别的路径不在这里出页面，也不回源 */
  return apiError(404, 'not-found');
}

/**
 * 默认 fetch：一律 404（方案第 3 节第二道保险）。本 Worker 只经命名入口 AccountService（网关的服务绑定 ACCOUNT）处理请求；
 * 公网（残留路由、*.workers.dev 等）进来的请求碰不到任何接口，也不读任何 x-styrigx-* 头。
 */
export default {
  /** @param {Request} _request */
  async fetch(_request) {
    return tagRuntime(apiError(404, 'not-found'));
  },
};
