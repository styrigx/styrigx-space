/**
 * 书签（D1 版）。表和读写在 _kernel/bookmarks.js；网址预览在 /api/bookmark-preview。
 *
 * GET /api/bookmarks
 *   - 任何有效会话（主人、访客）都能读：书签页本来就对访客公开。
 *   - 第一次读时自动把 web/data/links.yaml 的书签导入 D1（只导一次）。
 *   - 返回 {ok:true, cats:[{id, name:{zh,en}, links:[{id, url, name:{zh,en}, desc:{zh,en}, icon}]}]}
 *   - 没绑定 SGX_D1（本地 / 预览没配）→ 200 {ok:false, cats:[]}，前端退回页面里的静态书签。
 *
 * POST /api/bookmarks   body: {op, ...}（JSON，最多 16 KB；操作见 _kernel/bookmarks.js 的 parseOp）
 *   - 只有主人；必须同源。
 *   - 成功 → 200 {ok:true, cats:[...]}（直接带回最新的全部书签，前端整页重画）
 *   - 400 参数不对；404 分类/书签不存在；409 not-empty（分类里还有书签）/ mismatch（排序名单和库里不一致）/ limit（超上限）
 */
import { verifySessionDetailed } from '../_middleware.js';
import { isSameOrigin, originDenied } from '../_kernel/http.js';
import { ensureSchema, seedIfNeeded, listAll, parseOp, applyOp } from '../_kernel/bookmarks.js';

const NO_STORE = { 'Cache-Control': 'private, no-store' };
const MAX_BODY = 16384;
const STATUS = { 'not-found': 404, 'not-empty': 409, mismatch: 409, limit: 409 };

/** @param {any} context */
export async function onRequestGet(context) {
  const { request, env } = context;
  const sess = await verifySessionDetailed(request, env);
  if (!sess.ok) return Response.json({ ok: false }, { status: 401, headers: NO_STORE });
  const db = env && env.SGX_D1;
  if (!db) return Response.json({ ok: false, cats: [] }, { headers: NO_STORE });
  try {
    await ensureSchema(db);
    await seedIfNeeded(db);
    return Response.json({ ok: true, cats: await listAll(db) }, { headers: NO_STORE });
  } catch (e) {
    console.error('[api/bookmarks] d1 error', e && /** @type {any} */ (e).message);
    return Response.json({ ok: false, error: 'server' }, { status: 503, headers: NO_STORE });
  }
}

/** @param {any} context */
export async function onRequestPost(context) {
  const { request, env } = context;
  if (!isSameOrigin(request)) return originDenied();
  const sess = await verifySessionDetailed(request, env);
  if (!sess.ok) return Response.json({ ok: false }, { status: 401, headers: NO_STORE });
  if (sess.role !== 'owner') return Response.json({ ok: false, error: 'role' }, { status: 403, headers: NO_STORE });
  const db = env && env.SGX_D1;
  if (!db) return Response.json({ ok: false, error: 'server' }, { status: 503, headers: NO_STORE });
  const raw = await request.text();
  if (raw.length > MAX_BODY) return Response.json({ ok: false, error: 'too-large' }, { status: 413, headers: NO_STORE });
  let body;
  try {
    body = JSON.parse(raw);
  } catch (e) {
    return Response.json({ ok: false, error: 'bad-json' }, { status: 400, headers: NO_STORE });
  }
  const o = parseOp(body);
  if ('error' in o) return Response.json({ ok: false, error: o.error }, { status: 400, headers: NO_STORE });
  try {
    await ensureSchema(db);
    await seedIfNeeded(db); /* 还没读过就先写：先导入种子，免得之后种子盖不上来 */
    const err = await applyOp(db, o);
    if (err) return Response.json({ ok: false, error: err }, { status: STATUS[err] || 400, headers: NO_STORE });
    return Response.json({ ok: true, cats: await listAll(db) }, { headers: NO_STORE });
  } catch (e) {
    console.error('[api/bookmarks] d1 error', e && /** @type {any} */ (e).message);
    return Response.json({ ok: false, error: 'server' }, { status: 503, headers: NO_STORE });
  }
}
