/**
 * 账号云同步：设置项（外观 / 时区天气 / 搜索引擎 / Good Lock 等）跨设备同步。
 *
 * v6 会话 + 路由档（src/gate.js scopeDenial → core/route-access.js；v6 P4 起旧进站会话 + 账号会话 + 作用域 prefs.sync 删除）：
 * 没有 → 401 session。前端（lib/cloud-sync.js）遇到 401 / 403 停在「只存本机」。
 *
 * 存储：D1 styrigx-account 的 settings_sync 表（绑定 D1_ACCOUNT，migrations/0002_settings_sync.sql），一项设置一行
 *   (k, v, t, updated_at)。运行时不读 KV、没有回落。
 * - 逐项「新的赢」：t 更大的覆盖（相等不动），在 SQL 里原子完成（UPSERT ... WHERE excluded.t > settings_sync.t），
 *   两台设备同时写、或旧设备拿着旧值来写，都不会把更新的值盖掉；v=null 表示这一项被恢复默认（本地删了 key）
 * - 只收 sgx- 开头的 key（前端 lib/cloud-sync.js 的白名单决定同步哪些，锁屏 / 凭证类从来不在里面）
 * - 每次最多 80 项、值最长 600 字符、总共最多 160 项；t 不能比服务器时间快 1 分钟以上（防坏时钟把别的设备永久压住）
 * - updatedAt = 服务器最后一次真正写入的时间（MAX(updated_at)），没有数据为 0
 * - 表不存在（"no such table"，还没跑 migration）时自己补建一次再重试，同数字健康的 CREATE TABLE IF NOT EXISTS 兜底
 * - 没绑 D1_ACCOUNT → 500 config（正式 / 预览的 wrangler.toml 都绑了；缺绑定只会是配置错误）
 *
 * v6 P4-3（定稿 v5.5 §七「全站只有一份配置（头像、偏好、名片等），归站长 styrigx；root 与站长共同持有；普通用户只能看」）：
 * 读写的永远是站长那一份（uid 1000 的行；表有 uid 列时 WHERE uid = 1000，没有 uid 列时整张表本来就是 styrigx 的）。
 * 写（POST）路由档 owner（站长 + root），普通用户只能读（GET user 档）。P2 期间别的 uid 写下的行不再读写（留在表里，删不删见 PR 未决）。
 *
 * GET  /api/prefs → { ok, items, updatedAt }
 * POST /api/prefs { changes: { key: { v, t } } } → 合并后 { ok, items, updatedAt }（只接受同源）
 */
import { isSameOrigin, originDenied, json, apiError } from '../lib/http.js';
import { scopeDenial } from '../gate.js';
import { hasUidColumn } from '../lib/uid-schema.js';
import { STYRIGX_UID } from '../core/groups.js';

const KEY_RE = /^sgx-[a-z0-9-]{1,48}$/;
const MAX_ITEMS = 80;
/** 总项数上限（导入脚本也按它） */
export const MAX_TOTAL = MAX_ITEMS * 2;
const MAX_VALUE = 600;
const SKEW_MS = 60 * 1000;

/** 表结构（同 migrations/0002_settings_sync.sql） */
export const SCHEMA =
  'CREATE TABLE IF NOT EXISTS settings_sync (k TEXT NOT NULL PRIMARY KEY, v TEXT, t INTEGER NOT NULL, updated_at INTEGER NOT NULL)';

/**
 * 逐项新的赢的写入：?1 k、?2 v、?3 t、?4 updated_at、?5 总项数上限。
 * - 已有这一项：只有 excluded.t > 旧 t 才覆盖（相等 / 更旧不动），一条语句完成比较和写入，没有「先读后写」的窗口
 * - 新的一项：表里不到 ?5 项才插（并发写也超不过上限）
 * 导入脚本复用同一条（旧 KV 值不会盖掉 D1 里更新的值，重复跑幂等）。
 */
