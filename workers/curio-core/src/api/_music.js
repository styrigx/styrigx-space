// workers/curio-core/src/api/_music.js
// 奇趣「音乐」私人子页（/curio/music/）的数据层：表结构、权限、校验、读写、播放令牌、Range。下划线开头：不是接口。
//
// 三层（v5 S3；档在 routes.js ROUTE_ACCESS，守卫在 _auth.js，app.js 套用）：
//   歌单 / 封面 public（GET /api/music 只回元数据：专辑名、艺术家、年份、有没有封面、曲目号 / 名 / 时长；没有任何音频地址、R2 key、令牌）；
//   听 entry（进站即可，含分享链接进来的 by=link：POST /api/music-play 签令牌、GET /api/music-stream 取音频）；
//   上传 / 管理 music（进站 + 账号会话 + curio.write，与其他写接口同一套作用域）。写另要同源（403 origin）。
// 表（D1 styrigx-curio-core，绑定 D1_MUSIC；迁移 migrations/0004_movies_music.sql，MUSIC_SCHEMA 只兜底全新的库，两边一致，测试核对）：
//   music_albums  专辑：名、艺术家、年份、封面（R2_MUSIC 的 key）、排序
//   music_tracks  曲目：专辑、曲序、名、时长（秒）、音频（R2_MUSIC 的 key、类型、字节数）、可选歌词 LRC
//   music_tokens  播放令牌：随机 32 字节（crypto.getRandomValues，base64url），一张专辑一枚，10 分钟有效；
//                 有效期内可以多次 Range 请求（拖进度）。不用 HMAC、不要任何 secret。签新令牌时顺手删过期的。
// R2（绑定 R2_MUSIC，同一个桶 styrigx-curio-core）：music/<专辑 id>/<曲序>-<时间>.<扩展名>、music/<专辑 id>/cover-<时间>.<扩展名>。
//   不在 photos/ 下，照片清扫（photo-sweep.js）不碰；删专辑 / 删曲目时当场删。
// 不进全站搜索索引 / AI 召回、不进站点地图（search-index.js 不读这些表；页面 noindex）。
import { err, isSameOrigin } from './_lib.js';

export const MUSIC_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS music_albums (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, artist TEXT NOT NULL DEFAULT '', year INTEGER NOT NULL DEFAULT 0, cover TEXT NOT NULL DEFAULT '', pos INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS music_tracks (id INTEGER PRIMARY KEY AUTOINCREMENT, album_id INTEGER NOT NULL, no INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, duration INTEGER NOT NULL DEFAULT 0, r2_key TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0, lrc TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL DEFAULT 0)",
  'CREATE INDEX IF NOT EXISTS music_tracks_album ON music_tracks (album_id, no, id)',
  'CREATE TABLE IF NOT EXISTS music_tokens (token TEXT PRIMARY KEY, album_id INTEGER NOT NULL, expires_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS music_tokens_exp ON music_tokens (expires_at)',
];

/**
 * 上限：专辑 500 张、每张 200 首；名字 / 艺术家 120 字；歌词 60000 字；
 * 单个音频文件 95 MB（Workers 请求体上限 100 MB，留余量；浏览器端直传，不分片）；封面 3 MB（浏览器先缩到 1600 webp）。
 */
export const MUSIC_LIMITS = { albums: 500, tracks: 200, short: 120, lrc: 60000, trackBytes: 95 * 1024 * 1024, coverBytes: 3 * 1024 * 1024 };
/** 播放令牌有效期：10 分钟 */
export const TOKEN_TTL_MS = 10 * 60 * 1000;
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** 收的音频类型 → 扩展名（看 Content-Type；回放时原样带回 + nosniff） */
export const AUDIO_TYPES = Object.freeze({
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/flac': 'flac', 'audio/x-flac': 'flac',
  'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm',
});

/** 写（音乐的上传 / 管理 / 签播放令牌）：同源，否则 403 origin；通过返回 null。权限档在 app.js 按 routes.js ROUTE_ACCESS 套过了 */
export function musicOrigin(context) {
  return isSameOrigin(context.request) ? null : err('origin', 403);
}

const schemaDone = new WeakSet();
/** 建表（幂等） @param {any} db */
export async function ensureMusicSchema(db) {
  if (schemaDone.has(db)) return;
  await db.batch(MUSIC_SCHEMA.map((s) => db.prepare(s)));
  schemaDone.add(db);
}

