// workers/curio-core/src/api/music.js
// 私人音乐（仅本人可见，权限见 _music.js requireMusic：账号会话 + curio.write）。
// GET  /api/music   → {ok, albums:[{id, title, artist, year, cover, tracks:[{id, no, title, duration, size, type, lrc}]}]}
// POST /api/music   同源 + 同上：body {op:'album.add'|'album.edit'|'album.del'|'track.edit'|'track.del', ...}（校验见 _music.js parseMusicOp）
//                   成功 → {ok:true, id?, albums}；删专辑 / 曲目连 R2_MUSIC 里的音频、封面一起删（删失败只记日志）。
// 无权限：没进门 401 unauthorized、没账号会话 401 account、没作用域 403 scope、写非同源 403 origin。
import { json, err, methodNotAllowed } from './_lib.js';
import { readBody } from './_write.js';
import { requireMusic, guardMusicWrite, ensureMusicSchema, listAlbums, parseMusicOp, applyMusicOp } from './_music.js';

const STATUS = { 'not-found': 404, limit: 409 };

export async function onRequestGet(context) {
  const denied = await requireMusic(context);
  if (denied) return denied;
  const { env } = context;
  if (!env || !env.D1_MUSIC) return err('server', 503);
  await ensureMusicSchema(env.D1_MUSIC);
  return json({ ok: true, albums: await listAlbums(env.D1_MUSIC) });
}

export async function onRequestPost(context) {
  const denied = await guardMusicWrite(context);
  if (denied) return denied;
  const { env } = context;
  if (!env || !env.D1_MUSIC) return err('server', 503);
  const { body, response } = await readBody(context.request);
  if (response) return response;
  const o = parseMusicOp(body);
  if ('error' in o) return err(o.error, 400);
  await ensureMusicSchema(env.D1_MUSIC);
  const r = await applyMusicOp(env.D1_MUSIC, o, Date.now());
  if (r.error) return err(r.error, STATUS[r.error] || 400);
  for (const key of r.removed) {
    try { if (env.R2_MUSIC) await env.R2_MUSIC.delete(key); } catch (e) { console.error('[curio-music] r2 delete failed'); }
  }
  const out = { ok: true, albums: await listAlbums(env.D1_MUSIC) };
  if (r.id) out.id = r.id;
  return json(out);
}

export function onRequest() {
  return methodNotAllowed('GET, POST');
}
