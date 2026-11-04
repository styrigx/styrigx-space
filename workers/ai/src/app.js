/**
 * @fileoverview styrigx-ai 默认 handler。没有公开地址（wrangler.toml：workers_dev / preview_urls 关、没有路由），
 * 唯一入口是网关的服务绑定 AI_SERVICE，所以这里没有关口：不验 cookie、不持钥匙；结论头只可能是网关写的。
 */
import { route } from './router.js';
import { apiError } from './lib/http.js';

export default {
  /** @param {Request} request @param {any} env */
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (e) {
      console.error('[ai] unhandled', e && /** @type {any} */ (e).name);
      return apiError(500, 'internal');
    }
  },
};
