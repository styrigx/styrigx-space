// workers/curio-core/src/api/movies.js
// GET  /api/movies   公开（v5 S3）：{ok, canWrite, showPrivate, movies:[...]}（canWrite = curio.write；showPrivate = 有账号会话，只用来选页底那句话）（海报只给有没有，图走 /api/photo?kind=movie&id=）
// POST /api/movies   账号会话 + 作用域 curio.write + 同源：body {op:'movie.add'|'movie.edit'|'movie.del', ...}（校验见 _movies.js parseMovieOp）
//                    成功 → {ok:true, canWrite:true, id?, movies}（带回全部，前端整页重画；add 带新 id，好接着传海报）；删电影连 R2 海报一起删。
//                    无权限：没登录账号 401 account、没作用域 403 scope、非同源 403 origin；400 参数不对；404 不存在；409 limit
// 不进全站搜索索引（src/search-index.js 的 CONTENT_ROUTES 不含本接口，索引也不读 movies 表）。
import { json, err, methodNotAllowed } from './_lib.js';
import { readAccess } from './_auth.js';
import { readBody, guardWrite } from './_write.js';
import { ensureMovieSchema, listMovies, parseMovieOp, applyMovieOp } from './_movies.js';

const STATUS = { 'not-found': 404, limit: 409 };

export async function onRequestGet(context) {
  const { env } = context;
  const vis = await readAccess(context);
  if (!env || !env.D1_MOVIES) return err('server', 503);
  await ensureMovieSchema(env.D1_MOVIES);
  return json({ ok: true, ...vis, movies: await listMovies(env.D1_MOVIES) });
}

export async function onRequestPost(context) {
  const denied = await guardWrite(context);
  if (denied) return denied;
  const { env } = context;
  if (!env || !env.D1_MOVIES) return err('server', 503);
  const { body, response } = await readBody(context.request);
  if (response) return response;
  const o = parseMovieOp(body);
  if ('error' in o) return err(o.error, 400);
  await ensureMovieSchema(env.D1_MOVIES);
  const r = await applyMovieOp(env.D1_MOVIES, o, Date.now());
  if (r.error) return err(r.error, STATUS[r.error] || 400);
  for (const key of r.removed) {
    try { if (env.R2_PHOTOS) await env.R2_PHOTOS.delete(key); } catch (e) { console.error('[curio-movies] poster delete failed'); }
  }
  const out = { ok: true, canWrite: true, showPrivate: true, movies: await listMovies(env.D1_MOVIES) };
  if (r.id) out.id = r.id;
  return json(out);
}

export function onRequest() {
  return methodNotAllowed('GET, POST');
}
