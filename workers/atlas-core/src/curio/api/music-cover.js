// workers/atlas-core/src/curio/api/music-cover.js
// GET /api/music-cover?album=N    专辑封面，public（v5 S3：和歌单同档；封面走这条，和音频 /api/music-stream 分开）。没封面 404。
// GET /api/music-cover?artist=N   歌手头像（M4，音乐 v1.19 十二 M4 第 2 / 4 条），同档同缓存；没头像 404（前端退回默认图标）。
//   单曲没有封面时前端改用歌手头像（封面空 → 歌手头像 → 默认图），也走这条，不加新路由。album / artist 只能给一个。
// Content-Type（6.5b）：R2 自带的 contentType → key 扩展名（jpg / png / webp）→ 专辑 webp、头像 jpeg（_music.js coverTypeOf）。
// 缓存同照片（_image.js）：private, no-cache + ETag（由 R2 key 算，换封面换 key）+ Vary: Cookie。
import { err, methodNotAllowed } from './_lib.js';
import { ensureMusicSchema, coverTypeOf } from './_music.js';
import { etagMatches, etagOf, imageResponse, notModified } from './_image.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env || !env.D1_MUSIC || !env.R2_MUSIC) return err('server', 503);
  const sp = new URL(request.url).searchParams;
  const byArtist = sp.has('artist');
  if (byArtist && sp.has('album')) return err('bad-id', 400);
  const id = Number(sp.get(byArtist ? 'artist' : 'album') || '');
  if (!Number.isInteger(id) || id <= 0) return err('bad-id', 400);
  await ensureMusicSchema(env.D1_MUSIC);
  const row = byArtist
    ? await env.D1_MUSIC.prepare('SELECT avatar AS cover FROM music_artists WHERE id = ?1').bind(id).first()
    : await env.D1_MUSIC.prepare('SELECT cover FROM music_albums WHERE id = ?1').bind(id).first();
  if (!row || !row.cover) return err('not-found', 404);
  const etag = await etagOf(row.cover);
  if (etagMatches(request, etag)) return notModified(etag);
  const obj = await env.R2_MUSIC.get(row.cover);
  if (!obj) return err('not-found', 404);
  return imageResponse(obj.body, coverTypeOf(obj, row.cover, byArtist ? 'image/jpeg' : 'image/webp'), etag);
}

export function onRequest() {
  return methodNotAllowed('GET');
}
