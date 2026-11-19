// workers/atlas-core/src/curio/api/_music.js
// 奇趣「音乐」私人子页（/curio/music/）的数据层：表结构、权限、校验、读写、播放令牌、Range。下划线开头：不是接口。
//
// 三层（v5 S3；档在 routes.js ROUTE_ACCESS，守卫在 _auth.js，app.js 套用）：
//   歌单 / 封面 public（GET /api/music 只回元数据：专辑名、艺术家、年份、有没有封面、曲目号 / 名 / 时长；没有任何音频地址、R2 key、令牌）；
//   听 entry（进站即可，含分享链接进来的 by=link：POST /api/music-play 签令牌、GET /api/music-stream 取音频）；
//   上传 / 管理 music（进站 + 账号会话 + curio.write，与其他写接口同一套作用域）。写另要同源（403 origin）。
// 表（D1 styrigx-atlas-core，绑定 D1_MUSIC；迁移 migrations/0001_curio.sql，MUSIC_SCHEMA 只兜底全新的库，两边一致，测试核对）：
//   music_albums  专辑：名、艺术家、年份、封面（R2_MUSIC 的 key）、排序
//   music_tracks  曲目：专辑、曲序、名、时长（秒）、音频（R2_MUSIC 的 key、类型、字节数）、可选歌词 LRC
//   music_artists 歌手（M1 起写）：名字 UNIQUE；专辑 / 曲目的 artist_id 指向它（0 = 没有歌手）。按名字对上：去掉首尾空格后完全一致，不做繁简 / 大小写合并；
//                 没有就在同一个 batch 里建。专辑的 artist 文本留作显示名；曲目没有歌手文本，歌单里的曲目歌手名取这张表。旧数据不回填（归 M4）。
//   music_tokens  播放令牌：随机 32 字节（crypto.getRandomValues，base64url），一张专辑一枚，10 分钟有效；
//                 有效期内可以多次 Range 请求（拖进度）。不用 HMAC、不要任何 secret。签新令牌时顺手删过期的。
// R2（绑定 R2_MUSIC，同一个桶 styrigx-atlas-core）：music/<专辑 id>/<曲序>-<时间>.<扩展名>、music/<专辑 id>/cover-<时间>.<扩展名>；
//   曲目移出专辑变单曲时复制的封面：music/t<曲目 id>/cover-<时间>.<扩展名>（复制在写 D1 之前，那时还没有单曲 id）。
//   不在 photos/ 下，照片清扫（photo-sweep.js）不碰；删专辑 / 删曲目时当场删。
// 不进全站搜索索引 / AI 召回、不进站点地图（search-index.js 不读这些表；页面 noindex）。
import { err, isSameOrigin } from './_lib.js';

export const MUSIC_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS music_albums (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, artist TEXT NOT NULL DEFAULT '', year INTEGER NOT NULL DEFAULT 0, cover TEXT NOT NULL DEFAULT '', pos INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'album' CHECK (kind IN ('album', 'single')), artist_id INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS music_tracks (id INTEGER PRIMARY KEY AUTOINCREMENT, album_id INTEGER NOT NULL, no INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, duration INTEGER NOT NULL DEFAULT 0, r2_key TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0, lrc TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL DEFAULT 0, artist_id INTEGER NOT NULL DEFAULT 0)",
  'CREATE INDEX IF NOT EXISTS music_tracks_album ON music_tracks (album_id, no, id)',
  'CREATE TABLE IF NOT EXISTS music_tokens (token TEXT PRIMARY KEY, album_id INTEGER NOT NULL, expires_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS music_tokens_exp ON music_tokens (expires_at)',
  "CREATE TABLE IF NOT EXISTS music_artists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, avatar TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT '', style TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)",
  'CREATE INDEX IF NOT EXISTS music_albums_kind ON music_albums (kind, pos, id)',
  'CREATE INDEX IF NOT EXISTS music_albums_artist ON music_albums (artist_id)',
  'CREATE INDEX IF NOT EXISTS music_tracks_artist ON music_tracks (artist_id)',
];

/**
 * 上限（音乐分层方案 v1.13）：专辑 100 张、单曲 500 首，按 music_albums.kind 分开算；每张专辑 200 首；名字 / 艺术家 120 字；歌词 60000 字；
 * 单个音频文件 95 MB（Workers 请求体上限 100 MB，留余量；浏览器端直传，不分片）；封面 3 MB（浏览器先缩到 1600 webp）。
 */
