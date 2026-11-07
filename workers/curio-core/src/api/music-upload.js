// workers/curio-core/src/api/music-upload.js
// POST /api/music-upload?album=N&kind=track&no=K&title=…&duration=S   body = 音频本身（浏览器直传，不分片）
// POST /api/music-upload?album=N&kind=cover                           body = 封面图片（浏览器先缩到 1600、转 webp）
// 权限：同源 + 账号会话 + curio.write（_music.js guardMusicWrite）。
// 上限：音频单文件 95 MB（MUSIC_LIMITS.trackBytes；Workers 请求体上限 100 MB），要带 Content-Length（没有 411）；封面 3 MB。
// 音频类型看 Content-Type（AUDIO_TYPES 白名单，回放原样带回 + nosniff）；封面看头几个字节（webp / jpeg / png）。
// R2_MUSIC：music/<专辑>/<曲序>-<时间>.<扩展名>、music/<专辑>/cover-<时间>.<扩展名>；换封面删旧的。
// → 曲目 {ok:true, id}；封面 {ok:true}。400 参数不对 / 不是音频图片；404 专辑不在；409 曲目满了；413 太大
import { err, json, methodNotAllowed } from './_lib.js';
import { sniffImage } from './_image.js';
import { guardMusicWrite, ensureMusicSchema, MUSIC_LIMITS, AUDIO_TYPES, trackKey } from './_music.js';

const IMG_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

function intParam(sp, name, min, max) {
  const v = sp.get(name);
  if (v === null || v === '') return min === 0 ? 0 : null;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

export async function onRequestPost(context) {
  const denied = await guardMusicWrite(context);
  if (denied) return denied;
  const { request, env } = context;
  if (!env || !env.D1_MUSIC || !env.R2_MUSIC) return err('server', 503);
  const sp = new URL(request.url).searchParams;
  const albumId = intParam(sp, 'album', 1, 2 ** 31 - 1);
  const kind = sp.get('kind');
  if (!albumId || (kind !== 'track' && kind !== 'cover')) return err('bad-params', 400);
  const lenHdr = request.headers.get('Content-Length');
  const len = lenHdr === null ? NaN : Number(lenHdr);
  const max = kind === 'track' ? MUSIC_LIMITS.trackBytes : MUSIC_LIMITS.coverBytes;
  if (Number.isFinite(len) && len > max) return err('too-large', 413);
  const db = env.D1_MUSIC;
  await ensureMusicSchema(db);
  const album = await db.prepare('SELECT id, cover FROM music_albums WHERE id = ?1').bind(albumId).first();
  if (!album) return err('not-found', 404);
  const now = Date.now();

  if (kind === 'cover') {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > max) return err('too-large', 413);
    const type = sniffImage(bytes);
    if (!type) return err('not-image', 400);
    const key = `music/${albumId}/cover-${now}.${IMG_EXT[type]}`;
    try { await env.R2_MUSIC.put(key, bytes, { httpMetadata: { contentType: type } }); } catch (e) { return err('storage', 503); }
    await db.prepare('UPDATE music_albums SET cover = ?1, updated_at = ?2 WHERE id = ?3').bind(key, now, albumId).run();
    if (album.cover) { try { await env.R2_MUSIC.delete(album.cover); } catch (e) { console.error('[curio-music] old cover delete failed'); } }
    return json({ ok: true });
  }

  /* 音频：要知道长度（R2 流式写入要定长，也好在读之前就拒掉超限的） */
  if (!Number.isFinite(len) || len <= 0) return err('length-required', 411);
  const type = String(request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  const ext = AUDIO_TYPES[type];
  if (!ext) return err('not-audio', 400);
  const no = intParam(sp, 'no', 0, 999);
  const duration = intParam(sp, 'duration', 0, 24 * 3600);
  const title = String(sp.get('title') || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MUSIC_LIMITS.short);
  if (no === null || duration === null) return err('bad-params', 400);
  if (!title) return err('bad-title', 400);
  const n = await db.prepare('SELECT COUNT(*) AS n FROM music_tracks WHERE album_id = ?1').bind(albumId).first();
  if (n && n.n >= MUSIC_LIMITS.tracks) return err('limit', 409);
  const key = trackKey(albumId, no, ext, now);
  try {
    await env.R2_MUSIC.put(key, request.body, { httpMetadata: { contentType: type } });
  } catch (e) {
    return err('storage', 503);
  }
  const r = await db.prepare('INSERT INTO music_tracks (album_id, no, title, duration, r2_key, type, size, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
    .bind(albumId, no, title, duration, key, type, len, now).run();
  return json({ ok: true, id: r.meta && r.meta.last_row_id });
}

export function onRequest() {
  return methodNotAllowed('POST');
}
