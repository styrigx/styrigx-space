#!/usr/bin/env node
/**
 * @fileoverview 一次性导入：认证库 KV 里值得留的旧值 → D1 styrigx-auth-gateway（2026-10-27，网关不再绑定 KV，运行时不读 KV）。
 *
 * 历史脚本：导入已在 2026-10-27 上线前做完，源 namespace b796097c… 2026-10-29 已删除，本脚本不会再有可读的源。
 *
 * 必须在部署「网关不绑 KV」的版本之前跑（顺序：本脚本 --dry-run → 本脚本 → 本脚本 --verify → 部署网关）。
 * 不跑就部署：锁屏 / 账号密码、通行密钥都读不到（锁屏、账号都按「未设置」处理，根凭证可以代开），
 * 通行密钥的 user handle 会重新生成（已注册的通行密钥校验 userHandle 失败），已登录设备、临时钥匙全部丢失。
 *
 * 读（KV namespace，默认认证库 b796097c90104000992b7713f61e16ea，以前的 KV_LOCK_DOOR / KV_ACCOUNT_LOGIN）：
 *   lock-password / account-password                   → password (realm, record)
 *   lock-passkey-index + lock-passkey:<credId 前 12 位>   → passkey (realm, credential_id, record)（索引不存在时按前缀列）
 *   account-passkey-index + account-passkey:*           → 同上 realm='account'
 *   lock-user-id / account-user-id                      → user_handle (realm, handle)
 *   lock-epoch / account-epoch                          → epoch (realm, value) = KV 值 + 1（KV 没有按 0 算 → 1）：
 *                                                          上线后所有锁屏 / 账号会话和票失效一次（每个人重新解锁 / 登录一次），
 *                                                          旧的、本该已吊销的票不会因为纪元对上了而复活
 *   account-device:<id>（+ account-device-revoked:<id>）→ device (realm='account', ...)；已退出的导成 revoked_at > 0 的行
 *   lock-tempkey:<id>（+ lock-tempkey-revoked:<id>）     → tempkey (realm='lock', ...)（code_hash = 记录里的 h；跳过已过期的，
 *                                                          已作废的导成 revoked_at > 0 的行）
 * 不导入（只是计数 / 一次性的，过期就没用）：*-password-fail*、*-password-cooldown:*、lock-tempkey-fail*、root-fail*、
 *   *-challenge:*、lock-tempkey-code:*（由 tempkey.code_hash 代替）、
 *   *-configured（「已配置」由凭证推出）、lock-reset-switch（开关改在 D1 recovery_switch，要用时在控制台插一行）、
 *   root-audit:*（7 天审计，KV 里的旧记录留在 KV 自然过期）。
 *
 * 幂等：每一类（kv_migration.name = '<realm>-<内容>'）的行都用 INSERT OR IGNORE ... WHERE NOT EXISTS (该类的标记)，
 * 整类写完最后才写标记。中途失败 → 再跑一次补齐（已写的行不覆盖）；写过标记的类再跑一律跳过
 * （上线后在 D1 里改过 / 删过的不会被旧 KV 值盖回去）。纪元、user handle 本身就是 INSERT OR IGNORE（D1 里已有就不动）。
 * 只写 D1、不写也不删 KV（namespace 后来在 2026-10-29 手动删除）。
 *
 * 用法（Cloudflare REST API，不依赖 wrangler 登录；凭据只从环境变量读）：
 *   CF_API_TOKEN=… CF_ACCOUNT_ID=… node scripts/migrate-kv-to-d1.mjs --dry-run   读 KV、读 D1 的标记，打印计划（只有计数，不打印值）
 *   CF_API_TOKEN=… CF_ACCOUNT_ID=… node scripts/migrate-kv-to-d1.mjs             建表（CREATE ... IF NOT EXISTS）+ 写入
 *   CF_API_TOKEN=… CF_ACCOUNT_ID=… node scripts/migrate-kv-to-d1.mjs --verify    核对：计划里的每一行都在 D1 里
 * 选项：--auth-kv <namespace id>（默认 b796097c…）、--auth-d1 <database id>（默认 workers/auth-gateway/wrangler.toml 的 D1_LOCK_AUTH，
 *   即 styrigx-auth-gateway 6931d1da-…）；--preview：库 id 改读 web/wrangler.toml [env.preview]（测试专用库 styrigx-test-preview），
 *   这时 --auth-kv 必须显式给（预览网关不绑 KV，没有默认的源）。CF_API_BASE 可指向 tests/web/e2e/preview-emulator.cjs 本地跑。
 * Token 权限：Account → Workers KV Storage: Read（读 KV）+ D1: Edit（建表、写入；--dry-run / --verify 只读也要 D1 读）。
 */
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { SCHEMA } from '../workers/auth-gateway/functions/_kernel/d1-state.js';

