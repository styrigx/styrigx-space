/**
 * @fileoverview 账号 Worker 的门（纵深防御的最小检查；门本身在网关 workers/space-core/src/gate.js：
 * 无身份 /api/* 401、头像文件公开）。
 * v6 P4（定稿 v5.2 §十三）起只认 v6 会话（sgx-session）：旧进站会话的身份头（X-Styrigx-Space-*）和旧账号会话（sgx-account-session）
 * 连同作用域授权（core/authorize.js）一并删除，服务端不再接受旧 cookie。
 * 能做什么由 v6 会话 + 路由档决定（core/admit.js admitRoute → core/groups.js permits）。
 * 调用方：rpc/account-service.js serviceFetch。
 */
import { json, apiError } from './lib/http.js';
import { admitRoute } from './core/admit.js';
import { SESSION_COOKIE } from './core/identity-session.js';
import { readCookie } from './lib/cookies.js';

/**
 * 按 v6 会话回答（context.auth）。
 * - v6(action?)：v6 会话（sgx-session）对这条路由（给了 action 就按那个 action）的放行结论（core/admit.js admitRoute；判断只经
 *   core/groups.js permits）。没带 sgx-session → 不查库，{ allowed:false, reason:'no-cookie' }。同一请求、同一 action 只查一次。
 * - dataUid()：这个请求的数据归谁（ADR-0006 §2.12 (a)：uid 只取服务端会话，绝不取客户端参数 / 查询串 / 请求头 / 请求体）：
 *   v6 会话放行 → 会话里的 uid；否则 null。
 * @param {Request} request
 * @param {Record<string, any>} env 已换好密钥字符串的 env
 */
export function headerAuth(request, env) {
  /** @type {Record<string, Promise<any>>} */
  const v6P = {};
  const hasV6 = !!readCookie(request, SESSION_COOKIE);
  let pathname = '';
  try { pathname = new URL(request.url).pathname; } catch (e) {}
  const p = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const self = {
    /** 请求带没带 v6 会话 cookie */
    hasV6,
    /** @param {string} [action] */
    v6(action) {
      const k = typeof action === 'string' ? 'a:' + action : '-';
      if (!v6P[k]) {
        v6P[k] = hasV6
          ? admitRoute(env, request, String(request.method || 'GET').toUpperCase(), p, undefined, typeof action === 'string' ? { action } : undefined)
          : Promise.resolve({ allowed: false, reason: 'no-cookie', uid: null, root: false, rescue: false, renew: false, groups: [], name: '', via: '', level: null });
      }
      return v6P[k];
    },
    /** 已经算过的路由级 v6 结论（续期用；没算过 → null，不为续期多查一次库） */
    v6Computed() {
      return v6P['-'] || null;
    },
    /** @returns {Promise<number|null>} */
    async dataUid() {
      const v = await self.v6();
      return v && v.allowed === true && Number.isInteger(v.uid) ? v.uid : null;
    },
  };
  return self;
}

/**
 * v6 会话 + 路由档（/api/avatar、/api/prefs、/api/profile 写的门）：放行 → null；否则 401 session。
 * v6 P4 起旧会话的作用域（avatar.write / prefs.sync / profile.write）删除，档只在路由表（core/route-access.js）。
 * @param {ReturnType<typeof headerAuth>} auth context.auth
 * @param {string} [_scope] 旧作用域名（不再使用，调用方签名不变）
 * @param {Record<string, string>} [headers] 错误响应的额外头（头像接口要 no-store）
 * @returns {Promise<Response|null>}
 */
export async function scopeDenial(auth, _scope, headers) {
  if (auth && auth.hasV6 && typeof auth.v6 === 'function') {
    const v = await auth.v6();
    if (v && v.allowed === true && Number.isInteger(v.uid)) return null;
  }
  return apiError(401, 'session', undefined, headers);
}

/**
 * 不要身份的接口（方法 + 路径，精确匹配）。必须是网关访问表（workers/space-core/src/gate.js ROUTE_ACCESS）里
 * 转发到本 Worker 的 public 条目的同一份；tests/workers/account/service.test.mjs 核对两边一致。
 */
export const PUBLIC_API = Object.freeze(['POST /api/identity', 'GET /api/profile']);

/**
 * 纵深防御的最小门（门本身在网关 src/gate.js 访问表，结论相同）：/api/* 不在 PUBLIC_API 里、又没有一个 v6 身份够这条路由的档 → 401 {ok:false}；
 * 放行 → null。头像文件 /avatar/* 不要身份。
 * @param {Request} request @param {ReturnType<typeof headerAuth>} auth
 * @returns {Promise<Response|null>}
 */
export async function identityDenial(request, auth) {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith('/api/')) return null;
  const p = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (PUBLIC_API.includes(String(request.method || 'GET').toUpperCase() + ' ' + p)) return null;
  if (auth && auth.hasV6) {
    const v = await auth.v6();
    if (v && v.allowed === true && Number.isInteger(v.uid)) return null; /* 要真有一个 v6 身份：坏 cookie 不算 */
  }
  return json(401, { ok: false });
}
