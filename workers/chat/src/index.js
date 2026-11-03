/**
 * @fileoverview styrigx-chat 入口（2026-10-22 从网关拆出来）。只接网关服务绑定 CHAT 转来的请求（没有公开地址，见 wrangler.toml）。
 *
 *   GET  https://styrigx-chat/models → 模型列表（网关 GET /api/chat）
 *   POST https://styrigx-chat/chat   → SSE 回答（网关 POST /api/chat）
 *   不验身份（P2-2 起删掉了旧角色头这道检查）：门只在网关（同源 + 锁屏会话 + 账号会话，方案 2.3.1），
 *   本 Worker 没有公开地址（wrangler.toml：workers_dev / preview_urls 关，没有路由和域名），只有网关的服务绑定 CHAT 进得来。
 *   GET  https://styrigx-chat/healthz → 健康检查（2026-10-28；只给 styrigx-status 的服务绑定 CHAT 每分钟测，网关只转 /models 和 /chat，进不来）：
 *     钥匙读得到且 API 地址可用 → 200 { ok: true }；否则 503 { ok: false, error: 'no_key' }。不调上游、不花模型额度，不回钥匙。
 *     不要求任何身份（回答里也没有任何东西）。
 *   其他路径 → 404 not-found；方法不对 → 405 method。
 *   开始回答之前抛出的意外错误 → 500 { ok:false, error:'internal' }（JSON，不带堆栈；日志只记错误类型），不让 Cloudflare 回它的错误页。
 * 具体逻辑见 src/chat.js。
 */
import { handleChat, handleHealthz, handleModels, json } from './chat.js';

export default {
  /** @param {Request} request @param {any} env */
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/healthz') {
        if (request.method !== 'GET') return json(405, { ok: false, error: 'method' });
        return await handleHealthz(env);
      }
      if (url.pathname !== '/models' && url.pathname !== '/chat') return json(404, { ok: false, error: 'not-found' });
      if (url.pathname === '/models') {
        if (request.method !== 'GET') return json(405, { ok: false, error: 'method' });
        return handleModels(env);
      }
      if (request.method !== 'POST') return json(405, { ok: false, error: 'method' });
      return await handleChat(request, env);
    } catch (e) {
      console.error('[chat] unexpected error', e && /** @type {any} */ (e).name);
      return json(500, { ok: false, error: 'internal' });
    }
  },
};
