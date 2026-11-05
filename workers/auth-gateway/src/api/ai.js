/**
 * @fileoverview /api/ai：站内对话助手的门（P4-1，方案 5.3）。回答本身在 styrigx-ai（workers/ai），只经服务绑定 AI_SERVICE 进去。
 *
 * POST /api/ai { q, lang, history } → styrigx-ai POST /ask，SSE 原样流回（状态码、Content-Type、X-Styrigx-AI-Scope 不改）。
 * 顺序：
 *   1. 只接受同源 POST（lib/http.js isSameOrigin）→ 否则 403 origin；别的方法 405 method（router 的 pickHandler）
 *   2. 要进门（锁屏会话，不分进门方式）→ 否则 401 unauthorized。不要账号会话：没有账号会话也能问，只是只召回公开内容
 *   3. AI 限流（core/ai-limit.js）：每 IP 每分钟 6 次 → 429 cooldown；全站总闸每分钟 60 次 → 429 busy（D1 出错也 busy）
 *   4. 问账号 Worker 要授权结论（core/account-rpc.js askAuthorizeFor），写账号结论头（core/conclusion.js writeAccountConclusion：
 *      有账号会话才写 X-Styrigx-Account-Session: 1 等；没有 / 出错 → 不写 = 只给公开内容）
 *   5. 转给 AI_SERVICE：新建的请求只带 Content-Type 和结论头，不转 cookie、不转浏览器的任何别的头（浏览器伪造的
 *      X-Styrigx-Account-* 在 app.js 第一步已剥掉，这里也不会带过去）；带上浏览器请求的 signal，断开时一起取消
 * 请求体最多 BODY_MAX 字节（超了 413 too-large；styrigx-ai 自己再校验 q / history）。
 * 网关这边的错误：403 origin · 401 unauthorized · 429 cooldown / busy · 413 too-large · 400 bad_request（读不出请求体）·
 *   503 upstream（没绑 AI_SERVICE）· 502 upstream（调 styrigx-ai 抛错）。
 *
 * GET /api/ai（P4-2）：可选模型列表 → styrigx-ai GET /models，JSON 原样回（{ ok, default, models, canChoose }）。
 *   要进门（否则 401）；不计 AI 限流（只读 KV，不调模型）；同样写账号结论头（canChoose 跟它走：只有账号会话能切模型）。
 *   POST 的 body.model 由 styrigx-ai 只在有账号结论头时采纳（进站一律默认模型）。
 */
import { lockSessionOf } from '../core/lock-session.js';
import { askAuthorizeFor } from '../core/account-rpc.js';
import { writeAccountConclusion } from '../core/conclusion.js';
import { aiIpLimit, aiGlobalGate } from '../core/ai-limit.js';
import { isSameOrigin, originDenied, apiError, NO_STORE } from '../lib/http.js';

/** 服务绑定的地址：主机名只用来拼 URL，路径是 styrigx-ai 认的 */
const AI_BASE = 'https://styrigx-ai';
export const BODY_MAX = 16 * 1024;

/** @param {{request: Request, env: any, data?: any}} context */
export async function onRequestPost(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return apiError(405, 'method');
  if (!isSameOrigin(request)) return originDenied();
  const sess = await lockSessionOf(context);
  if (!sess.ok) return apiError(401, 'unauthorized');

  const ipLimited = await aiIpLimit(request, env);
  if (ipLimited) return ipLimited;

  let body;
  try { body = await request.arrayBuffer(); } catch (e) { return apiError(400, 'bad_request'); }
  if (body.byteLength > BODY_MAX) return apiError(413, 'too-large');

  const svc = env && env.AI_SERVICE;
  if (!svc || typeof svc.fetch !== 'function') return apiError(503, 'upstream');

  const busy = await aiGlobalGate(env);
  if (busy) return busy;

  const account = await askAuthorizeFor(request, env);
  const headers = writeAccountConclusion(new Headers({ 'Content-Type': 'application/json' }), account);
  let res;
  try {
    res = await svc.fetch(new Request(AI_BASE + '/ask', { method: 'POST', headers, body, signal: request.signal }));
  } catch (e) {
    console.error('[ai] service failed', e && /** @type {any} */ (e).name);
    return apiError(502, 'upstream');
  }
  const out = new Headers(res.headers);
  out.set('Cache-Control', NO_STORE);
  return new Response(res.body, { status: res.status, headers: out });
}

/** @param {{request: Request, env: any, data?: any}} context */
export async function onRequestGet(context) {
  const { request, env } = context;
  const sess = await lockSessionOf(context);
  if (!sess.ok) return apiError(401, 'unauthorized');
  const svc = env && env.AI_SERVICE;
  if (!svc || typeof svc.fetch !== 'function') return apiError(503, 'upstream');
  const account = await askAuthorizeFor(request, env);
  const headers = writeAccountConclusion(new Headers(), account);
  let res;
  try {
    res = await svc.fetch(new Request(AI_BASE + '/models', { method: 'GET', headers }));
  } catch (e) {
    console.error('[ai] models failed', e && /** @type {any} */ (e).name);
    return apiError(502, 'upstream');
  }
  const out = new Headers(res.headers);
  out.set('Cache-Control', NO_STORE);
  return new Response(res.body, { status: res.status, headers: out });
}
