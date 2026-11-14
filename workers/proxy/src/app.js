/**
 * 默认 handler：fetch（路径分发在 router.js）+ scheduled（每 6 小时刷新代理订阅，wrangler.toml 的 crons）。
 */
import { route } from './router.js';
import { runRefresh } from './core/sub/pipeline.js';
import { dbReady } from './core/sub/store.js';

export default {
  async fetch(request, env, ctx) {
    return route(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    if (!dbReady(env)) return;
    ctx.waitUntil(runRefresh(env).then((r) => {
      if (!r.ok) console.log('[proxy-rules] refresh: ' + r.error);
      else console.log('[proxy-rules] refresh: ' + r.sources.map((s) => s.name + '=' + (s.ok ? s.nodes : s.error)).join(' '));
    }));
  },
};
