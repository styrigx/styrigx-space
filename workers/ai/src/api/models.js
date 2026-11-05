/**
 * @fileoverview GET /models：可选模型列表（P4-2）。网关 GET /api/ai 转进来（P4-2d 更正：不是 /api/ai/models），账号页「AI 模型」一行（apps/account-ai.js）用它画选项。
 * 200 { ok: true, default, models: [{ id, label, provider }], canChoose }
 *   canChoose = 这次请求带账号结论头（X-Styrigx-Account-Session: 1）：只有登了账号才能切，进站只用默认模型。
 * 只读 KV（core/models.js），不调模型、不读钥匙。
 */
import { loadModels, publicModels } from '../core/models.js';
import { json } from '../lib/http.js';
import { ACCOUNT_SESSION_HEADER } from './ask.js';

/** @param {Request} request @param {any} env */
export async function onRequestGet(request, env) {
  const reg = await loadModels(env);
  return json(200, { ok: true, ...publicModels(reg), canChoose: request.headers.get(ACCOUNT_SESSION_HEADER) === '1' });
}
