/**
 * 应用授权（account_grant 表；接口 /api/account/grants，api/account/grants.js）。
 *
 * - 一行一个应用（app = 作用域表 scopes.js 的应用 id = 授权卡 id），record = {"v":1,"scopes":[...],"deviceId","by"}，granted_at = 毫秒。
 *   取消授权 = DELETE（只降权）；重新授权 = 写回这一行。授权没有过期，不归设备清扫管。
 * - 授权只看表里的行（命名 v2 删了种子 / 补种逻辑；旧逻辑算作已授权的应用由 migrations/0005_account_tables.sql 一次写成行）。
 * - D1 读主库、不缓存（取消后网关下次请求即拦截靠的就是这个）。出错一律抛，调用方 fail closed。
 *
 * 只 import workers/account/src/lib/ 和本目录。
 */
import { onDb } from '../lib/db.js';
import { SCOPES, knownScopes } from './scopes.js';

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

/** @param {string} app @param {string} deviceId @param {string} by */
function recordJson(app, deviceId, by) {
  return JSON.stringify({ v: RECORD_V, scopes: scopesOfApp(app), deviceId: String(deviceId || ''), by: String(by || '') });
}

/**
 * @typedef {{app:string, scopes:string[], deviceId:string, by:string, grantedAt:number}} GrantRow
 */

/** @param {any} row @returns {GrantRow|null} */
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
 * 全部授权行（只读，只留作用域表里还有的应用）。D1 出错抛错。
 * @param {any} env @returns {Promise<GrantRow[]>}
 */
export async function listGrants(env) {
  return onDb(env, async (d) => {
    const res = await d.prepare('SELECT app, record, granted_at FROM account_grant ORDER BY app').all();
    return /** @type {GrantRow[]} */ (((res && res.results) || []).map(parseRow).filter((r) => r && isAppId(r.app)));
  });
}

/**
 * 授权（写回 / 覆盖一行）。D1 出错抛错。
 * @param {any} env @param {string} app @param {{deviceId?: string, by?: string}} [who] 授权时的账号会话（写进 record 作审计）
 */
export async function addGrant(env, app, who) {
  if (!isAppId(app)) throw new Error('grants: bad app');
  const rec = recordJson(app, (who && who.deviceId) || '', (who && who.by) || '');
  await onDb(env, (d) => d.prepare(
    'INSERT INTO account_grant (app, record, granted_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT (app) DO UPDATE SET record = excluded.record, granted_at = excluded.granted_at'
  ).bind(app, rec, Date.now()).run());
}

/** 取消授权（没有这一行也算成功）。D1 出错抛错。 @param {any} env @param {string} app */
export async function revokeGrant(env, app) {
  if (!isAppId(app)) throw new Error('grants: bad app');
  await onDb(env, (d) => d.prepare('DELETE FROM account_grant WHERE app = ?').bind(app).run());
}

/**
 * 已授权 ∩ 作用域表：每行只认 record.scopes 里属于这个应用的作用域。
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
