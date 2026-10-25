/**
 * @fileoverview 分享短链 Worker 的门（照账号 Worker src/gate.js 的写法）。
 *
 * 生产（SGX_ENV=production）：
 * - 只认 styrigx.com：别的域名的 /api/* → 403，其他 → 301 到 styrigx.com（路由只登记了 styrigx.com，正常进不来）
 * - /s/<码>：谁都能打开（码就是凭证），不在这里拦，由 open.js 处理
 * - /api/share*：只许管理员。访客 → 403 role（同网关 ADMIN_ONLY_APIS；这里没有认证类 action）；没会话 → 401 {ok:false}
 *   接口里还要账号会话（api/share.js）
 * 非生产（本地 / 单测不设 SGX_ENV）：不拦，接口自己验（同账号 Worker）。
 */
import { ROLE_ADMIN } from './auth.js';
import { SHARE_PATH_RE } from './lib/links.js';

const HOST = 'styrigx.com';

function jsonRes(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

/**
 * @param {Request} request
 * @param {Record<string, any>} env
 * @param {{ lockSession: () => Promise<{ok:boolean, role:string|null}> }} auth
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
  if (SHARE_PATH_RE.test(pathname)) return null;
  if (pathname.startsWith('/api/')) {
    const sess = await auth.lockSession();
    if (!sess.ok) return jsonRes(401, { ok: false });
    if (sess.role !== ROLE_ADMIN) return jsonRes(403, { ok: false, error: 'role' });
    return null;
  }
  return null;
}
