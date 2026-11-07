/**
 * 应用授权记录（P3-1，第 3 件；设计方案 2.4、2.5、4.3、4.7）：账号库 D1 styrigx-account 的 app_grant 表（migrations/0004_app_grant.sql）。
 *
 * - 一行一个应用（app = 作用域表 scopes.js 的应用 id = 授权卡 id），record = {"v":1,"scopes":[...],"deviceId","by"}，granted_at = 毫秒。
 *   取消授权 = DELETE（只降权）；重新授权 = 写回这一行。授权没有过期，不归设备清扫（sweepExpired）管。
 * - 种子（ensureSeed）：表里一行都没有、且 data_migration 没有 SEED_MARK 时，同一个 db.batch 写满全部应用 + 这条标记。
 *   之后用户取消到 0 行也不会再种。触发点只有两处，共用这一份：授权卡页 grant-list、登录完成后的授权检查（同意流程也走 grant-list）。
 *   以后加应用：scopes.js 加一行，这里在 SEED_SUPPLEMENTS 按版本号补种（只种新增的应用）：
 *   app-grant-seed-2（2026-11-07）补「个人资料」profile。补种和首次种子同一个触发点（ensureSeed），各自一条标记，只种一次；
 *   用户以后取消了也不会再种。首次种子本身已经写满全部应用（含新应用），同一次也把补种标记写上。
 * - readGrantState：grantedScopes 用的只读查询（标记 + 全部行 + 还没补种的新应用），不写。没有标记 = 还没切换（骨架模式，见 authz.js）。
 *   已切换但某条补种标记还没写（上线到首次打开授权卡页 / 再次登录之间）：那批新应用按已授权算（pending），同首次切换的骨架行为，
 *   上线后新接口不会先 403 scope。
 *
 * D1 读主库、不缓存（「取消后网关下次请求即拦截」靠的就是这个）。出错一律抛，调用方 fail closed。
 * 表不存在（迁移没跑的库）：onAuthDb 按 GRANT_DB_REALM.schema 建表后重试一次。
 *
 * 只 import workers/account/src/lib/ 和本目录。
 */
import { onAuthDb } from '../lib/d1-state.js';
import { ACCOUNT_AUTH_SCHEMA, ACCOUNT_DB_REALM } from './account-store.js';
import { SCOPES, knownScopes } from './scopes.js';

/** 与 migrations/0004_app_grant.sql 一致的建表语句（兜底建表用；tests/workers/account/app-grant.test.mjs 核对） */
export const APP_GRANT_SCHEMA = Object.freeze([
  'CREATE TABLE IF NOT EXISTS app_grant (app TEXT PRIMARY KEY, record TEXT NOT NULL, granted_at INTEGER NOT NULL)',
]);

/** 本模块用的账号域：兜底建表 = 0003 全部 + 0004（data_migration 在 0003 里） */
const GRANT_DB_REALM = Object.freeze(Object.assign({}, ACCOUNT_DB_REALM, { schema: Object.freeze(ACCOUNT_AUTH_SCHEMA.concat(APP_GRANT_SCHEMA)) }));

/** 首次切换的种子标记（data_migration.name） */
export const SEED_MARK = 'app-grant-seed-1';

/**
 * 首次切换之后新增应用的补种（按版本号，一条标记一批应用；应用必须在作用域表里）。
 * @type {ReadonlyArray<Readonly<{mark: string, apps: ReadonlyArray<string>}>>}
 */
export const SEED_SUPPLEMENTS = Object.freeze([
  Object.freeze({ mark: 'app-grant-seed-2', apps: Object.freeze(['profile']) }),
]);

/** record 版本 */
const RECORD_V = 1;

/** 全部应用 id，按作用域表顺序（= 授权卡顺序） */
export const APP_IDS = Object.freeze(SCOPES.map((s) => s.app).filter((a, i, all) => all.indexOf(a) === i));

