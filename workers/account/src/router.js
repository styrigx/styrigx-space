/**
 * @fileoverview styrigx-account 的路由（AccountService 放行之后的去向）：接口路由表 API_ROUTES 与头像文件 /avatar/<尺寸>.webp。
 *
 * 管站点账号的全部身份和数据：
 * - 账号（api/account/，一个入口一个文件；子路径就是入口名）：GET /api/account（status.js 只读状态）、
 *   POST /api/account/session（sudo root 登录）、/reauth（sudo root reauth）、/reset（sudo root reset，恢复密钥）、
 *   /keys（账号安全：账号密码、账号通行密钥）、/devices（已登录设备）、/grants（应用授权）、
 *   /proxy（代理订阅管理：只验会话 / reauth，经服务绑定 PROXY 转给 styrigx-proxy-rules 的 ProxyAdmin）
 * - 头像：GET /avatar/<尺寸>.webp（公开）、PUT / DELETE /api/avatar（进站会话 + 账号会话 + avatar.write）→ KV_PROFILE
 * - 个人资料（2026-11-07）：GET /api/profile（有进站会话即可）、PUT /api/profile（进站会话 + 账号会话 + profile.write）→ KV_PROFILE 的 profile 键
 * - 设置云同步：GET / POST /api/prefs（进站会话 + 账号会话 + prefs.sync）→ D1_ACCOUNT 的 settings_sync
 * - v6 身份命令（P2）：POST /api/identity（whoami / su / sudo / exit / lock / passwd / passkey / groups / who / useradd / userdel / usermod；
 *   公开入口，每个 action 的档在 core/route-access.js，判断只经 core/groups.js permits）→ D1_ACCOUNT 的 account_users / account_sessions …
 * - 数字健康：POST /api/wellbeing（账号会话 + wellbeing.write 才记）/ GET（有进站会话即可；明细只给账号会话）→ D1_ACCOUNT 的 wb_daily
 *
 * 请求只经网关进来（浏览器 → 网关验锁屏、剥外部 x-styrigx-* 头、写规范身份头 → 服务绑定 ACCOUNT → 命名入口 AccountService，
 * 见 rpc/account-service.js）。默认 fetch（app.js）一律 404，不经这里。
 *
 * 默认头像（没上传过）：读 Pages 上的静态文件 static/avatar/<尺寸>.webp。生产没有 env.ASSETS，发子请求到同一地址
 * （Worker 发往同一 zone 的子请求不再进任何 Worker，直接到 Pages）。
 */
import { apiError } from './lib/http.js';
import * as avatar from './api/avatar.js';
import * as avatarFile from './api/avatar-file.js';
import * as prefs from './api/prefs.js';
import * as profile from './api/profile.js';
import * as wellbeing from './api/wellbeing.js';
import * as identity from './api/identity.js';
import * as accountStatus from './api/account/status.js';
import * as accountSession from './api/account/session.js';
import * as accountReauth from './api/account/reauth.js';
import * as accountReset from './api/account/reset.js';
import * as accountKeys from './api/account/keys.js';
import * as accountDevices from './api/account/devices.js';
import * as accountGrants from './api/account/grants.js';
import * as accountProxy from './api/account/proxy.js';

/** 接口路由表（只经 AccountService 用；网关转发表 workers/space-core/src/router.js FORWARDING 里的 /api/* 路径与这里一一对应） */
/** @type {Map<string, Record<string, Function>>} */
export const API_ROUTES = new Map([
  ['/api/account', accountStatus],
  ['/api/account/session', accountSession],
  ['/api/account/reauth', accountReauth],
  ['/api/account/reset', accountReset],
  ['/api/account/keys', accountKeys],
  ['/api/account/devices', accountDevices],
  ['/api/account/grants', accountGrants],
  ['/api/account/proxy', accountProxy],
  ['/api/avatar', avatar],
  ['/api/prefs', prefs],
  ['/api/profile', profile],
  ['/api/wellbeing', wellbeing],
  ['/api/identity', identity],
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
 * AccountService 放行后的去向（rpc/account-service.js serviceFetch 调）。
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
