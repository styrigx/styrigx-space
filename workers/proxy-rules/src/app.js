/**
 * 默认 handler：只有 fetch。路径分发在 router.js。
 */
import { route } from './router.js';

export default {
  async fetch(request, env, ctx) {
    return route(request, env, ctx);
  },
};