function line(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function posInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 2 ** 31 ? n : 0;
}
/** 年份 0 或 1900–2100；不合格 null */
function year(v) {
  if (v === undefined || v === null || v === '' || v === 0 || v === '0') return 0;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1900 && n <= 2100 ? n : null;
}
/** 歌词：只留换行和可见字符，截断 */
export function cleanLrc(v) {
  if (typeof v !== 'string') return null;
  return v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').slice(0, MUSIC_LIMITS.lrc);
}

const L = MUSIC_LIMITS;
const ALBUM_FIELDS = {
  title: (v) => line(v, L.short) || null,
  artist: (v) => line(v, L.short),
  year,
};
const TRACK_FIELDS = {
  title: (v) => line(v, L.short) || null,
  no: (v) => { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 999 ? n : null; },
  lrc: cleanLrc,
};

function take(fields, b, all, required) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [col, fn] of Object.entries(fields)) {
    if (b[col] === undefined) { if (all && col !== required && col !== 'lrc') out[col] = col === 'artist' ? '' : 0; continue; }
    const v = fn(b[col]);
    if (v === null) return { error: 'bad-' + col };
    out[col] = v;
  }
  return { fields: out };
}

/**
 * 校验写操作：album.add {title, artist?, year?} / album.edit {id, …} / album.del {id} / track.edit {id, title?, no?, lrc?} / track.del {id}
 * @param {any} b
 */
export function parseMusicOp(b) {
  if (!b || typeof b !== 'object' || typeof b.op !== 'string') return { error: 'bad-op' };
  switch (b.op) {
    case 'album.add': {
      if (b.title === undefined) return { error: 'bad-title' };
      const r = take(ALBUM_FIELDS, b, true, 'title');
      return 'error' in r ? r : { op: b.op, fields: r.fields };
    }
    case 'album.edit':
    case 'track.edit': {
      const id = posInt(b.id);
      if (!id) return { error: 'bad-id' };
      const r = take(b.op === 'album.edit' ? ALBUM_FIELDS : TRACK_FIELDS, b, false, 'title');
      if ('error' in r) return r;
      if (!Object.keys(r.fields).length) return { error: 'nothing' };
      return { op: b.op, id, fields: r.fields };
    }
    case 'album.del':
    case 'track.del': {
      const id = posInt(b.id);
      return id ? { op: b.op, id } : { error: 'bad-id' };
    }
    default:
      return { error: 'bad-op' };
  }
}

/**
 * 全部专辑（按添加顺序，新的在后；封面横滑从第一张开始）和各自的曲目（按曲序）。只有元数据，从不带音频地址 / R2 key。
 * full（管理的人：账号 + curio.write）多给 size / type / 有没有歌词；歌词正文在签播放令牌时给。
 * @param {any} db @param {boolean} [full]
 */
export async function listAlbums(db, full = false) {
  const [as, ts] = await db.batch([
    db.prepare('SELECT id, title, artist, year, cover FROM music_albums ORDER BY pos, id'),
    db.prepare('SELECT id, album_id, no, title, duration, size, type, length(lrc) AS lrc_len FROM music_tracks ORDER BY album_id, no, id'),
  ]);
  /** @type {Map<number, any[]>} */
  const by = new Map();
  for (const t of ts.results || []) {
    if (!by.has(t.album_id)) by.set(t.album_id, []);
    const row = { id: t.id, no: t.no, title: t.title, duration: t.duration };
    by.get(t.album_id).push(full ? { ...row, size: t.size, type: t.type, lrc: (t.lrc_len || 0) > 0 } : row);
  }
  return (as.results || []).map((a) => ({ id: a.id, title: a.title, artist: a.artist, year: a.year, cover: !!a.cover, tracks: by.get(a.id) || [] }));
}

/**
 * 执行已校验的写操作。返回 {error}（not-found / limit）或 {removed:[R2_MUSIC key…], id?}（删的音频 / 封面，交给调用方从 R2 删）。
 * @param {any} db @param {any} o @param {number} [now]
 */