export const UPSERT_SQL =
  'INSERT INTO settings_sync (k, v, t, updated_at) SELECT ?1, ?2, ?3, ?4 ' +
  'WHERE EXISTS (SELECT 1 FROM settings_sync WHERE k = ?1) OR (SELECT COUNT(*) FROM settings_sync) < ?5 ' +
  'ON CONFLICT(k) DO UPDATE SET v = excluded.v, t = excluded.t, updated_at = excluded.updated_at WHERE excluded.t > settings_sync.t';

const SELECT_ALL = 'SELECT k, v, t, updated_at FROM settings_sync';

/** 有 uid 列时的写法（?6 = uid；每个 uid 各自 160 项上限） */
export const UPSERT_SQL_UID =
  'INSERT INTO settings_sync (uid, k, v, t, updated_at) SELECT ?6, ?1, ?2, ?3, ?4 ' +
  'WHERE EXISTS (SELECT 1 FROM settings_sync WHERE uid = ?6 AND k = ?1) OR (SELECT COUNT(*) FROM settings_sync WHERE uid = ?6) < ?5 ' +
  'ON CONFLICT(uid, k) DO UPDATE SET v = excluded.v, t = excluded.t, updated_at = excluded.updated_at WHERE excluded.t > settings_sync.t';
const SELECT_ALL_UID = 'SELECT k, v, t, updated_at FROM settings_sync WHERE uid = ?';

/**
 * 这次请求的读写方式：{ uid（恒为站长 1000）, byUid }；没有身份（不该发生：门已过）→ null。
 * @param {any} context @param {any} db
 */
async function scopeOf(context, db) {
  if (!Number.isInteger(await context.auth.dataUid())) return null;
  const byUid = await hasUidColumn(db, 'settings_sync');
  /* 一份配置，归站长（定稿 v5.5 §七）：谁读写都落到 styrigx 那份 */
  return { uid: STYRIGX_UID, byUid, blocked: false };
}

/**
 * 云同步存在 D1_ACCOUNT（D1 styrigx-account 的 settings_sync）；没绑 → 500 config。
 * @param {any} env
 */
function prefsDb(env) {
  return (env && env.D1_ACCOUNT) || null;
}

/** v6 会话 + 路由档（context.auth，见 src/gate.js headerAuth / scopeDenial）；不满足返回错误响应 @param {any} context */
async function gate(context) {
  const { env, auth } = context;
  const denied = await scopeDenial(auth, 'prefs.sync');
  if (denied) return denied;
  if (!prefsDb(env)) return apiError(500, 'config');
  return null;
}

/** @param {any} e */
function noSuchTable(e) {
  return /no such table/i.test(String((e && e.message) || e));
}

/**
 * 跑一次；表不存在就补建（CREATE TABLE IF NOT EXISTS）再跑一次。
 * @template T @param {any} db @param {() => Promise<T>} fn @returns {Promise<T>}
 */
async function withTable(db, fn) {
  try {
    return await fn();
  } catch (e) {
    if (!noSuchTable(e)) throw e;
    await db.prepare(SCHEMA).run();
    return await fn();
  }
}

/**
 * 行 → { items, updatedAt }
 * @param {any[]} rows
 */
export function rowsToPrefs(rows) {
  /** @type {Record<string, {v:string|null, t:number}>} */
  const items = {};
  let updatedAt = 0;
  for (const r of rows || []) {
    items[r.k] = { v: r.v === undefined ? null : r.v, t: Number(r.t) };
    if (Number(r.updated_at) > updatedAt) updatedAt = Number(r.updated_at);
  }
  return { items, updatedAt };
}

/**
 * 一项设置是否合法（键名、值类型 / 长度、时间）；接口和导入脚本共用。
 * @param {string} k @param {any} c @param {number} now
 * @returns {{v:string|null, t:number}|null}
 */
export function cleanItem(k, c, now) {
  if (!KEY_RE.test(k)) return null;
  if (!c || typeof c !== 'object') return null;
  const t = Number(c.t);
  if (!Number.isFinite(t) || t <= 0 || t > now + SKEW_MS) return null;
  const v = c.v;
  if (v !== null && typeof v !== 'string') return null;
  if (typeof v === 'string' && v.length > MAX_VALUE) return null;
  return { v: v, t: Math.floor(t) };
}