export const AUTH_KV_NAMESPACE = 'b796097c90104000992b7713f61e16ea';
/** 账号会话 400 天（device 行的默认 expires_at，同 realms.js REALM_ACCOUNT.maxAge） */
const DEVICE_TTL_MS = 34560000 * 1000;

/** 以前的 KV 键名（只有本脚本认，运行时代码不再引用） */
export const LEGACY_KV = Object.freeze({
  lock: Object.freeze({ password: 'lock-password', passkeyPrefix: 'lock-passkey:', passkeyIndex: 'lock-passkey-index', userHandle: 'lock-user-id', epoch: 'lock-epoch' }),
  account: Object.freeze({ password: 'account-password', passkeyPrefix: 'account-passkey:', passkeyIndex: 'account-passkey-index', userHandle: 'account-user-id', epoch: 'account-epoch' }),
  devicePrefix: 'account-device:',
  deviceRevokedPrefix: 'account-device-revoked:',
  tempkeyPrefix: 'lock-tempkey:',
  tempkeyRevokedPrefix: 'lock-tempkey-revoked:',
});

/** 计划要读的键：精确键 + 前缀（只为这些键取值；计数类、challenge 一律不读） */
export function wantedKey(name) {
  for (const r of [LEGACY_KV.lock, LEGACY_KV.account]) {
    if (name === r.password || name === r.passkeyIndex || name === r.userHandle || name === r.epoch || name.startsWith(r.passkeyPrefix)) return true;
  }
  return name.startsWith(LEGACY_KV.devicePrefix) || name.startsWith(LEGACY_KV.deviceRevokedPrefix)
    || name.startsWith(LEGACY_KV.tempkeyPrefix) || name.startsWith(LEGACY_KV.tempkeyRevokedPrefix);
}

/** @param {any} v */
function parseJson(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (e) { return null; }
}

const guarded = (table, cols) =>
  'INSERT OR IGNORE INTO ' + table + ' (' + cols.join(', ') + ') SELECT ' + cols.map(() => '?').join(', ') +
  ' WHERE NOT EXISTS (SELECT 1 FROM kv_migration WHERE name = ?)';
const MARK = 'INSERT OR IGNORE INTO kv_migration (name, migrated_at) VALUES (?, ?)';

/**
 * 由 KV 内容算出导入计划（纯函数，单测直接测）。
 * @param {Map<string, {value: string, expiration?: number}>} kv 键 → 值（字符串）与过期时间（秒，KV list 给的）
 * @param {number} [now] 毫秒
 * @param {{epochWhenMissing?: boolean}} [opts] epochWhenMissing（默认 true）：KV 没有纪元键时也写 1。
 *   单测替身（tests/workers/_harness.cjs）传 false：没有就不写，网关按 0 起步，和单测里按纪元 0 签的票对得上
 * @returns {{families: Array<{name: string, marker: string|null, rows: Array<{table: string, key: Record<string, any>}>, statements: Array<{sql: string, params: any[]}>}>}}
 */
