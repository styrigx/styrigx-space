// workers/atlas-core/src/curio/api/music.js
// 私人音乐的歌单（三层权限见 _music.js；档在 routes.js ROUTE_ACCESS）。
// GET  /api/music   public：→ {ok, canManage, albums:[{id, kind:'album'|'single', title, artist, year, cover, tracks:[{id, no, title, duration, artist}]}]}——只有元数据，没有音频地址；
//                   曲目的 artist = music_artists.name（按 artist_id；0 → ''）（音乐 v1.18 十一 第 1 条）；
//                   canManage（music-manage）时曲目另带 size / type / lrc（有没有歌词），前端据此显示上传 / 删除。
// POST /api/music   music 档 + 同源：body {op:'album.add'|'album.edit'|'album.del'|'track.edit'|'track.del', ...}（校验见 _music.js parseMusicOp）
//                   成功 → {ok:true, canManage:true, id?, albums}；删专辑 / 曲目连 R2_MUSIC 里的音频、封面一起删（删失败只记日志）。
//                   track.edit（M1）另收 artist（改歌手，写 artist_id）、album_id（N = 移到专辑 N；0 = 移出变单曲，id = 新单曲）：
//                     400 same-album / target-single / already-single / bad-album / bad-artist；404 album-not-found；409 limit；503 storage（复制封面失败，D1 没动）。
//                   R2 删除一律在 D1 提交成功之后（单曲划进专辑：空单曲的旧封面也是）。
//                   track.edit（M3）另收 year（只给单曲里的曲目，写进单曲记录；专辑曲目 / 同时移专辑 400 year-not-single、不合格 400 bad-year）；
//                     单曲里的曲目改名，单曲记录的名同一个 batch 跟着改。
//                   track.del（M3）：删的是单曲唯一一首 → 空单曲记录连同它的封面一起删（权限仍是 track.del 的 music-manage）。
//                   歌手（M4，音乐 v1.19 7.5 / 十二 M4）：artist.edit {id, name?, bio?, style?}（music-manage；改名名下专辑文本跟着改；重名 409 artist-exists）、
//                     artist.merge {id, into}（root + 一次性票；404 not-found / into-not-found）、artist.del {id}（root + 一次性票；名下有作品 409 artist-has-works）。
//                     合并：目标没有头像就把原歌手的头像搬过去（R2 先复制、D1 同一个 batch 写上，复制失败 503 storage），目标有就丢掉原头像。
//                     合并 / 删掉的歌手头像等 D1 提交成功之后删。GET / POST 的回答多一个 artists（歌手表，listMusic），专辑 / 曲目多 artist_id。
// 无权限（app.js 守卫）：没有 v6 身份 401 unauthorized、档不够 403 forbidden；写非同源 403 origin。
import { json, err, methodNotAllowed } from './_lib.js';
import { readBody } from './_write.js';
import { viaV6, v6Of, auditRootOp } from './_auth.js';
import { visibility } from '../../common/visibility.js';
import { musicOrigin, ensureMusicSchema, listMusic, parseMusicOp, applyMusicOp } from './_music.js';

const STATUS = { 'not-found': 404, 'album-not-found': 404, 'into-not-found': 404, limit: 409, 'single-tracks': 409, 'artist-exists': 409, 'artist-has-works': 409, storage: 503 };

export async function onRequestGet(context) {
  const { env } = context;
  if (!env || !env.D1_MUSIC) return err('server', 503);
  const { canManage } = await visibility(context);
  await ensureMusicSchema(env.D1_MUSIC);
  const m = await listMusic(env.D1_MUSIC, canManage);
  return json({ ok: true, canManage, albums: m.albums, artists: m.artists });
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
  /* 割接：经 v6 放进来的按 op 再判一次档（路由表：album.del 连曲目一起删 = 结构删除 → root；artist.merge / artist.del = root（M4）；其余 music-manage） */
  if (viaV6(context) && !(await v6Of(context, o.op)).allowed) return err('forbidden', 403);
  await ensureMusicSchema(env.D1_MUSIC);
  const r = await applyMusicOp(env.D1_MUSIC, o, Date.now(), env.R2_MUSIC || null);
  if (r.error) return err(r.error, STATUS[r.error] || 400);
  for (const key of r.removed) {
    try { if (env.R2_MUSIC) await env.R2_MUSIC.delete(key); } catch (e) { console.error('[curio-music] r2 delete failed'); }
  }
  if (o.op === 'album.del') await auditRootOp(context, 'rm-bulk curio album ' + o.id);
  if (o.op === 'artist.merge') await auditRootOp(context, 'merge curio artist ' + o.id + ' ' + o.into);
  if (o.op === 'artist.del') await auditRootOp(context, 'rm-bulk curio artist ' + o.id);
  const m = await listMusic(env.D1_MUSIC, true);
  const out = { ok: true, canManage: true, albums: m.albums, artists: m.artists };
  if (r.id) out.id = r.id;
  return json(out);
}

export function onRequest() {
  return methodNotAllowed('GET, POST');
}
