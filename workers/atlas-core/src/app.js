/**
 * @fileoverview styrigx-atlas-core：内容层接口 Worker（Atlas 后端合并，2026-11-14 设计稿第一项）。
 *
 * 奇趣（src/curio/，原 workers/curio-core/src）、日刻（src/daymark/，原 workers/daymark-core/src）两份代码原样平移，
 * 本文件只按公开地址前缀分流，不碰各自的访问档、守卫、路由表：
 *   /curio/api/*   → src/curio/app.js（X-Curio-Runtime）
 *   /daymark/api/* → src/daymark/index.js（X-Daymark-Runtime）
 *   其他           → 404（带 X-Atlas-Runtime）
 * 公开路径不变，前端无感。两份代码在旧 Worker 下线（设计稿第 7 步）前要和旧目录逐字一致，
 * tests/workers/atlas-core/core.test.mjs 核对；改业务代码时两边一起改。
 */
import curio, { runHourly as runCurioHourly } from './curio/app.js';
import daymark from './daymark/index.js';
import { rebuildSearchIndex as rebuildDaymarkIndex } from './daymark/search-index.js';

const NO_STORE = 'private, no-store';
const HSTS = 'max-age=31536000';

/** 公开地址的前缀 → 归哪个产品；不是 Atlas 的接口返回 '' */
export function productOf(pathname) {
  const p = String(pathname || '');
  if (p.startsWith('/curio/api/')) return 'curio';
  if (p.startsWith('/daymark/api/')) return 'daymark';
  return '';
}

function notFound() {
  return new Response(JSON.stringify({ ok: false, error: 'not-found' }), {
    status: 404,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': NO_STORE,
      'X-Atlas-Runtime': 'worker',
      'X-Content-Type-Options': 'nosniff',
      'Strict-Transport-Security': HSTS,
    },
  });
}

/**
 * 每小时任务：先奇趣（搜索索引兜底 + 清扫时段的照片清扫），再日刻（搜索索引兜底）。
 * 一边失败不影响另一边；返回各自结果。
 * @param {Record<string, any>} env @param {number} at
 */
export async function runHourly(env, at) {
  const out = { curio: true, daymark: true };
  try { await runCurioHourly(env, at); } catch (e) { out.curio = false; console.error('[atlas] curio hourly failed', e && /** @type {any} */ (e).name); }
  try { await rebuildDaymarkIndex(env, Date.now(), { skipUnchanged: true }); } catch (e) { out.daymark = false; console.error('[atlas] daymark hourly failed', e && /** @type {any} */ (e).name); }
  return out;
}

export default {
  /**
   * @param {Request} request
   * @param {Record<string, any>} env
   * @param {{ waitUntil(p: Promise<any>): void }} ctx
   */
  async fetch(request, env, ctx) {
    const product = productOf(new URL(request.url).pathname);
    if (product === 'curio') return curio.fetch(request, env, ctx);
    if (product === 'daymark') return daymark.fetch(request, env, ctx);
    return notFound();
  },

  /** Cron 入口（不挂 Cron，每小时由 status 调 HourlyJob；这里留给手动触发） */
  async scheduled(controller, env, ctx) {
    const p = runHourly(env, Number(controller && controller.scheduledTime) || Date.now());
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
    await p;
  },
};
