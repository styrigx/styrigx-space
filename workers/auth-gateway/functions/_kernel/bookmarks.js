/**
 * @fileoverview 书签（D1 版）：表结构、校验、读写。接口在 functions/api/bookmarks.js。
 *
 * 表（SGX_D1 = styrigx-sgx，迁移 migrations/0003_bookmarks.sql，代码里也有 IF NOT EXISTS 兜底）：
 *   bm_cat  分类：id、中英文名、排序
 *   bm_link 书签：id、所属分类、网址、中英文名、中英文简介、图标网址、排序、时间
 *   bm_meta 标记：seeded=1 表示已经从 links.yaml 导入过（之后删光也不会再导入）
 *
 * 中英文：名字/简介各两份；英文留空时前端显示中文（反之亦然），所以新增时只填一种也行。
 */
import { BOOKMARKS_SEED } from './bookmarks-seed.js';

export const BM_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS bm_cat (id INTEGER PRIMARY KEY AUTOINCREMENT, name_zh TEXT NOT NULL DEFAULT \'\', name_en TEXT NOT NULL DEFAULT \'\', pos INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS bm_link (id INTEGER PRIMARY KEY AUTOINCREMENT, cat_id INTEGER NOT NULL, url TEXT NOT NULL, name_zh TEXT NOT NULL DEFAULT \'\', name_en TEXT NOT NULL DEFAULT \'\', desc_zh TEXT NOT NULL DEFAULT \'\', desc_en TEXT NOT NULL DEFAULT \'\', icon TEXT NOT NULL DEFAULT \'\', pos INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)',
  'CREATE INDEX IF NOT EXISTS bm_link_cat ON bm_link (cat_id, pos)',
  'CREATE TABLE IF NOT EXISTS bm_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)',
];

/** 上限：分类 50、书签 500、名字 40 字、简介 80 字、网址 2048 字符 */
export const BM_LIMITS = { cats: 50, links: 500, name: 40, desc: 80, url: 2048 };

/** 去控制字符、去首尾空白、截断 */
export function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

/**
 * 只收 http/https、不带账号密码的网址；返回规整后的字符串，不合格返回 ''。
 * @param {unknown} v
 */
export function cleanUrl(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!s || s.length > BM_LIMITS.url) return '';
  let u;
  try {
    u = new URL(s);
  } catch (e) {
    return '';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  if (u.username || u.password) return '';
  return u.href;
}

/** 图标网址：只收 https，或空 */
export function cleanIcon(v) {
  const u = cleanUrl(v);
  return u.startsWith('https://') ? u : '';
}

/**
 * {zh,en} 双语字段；至少一种非空（required 时）。
 * @param {any} v
 * @param {number} max
 * @param {boolean} required
 * @returns {{zh:string,en:string}|null}
 */
export function cleanPair(v, max, required) {
  if (typeof v === 'string') v = { zh: v, en: '' };
  if (!v || typeof v !== 'object') return required ? null : { zh: '', en: '' };
  const zh = cleanText(v.zh, max);
  const en = cleanText(v.en, max);
  if (required && !zh && !en) return null;
  return { zh, en };
}

function posInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 2 ** 31 ? n : 0;
}

function idList(v, max) {
  if (!Array.isArray(v) || v.length === 0 || v.length > max) return null;
  const ids = v.map(posInt);
  if (ids.some((n) => !n) || new Set(ids).size !== ids.length) return null;
  return ids;
}

/**
 * 校验写操作，返回规整后的操作或 {error}。
 * 支持：
 *   cat.add    {name:{zh,en}}
 *   cat.edit   {id, name}
 *   cat.del    {id}                 分类里还有书签 → not-empty
 *   cat.order  {ids:[...]}          全部分类的新顺序
 *   link.add   {cat, url, name, desc?, icon?}
 *   link.edit  {id, cat?, url?, name?, desc?, icon?}   只改给了的字段
 *   link.del   {id}
 *   link.order {cat, ids:[...]}     这个分类里全部书签的新顺序
 * @param {any} b
 */
