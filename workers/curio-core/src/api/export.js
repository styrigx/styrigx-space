// workers/core/src/api/export.js
// GET /api/export[?lang=en]  —— 导出全部收藏为浏览器书签文件（Netscape HTML，Chrome / 三星浏览器都能导入）。
// 要账号会话（含私密，方案 4.2：读私密 = 账号会话，不要作用域）；必须同站（_lib.js 的 isSameSite：直接点链接下载时浏览器只带 Sec-Fetch-Site）。
// 没进门 401 unauthorized；没账号会话 401 account。私密的也导出。
import { err, methodNotAllowed, isSameSite } from './_lib.js';
import { requireAccount, auditRootOp } from './_auth.js';
import { ensureSchema } from './_store.js';
import { renderBookmarks } from './_netscape.js';
import { LANGS, DEFAULT_LANG } from '../search-index.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!isSameSite(request)) return err('origin', 403);
  const { response } = await requireAccount(context);
  if (response) return response;
  const db = env && env.D1_FINDS;
  if (!db) return err('server', 503);
  await ensureSchema(db);
  const [cats, links] = await db.batch([
    db.prepare('SELECT id, name_zh, name_en FROM cats ORDER BY pos, id'),
    db.prepare('SELECT cat_id, url, name_zh, name_en, desc_zh, desc_en, created_at FROM links ORDER BY pos, id'),
  ]);
  const byId = new Map();
  const out = [];
  for (const r of cats.results || []) {
    const c = { name: { zh: r.name_zh, en: r.name_en }, links: [] };
    byId.set(r.id, c);
    out.push(c);
  }
  for (const r of links.results || []) {
    const c = byId.get(r.cat_id);
    if (c) c.links.push({ url: r.url, name: { zh: r.name_zh, en: r.name_en }, desc: { zh: r.desc_zh, en: r.desc_en }, created_at: r.created_at });
  }
  /* 默认英文（四站默认语言；2026-11-07 前默认中文）；前端导出链接总带 ?lang=<页面语言>，只认本站语言列表里的 */
  const want = new URL(request.url).searchParams.get('lang') || '';
  const lang = LANGS.includes(want) ? want : DEFAULT_LANG;
  const now = Date.now();
  const day = new Date(now + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
  /* 割接：经 v6 放进来的 root 导出全部收藏（含私密）留痕 */
  await auditRootOp(context, 'export curio bookmarks');
  return new Response(renderBookmarks(out, lang, now), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': 'attachment; filename="curio-' + day + '.html"',
      'Cache-Control': 'private, no-store',
    },
  });
}

export function onRequest() {
  return methodNotAllowed('GET');
}
