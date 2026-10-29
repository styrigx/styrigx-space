/**
 * 账号云同步：设置项（外观 / 时区天气 / 搜索引擎 / Good Lock 等）跨设备同步。
 *
 * 只有登录了账号（sgx-account-session）的管理员能用：先要 admin lock 会话（前置条件），再要账号会话；
 * 访客 / 没登录账号一律 401，前端停在「只存本机」。
 *
 * 存储：D1 styrigx-account 的 settings_sync 表（绑定 D1_SETTINGS_SYNC，migrations/0002_settings_sync.sql），一项设置一行
 *   (k, v, t, updated_at)。2026-10-28 之前在 KV account-prefs，旧值由 scripts/migrate-prefs-kv-to-d1.mjs 一次性导入；运行时不读 KV、没有回落。
 * - 逐项「新的赢」：t 更大的覆盖（相等不动），在 SQL 里原子完成（UPSERT ... WHERE excluded.t > settings_sync.t），
 *   两台设备同时写、或旧设备拿着旧值来写，都不会把更新的值盖掉；v=null 表示这一项被恢复默认（本地删了 key）
 * - 只收 sgx- 开头的 key（前端 lib/cloud-sync.js 的白名单决定同步哪些，锁屏 / 凭证类从来不在里面）
 * - 每次最多 80 项、值最长 600 字符、总共最多 160 项；t 不能比服务器时间快 1 分钟以上（防坏时钟把别的设备永久压住）
 * - updatedAt = 服务器最后一次真正写入的时间（MAX(updated_at)），没有数据为 0
 * - 表不存在（"no such table"，还没跑 migration）时自己补建一次再重试，同数字健康的 CREATE TABLE IF NOT EXISTS 兜底
 * - 没绑 D1_SETTINGS_SYNC → 500 config（正式 / 预览的 wrangler.toml 都绑了；缺绑定只会是配置错误）
 *
 * GET  /api/prefs → { ok, items, updatedAt }
 * POST /api/prefs { changes: { key: { v, t } } } → 合并后 { ok, items, updatedAt }（只接受同源）
 */
import { ROLE_ADMIN } from '../auth.js';
import { isSameOrigin, originDenied, json, apiError } from '../lib/http.js';

const KEY_RE = /^sgx-[a-z0-9-]{1,48}$/;
const MAX_ITEMS = 80;
/** 总项数上限（导入脚本也按它） */
export const MAX_TOTAL = MAX_ITEMS * 2;
const MAX_VALUE = 600;
const SKEW_MS = 60 * 1000;

/** 表结构（同 migrations/0002_settings_sync.sql）；导入脚本 scripts/migrate-prefs-kv-to-d1.mjs 也用这一条 */
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

/**
 * 云同步存在 D1_SETTINGS_SYNC（D1 styrigx-account 的 settings_sync）；没绑 → 500 config。
 * @param {any} env
 */
function prefsDb(env) {
  return (env && env.D1_SETTINGS_SYNC) || null;
}

/** admin lock 会话 + 账号会话（都由网关 AuthVerifier 验，见 src/auth.js）；不满足返回错误响应 @param {any} context */
async function gate(context) {
  const { env, auth } = context;
  const sess = await auth.lockSession();
  if (!sess.ok || sess.role !== ROLE_ADMIN) return apiError(401, 'session');
  const acc = await auth.accountSession();
  if (!acc.ok) return apiError(401, 'account', { reason: acc.reason });
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
    let p;
    try {
      p = rowsToPrefs((await withTable(db, () => db.prepare(SELECT_ALL).all())).results);
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
    let rows;
    try {
      rows = await withTable(db, async () => {
        if (!keys.length) return (await db.prepare(SELECT_ALL).all()).results;
        /* 总项数上限：新键加上去超过 160 → 整单 413（SQL 里的 COUNT 条件再兜一次并发） */
        const have = new Set(((await db.prepare('SELECT k FROM settings_sync').all()).results || []).map((r) => r.k));
        if (have.size + keys.filter((k) => !have.has(k)).length > MAX_TOTAL) return null;
        const up = db.prepare(UPSERT_SQL);
        const res = await db.batch([...keys.map((k) => up.bind(k, changes[k].v, changes[k].t, now, MAX_TOTAL)), db.prepare(SELECT_ALL)]);
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