export function parseOp(b) {
  if (!b || typeof b !== 'object' || typeof b.op !== 'string') return { error: 'bad-op' };
  const L = BM_LIMITS;
  switch (b.op) {
    case 'cat.add': {
      const name = cleanPair(b.name, L.name, true);
      return name ? { op: b.op, name } : { error: 'bad-name' };
    }
    case 'cat.edit': {
      const id = posInt(b.id);
      const name = cleanPair(b.name, L.name, true);
      if (!id) return { error: 'bad-id' };
      return name ? { op: b.op, id, name } : { error: 'bad-name' };
    }
    case 'cat.del':
    case 'link.del': {
      const id = posInt(b.id);
      return id ? { op: b.op, id } : { error: 'bad-id' };
    }
    case 'cat.order': {
      const ids = idList(b.ids, L.cats);
      return ids ? { op: b.op, ids } : { error: 'bad-ids' };
    }
    case 'link.order': {
      const cat = posInt(b.cat);
      const ids = idList(b.ids, L.links);
      if (!cat) return { error: 'bad-cat' };
      return ids ? { op: b.op, cat, ids } : { error: 'bad-ids' };
    }
    case 'link.add': {
      const cat = posInt(b.cat);
      const url = cleanUrl(b.url);
      const name = cleanPair(b.name, L.name, true);
      if (!cat) return { error: 'bad-cat' };
      if (!url) return { error: 'bad-url' };
      if (!name) return { error: 'bad-name' };
      return { op: b.op, cat, url, name, desc: cleanPair(b.desc, L.desc, false), icon: cleanIcon(b.icon) };
    }
    case 'link.edit': {
      const id = posInt(b.id);
      if (!id) return { error: 'bad-id' };
      /** @type {any} */
      const out = { op: b.op, id };
      if (b.cat !== undefined) { out.cat = posInt(b.cat); if (!out.cat) return { error: 'bad-cat' }; }
      if (b.url !== undefined) { out.url = cleanUrl(b.url); if (!out.url) return { error: 'bad-url' }; }
      if (b.name !== undefined) { out.name = cleanPair(b.name, L.name, true); if (!out.name) return { error: 'bad-name' }; }
      if (b.desc !== undefined) out.desc = cleanPair(b.desc, L.desc, false);
      if (b.icon !== undefined) out.icon = cleanIcon(b.icon);
      if (Object.keys(out).length === 2) return { error: 'nothing' };
      return out;
    }
    default:
      return { error: 'bad-op' };
  }
}

/** 同一个 Worker 实例里建过表就不再建（每个 db 对象记一次） */
const schemaDone = new WeakSet();

/** 建表（幂等） */
export async function ensureSchema(db) {
  if (schemaDone.has(db)) return;
  await db.batch(BM_SCHEMA.map((s) => db.prepare(s)));
  schemaDone.add(db);
}

/**
 * 第一次读时导入 links.yaml 的种子。先抢 seeded 标记（INSERT OR IGNORE），抢到的那一次才写，
 * 两个请求同时来也只导入一次；导入过以后删光了也不会再导入。
 * @param {any} db
 * @param {number} [now]
 * @param {any[]} [seed]
 */
export async function seedIfNeeded(db, now = Date.now(), seed = BOOKMARKS_SEED) {
  const got = await db.prepare("INSERT OR IGNORE INTO bm_meta (k, v) VALUES ('seeded', ?1)").bind(String(now)).run();
  const changes = got && got.meta ? Number(got.meta.changes) : 0;
  if (changes !== 1) return false;
  const stmts = [];
  seed.forEach((c, i) => {
    const cid = i + 1;
    /* 种子在空表里写，id 直接用 1..N，书签按分类挂上 */
    stmts.push(db.prepare('INSERT INTO bm_cat (id, name_zh, name_en, pos) VALUES (?1, ?2, ?3, ?4)').bind(cid, c.name.zh, c.name.en, i));
    c.links.forEach((l, j) => {
      stmts.push(
        db.prepare('INSERT INTO bm_link (cat_id, url, name_zh, name_en, desc_zh, desc_en, icon, pos, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, \'\', ?7, ?8, ?8)')
          .bind(cid, l.url, l.name.zh, l.name.en, l.desc.zh, l.desc.en, j, now)
      );
    });
  });
  if (stmts.length) await db.batch(stmts);
  return true;
}

/**
 * 读全部书签，组成 [{id, name:{zh,en}, links:[{id,url,name,desc,icon}]}]。
 * @param {any} db
 */
export async function listAll(db) {
  const [cats, links] = await db.batch([
    db.prepare('SELECT id, name_zh, name_en FROM bm_cat ORDER BY pos, id'),
    db.prepare('SELECT id, cat_id, url, name_zh, name_en, desc_zh, desc_en, icon FROM bm_link ORDER BY pos, id'),
  ]);
  /** @type {Map<number, any>} */
  const byId = new Map();
  const out = [];
  for (const r of cats.results || []) {
    const c = { id: r.id, name: { zh: r.name_zh, en: r.name_en }, links: [] };
    byId.set(r.id, c);
    out.push(c);
  }
  for (const r of links.results || []) {
    const c = byId.get(r.cat_id);
    if (!c) continue;
    c.links.push({ id: r.id, url: r.url, name: { zh: r.name_zh, en: r.name_en }, desc: { zh: r.desc_zh, en: r.desc_en }, icon: r.icon });
  }
  return out;
}

async function one(db, sql, ...args) {
  return db.prepare(sql).bind(...args).first();
}