/** @param {any} app */
export function isAppId(app) {
  return typeof app === 'string' && APP_IDS.indexOf(app) !== -1;
}

/** 某应用在作用域表里的全部作用域（按字母排序） @param {string} app */
export function scopesOfApp(app) {
  return knownScopes(SCOPES.filter((s) => s.app === app).map((s) => s.id));
}

/**
 * 一行的 record（JSON 字符串）。
 * @param {string} app @param {string} deviceId @param {string} by
 */
function recordJson(app, deviceId, by) {
  return JSON.stringify({ v: RECORD_V, scopes: scopesOfApp(app), deviceId: String(deviceId || ''), by: String(by || '') });
}

/** @param {any} row @returns {{app:string, scopes:string[], deviceId:string, by:string, grantedAt:number}|null} */
function parseRow(row) {
  if (!row || typeof row.app !== 'string') return null;
  /** @type {any} */
  let rec = null;
  try { rec = JSON.parse(String(row.record)); } catch (e) { rec = null; }
  if (!rec || typeof rec !== 'object') rec = {};
  return {
    app: row.app,
    scopes: knownScopes(rec.scopes),
    deviceId: typeof rec.deviceId === 'string' ? rec.deviceId : '',
    by: typeof rec.by === 'string' ? rec.by : '',
    grantedAt: Number(row.granted_at) || 0,
  };
}

/**
 * 授权状态（只读）：有没有种子标记 + 全部授权行。D1 出错抛错。
 * @param {any} env
 * @returns {Promise<{seeded: boolean, rows: Array<{app:string, scopes:string[], deviceId:string, by:string, grantedAt:number}>}>}
 */
export async function readGrantState(env) {
  return onAuthDb(env, GRANT_DB_REALM, async (db) => {
    const mark = await db.prepare('SELECT 1 AS x FROM data_migration WHERE name = ?').bind(SEED_MARK).first();
    const res = await db.prepare('SELECT app, record, granted_at FROM app_grant ORDER BY app').all();
    const rows = ((res && res.results) || []).map(parseRow).filter((r) => r && isAppId(r.app));
    /** @type {string[]} */
    const pending = [];
    if (mark) {
      for (const sup of SEED_SUPPLEMENTS) {
        const m = await db.prepare('SELECT 1 AS x FROM data_migration WHERE name = ?').bind(sup.mark).first();
        if (!m) for (const app of sup.apps) if (isAppId(app) && pending.indexOf(app) === -1) pending.push(app);
      }
    }
    return { seeded: !!mark, rows: /** @type {any} */ (rows), pending };
  });
}

/**
 * 首次切换的幂等种子：表空且没有标记 → 同一个 batch 写满全部应用 + 标记；已有标记（哪怕 0 行）→ 什么都不写。
 * 两条语句在一个 batch（一个事务）里，条件写在 SQL 里（INSERT ... SELECT ... WHERE NOT EXISTS），并发两次也只种一次。
 * 表里已有行但没有标记（不该出现）：不动已有行，只补标记。
 * @param {any} env
 * @param {{deviceId?: string, by?: string}} [who] 触发种子的账号会话（写进 record 作审计）
 * @returns {Promise<boolean>} 这次是否真的种了
 * D1 出错抛错。
 */