export function planAuthImport(kv, now, opts) {
  const epochWhenMissing = !(opts && opts.epochWhenMissing === false);
  const t = now || Date.now();
  const val = (k) => (kv.has(k) ? kv.get(k).value : null);
  const families = [];

  for (const realm of ['lock', 'account']) {
    const L = LEGACY_KV[realm];
    /* 纪元：KV 值 + 1（没有按 0 → 1），INSERT OR IGNORE（D1 已有就不动） */
    const ev = val(L.epoch);
    const epoch = (ev === null ? 0 : (parseInt(ev, 10) || 0)) + 1;
    const withEpoch = ev !== null || epochWhenMissing;
    families.push({
      name: realm + '-epoch', marker: null, rows: withEpoch ? [{ table: 'epoch', key: { realm: realm } }] : [],
      statements: withEpoch ? [{ sql: 'INSERT OR IGNORE INTO epoch (realm, value) VALUES (?, ?)', params: [realm, epoch] }] : [],
    });
    /* 密码 */
    {
      const marker = realm + '-password';
      const rec = parseJson(val(L.password));
      const fam = { name: marker, marker, rows: [], statements: [] };
      if (rec && rec.hash) {
        fam.rows.push({ table: 'password', key: { realm: realm } });
        fam.statements.push({ sql: guarded('password', ['realm', 'record']), params: [realm, JSON.stringify(rec), marker] });
      }
      fam.statements.push({ sql: MARK, params: [marker, t] });
      families.push(fam);
    }
    /* 通行密钥：索引在就按索引（顺序 = 注册顺序），不在按前缀 */
    {
      const marker = realm + '-passkey';
      const fam = { name: marker, marker, rows: [], statements: [] };
      const idx = parseJson(val(L.passkeyIndex));
      const recs = [];
      const seen = new Set();
      const add = (v, want) => {
        if (!v || !v.credId || (want && v.credId !== want) || seen.has(v.credId)) return;
        seen.add(v.credId);
        recs.push(v);
      };
      if (Array.isArray(idx)) {
        for (const credId of idx) add(parseJson(val(L.passkeyPrefix + String(credId).slice(0, 12))), credId);
      } else {
        for (const k of [...kv.keys()].filter((n) => n.startsWith(L.passkeyPrefix)).sort()) add(parseJson(val(k)), '');
      }
      for (const v of recs) {
        fam.rows.push({ table: 'passkey', key: { realm: realm, credential_id: v.credId } });
        fam.statements.push({ sql: guarded('passkey', ['realm', 'credential_id', 'record']), params: [realm, v.credId, JSON.stringify(v), marker] });
      }
      fam.statements.push({ sql: MARK, params: [marker, t] });
      families.push(fam);
    }
    /* user handle（已有就不动） */
    {
      const uh = val(L.userHandle);
      const fam = { name: realm + '-user-handle', marker: null, rows: [], statements: [] };
      if (uh) {
        fam.rows.push({ table: 'user_handle', key: { realm: realm } });
        fam.statements.push({ sql: 'INSERT OR IGNORE INTO user_handle (realm, handle) VALUES (?, ?)', params: [realm, String(uh)] });
      }
      families.push(fam);
    }
  }

  /* 已登录设备（含已单独退出的：导成 revoked_at > 0） */
  {
    const marker = 'account-device';
    const fam = { name: marker, marker, rows: [], statements: [] };
    const cols = ['realm', 'device_id', 'record', 'last_seen', 'revoked_at', 'expires_at'];
    const expOf = (k, dflt) => {
      const e = kv.get(k) && kv.get(k).expiration;
      return e ? Number(e) * 1000 : dflt;
    };
    const revoked = new Map();
    for (const k of kv.keys()) {
      if (!k.startsWith(LEGACY_KV.deviceRevokedPrefix)) continue;
      const id = k.slice(LEGACY_KV.deviceRevokedPrefix.length);
      const exp = expOf(k, t + DEVICE_TTL_MS);
      if (id && exp > t) revoked.set(id, exp);
    }
    for (const k of [...kv.keys()].filter((n) => n.startsWith(LEGACY_KV.devicePrefix)).sort()) {
      const rec = parseJson(val(k));
      const id = k.slice(LEGACY_KV.devicePrefix.length);
      if (!rec || rec.deviceId !== id || revoked.has(id)) continue;
      const exp = expOf(k, t + DEVICE_TTL_MS);
      if (exp <= t) continue;
      fam.rows.push({ table: 'device', key: { realm: 'account', device_id: id } });
      fam.statements.push({ sql: guarded('device', cols), params: ['account', id, JSON.stringify(rec), Number(rec.lastSeen) || 0, 0, exp, marker] });
    }
    for (const [id, exp] of [...revoked.entries()].sort()) {
      fam.rows.push({ table: 'device', key: { realm: 'account', device_id: id } });
      fam.statements.push({ sql: guarded('device', cols), params: ['account', id, JSON.stringify({ deviceId: id }), 0, t, exp, marker] });
    }
    fam.statements.push({ sql: MARK, params: [marker, t] });
    families.push(fam);
  }

  /* 临时钥匙（只导还有效、没作废的；code_hash 冲突时 INSERT OR IGNORE 跳过） */
  {
    const marker = 'lock-tempkey';
    const fam = { name: marker, marker, rows: [], statements: [] };
    const cols = ['realm', 'id', 'name', 'code_hash', 'link', 'created_at', 'revoked_at', 'expires_at'];
    const revoked = new Map();
    for (const k of kv.keys()) {
      if (!k.startsWith(LEGACY_KV.tempkeyRevokedPrefix)) continue;
      const id = k.slice(LEGACY_KV.tempkeyRevokedPrefix.length);
      const e = kv.get(k).expiration;
      const exp = e ? Number(e) * 1000 : t + 30 * 24 * 3600 * 1000; /* 没有过期时间：按最长有效期 30 天留 */
      if (id && exp > t) revoked.set(id, exp);
    }
    for (const k of [...kv.keys()].filter((n) => n.startsWith(LEGACY_KV.tempkeyPrefix)).sort()) {
      const v = parseJson(val(k));
      const id = k.slice(LEGACY_KV.tempkeyPrefix.length);
      if (!v || v.id !== id || !(Number(v.expiresAt) > t) || revoked.has(id)) continue;
      if (!v.link && !v.h) continue; /* 普通钥匙没有码哈希：输不进来，不导 */
      fam.rows.push({ table: 'tempkey', key: { realm: 'lock', id: id } });
      fam.statements.push({
        sql: guarded('tempkey', cols),
        params: ['lock', id, String(v.name || ''), v.link ? null : String(v.h), v.link ? 1 : 0, Number(v.createdAt) || t, 0, Number(v.expiresAt), marker],
      });
    }
    /* 已作废的：导成 revoked_at > 0 的行（留到原来的到期时间），拿它签过的访客会话照样拒 */
    for (const [id, exp] of [...revoked.entries()].sort()) {
      fam.rows.push({ table: 'tempkey', key: { realm: 'lock', id: id } });
      fam.statements.push({ sql: guarded('tempkey', cols), params: ['lock', id, '', null, 0, 0, t, exp, marker] });
    }
    fam.statements.push({ sql: MARK, params: [marker, t] });
    families.push(fam);
  }
  return { families };
}