export async function applyMusicOp(db, o, now = Date.now()) {
  switch (o.op) {
    case 'album.add': {
      const n = await db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(pos), -1) AS p FROM music_albums').first();
      if (n && n.n >= L.albums) return { error: 'limit' };
      const f = o.fields;
      const r = await db.prepare('INSERT INTO music_albums (title, artist, year, pos, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)')
        .bind(f.title, f.artist || '', f.year || 0, (n ? n.p : -1) + 1, now).run();
      return { removed: [], id: r.meta && r.meta.last_row_id };
    }
    case 'album.edit':
    case 'track.edit': {
      const T = o.op === 'album.edit' ? 'music_albums' : 'music_tracks';
      const cur = await db.prepare(`SELECT id FROM ${T} WHERE id = ?1`).bind(o.id).first();
      if (!cur) return { error: 'not-found' };
      const cols = Object.keys(o.fields);
      const args = cols.map((c) => o.fields[c]);
      let set = cols.map((c, i) => c + ' = ?' + (i + 1)).join(', ');
      if (T === 'music_albums') { args.push(now); set += ', updated_at = ?' + args.length; }
      args.push(o.id);
      await db.prepare(`UPDATE ${T} SET ${set} WHERE id = ?${args.length}`).bind(...args).run();
      return { removed: [] };
    }
    case 'album.del': {
      const a = await db.prepare('SELECT id, cover FROM music_albums WHERE id = ?1').bind(o.id).first();
      if (!a) return { error: 'not-found' };
      const ts = await db.prepare('SELECT r2_key FROM music_tracks WHERE album_id = ?1').bind(o.id).all();
      await db.batch([
        db.prepare('DELETE FROM music_tracks WHERE album_id = ?1').bind(o.id),
        db.prepare('DELETE FROM music_tokens WHERE album_id = ?1').bind(o.id),
        db.prepare('DELETE FROM music_albums WHERE id = ?1').bind(o.id),
      ]);
      const removed = (ts.results || []).map((t) => t.r2_key).filter(Boolean);
      if (a.cover) removed.push(a.cover);
      return { removed };
    }
    case 'track.del': {
      const t = await db.prepare('SELECT id, r2_key FROM music_tracks WHERE id = ?1').bind(o.id).first();
      if (!t) return { error: 'not-found' };
      await db.prepare('DELETE FROM music_tracks WHERE id = ?1').bind(o.id).run();
      return { removed: t.r2_key ? [t.r2_key] : [] };
    }
    default:
      return { error: 'bad-op' };
  }
}

/** 随机令牌：32 字节 crypto.getRandomValues → base64url（43 字符，无填充） */
export function newToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 给一张专辑签播放令牌（顺手清掉过期的）。专辑不在 → null。
 * @param {any} db @param {number} albumId @param {number} [now]
 * @returns {Promise<{token: string, expires: number} | null>}
 */
export async function issueToken(db, albumId, now = Date.now()) {
  const a = await db.prepare('SELECT id FROM music_albums WHERE id = ?1').bind(albumId).first();
  if (!a) return null;
  const token = newToken();
  const expires = now + TOKEN_TTL_MS;
  await db.batch([
    db.prepare('DELETE FROM music_tokens WHERE expires_at <= ?1').bind(now),
    db.prepare('INSERT INTO music_tokens (token, album_id, expires_at) VALUES (?1, ?2, ?3)').bind(token, albumId, expires),
  ]);
  return { token, expires };
}

/**
 * 令牌 + 曲目 → 音频位置。令牌格式不对、不存在、过期、或曲目不属于令牌的专辑 → null。
 * @param {any} db @param {string} token @param {number} trackId @param {number} [now]
 */
export async function trackForToken(db, token, trackId, now = Date.now()) {
  if (!TOKEN_RE.test(String(token || '')) || !trackId) return null;
  return db.prepare('SELECT t.r2_key AS key, t.type AS type, t.size AS size FROM music_tokens k JOIN music_tracks t ON t.album_id = k.album_id WHERE k.token = ?1 AND t.id = ?2 AND k.expires_at > ?3')
    .bind(token, trackId, now).first();
}

/**
 * Range 头 → 读哪一段。只认单段 bytes=。
 *   没有 Range → null（整个文件 200）
 *   bytes=a-b / bytes=a- / bytes=-n → {offset, length}（b 超出就截到文件尾）
 *   格式不对、起点超出、多段 → 'invalid'（416）
 * @param {string|null} h @param {number} size
 */
export function parseRange(h, size) {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(h).trim());
  if (!m || (m[1] === '' && m[2] === '') || !(size > 0)) return 'invalid';
  if (m[1] === '') {
    const n = Math.min(Number(m[2]), size);
    if (!(n > 0)) return 'invalid';
    return { offset: size - n, length: n };
  }
  const a = Number(m[1]);
  const b = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (a >= size || b < a) return 'invalid';
  return { offset: a, length: b - a + 1 };
}

/** 曲目编号 / 文件名 → R2 key @param {number} albumId @param {number} no @param {string} ext @param {number} now */
export function trackKey(albumId, no, ext, now) {
  return `music/${albumId}/${String(no).padStart(3, '0')}-${now}.${ext}`;
}