export async function ensureSeed(env, who) {
  const deviceId = (who && who.deviceId) || '';
  const by = (who && who.by) || '';
  return onAuthDb(env, GRANT_DB_REALM, async (db) => {
    const mark = await db.prepare('SELECT 1 AS x FROM data_migration WHERE name = ?').bind(SEED_MARK).first();
    if (mark) {
      await ensureSupplements(db, deviceId, by, true);
      return false;
    }
    const now = Date.now();
    const values = APP_IDS.map(() => '(?, ?, ?)').join(', ');
    /** @type {any[]} */
    const params = [];
    for (const app of APP_IDS) params.push(app, recordJson(app, deviceId, by), now);
    const out = await db.batch([
      db.prepare(
        'INSERT INTO app_grant (app, record, granted_at) SELECT column1, column2, column3 FROM (VALUES ' + values + ') ' +
        'WHERE NOT EXISTS (SELECT 1 FROM data_migration WHERE name = ?) AND NOT EXISTS (SELECT 1 FROM app_grant)'
      ).bind(...params, SEED_MARK),
      db.prepare('INSERT OR IGNORE INTO data_migration (name, migrated_at) VALUES (?, ?)').bind(SEED_MARK, now),
    ]);
    const changes = out && out[0] && out[0].meta ? Number(out[0].meta.changes) || 0 : 0;
    /* 首次种子刚写满全部应用（含新应用），或表里本来就有行（不该出现，不动）：补种只写标记，不加行 */
    await ensureSupplements(db, deviceId, by, false);
    return changes > 0;
  });
}

/**
 * 补种（SEED_SUPPLEMENTS）：每条标记还没写的，同一个 batch 补上这批应用的行（已有行不动：INSERT OR IGNORE）+ 写标记。
 * addRows=false（首次种子在同一次调用里刚跑）：只写标记。条件写在 SQL 里，并发也只种一次。
 * @param {any} db @param {string} deviceId @param {string} by @param {boolean} addRows
 */
async function ensureSupplements(db, deviceId, by, addRows) {
  for (const sup of SEED_SUPPLEMENTS) {
    const done = await db.prepare('SELECT 1 AS x FROM data_migration WHERE name = ?').bind(sup.mark).first();
    if (done) continue;
    const now = Date.now();
    const apps = addRows ? sup.apps.filter(isAppId) : [];
    const stmts = apps.map((app) => db.prepare(
      'INSERT OR IGNORE INTO app_grant (app, record, granted_at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM data_migration WHERE name = ?)'
    ).bind(app, recordJson(app, deviceId, by), now, sup.mark));
    stmts.push(db.prepare('INSERT OR IGNORE INTO data_migration (name, migrated_at) VALUES (?, ?)').bind(sup.mark, now));
    await db.batch(stmts);
  }
}

/**
 * 授权（写回 / 覆盖一行）。D1 出错抛错。
 * @param {any} env @param {string} app @param {{deviceId?: string, by?: string}} [who]
 */
export async function addGrant(env, app, who) {
  if (!isAppId(app)) throw new Error('app-grant: bad app');
  const rec = recordJson(app, (who && who.deviceId) || '', (who && who.by) || '');
  await onAuthDb(env, GRANT_DB_REALM, (db) => db.prepare(
    'INSERT INTO app_grant (app, record, granted_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT (app) DO UPDATE SET record = excluded.record, granted_at = excluded.granted_at'
  ).bind(app, rec, Date.now()).run());
}

/**
 * 取消授权（DELETE 这一行；没有这一行也算成功）。D1 出错抛错。
 * @param {any} env @param {string} app
 */
export async function revokeGrant(env, app) {
  if (!isAppId(app)) throw new Error('app-grant: bad app');
  await onAuthDb(env, GRANT_DB_REALM, (db) => db.prepare('DELETE FROM app_grant WHERE app = ?').bind(app).run());
}

/**
 * 已授权 ∩ 作用域表（grantedScopes 记录模式用）：每行只认 record.scopes 里属于这个应用的作用域
 * （作用域表里不再有的、别的应用的，一律不算）。
 * @param {Array<{app:string, scopes:string[]}>} rows
 * @returns {string[]}
 */
export function scopesOfRows(rows) {
  /** @type {string[]} */
  const all = [];
  for (const r of rows || []) {
    if (!r || !isAppId(r.app)) continue;
    const own = scopesOfApp(r.app);
    for (const s of r.scopes || []) if (own.indexOf(s) !== -1) all.push(s);
  }
  return knownScopes(all);
}
