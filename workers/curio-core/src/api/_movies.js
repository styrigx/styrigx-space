// workers/curio-core/src/api/_movies.js
// 奇趣「电影」子页（/curio/movies/）的数据层：表结构、校验、读写。下划线开头：不是接口（路由表见 src/routes.js）。
//
// 表 movies（D1 styrigx-curio-core，绑定 D1_MOVIES；迁移 migrations/0004_movies_music.sql，MOVIE_SCHEMA 只兜底全新的库，两边一致，测试核对）：
//   片名、原名、年份、导演、个人评分 0–5、短评、观看日期、海报（R2 R2_PHOTOS 的 key，photos/movie/…，上传 / 读取走 /api/photo?kind=movie）、排序。
// 可见性：进门（进站会话）即可读，没有私密条目；写要账号会话 + 作用域 curio.write + 同源（同发现 / 设备 / 游戏，不新造权限）。
// 不进全站搜索索引 / AI 召回（src/search-index.js 只读 cats / links / devices / games）。

export const MOVIE_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS movies (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, original_title TEXT NOT NULL DEFAULT '', year INTEGER NOT NULL DEFAULT 0, director TEXT NOT NULL DEFAULT '', rating INTEGER NOT NULL DEFAULT 0, review TEXT NOT NULL DEFAULT '', watched_at TEXT NOT NULL DEFAULT '', poster TEXT NOT NULL DEFAULT '', pos INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)",
];

/** 上限：电影 3000 部；片名 / 原名 / 导演 120 字；短评 2000 字 */
export const MOVIE_LIMITS = { movies: 3000, short: 120, review: 2000 };

/** 照片接口（photo.js）和清扫（photo-sweep.js）用的描述：表、海报列、绑定；没有私密列 */
export const MOVIE_KIND = Object.freeze({ table: 'movies', photo: 'poster', binding: 'D1_MOVIES', hasPrivate: false });

function line(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function text(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}
/** 'YYYY-MM-DD' 真实日期或空串；不合格 null */
export function cleanDate(v) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(v + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return null;
  const y = Number(v.slice(0, 4));
  return y >= 1900 && y <= 2100 ? v : null;
}
/** 年份：0（没填）或 1880–2100 */
export function cleanYear(v) {
  if (v === undefined || v === null || v === '' || v === 0 || v === '0') return 0;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1880 && n <= 2100 ? n : null;
}
function posInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 2 ** 31 ? n : 0;
}

const L = MOVIE_LIMITS;
const FIELDS = {
  title: (v) => line(v, L.short) || null,
  original_title: (v) => line(v, L.short),
  year: cleanYear,
  director: (v) => line(v, L.short),
  rating: (v) => { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 5 ? n : null; },
  review: (v) => text(v, L.review),
  watched_at: cleanDate,
};
const DEFAULTS = { original_title: '', year: 0, director: '', rating: 0, review: '', watched_at: '' };

/**
 * 校验写操作：movie.add {字段…}（片名必填）/ movie.edit {id, 字段…}（只改给了的）/ movie.del {id}。返回规整后的操作或 {error}。
 * @param {any} b
 */
export function parseMovieOp(b) {
  if (!b || typeof b !== 'object' || typeof b.op !== 'string') return { error: 'bad-op' };
  const take = (all) => {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [col, fn] of Object.entries(FIELDS)) {
      if (b[col] === undefined) { if (all && col !== 'title') out[col] = DEFAULTS[col]; continue; }
      const v = fn(b[col]);
      if (v === null) return { error: 'bad-' + col.replace(/_/g, '-') };
      out[col] = v;
    }
    return { fields: out };
  };
  switch (b.op) {
    case 'movie.add': {
      if (b.title === undefined) return { error: 'bad-title' };
      const r = take(true);
      return 'error' in r ? r : { op: b.op, fields: r.fields };
    }
    case 'movie.edit': {
      const id = posInt(b.id);
      if (!id) return { error: 'bad-id' };
      const r = take(false);
      if ('error' in r) return r;
      if (!Object.keys(r.fields).length) return { error: 'nothing' };
      return { op: b.op, id, fields: r.fields };
    }
    case 'movie.del': {
      const id = posInt(b.id);
      return id ? { op: b.op, id } : { error: 'bad-id' };
    }
    default:
      return { error: 'bad-op' };
  }
}

const schemaDone = new WeakSet();
/** 建表（幂等） @param {any} db */
export async function ensureMovieSchema(db) {
  if (schemaDone.has(db)) return;
  await db.batch(MOVIE_SCHEMA.map((s) => db.prepare(s)));
  schemaDone.add(db);
}

function row(r) {
  return {
    id: r.id, title: r.title, original_title: r.original_title, year: r.year, director: r.director,
    rating: r.rating, review: r.review, watched_at: r.watched_at, poster: !!r.poster,
  };
}

/** 全部电影：最近看的在前（观看日期倒序，没填日期的排后面，再按添加先后） @param {any} db */
export async function listMovies(db) {
  const r = await db.prepare("SELECT * FROM movies ORDER BY (watched_at = '') ASC, watched_at DESC, pos DESC, id DESC").all();
  return (r.results || []).map(row);
}

/**
 * 执行已校验的写操作。返回 {error}（not-found / limit）或 {removed:[R2 key…], id?}（删电影时它的海报，交给调用方从 R2_PHOTOS 删）。
 * @param {any} db D1_MOVIES @param {any} o parseMovieOp 的结果 @param {number} [now]
 */
export async function applyMovieOp(db, o, now = Date.now()) {
  switch (o.op) {
    case 'movie.add': {
      const n = await db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(pos), -1) AS p FROM movies').first();
      if (n && n.n >= L.movies) return { error: 'limit' };
      const cols = Object.keys(o.fields);
      const vals = cols.map((c) => o.fields[c]);
      cols.push('pos', 'created_at', 'updated_at');
      vals.push((n ? n.p : -1) + 1, now, now);
      const r = await db.prepare(`INSERT INTO movies (${cols.join(', ')}) VALUES (${cols.map((_, i) => '?' + (i + 1)).join(', ')})`).bind(...vals).run();
      return { removed: [], id: r.meta && r.meta.last_row_id };
    }
    case 'movie.edit': {
      const cur = await db.prepare('SELECT id FROM movies WHERE id = ?1').bind(o.id).first();
      if (!cur) return { error: 'not-found' };
      const cols = Object.keys(o.fields);
      const args = cols.map((c) => o.fields[c]);
      args.push(now, o.id);
      await db.prepare(`UPDATE movies SET ${cols.map((c, i) => c + ' = ?' + (i + 1)).join(', ')}, updated_at = ?${cols.length + 1} WHERE id = ?${cols.length + 2}`).bind(...args).run();
      return { removed: [] };
    }
    case 'movie.del': {
      const cur = await db.prepare('SELECT id, poster FROM movies WHERE id = ?1').bind(o.id).first();
      if (!cur) return { error: 'not-found' };
      await db.prepare('DELETE FROM movies WHERE id = ?1').bind(o.id).run();
      return { removed: cur.poster ? [cur.poster] : [] };
    }
    default:
      return { error: 'bad-op' };
  }
}