/**
 * 执行一个已校验的写操作。返回 null 表示成功，否则返回错误码（not-found / not-empty / limit / mismatch）。
 * @param {any} db
 * @param {any} o  parseOp 的结果
 * @param {number} [now]
 */
export async function applyOp(db, o, now = Date.now()) {
  switch (o.op) {
    case 'cat.add': {
      const n = await one(db, 'SELECT COUNT(*) AS n, COALESCE(MAX(pos), -1) AS p FROM bm_cat');
      if (n && n.n >= BM_LIMITS.cats) return 'limit';
      await db.prepare('INSERT INTO bm_cat (name_zh, name_en, pos) VALUES (?1, ?2, ?3)').bind(o.name.zh, o.name.en, (n ? n.p : -1) + 1).run();
      return null;
    }
    case 'cat.edit': {
      const r = await db.prepare('UPDATE bm_cat SET name_zh = ?1, name_en = ?2 WHERE id = ?3').bind(o.name.zh, o.name.en, o.id).run();
      return r.meta && r.meta.changes ? null : 'not-found';
    }
    case 'cat.del': {
      const used = await one(db, 'SELECT COUNT(*) AS n FROM bm_link WHERE cat_id = ?1', o.id);
      if (used && used.n > 0) return 'not-empty';
      const r = await db.prepare('DELETE FROM bm_cat WHERE id = ?1').bind(o.id).run();
      return r.meta && r.meta.changes ? null : 'not-found';
    }
    case 'cat.order': {
      const all = await db.prepare('SELECT id FROM bm_cat').all();
      const have = new Set((all.results || []).map((r) => r.id));
      if (have.size !== o.ids.length || o.ids.some((id) => !have.has(id))) return 'mismatch';
      await db.batch(o.ids.map((id, i) => db.prepare('UPDATE bm_cat SET pos = ?1 WHERE id = ?2').bind(i, id)));
      return null;
    }
    case 'link.add': {
      const cat = await one(db, 'SELECT id FROM bm_cat WHERE id = ?1', o.cat);
      if (!cat) return 'not-found';
      const n = await one(db, 'SELECT COUNT(*) AS n FROM bm_link');
      if (n && n.n >= BM_LIMITS.links) return 'limit';
      const p = await one(db, 'SELECT COALESCE(MAX(pos), -1) AS p FROM bm_link WHERE cat_id = ?1', o.cat);
      await db
        .prepare('INSERT INTO bm_link (cat_id, url, name_zh, name_en, desc_zh, desc_en, icon, pos, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)')
        .bind(o.cat, o.url, o.name.zh, o.name.en, o.desc.zh, o.desc.en, o.icon, (p ? p.p : -1) + 1, now)
        .run();
      return null;
    }
    case 'link.edit': {
      const cur = await one(db, 'SELECT id, cat_id FROM bm_link WHERE id = ?1', o.id);
      if (!cur) return 'not-found';
      const sets = [];
      const args = [];
      const add = (col, v) => { args.push(v); sets.push(col + ' = ?' + args.length); };
      if (o.cat && o.cat !== cur.cat_id) {
        const cat = await one(db, 'SELECT id FROM bm_cat WHERE id = ?1', o.cat);
        if (!cat) return 'not-found';
        const p = await one(db, 'SELECT COALESCE(MAX(pos), -1) AS p FROM bm_link WHERE cat_id = ?1', o.cat);
        add('cat_id', o.cat);
        add('pos', (p ? p.p : -1) + 1); /* 换分类 → 排到新分类最后 */
      }
      if (o.url) add('url', o.url);
      if (o.name) { add('name_zh', o.name.zh); add('name_en', o.name.en); }
      if (o.desc) { add('desc_zh', o.desc.zh); add('desc_en', o.desc.en); }
      if (o.icon !== undefined) add('icon', o.icon);
      add('updated_at', now);
      args.push(o.id);
      await db.prepare('UPDATE bm_link SET ' + sets.join(', ') + ' WHERE id = ?' + args.length).bind(...args).run();
      return null;
    }
    case 'link.del': {
      const r = await db.prepare('DELETE FROM bm_link WHERE id = ?1').bind(o.id).run();
      return r.meta && r.meta.changes ? null : 'not-found';
    }
    case 'link.order': {
      const all = await db.prepare('SELECT id FROM bm_link WHERE cat_id = ?1').bind(o.cat).all();
      const have = new Set((all.results || []).map((r) => r.id));
      if (have.size !== o.ids.length || o.ids.some((id) => !have.has(id))) return 'mismatch';
      await db.batch(o.ids.map((id, i) => db.prepare('UPDATE bm_link SET pos = ?1 WHERE id = ?2').bind(i, id)));
      return null;
    }
    default:
      return 'bad-op';
  }
}
