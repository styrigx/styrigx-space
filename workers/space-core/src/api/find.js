/**
 * @fileoverview GET /api/find?q=：关键词搜索（v5 S4，Gray 2026-11-10 16:13 定：从 AI 拆出、不走模型、谁都能用）。
 *
 * 公开：gate.js 访问表 ROUTE_ACCESS 里一条「GET /api/find」（不要进站会话；访客 nobody 也能调）。
 * 顺序：
 *   1. q 去空白后为空或超过 FIND_Q_MAX 个字符 → 400 bad_request（不进限流、不调 styrigx-ai）
 *   2. 按 IP 限流（core/find-limit.js FIND_LIMITER）→ 429 cooldown + Retry-After + message
 *   3. 经服务绑定 AI_SERVICE 调 styrigx-ai 的 GET /find（同一份 KV 索引读取代码 core/recall.js loadIndexes，60 秒缓存；不调模型）。
 *      新建的内部请求只带 q 和 lang：不转 cookie、不写账号结论头 → styrigx-ai 只回公开条目（它那边也固定不回私密条目）。
 * 回答只有公开页面元数据：{ ok, q, results: [{ title, url, site, snippet }] }；索引读不了时 styrigx-ai 回 degraded: true。
 * 网关这边调不到 styrigx-ai（没绑 / 抛错 / 回了非 2xx）同样降级：200 { ok: true, q, results: [], degraded: true }，不回 5xx（终端照常显示）。
 * 为什么是新路径 /api/find 而不是复活 /api/search：/api/search 在 P4-2 退役，部署冒烟和单测都把它当作「已删」核对；
 * 新名字和终端命令 find 对上，也不会让人以为旧的全站搜索（带私密档）回来了。
 */
import { findLimit } from '../core/find-limit.js';
import { apiError, json, NO_STORE } from '../lib/http.js';

/** 服务绑定的地址：主机名只用来拼 URL，路径是 styrigx-ai 认的 */
const AI_BASE = 'https://styrigx-ai';
/** q 最多多少个字符（同 styrigx-ai api/find.js FIND_Q_MAX） */
export const FIND_Q_MAX = 100;

/** @param {string} q */
function degraded(q) {
  return json(200, { ok: true, q, results: [], degraded: true });
}

/** @param {{request: Request, env: any}} context */
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const q = String(url.searchParams.get('q') || '').normalize('NFKC').trim();
  if (!q || [...q].length > FIND_Q_MAX) return apiError(400, 'bad_request');
  const limited = await findLimit(request, env);
  if (limited) return limited;
  const l = url.searchParams.get('lang');
  const lang = l === 'zh' || l === 'en' ? l : '';
  const svc = env && env.AI_SERVICE;
  if (!svc || typeof svc.fetch !== 'function') {
    console.error('[find] AI_SERVICE not bound, degraded');
    return degraded(q);
  }
  const target = new URL(AI_BASE + '/find');
  target.searchParams.set('q', q);
  if (lang) target.searchParams.set('lang', lang);
  let res;
  try {
    res = await svc.fetch(new Request(target.toString(), { method: 'GET' }));
  } catch (e) {
    console.error('[find] service failed, degraded', e && /** @type {any} */ (e).name);
    return degraded(q);
  }
  if (!res.ok) {
    console.error('[find] service status ' + res.status + ', degraded');
    if (res.body) res.body.cancel().catch(() => {});
    return degraded(q);
  }
  const out = new Headers(res.headers);
  out.set('Cache-Control', NO_STORE);
  return new Response(res.body, { status: res.status, headers: out });
}