export const MUSIC_LIMITS = { albums: 100, singles: 500, tracks: 200, short: 120, lrc: 60000, trackBytes: 95 * 1024 * 1024, coverBytes: 3 * 1024 * 1024 };
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
/** 记录类型（迁移 0005 music_albums.kind）：album 专辑 / single 单曲（只含 1 首）；音乐 v1.13 ② 单曲 / 专辑分类 */
export const KINDS = Object.freeze(['album', 'single']);
function kindOf(v) { return KINDS.includes(v) ? v : null; }
/** 某种记录的上限：专辑 100、单曲 500 @param {string} kind */
export function kindLimit(kind) { return kind === 'single' ? L.singles : L.albums; }
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

/** 歌手名（音乐 v1.18 十一 第 4 条）：去掉首尾空格（同其他单行字段，控制字符换空格、连续空白并成一个）后按原样比对，不做繁简、大小写合并；空 = 没有歌手 */
export function artistName(v) { return line(v, L.short); }

/**
 * 校验写操作：
 *   album.add {title, artist?, year?, kind?} / album.edit {id, title?, artist?, year?, kind?} / album.del {id}
 *   track.edit {id, title?, no?, lrc?, artist?, album_id?, year?} / track.del {id}
 * kind：album（缺省）/ single；别的值 bad-kind。
 * track.edit 的 artist（M1）：曲目改歌手，写 artist_id（按名字对上 music_artists，没有就建；空 → 0）；不是字符串 bad-artist。
 * track.edit 的 album_id（M1，音乐 v1.18 7.3 / 7.6 / 十一）：正整数 = 移到这张专辑；0 = 移出变单曲；别的值 bad-album。
 * @param {any} b
 */
