#!/usr/bin/env node
/**
 * @fileoverview 一次性导入：设置云同步 KV account-prefs → D1 styrigx-account 的 settings_sync（2026-10-28，账号 Worker
 * styrigx-account 的 /api/prefs 改用 D1_SETTINGS_SYNC，删了 KV_SETTINGS_SYNC 绑定，运行时不读 KV、没有回落）。
 *
 * 必须在部署「prefs 走 D1」的账号 Worker 之前跑（顺序：wrangler d1 migrations apply（或本脚本自己建表）→ 本脚本 --dry-run
 * → 本脚本 → 本脚本 --verify → 部署账号 Worker）。不跑就部署：云同步在服务器上是空的，各设备下次同步时把本机的设置重新推上去
 * （逐项新的赢，不会丢本机设置，但只在一台设备上改过、还没推到别的设备的值，要等那台设备再同步一次）。
 *
 * 读（KV namespace，默认账号资料库 b20701f5f48e498e897bc6f0bd81643f，以前的 KV_SETTINGS_SYNC，和 KV_PROFILE 同一个库）：
 *   account-prefs = { items: { <sgx-…>: { v: string|null, t: 毫秒 } }, updatedAt } → settings_sync (k, v, t, updated_at = updatedAt)
 *   每一项按接口同样的规则清洗（src/api/prefs.js cleanItem：sgx- 键名、值类型 / 长度、t 不在未来），不合法的跳过（只计数）。
 *   头像 avatar:* 不动（仍在 KV_PROFILE）。
 *
 * 幂等：每一行用接口同一条 UPSERT（src/api/prefs.js UPSERT_SQL）：D1 里没有 → 插入；D1 里的 t 更旧 → 覆盖；
 * D1 里的 t 相等或更新（上线后某台设备已经同步过）→ 不动。所以重复跑、中途失败再跑都安全，旧 KV 值不会盖掉 D1 里更新的设置。
 * 只写 D1、不写也不删 KV（account-prefs 留在 KV 里不动，确认无误后可以在控制台手动删）。
 *
 * 用法（Cloudflare REST API，不依赖 wrangler 登录；凭据只从环境变量读；同 scripts/migrate-kv-to-d1.mjs）：
 *   CF_API_TOKEN=… CF_ACCOUNT_ID=… node scripts/migrate-prefs-kv-to-d1.mjs --dry-run   读 KV、读 D1，打印计划（只有计数，不打印值）
 *   CF_API_TOKEN=… CF_ACCOUNT_ID=… node scripts/migrate-prefs-kv-to-d1.mjs             建表（CREATE ... IF NOT EXISTS）+ 写入
 *   CF_API_TOKEN=… CF_ACCOUNT_ID=… node scripts/migrate-prefs-kv-to-d1.mjs --verify    核对：KV 里的每一项在 D1 里都有，且 t 不比 KV 旧
 * 选项：--account-kv <namespace id>（默认 b20701f5…）、--account-d1 <database id>（默认 workers/account/wrangler.toml 的
 *   D1_SETTINGS_SYNC，即 styrigx-account 03f60d23-…）。没有 --preview：预览 D1 styrigx-account-preview 还没建。
 *   CF_API_BASE 可指向本地模拟器。
 * Token 权限：Account → Workers KV Storage: Read（读 KV）+ D1: Edit（建表、写入；--dry-run / --verify 只读也要 D1 读）。
 */
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { cfApi, d1IdOf } from './migrate-kv-to-d1.mjs';
import { SCHEMA, UPSERT_SQL, MAX_TOTAL, cleanItem } from '../workers/account/src/api/prefs.js';

export const ACCOUNT_KV_NAMESPACE = 'b20701f5f48e498e897bc6f0bd81643f';
/** 以前的 KV 键名（只有本脚本认，运行时代码不再引用） */
export const LEGACY_PREFS_KEY = 'account-prefs';

/**
 * 由 KV 里 account-prefs 的原始值算出导入计划（纯函数，单测直接测）。
 * @param {string|null} raw KV 值（JSON 字符串）；null = KV 里没有
 * @param {number} [now] 毫秒
 * @returns {{found: boolean, updatedAt: number, rows: Array<{k: string, v: string|null, t: number}>, skipped: number}}
 */
export function planPrefsImport(raw, now) {
  const t0 = now || Date.now();
  let rec = null;
  if (raw !== null && raw !== undefined) {
    try { rec = JSON.parse(raw); } catch (e) { rec = null; }
  }
  if (!rec || typeof rec !== 'object' || !rec.items || typeof rec.items !== 'object') {
    return { found: raw !== null && raw !== undefined, updatedAt: 0, rows: [], skipped: 0 };
  }
  const rows = [];
  let skipped = 0;
  for (const k of Object.keys(rec.items).sort()) {
    const c = cleanItem(k, rec.items[k], t0);
    if (c) rows.push({ k, v: c.v, t: c.t });
    else skipped++;
  }
  const u = Number(rec.updatedAt);
  return { found: true, updatedAt: Number.isFinite(u) && u > 0 ? Math.floor(u) : t0, rows, skipped };
}

