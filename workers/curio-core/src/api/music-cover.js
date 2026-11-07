// workers/curio-core/src/api/music-cover.js
// GET /api/music-cover?album=N   专辑封面（仅本人：账号会话 + curio.write，_music.js requireMusic）。没封面 404。
// 缓存同照片（_image.js）：private, no-cache + ETag（由 R2 key 算，换封面换 key）+ Vary: Cookie；304 排在权限检查之后。
import { err, methodNotAllowed } from './_lib.js';
import { requireMusic, ensureMusicSchema } from './_music.js';
import { etagMatches, etagOf, imageResponse, notModified } from './_image.js';

export async function onRequestGet(context) {
  const denied = await requireMusic(context);
  if (denied) return denied;
  const { request, env } = context;
  if (!env || !env.D1_MUSIC || !env.R2_MUSIC) return err('server', 503);
  const id = Number(new URL(request.url).searchParams.get('album') || '');
  if (!Number.isInteger(id) || id <= 0) return err('bad-id', 400);
  await ensureMusicSchema(env.D1_MUSIC);
  const row = await env.D1_MUSIC.prepare('SELECT cover FROM music_albums WHERE id = ?1').bind(id).first();
  if (!row || !row.cover) return err('not-found', 404);
  const etag = await etagOf(row.cover);
  if (etagMatches(request, etag)) return notModified(etag);
  const obj = await env.R2_MUSIC.get(row.cover);
  if (!obj) return err('not-found', 404);
  return imageResponse(obj.body, (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/webp', etag);
}

export function onRequest() {
  return methodNotAllowed('GET');
}
