/**
 * @fileoverview /api/status：站点监测数据（2026-10-22），给主站监测页和首页长条模块用。
 *
 * 网关只做门：验锁屏会话（admin / visitor 都能看；没会话 401），再通过服务绑定 STATUS 转给 styrigx-status Worker。
 * styrigx-status 没有公开地址，只能从这里进。
 *
 *   GET /api/status
 *   → 200 { ok, now, today, all_up, sites: [...], incidents: [...], usage, usage_reason, quota, quota_reason }
 *     （字段见 workers/status/src/monitor.js summary、src/usage.js、src/quota.js；原样转发，网关不缓存）
 *   401 没会话 · 503 监测服务不可用（没绑定 / 出错）
 */
import { verifyLockSession } from '../_kernel/lock-session.js';
import { apiError, NO_STORE } from '../../../shared/http.js';


/** @param {number} status @param {any} body */
/** @param {{request: Request, env: any}} ctx */
export async function onRequestGet({ request, env }) {
  const sess = await verifyLockSession(request, env);
  if (!sess.ok) return apiError(401, 'unauthorized');
  const svc = env && env.STATUS;
  if (!svc || typeof svc.fetch !== 'function') return apiError(503, 'upstream');
  try {
    const res = await svc.fetch(new Request('https://styrigx-status/summary', { method: 'GET' }));
    const body = await res.text();
    return new Response(body, {
      status: res.status === 200 ? 200 : 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': NO_STORE },
    });
  } catch (e) {
    console.error('[status] upstream failed', e && /** @type {any} */ (e).name);
    return apiError(503, 'upstream');
  }
}