export function parseMusicOp(b) {
  if (!b || typeof b !== 'object' || typeof b.op !== 'string') return { error: 'bad-op' };
  switch (b.op) {
    case 'album.add': {
      if (b.title === undefined) return { error: 'bad-title' };
      if (b.artist !== undefined && typeof b.artist !== 'string') return { error: 'bad-artist' };
      const r = take(ALBUM_FIELDS, b, true, 'title');
      if ('error' in r) return r;
      const kind = b.kind === undefined ? 'album' : kindOf(b.kind);
      if (!kind) return { error: 'bad-kind' };
      return { op: b.op, fields: { ...r.fields, kind } };
    }
    case 'album.edit':
    case 'track.edit': {
      const id = posInt(b.id);
      if (!id) return { error: 'bad-id' };
      if (b.artist !== undefined && typeof b.artist !== 'string') return { error: 'bad-artist' };
      const r = take(b.op === 'album.edit' ? ALBUM_FIELDS : TRACK_FIELDS, b, false, 'title');
      if ('error' in r) return r;
      if (b.op === 'album.edit' && b.kind !== undefined) {
        const kind = kindOf(b.kind);
        if (!kind) return { error: 'bad-kind' };
        r.fields.kind = kind;
      }
      if (b.op === 'track.edit') {
        if (b.artist !== undefined) r.fields.artist = artistName(b.artist);
        /* year（M3）：只给单曲里的曲目（写进单曲记录；曲目表没有年份列）；0 或 1900–2100，别的值 bad-year */
        if (b.year !== undefined) {
          const y = year(b.year);
          if (y === null) return { error: 'bad-year' };
          r.fields.year = y;
        }
        if (b.album_id !== undefined) {
          const v = b.album_id;
          if (!(typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v)))) return { error: 'bad-album' };
          const to = Number(v) === 0 ? 0 : posInt(v);
          if (to === 0 && Number(v) !== 0) return { error: 'bad-album' };
          r.fields.album_id = to;
        }
      }
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
 * 全部记录（专辑和单曲，各带 kind；按添加顺序，新的在后；封面横滑从第一张开始）和各自的曲目（按曲序）。只有元数据，从不带音频地址 / R2 key。
 * 每首曲目带 artist（M1，十一 第 1 条）：按 music_tracks.artist_id 对 music_artists.name；0 或对不上 → ''。
 * full（管理的人：账号 + curio.write）多给 size / type / 有没有歌词；歌词正文在签播放令牌时给。
 * @param {any} db @param {boolean} [full]
 */
export async function listAlbums(db, full = false) {
  const [as, ts] = await db.batch([
    db.prepare('SELECT id, title, artist, year, cover, kind FROM music_albums ORDER BY pos, id'),
    db.prepare("SELECT t.id, t.album_id, t.no, t.title, t.duration, t.size, t.type, length(t.lrc) AS lrc_len, COALESCE(r.name, '') AS artist FROM music_tracks t LEFT JOIN music_artists r ON r.id = t.artist_id AND t.artist_id > 0 ORDER BY t.album_id, t.no, t.id"),
  ]);
  /** @type {Map<number, any[]>} */
  const by = new Map();
  for (const t of ts.results || []) {
    if (!by.has(t.album_id)) by.set(t.album_id, []);
    const row = { id: t.id, no: t.no, title: t.title, duration: t.duration, artist: t.artist || '' };
    by.get(t.album_id).push(full ? { ...row, size: t.size, type: t.type, lrc: (t.lrc_len || 0) > 0 } : row);
  }
  return (as.results || []).map((a) => ({ id: a.id, kind: a.kind === 'single' ? 'single' : 'album', title: a.title, artist: a.artist, year: a.year, cover: !!a.cover, tracks: by.get(a.id) || [] }));
}

/* ---------- 歌手 artist_id（M1，十一 第 4 条） ----------
 * 同一个 batch 里先 INSERT OR IGNORE 歌手（name UNIQUE），再用子查询取 id 写进专辑 / 曲目：歌手和引用它的那条一起提交，写失败不留空歌手。 */
const ARTIST_ID_SQL = (n) => `COALESCE((SELECT id FROM music_artists WHERE name = ?${n}), 0)`;
/** @param {any} db @param {string} name @param {number} now */
function artistUpsert(db, name, now) {
  return name ? [db.prepare('INSERT OR IGNORE INTO music_artists (name, created_at, updated_at) VALUES (?1, ?2, ?2)').bind(name, now)] : [];
}

/** 曲目移出专辑变单曲时，复制的封面放哪（复制在写 D1 之前，那时还没有单曲 id，按曲目 id 起名）@param {number} trackId @param {string} src @param {number} now */
export function copiedCoverKey(trackId, src, now) {
  const m = /\.([a-z0-9]+)$/i.exec(src || '');
  return `music/t${trackId}/cover-${now}.${m ? m[1].toLowerCase() : 'webp'}`;
}

/**
 * track.edit（M1）：改名 / 曲序 / 歌词 / 歌手 / 所属专辑，一个 batch 提交。
 *   移到专辑 album_id=N：目标要是 kind='album'（单曲 400 target-single）；就是本来那张 400 same-album；目标不在 404 album-not-found；满 200 首 409 limit。
 *     曲序缺省接在目标专辑最后（max(no)+1，≤999）。原来是单曲（移走就空了）→ 同一个 batch 删掉这条单曲记录和它的令牌，
 *     单曲旧封面放进 removed（调用方在 D1 提交成功之后才删 R2）。原来是专辑、移空了照样保留（十一 第 3 条）。
 *   移出变单曲 album_id=0：本来就是单曲 400 already-single；单曲满 500 409 limit。新单曲：名 = 曲名、歌手 = 曲目的歌手（同一个 artist_id，显示名取歌手表）、
 *     年份 = 原专辑年份、排在最后、曲序 1；封面：原专辑有封面就先在 R2 复制一份新 key（复制失败 503 storage，D1 不动），D1 写失败删掉副本。
 *   改歌手 artist：写 artist_id；曲目在单曲里时，单曲记录的歌手（文本 + artist_id）跟着改。
 *   改名 title（M3）：曲目在单曲里、没移走时，单曲记录的名跟着改（同一个 batch，列表显示的是记录名）。
 *   年份 year（M3）：只收单曲里、没移走的曲目，写进单曲记录（同一个 batch）；专辑里的曲目 / 同时移专辑 400 year-not-single
 *     （曲目表没有年份列，专辑曲目的年份跟专辑走，改专辑年份走 album.edit）。
 * @param {any} db @param {any} o @param {number} now @param {any} r2
 */
async function editTrack(db, o, now, r2) {
  const f = { ...o.fields };
  const cur = await db.prepare("SELECT t.id, t.album_id, t.title, t.artist_id, a.id AS aid, a.kind, a.year, a.cover, (SELECT COUNT(*) FROM music_tracks WHERE album_id = t.album_id) AS n_src, COALESCE(r.name, '') AS artist_name FROM music_tracks t LEFT JOIN music_albums a ON a.id = t.album_id LEFT JOIN music_artists r ON r.id = t.artist_id AND t.artist_id > 0 WHERE t.id = ?1").bind(o.id).first();
  if (!cur) return { error: 'not-found' };
  const srcSingle = cur.aid && cur.kind === 'single';
  const hasArtist = f.artist !== undefined;
  const move = f.album_id;
  const hasYear = f.year !== undefined;
  const newYear = f.year;
  delete f.artist;
  delete f.album_id;
  delete f.year;
  if (hasYear && !(srcSingle && move === undefined)) return { error: 'year-not-single' };
  /** @type {string[]} */
  const removed = [];
  let copied = '';
  let moveOut = false;

  if (move !== undefined) {
    if (move > 0) {
      if (move === cur.album_id) return { error: 'same-album' };
      const to = await db.prepare('SELECT a.id, a.kind, (SELECT COUNT(*) FROM music_tracks WHERE album_id = a.id) AS n, (SELECT COALESCE(MAX(no), 0) FROM music_tracks WHERE album_id = a.id) AS maxno FROM music_albums a WHERE a.id = ?1').bind(move).first();
      if (!to) return { error: 'album-not-found' };
      if (to.kind === 'single') return { error: 'target-single' };
      if (to.n >= L.tracks) return { error: 'limit' };
      f.album_id = move;
      if (f.no === undefined) f.no = Math.min(999, (to.maxno || 0) + 1);
    } else {
      if (srcSingle) return { error: 'already-single' };
      const n = await db.prepare("SELECT COUNT(*) AS n FROM music_albums WHERE kind = 'single'").first();
      if (n && n.n >= L.singles) return { error: 'limit' };
      moveOut = true;
      if (f.no === undefined) f.no = 1;
    }
  }

  /* 移出：封面副本在写 D1 之前复制（7.6、十一「做的时候要守住的」） */
  if (moveOut && cur.cover) {
    if (!r2) return { error: 'storage' };
    try {
      const obj = await r2.get(cur.cover);
      if (obj) {
        const key = copiedCoverKey(cur.id, cur.cover, now);
        const bytes = obj.arrayBuffer ? await obj.arrayBuffer() : obj.body;
        await r2.put(key, bytes, { httpMetadata: obj.httpMetadata || {} });
        copied = key;
      } else console.error('[curio-music] album cover missing in r2, single gets no cover');
    } catch (e) {
      if (copied) { try { await r2.delete(copied); } catch (x) { /* 只记日志 */ } }
      console.error('[curio-music] cover copy failed');
      return { error: 'storage' };
    }
  }

  const stmts = [];
  if (hasArtist) stmts.push(...artistUpsert(db, o.fields.artist, now));
  const newArtist = hasArtist ? o.fields.artist : cur.artist_name;
  if (moveOut) {
    const title = f.title !== undefined ? f.title : cur.title;
    const aidSql = hasArtist ? (newArtist ? ARTIST_ID_SQL(7) : '0') : '?7';
    const args = [title, newArtist, cur.year || 0, copied, now, 'single', hasArtist ? newArtist : (cur.artist_id || 0)];
    if (hasArtist && !newArtist) args.pop();
    stmts.push(db.prepare(`INSERT INTO music_albums (title, artist, year, cover, pos, created_at, updated_at, kind, artist_id) VALUES (?1, ?2, ?3, ?4, (SELECT COALESCE(MAX(pos), -1) + 1 FROM music_albums), ?5, ?5, ?6, ${aidSql})`).bind(...args));
  }
  /* 曲目本身 */
  const sets = [];
  const args = [];
  for (const c of Object.keys(f)) { args.push(f[c]); sets.push(`${c} = ?${args.length}`); }
  if (moveOut) sets.push('album_id = (SELECT MAX(id) FROM music_albums)');
  if (hasArtist) {
    if (newArtist) { args.push(newArtist); sets.push(`artist_id = ${ARTIST_ID_SQL(args.length)}`); } else sets.push('artist_id = 0');
  }
  args.push(o.id);
  /* 只改年份（单曲记录）时曲目本身没有要改的列 */
  if (sets.length) stmts.push(db.prepare(`UPDATE music_tracks SET ${sets.join(', ')} WHERE id = ?${args.length}`).bind(...args));
  /* 单曲里的曲目改歌手（没移走）：单曲记录的歌手跟着改 */
  if (hasArtist && srcSingle && move === undefined) {
    stmts.push(newArtist
      ? db.prepare(`UPDATE music_albums SET artist = ?1, artist_id = ${ARTIST_ID_SQL(1)}, updated_at = ?2 WHERE id = ?3`).bind(newArtist, now, cur.aid)
      : db.prepare('UPDATE music_albums SET artist = ?1, artist_id = 0, updated_at = ?2 WHERE id = ?3').bind('', now, cur.aid));
  }
  /* 单曲里的曲目改名 / 改年份（没移走）：单曲记录的名、年份跟着改（M3，同一个 batch，失败一起回滚） */
  if (srcSingle && move === undefined && (f.title !== undefined || hasYear)) {
    const as = [];
    const aa = [];
    if (f.title !== undefined) { aa.push(f.title); as.push(`title = ?${aa.length}`); }
    if (hasYear) { aa.push(newYear); as.push(`year = ?${aa.length}`); }
    aa.push(now); as.push(`updated_at = ?${aa.length}`);
    aa.push(cur.aid);
    stmts.push(db.prepare(`UPDATE music_albums SET ${as.join(', ')} WHERE id = ?${aa.length}`).bind(...aa));
  }
  /* 单曲划进专辑：空单曲记录（和令牌）同一个 batch 删；旧封面等提交成功后由调用方删 */
  if (move > 0 && srcSingle && cur.n_src <= 1) {
    stmts.push(db.prepare('DELETE FROM music_tokens WHERE album_id = ?1').bind(cur.aid));
    stmts.push(db.prepare("DELETE FROM music_albums WHERE id = ?1 AND kind = 'single' AND NOT EXISTS (SELECT 1 FROM music_tracks WHERE album_id = ?1)").bind(cur.aid));
    if (cur.cover) removed.push(cur.cover);
  }

  let out;
  try {
    out = await db.batch(stmts);
  } catch (e) {
    /* D1 写失败：删掉刚复制的封面副本（不留孤儿）；单曲旧封面没动 */
    if (copied) { try { await r2.delete(copied); } catch (x) { console.error('[curio-music] cover copy cleanup failed'); } }
    throw e;
  }
  if (moveOut) {
    const ins = out[stmts.length - 2];
    return { removed, id: ins && ins.meta && ins.meta.last_row_id };
  }
  return { removed };
}

/**
 * 执行已校验的写操作。返回 {error}（not-found / limit / single-tracks / same-album / target-single / already-single / album-not-found / storage）
 * 或 {removed:[R2_MUSIC key…], id?}（删的音频 / 封面，交给调用方在 D1 提交之后从 R2 删）。
 * r2：track.edit 移出变单曲要复制封面时用（R2_MUSIC）。
 * @param {any} db @param {any} o @param {number} [now] @param {any} [r2]
 */
export async function applyMusicOp(db, o, now = Date.now(), r2 = null) {
  switch (o.op) {
    case 'album.add': {
      const f = o.fields;
      const kind = f.kind === 'single' ? 'single' : 'album';
      /* 上限按 kind 分开算：专辑 100、单曲 500 */
      const n = await db.prepare('SELECT SUM(kind = ?1) AS n, COALESCE(MAX(pos), -1) AS p FROM music_albums').bind(kind).first();
      if (n && n.n >= kindLimit(kind)) return { error: 'limit' };
      const artist = f.artist || '';
      const res = await db.batch([
        ...artistUpsert(db, artist, now),
        db.prepare(`INSERT INTO music_albums (title, artist, year, pos, created_at, updated_at, kind, artist_id) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ${artist ? ARTIST_ID_SQL(2) : '0'})`)
          .bind(f.title, artist, f.year || 0, (n ? n.p : -1) + 1, now, kind),
      ]);
      const r = res[res.length - 1];
      return { removed: [], id: r && r.meta && r.meta.last_row_id };
    }
    case 'album.edit': {
      const cur = await db.prepare('SELECT id, kind FROM music_albums WHERE id = ?1').bind(o.id).first();
      if (!cur) return { error: 'not-found' };
      /* 改 kind（Gray 2026-11-14 17:33）：专辑 → 单曲只在 ≤1 首时可以（否则 409 single-tracks）；单曲 → 专辑直接转；
         两个方向都按目标那边的上限算（专辑 100、单曲 500），超限 409 limit。和原来一样就当没改 */
      if (o.fields.kind !== undefined) {
        const to = o.fields.kind;
        if (to === (cur.kind === 'single' ? 'single' : 'album')) delete o.fields.kind;
        else {
          if (to === 'single') {
            const t = await db.prepare('SELECT COUNT(*) AS n FROM music_tracks WHERE album_id = ?1').bind(o.id).first();
            if (t && t.n > 1) return { error: 'single-tracks' };
          }
          const n = await db.prepare('SELECT SUM(kind = ?1) AS n FROM music_albums').bind(to).first();
          if (n && n.n >= kindLimit(to)) return { error: 'limit' };
        }
        if (!Object.keys(o.fields).length) return { removed: [] };
      }
      const cols = Object.keys(o.fields);
      const args = cols.map((c) => o.fields[c]);
      const sets = cols.map((c, i) => c + ' = ?' + (i + 1));
      const hasArtist = o.fields.artist !== undefined;
      const artist = hasArtist ? o.fields.artist : '';
      /* 改歌手：artist 文本留作显示名，artist_id 按名字对上 music_artists（没有就建；空 → 0）（M1） */
      if (hasArtist) sets.push('artist_id = ' + (artist ? ARTIST_ID_SQL(cols.indexOf('artist') + 1) : '0'));
      args.push(now); sets.push('updated_at = ?' + args.length);
      args.push(o.id);
      const stmts = [...(hasArtist ? artistUpsert(db, artist, now) : []), db.prepare(`UPDATE music_albums SET ${sets.join(', ')} WHERE id = ?${args.length}`).bind(...args)];
      /* 单曲记录改歌手：它那一首曲目的 artist_id 跟着改（单曲的歌手就是曲目的歌手） */
      const single = o.fields.kind !== undefined ? o.fields.kind === 'single' : cur.kind === 'single';
      if (hasArtist && single) {
        stmts.push(artist
          ? db.prepare(`UPDATE music_tracks SET artist_id = ${ARTIST_ID_SQL(1)} WHERE album_id = ?2`).bind(artist, o.id)
          : db.prepare('UPDATE music_tracks SET artist_id = 0 WHERE album_id = ?1').bind(o.id));
      }
      await db.batch(stmts);
      return { removed: [] };
    }
    case 'track.edit':
      return editTrack(db, o, now, r2);
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
      /* M3（十二 M3 第 4 条）：删的是单曲唯一一首 → 空单曲记录（和令牌）同一个 batch 删，它的封面 R2 文件也交给调用方删
         （与 M1 单曲划进专辑同一口径；D1 提交成功之后才删 R2）。权限仍是 track.del 那一档（curio-write），不走 album.del 的 root。
         专辑里删到空照样保留专辑（十一 第 3 条）。 */
      const t = await db.prepare("SELECT t.id, t.r2_key, t.album_id, a.kind, a.cover, (SELECT COUNT(*) FROM music_tracks WHERE album_id = t.album_id) AS n FROM music_tracks t LEFT JOIN music_albums a ON a.id = t.album_id WHERE t.id = ?1").bind(o.id).first();
      if (!t) return { error: 'not-found' };
      const stmts = [db.prepare('DELETE FROM music_tracks WHERE id = ?1').bind(o.id)];
      const lastOfSingle = t.kind === 'single' && t.n <= 1;
      if (lastOfSingle) {
        stmts.push(db.prepare('DELETE FROM music_tokens WHERE album_id = ?1').bind(t.album_id));
        stmts.push(db.prepare("DELETE FROM music_albums WHERE id = ?1 AND kind = 'single' AND NOT EXISTS (SELECT 1 FROM music_tracks WHERE album_id = ?1)").bind(t.album_id));
      }
      await db.batch(stmts);
      const removed = t.r2_key ? [t.r2_key] : [];
      if (lastOfSingle && t.cover) removed.push(t.cover);
      return { removed };
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

