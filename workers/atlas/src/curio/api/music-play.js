// workers/curio-core/src/api/music-play.js
// POST /api/music-play  body {album: N}   entry 档（进站即可，含分享链接 by=link；app.js 守卫）+ 同源（_music.js musicOrigin）
// → {ok, expires, ttl, tracks:[{id, no, title, duration, src, lrc}]}：src = /curio/api/music-stream?t=<令牌>&id=<曲目>，
//   令牌是随机 32 字节（不是 HMAC，不要 secret），存 D1 music_tokens，10 分钟有效，期间同一条地址可多次 Range 请求（拖进度）。
//   lrc：歌词正文（没有就是空串）。404 专辑不在。
import { err, json, methodNotAllowed } from './_lib.js';
import { readBody } from './_write.js';
import { musicOrigin, ensureMusicSchema, issueToken, TOKEN_TTL_MS } from './_music.js';

export async function onRequestPost(context) {
  const denied = musicOrigin(context);
  if (denied) return denied;
  const { env } = context;
  if (!env || !env.D1_MUSIC) return err('server', 503);
  const { body, response } = await readBody(context.request);
  if (response) return response;
  const album = Number(body && body.album);
  if (!Number.isInteger(album) || album <= 0 || album >= 2 ** 31) return err('bad-album', 400);
  const db = env.D1_MUSIC;
  await ensureMusicSchema(db);
  const t = await issueToken(db, album, Date.now());
  if (!t) return err('not-found', 404);
  const rows = await db.prepare('SELECT id, no, title, duration, lrc FROM music_tracks WHERE album_id = ?1 ORDER BY no, id').bind(album).all();
  const tracks = (rows.results || []).map((r) => ({
    id: r.id, no: r.no, title: r.title, duration: r.duration, lrc: r.lrc || '',
    src: '/curio/api/music-stream?t=' + t.token + '&id=' + r.id,
  }));
  return json({ ok: true, expires: t.expires, ttl: TOKEN_TTL_MS, tracks });
}

export function onRequest() {
  return methodNotAllowed('POST');
}
