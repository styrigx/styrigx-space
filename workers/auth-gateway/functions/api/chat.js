/**
 * @fileoverview /api/chat：主站聊天页（/chat/，2026-10-22）的门。聊天本身在 styrigx-chat（workers/chat，2026-10-22 拆出去）。
 *
 * 网关只做门，再通过服务绑定 CHAT 转给 styrigx-chat，回答原样流回去（状态码、响应头、SSE 一字不改）：
 * - POST 只接受同源（workers/shared/http.js isSameOrigin，同 /api/prefs）→ 否则 403 origin
 * - 锁屏会话：没有 / 无效 → 401 unauthorized；访客（visitor）→ 403 { error: 'admin_only' }（聊天额度是管理员的，访客不能用）
 * 通过后带上 X-Sgx-Role: admin 转进去（styrigx-chat 没有公开地址，这个头只可能是这里写的；不转 cookie）。
 *
 *   GET  /api/chat → styrigx-chat GET /models：200 { ok:true, default:'<id>', models:[{ id, label, search }] }（不看 Origin）
 *   POST /api/chat { messages, model? } → styrigx-chat POST /chat：200 text/event-stream，或 JSON 错误
 *       400 bad_request / bad_model · 503 no_key · 429 rate_limited · 502 model_unavailable / upstream（详见 workers/chat/src/chat.js）
 *   网关这边的错误：401 unauthorized · 403 origin / admin_only · 405 method ·
 *       503 no_key（没绑定 CHAT = 聊天没配置）· 502 upstream（调 styrigx-chat 抛错）
 * 钥匙 SGX_CHAT_API_KEY 和 CHAT_* 变量都只在 styrigx-chat（workers/chat/wrangler.toml），网关不碰。
 */
import { verifyLockSession } from '../_kernel/lock-session.js';
import { ROLE_ADMIN } from '../_kernel/lock-session.js';
import { isSameOrigin, originDenied, json, apiError } from '../../../shared/http.js';

/** 服务绑定的地址：主机名随便写（只用来拼 URL），路径是 styrigx-chat 认的 */
const CHAT_BASE = 'https://styrigx-chat';

/** @param {number} status @param {any} body */
/** 门：会话 + 只许管理员。通过 → null；否则错误响应 @param {Request} request @param {any} env */
async function adminGate(request, env) {
  const sess = await verifyLockSession(request, env);
  if (!sess.ok) return apiError(401, 'unauthorized');
  if (sess.role !== ROLE_ADMIN) return apiError(403, 'admin_only');
  return null;
}

/**
 * 转给 styrigx-chat。响应体（SSE）直接接回去，不缓冲；浏览器断开 → 这条流被取消 → styrigx-chat 那边一起断上游。
 * @param {any} env @param {Request} fwd @param {string} tag
 */
async function forward(env, fwd, tag) {
  const svc = env && env.CHAT;
  if (!svc || typeof svc.fetch !== 'function') return apiError(503, 'no_key');
  let res;
  try {
    res = await svc.fetch(fwd);
  } catch (e) {
    console.error('[chat] ' + tag + ' service failed', e && /** @type {any} */ (e).name);
    return apiError(502, 'upstream');
  }
  return new Response(res.body, { status: res.status, headers: res.headers });
}

/**
 * GET /api/chat：模型列表（页面的模型切换）。不看 Origin（同源 GET 浏览器不带 Origin）。
 * @param {{request: Request, env: any}} ctx
 */
export async function onRequestGet({ request, env }) {
  const denied = await adminGate(request, env);
  if (denied) return denied;
  return forward(env, new Request(CHAT_BASE + '/models', { method: 'GET', headers: { 'X-Sgx-Role': 'admin' } }), 'models');
}

/** @param {{request: Request, env: any}} ctx */
export async function onRequestPost({ request, env }) {
  if (request.method !== 'POST') return apiError(405, 'method');
  if (!isSameOrigin(request)) return originDenied();
  const denied = await adminGate(request, env);
  if (denied) return denied;
  /** @type {Record<string, string>} */
  const headers = { 'X-Sgx-Role': 'admin' };
  const ct = request.headers.get('Content-Type');
  if (ct) headers['Content-Type'] = ct;
  /* 请求体原样转（校验在 styrigx-chat；读不出来 = 坏请求，同以前 request.json() 失败）；
     带上浏览器这条请求的 signal，断开时一起取消 */
  let body;
  try { body = await request.arrayBuffer(); } catch (e) { return apiError(400, 'bad_request'); }
  const init = { method: 'POST', headers, body, signal: request.signal };
  return forward(env, new Request(CHAT_BASE + '/chat', init), 'chat');
}
