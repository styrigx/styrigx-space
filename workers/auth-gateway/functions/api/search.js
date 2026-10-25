/**
 * @fileoverview /api/search：全站搜索（2026-10-22）。四个站（styrigx.com、blog、daymark、curio）同一个接口。
 *
 * 网关只做门：验锁屏会话（admin / visitor 都能搜；没会话 401），再通过服务绑定 SEARCH 转给 styrigx-search-index Worker，
 * 带上角色头 X-Sgx-Role（私密条目只给 admin）。styrigx-search-index 没有公开地址，角色头只可能是这里写的。
 *
 *   GET /api/search?q=…&lang=zh|en&site=space|blog|daymark|curio&limit=1..50
 *   → 200 { ok, q, hits: [{ site, type, title, subtitle, url }] }
 *   401 没会话 · 400 参数 · 503 搜索服务不可用（没绑定 / 出错）
 */
import { ROLE_ADMIN } from '../_kernel/lock-session.js';
import { verifyLockSession } from '../_kernel/lock-session.js';
import { json, apiError, NO_STORE } from '../_kernel/http.js';


/** @param {number} status @param {any} body */
/** @param {{request: Request, env: any}} ctx */
export async function onRequestGet({ request, env }) {
  const sess = await verifyLockSession(request, env);
  if (!sess.ok) return apiError(401, 'unauthorized');
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length > 100) return apiError(400, 'too-long');
  if (!q) return json(200, { ok: true, q: '', hits: [] });
  const svc = env && env.SEARCH;
  if (!svc || typeof svc.fetch !== 'function') return apiError(503, 'upstream');
  const fwd = new URL('https://styrigx-search-index/search');
  fwd.searchParams.set('q', q);
  for (const k of ['lang', 'site', 'limit']) {
    const v = url.searchParams.get(k);
    if (v) fwd.searchParams.set(k, v.slice(0, 16));
  }
  try {
    const res = await svc.fetch(new Request(fwd.toString(), {
      method: 'GET',
      headers: { 'X-Sgx-Role': sess.role === ROLE_ADMIN ? 'admin' : 'visitor' },
    }));
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': NO_STORE },
    });
  } catch (e) {
    console.error('[search] upstream failed', e && /** @type {any} */ (e).name);
    return apiError(503, 'upstream');
  }
}
