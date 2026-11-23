// workers/atlas-core/src/curio/api/_items.js
// 游戏（/games/api/games、/games/api/cover，奇趣重组 PR 1）的数据层：表结构、校验、读写。下划线开头：不是接口（路由表见 src/games/routes.js）。
// 文件名沿用（原来是奇趣「设备」「游戏」两栏共用）；奇趣重组 PR 3 删掉了设备（devices 表、/curio/api/items），这里只剩游戏。
//
// 表 games（D1 styrigx-atlas-core，迁移 migrations/0001_curio.sql；ITEM_SCHEMA 只兜底全新的库，两边一致，测试核对）：
//   名字、平台、版本、状态（想玩 / 在玩 / 通关 / 搁置）、评分 0–5、评价、封面（R2 key）、私密、排序。
//   device_id 列留着不重建表（原来关联设备；PR 3 起不再读写，线上由 docs/ops/2026-11-23-drop-devices-movies.sql 清零），
//   接口照旧回 device_id: 0（兼容）；写操作里带 device_id 一律忽略。
// 只存一种语言（站点作者自己写的话），不像收藏那样分中英文。
// 私密：看不到私密的（没有 games-use）看不到私密的条目。
// 封面的上传 / 读取 / 删除在 _photo.js（/games/api/cover）；写操作的接口共用部分在 _items-post.js；删条目时顺手删 R2 里的封面（applyItemOp 返回 {removed} 交给调用方删）。

import { filterPrivate } from '../../common/visibility.js';

export const ITEM_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS games (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, platform TEXT NOT NULL DEFAULT '', device_id INTEGER NOT NULL DEFAULT 0, edition TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'want', rating INTEGER NOT NULL DEFAULT 0, review TEXT NOT NULL DEFAULT '', cover TEXT NOT NULL DEFAULT '', private INTEGER NOT NULL DEFAULT 0, pos INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)",
  'CREATE INDEX IF NOT EXISTS games_status ON games (status, pos)',
];

export const GAME_STATUS = ['want', 'playing', 'done', 'shelved'];

/** 上限：游戏 2000；名字 80 字；短字段 120 字；长文本（评价）4000 字 */
export const ITEM_LIMITS = { games: 2000, name: 80, short: 120, long: 4000 };

/** 单行：去控制字符（含换行）、去首尾空白、截断 */
function line(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
/** 多行：留换行（统一成 \n），去其它控制字符，截断 */
function text(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}
function posInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 2 ** 31 ? n : 0;
}
const bool = (v) => (v === true || v === 1 ? 1 : 0);

function idList(v, max) {
  if (!Array.isArray(v) || v.length === 0 || v.length > max) return null;
  const ids = v.map(posInt);
  if (ids.some((n) => !n) || new Set(ids).size !== ids.length) return null;
  return ids;
}

/** 字段规则：[列名, 清洗函数, 错误码]；清洗返回 null 视为不合格 */
const L = ITEM_LIMITS;
const GAME_FIELDS = {
  title: (v) => line(v, L.name) || null,
  platform: (v) => line(v, L.short),
  edition: (v) => line(v, L.short),
  status: (v) => (GAME_STATUS.includes(v) ? v : null),
  rating: (v) => { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 5 ? n : null; },
  review: (v) => text(v, L.long),
  private: bool,
};
const DEFAULTS = {
  game: { platform: '', edition: '', status: 'want', rating: 0, review: '', private: 0 },
};
export const KINDS = {
  game: { table: 'games', binding: 'D1_GAMES', fields: GAME_FIELDS, required: 'title', photo: 'cover', limit: L.games },
};

/**
 * 校验写操作，返回规整后的操作或 {error}。kind = 'game'（只剩游戏；别的 kind → bad-op）。
 *   <kind>.add   {字段...}       名字（title）必填，其余缺省；device_id 等不认识的字段忽略
 *   <kind>.edit  {id, 字段...}   只改给了的字段
 *   <kind>.del   {id}
 *   <kind>.order {ids:[...]}     全部条目的新顺序
 * @param {'game'} kind
 * @param {any} b
 */
export function parseItemOp(kind, b) {
  const K = KINDS[kind];
  if (!K || !b || typeof b !== 'object' || typeof b.op !== 'string') return { error: 'bad-op' };
  const [k, verb] = b.op.split('.');
  if (k !== kind) return { error: 'bad-op' };
  const take = (all) => {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [col, fn] of Object.entries(K.fields)) {
      if (b[col] === undefined) { if (all && col !== K.required) out[col] = DEFAULTS[kind][col]; continue; }
      const v = fn(b[col]);
      if (v === null) return { error: 'bad-' + col.replace(/_/g, '-') };
      out[col] = v;
    }
    return { fields: out };
  };
  switch (verb) {
    case 'add': {
      if (b[K.required] === undefined) return { error: 'bad-' + K.required };
      const r = take(true);
      return 'error' in r ? r : { op: b.op, kind, fields: r.fields };
    }
    case 'edit': {
      const id = posInt(b.id);
      if (!id) return { error: 'bad-id' };
      const r = take(false);
      if ('error' in r) return r;
      if (!Object.keys(r.fields).length) return { error: 'nothing' };
      return { op: b.op, kind, id, fields: r.fields };
    }
    case 'del': {
      const id = posInt(b.id);
      return id ? { op: b.op, kind, id } : { error: 'bad-id' };
    }
    case 'order': {
      const ids = idList(b.ids, K.limit);
      return ids ? { op: b.op, kind, ids } : { error: 'bad-ids' };
    }
    default:
      return { error: 'bad-op' };
  }
}

