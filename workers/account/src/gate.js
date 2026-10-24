/**
 * @fileoverview 账号 Worker 的门：照搬网关 middleware（workers/auth-gateway/functions/_middleware.js）对这几条路径的判断，
 * 一条不少、一条不松。会话本身由网关验（auth.js → SessionVerifier RPC），这里只按结论放行或拒绝。
 *
 * 生产（SGX_ENV=production）：
 * - 只认 styrigx.com：别的域名的 /api/* → 403，页面路径 → 301 到 styrigx.com（路由只登记了 styrigx.com，正常进不来）
 * - 访客调主人接口（/api/prefs）→ 403 role；认证类 action（verify/challenge/register/auth）照网关放过去，由接口自己再验
 * - 有会话 → 放行（接口里再按角色 / 账号会话细分）
 * - 没会话：头像文件 /avatar/<32|96|192|512>.webp 和静态后缀公开放行；/api/* → 401 {ok:false}；其他 → 302 到首页锁屏
 * 非生产（本地 / 单测不设 SGX_ENV）：和网关一样不拦，接口自己验。
 */
import { ROLE_VISITOR } from './auth.js';

const HOST = 'styrigx.com';
/* 主人专属 API（visitor 调用 → 403）：网关 OWNER_ONLY_APIS 里属于本 Worker 的那条 */
const OWNER_ONLY_APIS = ['/api/prefs'];
/* 认证类 action（网关 AUTH_ACTIONS） */
const AUTH_ACTIONS = new Set(['verify', 'challenge', 'register', 'auth']);
/* 网关 isWhitelisted 里对 /avatar/* 起作用的两条 */
const AVATAR_FILE_RE = /^\/avatar\/(32|96|192|512)\.webp$/;
const STATIC_RE = /\.(css|js|woff2|woff|ttf|png|svg|ico|json|xml|webmanifest)$/i;

/** @param {string} pathname */
export function isOwnerOnlyApi(pathname) {
  return OWNER_ONLY_APIS.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

/** 没会话也放行的路径（只有头像文件；/api/* 在本 Worker 里没有白名单） @param {string} pathname */
export function isPublic(pathname) {
  if (pathname.startsWith('/api/')) return false;
  return AVATAR_FILE_RE.test(pathname) || STATIC_RE.test(pathname);
}

function jsonRes(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

/**
 * @param {Request} request
 * @param {Record<string, any>} env
 * @param {{ session: () => Promise<{ok:boolean, role:string|null}> }} auth
 * @returns {Promise<Response|null>} 拒绝时的响应；null = 放行
 */
export async function gate(request, env, auth) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const isProd = (env && env.SGX_ENV === 'production') || url.hostname === HOST;
  if (!isProd) return null;
  if (url.hostname !== HOST) {
    if (pathname.startsWith('/api/')) return new Response('Forbidden', { status: 403 });
    url.protocol = 'https:';
    url.hostname = HOST;
    url.port = '';
    return Response.redirect(url.toString(), 301);
  }
  const sess = await auth.session();
  if (sess.role === ROLE_VISITOR && isOwnerOnlyApi(pathname)) {
    let isAuthAction = false;
    if (request.method === 'POST') {
      try {
        const body = await request.clone().json();
        isAuthAction = !!(body && AUTH_ACTIONS.has(body.action));
      } catch (e) {}
    }
    if (!isAuthAction) return jsonRes(403, { ok: false, error: 'role' });
  }
  if (sess.ok) return null;
  if (isPublic(pathname)) return null;
  if (pathname.startsWith('/api/')) return jsonRes(401, { ok: false });
  const dest = 'https://styrigx.com/?lock=1&return=' + encodeURIComponent(url.pathname + url.search);
  return new Response(null, {
    status: 302,
    headers: { 'Location': dest, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  });
}
