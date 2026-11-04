/**
 * @fileoverview /api/search：全站搜索（2026-10-22）。四个站（styrigx.com、blog、daymark、curio）同一个接口。
 *
 * 网关只做门：验锁屏会话（进了门都能搜；没会话 401），再问账号 Worker 要授权结论（core/account-rpc.js askAuthorizeFor），
 * 通过服务绑定 SEARCH 转给 styrigx-search-index Worker，带上账号结论头（core/conclusion.js writeAccountConclusion：
 * 有账号会话才写 X-Styrigx-Account-Session: 1 等，私密条目只给账号会话；方案 2.3.1、3.4 R14）。
 * styrigx-search-index 没有公开地址，结论头只可能是这里写的。
 *
 *   GET /api/search?q=…&lang=zh|en&site=space|blog|daymark|curio&limit=1..50
 *   → 200 { ok, q, hits: [{ site, type, title, subtitle, url }] }
 *   401 没会话 · 400 参数 · 503 搜索服务不可用（没绑定 / 出错）
 */
import { lockSessionOf } from '../core/lock-session.js';
import { askAuthorizeFor } from '../core/account-rpc.js';
import { writeAccountConclusion } from '../core/conclusion.js';
import { json, apiError, NO_STORE } from '../lib/http.js';


/** @param {{request: Request, env: any, data?: any}} context */
export async function onRequestGet(context) {
  const { request, env } = context;
  const sess = await lockSessionOf(context);
  if (!sess.ok) return apiError(401, 'unauthorized');
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length > 100) return apiError(400, 'too-long');
  if (!q) return json(200, { ok: true, q: '', hits: [] });
  const svc = env && env.SEARCH;
  if (!svc || typeof svc.fetch !== 'function') return apiError(503, 'upstream');
  const fwd = new URL('https://styrigx-search-index/search');
  fwd.searchParams.set('q', q);
  for (const k of ['lang', 'site', 'limit']) {
    const v = url.searchParams.get(k);
    if (v) fwd.searchParams.set(k, v.slice(0, 16));
  }
  /* 账号结论：进了门才问；没有 / 出错 → 不写结论头（= 没有账号会话，不给私密） */
  const account = await askAuthorizeFor(request, env);
  const headers = writeAccountConclusion(new Headers(), account);
  try {
    const res = await svc.fetch(new Request(fwd.toString(), { method: 'GET', headers }));
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': NO_STORE },
    });
  } catch (e) {
    console.error('[search] upstream failed', e && /** @type {any} */ (e).name);
    return apiError(503, 'upstream');
  }
}
