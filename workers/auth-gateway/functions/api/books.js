/**
 * B2-5：我的文件 › 书籍 —— 书库全部书的只读列表。
 * GET /api/books
 * - 数据源：书库 D1（styrigx-books），绑定名 BOOKS_D1，只做 SELECT，绝不写。
 * - 鉴权：middleware 已挡掉无会话请求（401）；这里按角色决定范围：
 *   owner → 全部书（含私有）；visitor → 只给 visibility='public' 的书。
 * - 返回 {ok:true, books:[{id,title,author,format,cover_url,read_url,added_at}]}，按添加时间倒序。
 *   cover_url / read_url 指向书库站（book.styrigx.com）：
 *   私有书封面走 /api/private/cover（书库站自己验 owner cookie），公开书走 /api/cover。
 *   不返回任何文件地址（r2_key 等内部字段不出库）。
 * - 未绑定 BOOKS_D1（本地 / preview）→ 200 {ok:false, books:[]}，前端显示「暂无内容」。
 */
import { verifySessionDetailed } from '../_middleware.js';

const BOOK_ORIGIN = 'https://book.styrigx.com';
const COVER_RE = /^covers\/[a-f0-9-]+\.webp$/;

/**
 * @param {any} row
 * @param {boolean} owner
 */
export function toBook(row, owner) {
  const isPublic = row.visibility === 'public';
  let cover = '';
  if (row.cover_key && COVER_RE.test(row.cover_key)) {
    cover = BOOK_ORIGIN + (owner && !isPublic ? '/api/private/cover?key=' : '/api/cover?key=') + encodeURIComponent(row.cover_key);
  }
  return {
    id: row.id,
    title: row.title || '',
    author: row.author || '',
    format: row.format || '',
    cover_url: cover,
    read_url: BOOK_ORIGIN + '/read/?id=' + encodeURIComponent(row.id),
    added_at: row.created_at || 0,
  };
}

/**
 * @param {any} context
 */
export async function onRequestGet(context) {
  const { request, env } = context;
  const headers = { 'Cache-Control': 'private, no-store' };
  const sess = await verifySessionDetailed(request, env);
  if (!sess.ok) return Response.json({ ok: false }, { status: 401, headers });
  const db = env && env.BOOKS_D1;
  if (!db) return Response.json({ ok: false, books: [] }, { headers });
  const owner = sess.role === 'owner';
  const sql = owner
    ? 'SELECT id,title,author,format,cover_key,visibility,created_at FROM books ORDER BY created_at DESC'
    : "SELECT id,title,author,format,cover_key,visibility,created_at FROM books WHERE visibility='public' ORDER BY created_at DESC";
  try {
    const { results } = await db.prepare(sql).all();
    const books = (results || []).map((/** @type {any} */ r) => toBook(r, owner));
    return Response.json({ ok: true, books }, { headers });
  } catch (e) {
    console.error('[api/books] d1 error', e && /** @type {any} */ (e).message);
    return Response.json({ ok: false, books: [] }, { status: 503, headers });
  }
}
