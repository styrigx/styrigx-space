/**
 * @fileoverview 只读固定查询（2026-11 AI 语义召回）：给 styrigx-ai 的服务绑定 RPC（rpc/reader.js 的 CurioReader.query）用。
 *
 * 预先写好的参数化查询，只有这几条，模型不写 SQL（奇趣重组 PR 3 删掉了电影查询 recentMovies，movies 表随之删）：
 *   music        { q }     问句里提到的专辑名 / 歌手名（专辑名或歌手名是问句的子串，忽略大小写，至少 2 个字）→ 这些专辑和各自的曲目（曲序）；
 *                          每条带 kind（album 专辑 / single 单曲，v1.13 ②）
 * 只读音乐的元数据（专辑名、歌手、年份、曲名、曲序、时长），不读音频 / 封面本体、歌词、播放令牌。
 * 音乐在 AI 里放开（Gray 2026-11-07：站有门锁、音乐已付费）。
 * 参数先校验再 bind，查询名不在表里 → { ok:false, error:'unknown' }。出错 → { ok:false, error:'failed' }（只打日志）。
 */
import { ensureMusicSchema } from './api/_music.js';

export const QUERIES = Object.freeze(['music']);
const Q_MAX = 200;

/** @param {any} db @param {{q?: any}} p */
export async function music(db, p) {
  const q = typeof (p && p.q) === 'string' ? p.q.slice(0, Q_MAX) : '';
  if ([...q.trim()].length < 2) return { ok: true, albums: [] };
  await ensureMusicSchema(db);
  const as = await db.prepare(
    "SELECT id, title, artist, year, kind FROM music_albums WHERE (length(title) >= 2 AND instr(lower(?1), lower(title)) > 0) OR (length(artist) >= 2 AND instr(lower(?1), lower(artist)) > 0) ORDER BY pos, id LIMIT 5",
  ).bind(q).all();
  const albums = as.results || [];
  if (!albums.length) return { ok: true, albums: [] };
  const ids = albums.map((a) => a.id);
  const ts = await db.prepare(
    'SELECT album_id, no, title, duration FROM music_tracks WHERE album_id IN (' + ids.map((_, i) => '?' + (i + 1)).join(', ') + ') ORDER BY album_id, no, id',
  ).bind(...ids).all();
  /** @type {Map<number, any[]>} */
  const by = new Map();
  for (const t of ts.results || []) {
    if (!by.has(t.album_id)) by.set(t.album_id, []);
    by.get(t.album_id).push({ no: t.no, title: t.title, duration: t.duration });
  }
  return { ok: true, albums: albums.map((a) => ({ title: a.title, kind: a.kind === 'single' ? 'single' : 'album', artist: a.artist, year: a.year, tracks: (by.get(a.id) || []).slice(0, 60) })) };
}

/**
 * @param {any} env @param {string} name @param {any} params
 */
export async function runQuery(env, name, params) {
  try {
    if (name === 'music') return await music(env.D1_MUSIC, params);
    return { ok: false, error: 'unknown' };
  } catch (e) {
    console.error('[curio-reader] ' + name + ' failed: ' + (e && e.message ? String(e.message).slice(0, 200) : 'error'));
    return { ok: false, error: 'failed' };
  }
}