/* ---------- 执行 ---------- */

/**
 * 跑计划。api.d1(sql, params) → { results: any[], meta: { changes } }（Cloudflare D1 REST query 的 result[0]）。
 * @param {{d1: (sql: string, params?: any[]) => Promise<{results?: any[], meta?: {changes?: number}}>}} api
 * @param {ReturnType<typeof planAuthImport>} plan
 * @param {{mode: 'dry-run'|'apply'|'verify', log?: (s: string) => void}} o
 * @returns {Promise<{ok: boolean, lines: string[], written: number, missing: string[]}>}
 */
export async function runPlan(api, plan, o) {
  const lines = [];
  const log = (s) => { lines.push(s); if (o.log) o.log(s); };
  let written = 0;
  const missing = [];
  const hasTable = async (name) => {
    const r = await api.d1("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]);
    return !!(r.results && r.results.length);
  };
  if (o.mode === 'apply') {
    for (const sql of SCHEMA) await api.d1(sql, []);
  }
  const markersReady = o.mode === 'apply' || (await hasTable('kv_migration'));
  for (const fam of plan.families) {
    let done = false;
    if (fam.marker && markersReady) {
      const r = await api.d1('SELECT 1 AS x FROM kv_migration WHERE name = ?', [fam.marker]);
      done = !!(r.results && r.results.length);
    }
    if (o.mode === 'dry-run') {
      log(fam.name + ': ' + fam.rows.length + ' row(s) planned' + (done ? ' (already imported: will be skipped)' : ''));
      continue;
    }
    if (o.mode === 'verify') {
      for (const row of fam.rows) {
        const cols = Object.keys(row.key);
        if (!(await hasTable(row.table))) { missing.push(fam.name + ' ' + row.table + ' (no table)'); continue; }
        const r = await api.d1('SELECT 1 AS x FROM ' + row.table + ' WHERE ' + cols.map((c) => c + ' = ?').join(' AND '), cols.map((c) => row.key[c]));
        if (!(r.results && r.results.length)) missing.push(fam.name + ' ' + row.table + ' ' + JSON.stringify(row.key));
      }
      if (fam.marker && !done) missing.push(fam.name + ' (marker missing)');
      log(fam.name + ': ' + fam.rows.length + ' row(s) checked');
      continue;
    }
    if (done) { log(fam.name + ': already imported, skipped'); continue; }
    let n = 0;
    for (const st of fam.statements) {
      const r = await api.d1(st.sql, st.params);
      if (st.sql !== MARK) n += Number((r.meta && r.meta.changes) || 0);
    }
    written += n;
    log(fam.name + ': ' + n + ' of ' + fam.rows.length + ' row(s) written');
  }
  if (o.mode === 'verify') log(missing.length ? 'verify FAILED: ' + missing.length + ' missing' : 'verify OK');
  return { ok: o.mode !== 'verify' || missing.length === 0, lines, written, missing };
}

/* ---------- Cloudflare REST ---------- */

/**
 * @param {{base: string, token: string, account: string}} c
 */
export function cfApi(c) {
  const h = { Authorization: 'Bearer ' + c.token };
  const req = async (url, init) => {
    const r = await fetch(url, Object.assign({}, init, { headers: Object.assign({}, h, (init && init.headers) || {}), signal: AbortSignal.timeout(30000) }));
    return r;
  };
  return {
    /** 列出 namespace 的全部键（带 expiration，秒） @param {string} ns */
    async kvList(ns) {
      const out = [];
      let cursor = '';
      for (;;) {
        const q = new URLSearchParams({ limit: '1000' });
        if (cursor) q.set('cursor', cursor);
        const r = await req(`${c.base}/accounts/${c.account}/storage/kv/namespaces/${ns}/keys?${q}`);
        const j = await r.json().catch(() => null);
        if (!r.ok || !j || !j.success) throw new Error('KV list HTTP ' + r.status + ' (the token needs Workers KV Storage: Read)');
        out.push(...(j.result || []));
        cursor = (j.result_info && j.result_info.cursor) || '';
        if (!cursor) return out;
      }
    },
    /** @param {string} ns @param {string} key @returns {Promise<string|null>} */
    async kvGet(ns, key) {
      const r = await req(`${c.base}/accounts/${c.account}/storage/kv/namespaces/${ns}/values/${encodeURIComponent(key)}`);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('KV get HTTP ' + r.status);
      return await r.text();
    },
    /** 绑定一个 D1 库 @param {string} id */
    d1For(id) {
      return async (sql, params) => {
        const r = await req(`${c.base}/accounts/${c.account}/d1/database/${id}/query`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql: sql, params: params || [] }),
        });
        const j = await r.json().catch(() => null);
        if (!r.ok || !j || !j.success) throw new Error('D1 query HTTP ' + r.status + ' ' + JSON.stringify((j && j.errors) || []) + ' (the token needs D1: Edit)');
        return (Array.isArray(j.result) ? j.result[0] : j.result) || {};
      };
    },
  };
}

