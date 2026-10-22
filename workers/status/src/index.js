/**
 * @fileoverview styrigx-status 入口（2026-10-22）。
 *   scheduled：Cron 每分钟一轮检查（src/monitor.js runOnce）
 *   fetch：只接网关服务绑定转来的 GET /summary（没有公开地址，见 wrangler.toml）
 *     → 200 { ok, now, today, all_up, sites: [...], incidents: [...] }（字段见 monitor.js summary）
 *     503 { ok:false, error:'db' } 库不可用
 */
import { runOnce, summary } from './monitor.js';

/** @param {number} status @param {any} body */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' },
  });
}

export default {
  /** @param {Request} request @param {any} env */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/summary') return json(404, { ok: false, error: 'not-found' });
    if (request.method !== 'GET') return json(405, { ok: false, error: 'method' });
    try {
      return json(200, await summary(env.STATUS_DB, Date.now()));
    } catch (e) {
      console.error('[status] summary failed', e && /** @type {any} */ (e).message);
      return json(503, { ok: false, error: 'db' });
    }
  },

  /** @param {{scheduledTime:number}} event @param {any} env @param {{waitUntil:(p:Promise<any>)=>void}} ctx */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runOnce(env, event.scheduledTime || Date.now()).catch((e) => {
        console.error('[status] run failed', e && /** @type {any} */ (e).message);
      }),
    );
  },
};
