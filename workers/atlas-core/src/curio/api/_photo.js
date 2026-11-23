// workers/atlas-core/src/curio/api/_photo.js
// 条目照片的读 / 换 / 删（现在只有游戏封面；R2 R2_PHOTOS：photos/game/<id>-<时间>.<webp|jpg|png>）。下划线开头：不是接口。
// 调用方：游戏 /games/api/cover（../../games/api/cover.js：?id=N，kind 固定是 game）。
// 奇趣重组 PR 3 删掉了奇趣 /curio/api/photo（?kind=device|game|movie）和设备照片、电影海报；这份规则留在这里（不搬文件），kind 表只剩 game。
// 调用方只给「这个请求指的是哪一条」（targetOf(request) → {kind, K, id} 或 null，null = 400 bad-id），其余规则一处：
//   GET    公开；私密条目的图看不到（没有本产品的 use 组，公用 privateNotFound 按命中的路由行 product 问）= 404，同不存在。没照片 404。
//   POST   同源 + 本路由的 manage 档；body 是图片本身（Content-Type image/webp|jpeg|png，看头几个字节核对），≤ 3 MB。
//          换照片：先写新的、再改 D1、最后删旧的。→ {ok:true}
//   DELETE 同源 + 本路由的 manage 档；删照片并清空 D1 里的 key。→ {ok:true}
// 响应头：Cache-Control private, no-cache + ETag + Vary: Cookie（_image.js）：浏览器每次用前都回来验会话，内容没变回 304。
//   ETag 由 R2 key 算（key 带时间，换照片 = 换 key = 换 ETag），304 不用读 R2。前端 ?v= 照旧用来换地址。
import { err, json } from './_lib.js';
import { privateNotFound } from '../../common/visibility.js';
import { guardWrite } from './_write.js';
import { ensureItemSchema, KINDS, itemDb } from './_items.js';
import { etagMatches, etagOf, imageResponse, notModified, sniffImage } from './_image.js';

export const PHOTO_MAX_BYTES = 3 * 1024 * 1024;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** 能带照片的条目：游戏（_items.js KINDS；设备、电影奇趣重组 PR 3 删了） */
export const PHOTO_KINDS = Object.freeze({ ...KINDS });

/** 这种条目的表所在的绑定（游戏 → D1_GAMES） */
function photoDb(env, kind) {
  return itemDb(env, kind);
}
async function ensureKind(db) {
  await ensureItemSchema(db);
}

/**
 * kind 名 → {kind, K}（不认识 → null）
 * @param {string} kind
 */
export function photoKind(kind) {
  return Object.prototype.hasOwnProperty.call(PHOTO_KINDS, kind) ? { kind, K: PHOTO_KINDS[kind] } : null;
}

/** @typedef {{kind: string, K: any, id: number}} PhotoTarget */

/**
 * GET：读一张照片。
 * @param {any} context @param {(request: Request) => PhotoTarget|null} targetOf
 */
export async function getPhoto(context, targetOf) {
  const { request, env } = context;
  const t = targetOf(request);
  if (!t) return err('bad-id', 400);
  const db = photoDb(env, t.kind);
  if (!db || !env.R2_PHOTOS) return err('server', 503);
  await ensureKind(db);
  const row = await db.prepare(`SELECT ${t.K.photo} AS photo, private FROM ${t.K.table} WHERE id = ?1`).bind(t.id).first();
  if (!row || !row.photo) return err('not-found', 404);
  /* 私密条目的图：看不到（没有本产品的 use 组）= 404，同不存在（公用 privateNotFound，组权限 v1.1 §八） */
  const hidden = await privateNotFound(context, !!row.private);
  if (hidden) return hidden;
  /* 会话和可见性（上一行）都过了才看缓存 */
  const etag = await etagOf(row.photo);
  if (etagMatches(request, etag)) return notModified(etag);
  const obj = await env.R2_PHOTOS.get(row.photo);
  if (!obj) return err('not-found', 404);
  const type = (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/webp';
  return imageResponse(obj.body, type, etag);
}

/**
 * POST：换一张照片（先写新的、再改 D1、最后删旧的）。
 * @param {any} context @param {(request: Request) => PhotoTarget|null} targetOf
 */
export async function putPhoto(context, targetOf) {
  const denied = await guardWrite(context);
  if (denied) return denied;
  const { request, env } = context;
  const t = targetOf(request);
  if (!t) return err('bad-id', 400);
  const db = photoDb(env, t.kind);
  if (!db || !env.R2_PHOTOS) return err('server', 503);
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > PHOTO_MAX_BYTES) return err('too-large', 413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > PHOTO_MAX_BYTES) return err('too-large', 413);
  const type = sniffImage(bytes);
  if (!type) return err('not-image', 400);
  await ensureKind(db);
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

/**
 * DELETE：删照片并清空 D1 里的 key。
 * @param {any} context @param {(request: Request) => PhotoTarget|null} targetOf
 */
export async function deletePhoto(context, targetOf) {
  const denied = await guardWrite(context);
  if (denied) return denied;
  const { request, env } = context;
  const t = targetOf(request);
  if (!t) return err('bad-id', 400);
  const db = photoDb(env, t.kind);
  if (!db || !env.R2_PHOTOS) return err('server', 503);
  await ensureKind(db);
  const row = await db.prepare(`SELECT ${t.K.photo} AS photo FROM ${t.K.table} WHERE id = ?1`).bind(t.id).first();
  if (!row) return err('not-found', 404);
  await db.prepare(`UPDATE ${t.K.table} SET ${t.K.photo} = '', updated_at = ?1 WHERE id = ?2`).bind(Date.now(), t.id).run();
  if (row.photo) { try { await env.R2_PHOTOS.delete(row.photo); } catch (e) { console.error('[curio-photo] delete failed'); } }
  return json({ ok: true });
}
