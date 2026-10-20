/**
 * GET /api/bookmark-preview?url=<网址>  —— 新增书签时自动填名字、简介、图标。
 *
 * - 只有主人（middleware 的 OWNER_ONLY_APIS 也挡访客）；必须同源（Origin 头）。
 * - 抓取规则和安全限制见 _kernel/link-preview.js（只抓公网 http/https、6 秒、256 KB、最多 3 次跳转）。
 * - 返回 200 {ok:true, url, title, desc, icon}（url 是跳转后的最终地址）；
 *   抓不到 → 200 {ok:false, error}（前端照样让主人手填，不算出错）；网址不合格 → 400。
 */
import { verifySessionDetailed } from '../_middleware.js';
import { isSameOrigin, originDenied } from '../_kernel/http.js';
import { cleanUrl } from '../_kernel/bookmarks.js';
import { fetchPreview } from '../_kernel/link-preview.js';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

/** @param {any} context */
export async function onRequestGet(context) {
  const { request, env } = context;
  if (!isSameOrigin(request)) return originDenied();
  const sess = await verifySessionDetailed(request, env);
  if (!sess.ok) return Response.json({ ok: false }, { status: 401, headers: NO_STORE });
  if (sess.role !== 'owner') return Response.json({ ok: false, error: 'role' }, { status: 403, headers: NO_STORE });
  const url = cleanUrl(new URL(request.url).searchParams.get('url'));
  if (!url) return Response.json({ ok: false, error: 'bad-url' }, { status: 400, headers: NO_STORE });
  const r = await fetchPreview(url);
  return Response.json(r, { headers: NO_STORE });
}
