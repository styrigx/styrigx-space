// workers/core/src/api/photo.js
// 设备照片 / 游戏封面 / 电影海报（R2 R2_PHOTOS：photos/<device|game|movie>/<id>-<时间>.<webp|jpg|png>）。
//   GET    /api/photo?kind=device|game|movie&id=N   公开（v5 S3）；没登录账号拿不到私密条目的图（404，同不存在；电影没有私密）。没照片 404。
//   POST   /api/photo?kind=…&id=N             账号会话 + 作用域 curio.write + 同源；body 是图片本身（Content-Type image/webp|jpeg|png，看头几个字节核对），≤ 3 MB。
//                                             换照片：先写新的、再改 D1、最后删旧的。→ {ok:true}
//   DELETE /api/photo?kind=…&id=N             账号会话 + 作用域 curio.write + 同源；删照片并清空 D1 里的 key。→ {ok:true}
// 前端上传前在浏览器里缩到长边 1600、转 webp，所以一般只有几百 KB。
// 响应头：Cache-Control private, no-cache + ETag + Vary: Cookie（_image.js）：浏览器每次用前都回来验会话，内容没变回 304。
//   ETag 由 R2 key 算（key 带时间，换照片 = 换 key = 换 ETag），304 不用读 R2。前端 ?v= 照旧用来换地址。
import { err, json, methodNotAllowed } from './_lib.js';
import { readAccess } from './_auth.js';
import { guardWrite, idParam } from './_write.js';
import { ensureItemSchema, KINDS, itemDb } from './_items.js';
import { ensureMovieSchema, MOVIE_KIND } from './_movies.js';
import { etagMatches, etagOf, imageResponse, notModified, sniffImage } from './_image.js';

export const PHOTO_MAX_BYTES = 3 * 1024 * 1024;

/** 看头几个字节认图片类型（实现搬到 _image.js，音乐封面上传也用；这里保留导出） */
export { sniffImage };
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** 能带照片的条目：设备、游戏（_items.js）+ 电影（_movies.js，表在 D1_MOVIES，没有私密列） */
export const PHOTO_KINDS = Object.freeze({ ...KINDS, movie: MOVIE_KIND });

function target(request) {
  const kind = new URL(request.url).searchParams.get('kind') || '';
  const K = Object.prototype.hasOwnProperty.call(PHOTO_KINDS, kind) ? PHOTO_KINDS[kind] : null;
  const id = idParam(request);
  return K && id ? { kind, K, id } : null;
}
/** 这种条目的表所在的绑定（设备 → D1_DEVICES，游戏 → D1_GAMES，电影 → D1_MOVIES） */
function photoDb(env, kind) {
  return kind === 'movie' ? (env && env.D1_MOVIES) || null : itemDb(env, kind);
}
async function ensureKind(db, kind) {
  if (kind === 'movie') await ensureMovieSchema(db);
  else await ensureItemSchema(db);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const t = target(request);
  if (!t) return err('bad-id', 400);
  const db = photoDb(env, t.kind); // 设备 → D1_DEVICES，游戏 → D1_GAMES，电影 → D1_MOVIES
  if (!db || !env.R2_PHOTOS) return err('server', 503);
  await ensureKind(db, t.kind);
  const row = await db.prepare(`SELECT ${t.K.photo} AS photo, ${t.K.hasPrivate === false ? '0' : 'private'} AS private FROM ${t.K.table} WHERE id = ?1`).bind(t.id).first();
  if (!row || !row.photo) return err('not-found', 404);
  if (row.private && !(await readAccess(context)).showPrivate) return err('not-found', 404);
  /* 会话（index.js）和可见性（上一行）都过了才看缓存 */
  const etag = await etagOf(row.photo);
  if (etagMatches(request, etag)) return notModified(etag);
  const obj = await env.R2_PHOTOS.get(row.photo);
  if (!obj) return err('not-found', 404);
  const type = (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/webp';
  return imageResponse(obj.body, type, etag);
}

export async function onRequestPost(context) {
  const denied = await guardWrite(context);
  if (denied) return denied;
  const { request, env } = context;
  const t = target(request);
  if (!t) return err('bad-id', 400);
  const db = photoDb(env, t.kind); // 设备 → D1_DEVICES，游戏 → D1_GAMES，电影 → D1_MOVIES
  if (!db || !env.R2_PHOTOS) return err('server', 503);
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > PHOTO_MAX_BYTES) return err('too-large', 413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > PHOTO_MAX_BYTES) return err('too-large', 413);
  const type = sniffImage(bytes);
  if (!type) return err('not-image', 400);
  await ensureKind(db, t.kind);
  const row = await db.prepare(`SELECT ${t.K.photo} AS photo FROM ${t.K.table} WHERE id = ?1`).bind(t.id).first();
  if (!row) return err('not-found', 404);
  const key = `photos/${t.kind}/${t.id}-${Date.now()}.${EXT[type]}`;
  try {
    await env.R2_PHOTOS.put(key, bytes, { httpMetadata: { contentType: type } });
  } catch (e) {
    return err('storage', 503);
  }
  await db.prepare(`UPDATE ${t.K.table} SET ${t.K.photo} = ?1, updated_at = ?2 WHERE id = ?3`).bind(key, Date.now(), t.id).run();
  if (row.photo) { try { await env.R2_PHOTOS.delete(row.photo); } catch (e) { console.error('[curio-photo] old delete failed'); } }
  return json({ ok: true });
}

export async function onRequestDelete(context) {
  const denied = await guardWrite(context);
  if (denied) return denied;
  const { request, env } = context;
  const t = target(request);
  if (!t) return err('bad-id', 400);
  const db = photoDb(env, t.kind); // 设备 → D1_DEVICES，游戏 → D1_GAMES，电影 → D1_MOVIES
  if (!db || !env.R2_PHOTOS) return err('server', 503);
  await ensureKind(db, t.kind);
  const row = await db.prepare(`SELECT ${t.K.photo} AS photo FROM ${t.K.table} WHERE id = ?1`).bind(t.id).first();
  if (!row) return err('not-found', 404);
  await db.prepare(`UPDATE ${t.K.table} SET ${t.K.photo} = '', updated_at = ?1 WHERE id = ?2`).bind(Date.now(), t.id).run();
  if (row.photo) { try { await env.R2_PHOTOS.delete(row.photo); } catch (e) { console.error('[curio-photo] delete failed'); } }
  return json({ ok: true });
}

export function onRequest() {
  return methodNotAllowed('GET, POST, DELETE');
}
