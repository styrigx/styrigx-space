/**
 * @fileoverview styrigx-chat 入口（2026-10-22 从网关拆出来）。只接网关服务绑定 CHAT 转来的请求（没有公开地址，见 wrangler.toml）。
 *
 *   GET  https://styrigx-chat/models → 模型列表（网关 GET /api/chat）
 *   POST https://styrigx-chat/chat   → SSE 回答（网关 POST /api/chat）
 *   头 X-Sgx-Role: owner（网关验完会话、确认是站长后写的）；没有 / 别的值 → 403 owner_only（双保险：本来也只有网关进得来）。
 *   其他路径 → 404 not-found；方法不对 → 405 method。
 * 具体逻辑见 src/chat.js。
 */
import { handleChat, handleModels, json } from './chat.js';

export default {
  /** @param {Request} request @param {any} env */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/models' && url.pathname !== '/chat') return json(404, { ok: false, error: 'not-found' });
    if (request.headers.get('X-Sgx-Role') !== 'owner') return json(403, { ok: false, error: 'owner_only' });
    if (url.pathname === '/models') {
      if (request.method !== 'GET') return json(405, { ok: false, error: 'method' });
      return handleModels(env);
    }
    if (request.method !== 'POST') return json(405, { ok: false, error: 'method' });
    return handleChat(request, env);
  },
};