/**
 * 跑计划。api.d1(sql, params) → { results: any[], meta: { changes } }（Cloudflare D1 REST query 的 result[0]）。
 * @param {{d1: (sql: string, params?: any[]) => Promise<{results?: any[], meta?: {changes?: number}}>}} api
 * @param {ReturnType<typeof planPrefsImport>} plan
 * @param {{mode: 'dry-run'|'apply'|'verify', log?: (s: string) => void}} o
 * @returns {Promise<{ok: boolean, lines: string[], written: number, missing: string[]}>}
 */
export async function runPrefsPlan(api, plan, o) {
  const lines = [];
  const log = (s) => { lines.push(s); if (o.log) o.log(s); };
  const missing = [];
  let written = 0;
  if (!plan.found) log('KV ' + LEGACY_PREFS_KEY + ': not found (nothing to import)');
  else log('KV ' + LEGACY_PREFS_KEY + ': ' + plan.rows.length + ' item(s) to import' + (plan.skipped ? ', ' + plan.skipped + ' invalid item(s) skipped' : ''));
  if (o.mode === 'apply') await api.d1(SCHEMA, []);
  const t = await api.d1("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", ['settings_sync']);
  const hasTable = !!(t.results && t.results.length);
  /** @type {Map<string, number>} D1 里已有的 k → t */
  const have = new Map();
  if (hasTable && o.mode !== 'apply') {
    for (const r of (await api.d1('SELECT k, t FROM settings_sync', [])).results || []) have.set(r.k, Number(r.t));
  }
  if (o.mode === 'dry-run') {
    const newer = plan.rows.filter((r) => have.has(r.k) && /** @type {number} */ (have.get(r.k)) >= r.t).length;
    log('settings_sync: ' + (hasTable ? have.size + ' row(s) in D1' : 'table missing (will be created)') +
      '; ' + (plan.rows.length - newer) + ' row(s) would be written, ' + newer + ' already same or newer in D1 (will be kept)');
    return { ok: true, lines, written: 0, missing };
  }
  if (o.mode === 'verify') {
    if (!hasTable && plan.rows.length) missing.push('settings_sync (no table)');
    else {
      for (const r of plan.rows) {
        if (!have.has(r.k)) missing.push(r.k + ' (missing)');
        else if (/** @type {number} */ (have.get(r.k)) < r.t) missing.push(r.k + ' (older than KV)');
      }
    }
    log('settings_sync: ' + plan.rows.length + ' row(s) checked');
    log(missing.length ? 'verify FAILED: ' + missing.length + ' missing' : 'verify OK');
    return { ok: missing.length === 0, lines, written: 0, missing };
  }
  for (const r of plan.rows) {
    const res = await api.d1(UPSERT_SQL, [r.k, r.v, r.t, plan.updatedAt, MAX_TOTAL]);
    written += Number((res.meta && res.meta.changes) || 0);
  }
  log('settings_sync: ' + written + ' of ' + plan.rows.length + ' row(s) written (the rest were already same or newer in D1)');
  return { ok: true, lines, written, missing };
}

/** @param {string[]} argv @param {string} name */
function opt(argv, name) {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] || '' : '';
}

/** @param {string[]} argv */
async function main(argv) {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  if (argv.includes('--preview')) throw new Error('--preview is not supported: the preview D1 styrigx-account-preview does not exist yet');
  const mode = argv.includes('--dry-run') ? 'dry-run' : argv.includes('--verify') ? 'verify' : 'apply';
  const token = process.env.CF_API_TOKEN || '';
  const account = process.env.CF_ACCOUNT_ID || '';
  if (!token || !account) throw new Error('CF_API_TOKEN and CF_ACCOUNT_ID are required');
  const ns = opt(argv, 'account-kv') || ACCOUNT_KV_NAMESPACE;
  if (!/^[0-9a-f]{32}$/.test(ns)) throw new Error('--account-kv must be a KV namespace id');
  const dbId = opt(argv, 'account-d1') || d1IdOf(readFileSync(repo + 'workers/account/wrangler.toml', 'utf8'), 'D1_SETTINGS_SYNC');
  if (!dbId) throw new Error('account D1 database id not found (D1_SETTINGS_SYNC in workers/account/wrangler.toml)');
  const api = cfApi({ base: (process.env.CF_API_BASE || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, ''), token, account });
  console.log(`${mode}: KV ${ns} (${LEGACY_PREFS_KEY}) → D1 ${dbId} (settings_sync)`);
  const raw = await api.kvGet(ns, LEGACY_PREFS_KEY);
  const res = await runPrefsPlan({ d1: api.d1For(dbId) }, planPrefsImport(raw), { mode, log: (s) => console.log('  ' + s) });
  if (!res.ok) {
    for (const m of res.missing) console.error('  missing: ' + m);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e) => { console.error('error: ' + (e && e.message ? e.message : e)); process.exit(1); });
}