/**
 * 读 KV 里计划要的键（只取 wantedKey 的值）。
 * @param {ReturnType<typeof cfApi>} api @param {string} ns
 * @returns {Promise<Map<string, {value: string, expiration?: number}>>}
 */
export async function readKv(api, ns) {
  const out = new Map();
  for (const k of await api.kvList(ns)) {
    if (!wantedKey(k.name)) continue;
    const v = await api.kvGet(ns, k.name);
    if (v !== null) out.set(k.name, { value: v, expiration: k.expiration });
  }
  return out;
}

/**
 * wrangler.toml 文本里某 binding 的 database_id。
 * @param {string} toml @param {string} binding
 */
export function d1IdOf(toml, binding) {
  for (const block of String(toml).split(/\n(?=\[\[)/)) {
    if (!/^\[\[(?:env\.preview\.)?d1_databases\]\]/.test(block)) continue;
    const b = block.match(/^binding = "([A-Z0-9_]+)"/m);
    const id = block.match(/^database_id = "([0-9a-f-]+)"/m);
    if (b && id && b[1] === binding) return id[1];
  }
  return '';
}

/** @param {string[]} argv */
function opt(argv, name) {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] || '' : '';
}

async function main(argv) {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const preview = argv.includes('--preview');
  const mode = argv.includes('--dry-run') ? 'dry-run' : argv.includes('--verify') ? 'verify' : 'apply';
  const token = process.env.CF_API_TOKEN || '';
  const account = process.env.CF_ACCOUNT_ID || '';
  if (!token || !account) throw new Error('CF_API_TOKEN and CF_ACCOUNT_ID are required');
  const ns = opt(argv, 'auth-kv') || (preview ? '' : AUTH_KV_NAMESPACE);
  if (!/^[0-9a-f]{32}$/.test(ns)) throw new Error('--auth-kv <namespace id> is required with --preview');
  const toml = readFileSync(repo + (preview ? 'web/wrangler.toml' : 'workers/auth-gateway/wrangler.toml'), 'utf8');
  const dbId = opt(argv, 'auth-d1') || d1IdOf(toml, 'D1_LOCK_AUTH');
  if (!dbId) throw new Error('auth D1 database id not found (D1_LOCK_AUTH)');
  const api = cfApi({ base: (process.env.CF_API_BASE || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, ''), token, account });
  console.log(`${mode}: KV ${ns} → D1 ${dbId}${preview ? ' (preview)' : ''}`);
  const kv = await readKv(api, ns);
  console.log(`read ${kv.size} legacy key(s) worth keeping`);
  const res = await runPlan({ d1: api.d1For(dbId) }, planAuthImport(kv), { mode, log: (s) => console.log('  ' + s) });
  if (!res.ok) {
    for (const m of res.missing) console.error('  missing: ' + m);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e) => { console.error('error: ' + (e && e.message ? e.message : e)); process.exit(1); });
}