/**
 * 这一种条目（game）的表所在的 D1 绑定（D1_GAMES，库 styrigx-atlas-core）；没绑返回 null
 * @param {Record<string, any>|undefined} env @param {string} kind
 */
export function itemDb(env, kind) {
  const K = KINDS[kind];
  return (env && K && env[K.binding]) || null;
}

const schemaDone = new WeakSet();
/** 建表（幂等；只兜底 games，devices 表奇趣重组 PR 3 删了，不再建） @param {any} db */
export async function ensureItemSchema(db) {
  if (schemaDone.has(db)) return;
  await db.batch(ITEM_SCHEMA.map((s) => db.prepare(s)));
  schemaDone.add(db);
}

/** 一行 → 接口里的游戏。device_id 固定回 0（列还在、不再用；保持接口字段兼容） */
function rowGame(r) {
  return {
    id: r.id, title: r.title, platform: r.platform, device_id: 0, edition: r.edition, status: r.status,
    rating: r.rating, review: r.review, cover: !!r.cover, private: !!r.private,
  };
}

/**
 * 读游戏（GET /games/api/games）：{games:[...]}（封面只给有没有，图走 /games/api/cover）。showPrivate=false：私密的不给。
 * @param {any} db  D1_GAMES
 * @param {boolean} showPrivate
 */
export async function listGames(db, showPrivate) {
  const r = await db.prepare('SELECT * FROM games ORDER BY pos, id').all();
  return { games: filterPrivate(r.results || [], showPrivate).map(rowGame) };
}

async function one(db, sql, ...args) {
  return db.prepare(sql).bind(...args).first();
}

/**
 * 执行一个已校验的写操作。返回 {error} 或 {removed: [R2 key...]}（删条目时它的封面，交给调用方从 R2 删）。
 * 错误码：not-found / limit / mismatch。
 * @param {any} db  o.kind 对应的绑定（itemDb(env, o.kind)）
 * @param {any} o  parseItemOp 的结果
 * @param {number} [now]
 */
export async function applyItemOp(db, o, now = Date.now()) {
  const K = KINDS[o.kind];
  const T = K.table;
  const verb = o.op.split('.')[1];
  switch (verb) {
    case 'add': {
      const n = await one(db, `SELECT COUNT(*) AS n, COALESCE(MAX(pos), -1) AS p FROM ${T}`);
      if (n && n.n >= K.limit) return { error: 'limit' };
      const cols = Object.keys(o.fields);
      const vals = cols.map((c) => o.fields[c]);
      cols.push('pos', 'created_at', 'updated_at');
      vals.push((n ? n.p : -1) + 1, now, now);
      const r = await db.prepare(`INSERT INTO ${T} (${cols.join(', ')}) VALUES (${cols.map((_, i) => '?' + (i + 1)).join(', ')})`).bind(...vals).run();
      return { removed: [], id: r.meta && r.meta.last_row_id };
    }
    case 'edit': {
      const cur = await one(db, `SELECT id FROM ${T} WHERE id = ?1`, o.id);
      if (!cur) return { error: 'not-found' };
      const cols = Object.keys(o.fields);
      const args = cols.map((c) => o.fields[c]);
      args.push(now, o.id);
      await db.prepare(`UPDATE ${T} SET ${cols.map((c, i) => c + ' = ?' + (i + 1)).join(', ')}, updated_at = ?${cols.length + 1} WHERE id = ?${cols.length + 2}`).bind(...args).run();
      return { removed: [] };
    }
    case 'del': {
      const cur = await one(db, `SELECT id, ${K.photo} AS photo FROM ${T} WHERE id = ?1`, o.id);
      if (!cur) return { error: 'not-found' };
      await db.prepare(`DELETE FROM ${T} WHERE id = ?1`).bind(o.id).run();
      return { removed: cur.photo ? [cur.photo] : [] };
    }
    case 'order': {
      const all = await db.prepare(`SELECT id FROM ${T}`).all();
      const have = new Set((all.results || []).map((r) => r.id));
      if (have.size !== o.ids.length || o.ids.some((id) => !have.has(id))) return { error: 'mismatch' };
      await db.batch(o.ids.map((id, i) => db.prepare(`UPDATE ${T} SET pos = ?1 WHERE id = ?2`).bind(i, id)));
      return { removed: [] };
    }
    default:
      return { error: 'bad-op' };
  }
}
