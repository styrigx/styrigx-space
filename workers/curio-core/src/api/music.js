// workers/curio-core/src/api/music.js
// 私人音乐的歌单（三层权限见 _music.js；档在 routes.js ROUTE_ACCESS）。
// GET  /api/music   public：→ {ok, canWrite, albums:[{id, title, artist, year, cover, tracks:[{id, no, title, duration}]}]}——只有元数据，没有音频地址；
//                   canWrite（账号 + curio.write）时曲目另带 size / type / lrc（有没有歌词），前端据此显示上传 / 删除。
// POST /api/music   music 档 + 同源：body {op:'album.add'|'album.edit'|'album.del'|'track.edit'|'track.del', ...}（校验见 _music.js parseMusicOp）
//                   成功 → {ok:true, canWrite:true, id?, albums}；删专辑 / 曲目连 R2_MUSIC 里的音频、封面一起删（删失败只记日志）。
// 无权限（app.js 守卫）：没进门 401 unauthorized、没账号会话 401 account、没作用域 403 scope；写非同源 403 origin。
import { json, err, methodNotAllowed } from './_lib.js';
import { readBody } from './_write.js';
import { conclusionOf, can, SCOPE_WRITE } from './_auth.js';
import { musicOrigin, ensureMusicSchema, listAlbums, parseMusicOp, applyMusicOp } from './_music.js';

const STATUS = { 'not-found': 404, limit: 409 };

export async function onRequestGet(context) {
  const { env } = context;
  if (!env || !env.D1_MUSIC) return err('server', 503);
  const canWrite = can(await conclusionOf(context), SCOPE_WRITE);
  await ensureMusicSchema(env.D1_MUSIC);
  return json({ ok: true, canWrite, albums: await listAlbums(env.D1_MUSIC, canWrite) });
}

export async function onRequestPost(context) {
  const denied = musicOrigin(context);
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
  const out = { ok: true, canWrite: true, albums: await listAlbums(env.D1_MUSIC, true) };
  if (r.id) out.id = r.id;
  return json(out);
}

export function onRequest() {
  return methodNotAllowed('GET, POST');
}
