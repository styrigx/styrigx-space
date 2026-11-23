/**
 * 默认 handler：fetch（路径分发在 router.js）+ scheduled（每 6 小时刷新代理订阅，wrangler.toml 的 crons）。
 */
import { route } from './router.js';
import { runRefresh } from './core/sub/pipeline.js';
import { dbReady } from './core/sub/store.js';

/** 入口兜底（报告修复 PR 5，2026-11-23）：handler 抛错只记错误名，回 500 JSON，不泄栈 */
const internal = () => new Response(JSON.stringify({ ok: false, error: 'internal' }), {
  status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      console.error('[proxy] fetch failed', e && /** @type {any} */ (e).name);
      return internal();
    }
  },
  async scheduled(controller, env, ctx) {
    if (!dbReady(env)) return;
    ctx.waitUntil(runRefresh(env).then((r) => {
      if (!r.ok) console.log('[proxy] refresh: ' + r.error);
      else console.log('[proxy] refresh: ' + r.sources.map((s) => s.name + '=' + (s.ok ? s.nodes : s.error)).join(' '));
    }));
  },
};