/**
 * 清洗客户端发来的改动；不合法的项直接丢掉（不整单拒绝）。
 * @param {any} changes
 * @param {number} now
 * @returns {Record<string, {v:string|null, t:number}>}
 */
export function cleanChanges(changes, now) {
  /** @type {Record<string, {v:string|null, t:number}>} */
  const out = {};
  if (!changes || typeof changes !== 'object') return out;
  let n = 0;
  for (const k of Object.keys(changes)) {
    if (n >= MAX_ITEMS) break;
    const c = cleanItem(k, changes[k], now);
    if (!c) continue;
    out[k] = c;
    n++;
  }
  return out;
}

/** @param {any} context */
export async function onRequestGet(context) {
  try {
    const { env } = context;
    const g = await gate(context);
    if (g) return g;
    const db = prefsDb(env);
    const sc = await scopeOf(context, db);
    if (!sc) return apiError(401, 'unauthorized');
    if (sc.blocked) return json(200, { ok: true, items: {}, updatedAt: 0 });
    let p;
    try {
      p = rowsToPrefs((await withTable(db, () => (sc.byUid ? db.prepare(SELECT_ALL_UID).bind(sc.uid) : db.prepare(SELECT_ALL)).all())).results);
    } catch (e) {
      console.error('[api/prefs] d1 error', e && /** @type {any} */ (e).message);
      return apiError(503, 'server');
    }
    return json(200, { ok: true, items: p.items, updatedAt: p.updatedAt });
  } catch (e) {
    return apiError(500, 'server');
  }
}

/** @param {any} context */
export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    if (request.method !== 'POST') return apiError(405, 'method');
    if (!isSameOrigin(request)) return originDenied();
    const g = await gate(context);
    if (g) return g;
    let body;
    try { body = await request.json(); } catch (e) { return apiError(400, 'body'); }
    const now = Date.now();
    const changes = cleanChanges(body && body.changes, now);
    const keys = Object.keys(changes);
    const db = prefsDb(env);
    const sc = await scopeOf(context, db);
    if (!sc) return apiError(401, 'unauthorized');
    if (sc.blocked) return apiError(409, 'not-ready');
    const sel = () => (sc.byUid ? db.prepare(SELECT_ALL_UID).bind(sc.uid) : db.prepare(SELECT_ALL));
    let rows;
    try {
      rows = await withTable(db, async () => {
        if (!keys.length) return (await sel().all()).results;
        /* 总项数上限：新键加上去超过 160 → 整单 413（SQL 里的 COUNT 条件再兜一次并发） */
        const haveQ = sc.byUid ? db.prepare('SELECT k FROM settings_sync WHERE uid = ?').bind(sc.uid) : db.prepare('SELECT k FROM settings_sync');
        const have = new Set(((await haveQ.all()).results || []).map((r) => r.k));
        if (have.size + keys.filter((k) => !have.has(k)).length > MAX_TOTAL) return null;
        const up = db.prepare(sc.byUid ? UPSERT_SQL_UID : UPSERT_SQL);
        const binds = (k) => (sc.byUid ? up.bind(k, changes[k].v, changes[k].t, now, MAX_TOTAL, sc.uid) : up.bind(k, changes[k].v, changes[k].t, now, MAX_TOTAL));
        const res = await db.batch([...keys.map(binds), sel()]);
        return res[res.length - 1].results;
      });
    } catch (e) {
      console.error('[api/prefs] d1 error', e && /** @type {any} */ (e).message);
      return apiError(503, 'server');
    }
    if (rows === null) return apiError(413, 'too-large');
    const p = rowsToPrefs(rows);
    return json(200, { ok: true, items: p.items, updatedAt: p.updatedAt });
  } catch (e) {
    return apiError(500, 'server');
  }
}
