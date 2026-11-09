#!/usr/bin/env node
/**
 * @fileoverview 主站数据合库（2026-11，Gray 定）：一次性把三个旧 D1 和旧搜索索引 KV 搬进主站共用的一套 styrigx-space-gateway。
 *
 *   D1 styrigx-auth-gateway（网关，全表）  → D1 styrigx-space-gateway（表名不变）
 *   D1 styrigx-share（短链 share_link / share_fail）→ 同上（表名不变，本来就带 share_ 前缀）
 *   D1 styrigx-status（监测 7 张表）        → 同上（表名加 status_ 前缀：checks → status_checks …）
 *   KV styrigx-search-index（全部键）       → KV styrigx-space-gateway
 * 账号 styrigx-account（D1 + KV）、奇趣 / 日刻 core、预览库 styrigx-test-preview 不动。旧库 / 旧命名空间只读、不删（删前 Gray 确认）。
 *
 * 由 .github/workflows/d1-cutover.yml（workflow_dispatch）跑，用法：
 *   node space/scripts/d1-cutover.mjs d1 [--dry-run | --verify] [--kv-keys N]
 *   node space/scripts/d1-cutover.mjs kv [--dry-run | --verify]
 *   node space/scripts/d1-cutover.mjs gate                     （deploy.yml 的 d1-cutover-gate：四个搬迁标记都在 → ready=true）
 * 环境：CLOUDFLARE_API_TOKEN（D1 编辑 / KV 编辑）、CLOUDFLARE_ACCOUNT_ID、WRANGLER_VERSION；CF_API_BASE 只给测试用。
 *
 * D1（每个来源一遍，顺序 status → share → gateway）：
 *   1. 列旧库的表（去掉 sqlite_* / _cf_* / d1_migrations*），和白名单核对：多出来或缺了必需表 → 失败（不悄悄丢表）。
 *   2. 新库里对应的表必须已经在（迁移由工作流先跑：三个 Worker 目录各自 d1 migrations apply，各用各的 migrations_table）。
 *      本脚本和 Worker 代码都不建业务表：表不在 = 迁移没跑，直接失败，不会在空库上悄悄建出空表。
 *   3. wrangler d1 export <旧库> --remote --no-schema --table …，逐行改表名（只认 INSERT INTO "<表>" / PRAGMA 行，别的行一律失败）。
 *   4. --dry-run：不写远端。在本机 node:sqlite 上按三套迁移建出新库的表，导入改好的 SQL，逐表比对行数，报告远端新库现状。
 *      正式：这个来源还没有搬迁标记 → 先清空新库里它的那几张表（没有标记 = 还没有新代码在用，见 gate），再 wrangler d1 execute --file 导入。
 *      已有标记 → 不再导入，只核对。
 *   5. 核对（不一致即失败）：
 *      - 每张表：新库行数 = 导出文件里的行数；
 *      - 凭证表（网关 epoch / password / passkey / user_handle / lock_reset_switch）：新库内容 = 旧库此刻的内容（逐行 sha256，与顺序无关）；
 *      - 计数表（网关 tempkey / device / kv_migration、短链 share_link）：新库行数 = 旧库此刻的行数；
 *      - 其余（challenge / attempt_limit / audit / share_fail / 监测全部）：旧库此刻和新库行数不一样只打 warning
 *        （旧 Worker 在新代码部署前还在写：监测每分钟、锁屏页的计数和审计；丢这几分钟无害）。
 *      导出里有凭证但新库对不上，多半是搬迁期间有人登录 / 改了密码：重跑一次（没有标记会先清空再搬）。
 *   6. 全部通过才写搬迁标记（新库表 d1_cutover：source / done_at / counts）。deploy.yml 的 d1-cutover-gate 见到
 *      gateway / share / status / kv 四条标记才放行部署（之前合并的 main 推送不会把新代码部署到空库上）。
 * KV：列旧命名空间全部键（带 metadata / expiration）→ 逐个读值 → bulk 写新命名空间 → 核对键数一致、每个值逐字节一致。
 *   site:space / site:blog 由 deploy-ai-worker 每次部署重写，site:curio / site:daymark 由各自 Worker 的 Cron 每小时重建，
 *   但模型登记 ai:models 是手写的值、不会重建，所以整个命名空间照搬一遍（量很小）。
 * 不打印、不上传任何行内容（只有表名、行数、哈希前缀）。临时文件在系统临时目录，结束时删掉。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_API = 'https://api.cloudflare.com/client/v4';

/** 新库（主站共用）。和 workers/{space-core,status}/wrangler.toml 的 database_id 一致（d1-cutover.test.mjs 核对）。 */
export const TARGET = { name: 'styrigx-space-gateway', id: '39d037fe-6ab3-410d-a090-4d7ce8d48d83' };
/** 新旧搜索索引 KV 命名空间。新的和 workers/{ai,curio-core,daymark-core}/wrangler.toml 的 KV_SEARCH_INDEX 一致。 */
export const KV = { from: { name: 'styrigx-search-index', id: 'bd1babcc3fe74d58994e254c74d34ced' }, to: { name: 'styrigx-space-gateway', id: '608cf3e27184481cbca2922950506d87' } };
export const MARKER_TABLE = 'd1_cutover';

/**
 * 三个来源。tables：旧表名 → 级别（hash 内容必须一致 / count 行数必须一致 / live 只打 warning）；required：旧库里必须有的表。
 * rename：旧表名 → 新表名。migrations：建新库表的迁移目录（dry-run 在本机按它建表）。
 */
export const SOURCES = [
  {
    key: 'status', old: { name: 'styrigx-status', id: '31970da7-4b8f-4180-ad93-c170649188dc' },
    tables: { checks: 'live', state: 'live', hourly: 'live', daily: 'live', incidents: 'live', usage: 'live', quota: 'live' },
    required: ['checks', 'state', 'hourly', 'daily', 'incidents', 'usage', 'quota'],
    rename: (t) => 'status_' + t, migrations: 'workers/status/migrations',
  },
  {
    key: 'share', old: { name: 'styrigx-share', id: '59bddcea-17cb-466a-90c9-16606d5b4b7e' },
    tables: { share_link: 'count', share_fail: 'live' },
    required: ['share_link', 'share_fail'],
    rename: (t) => t, migrations: 'workers/space-core/migrations-share',
  },
  {
    key: 'gateway', old: { name: 'styrigx-auth-gateway', id: '6931d1da-3502-480d-b0bd-de1bc4829d1d' },
    tables: {
      epoch: 'hash', password: 'hash', passkey: 'hash', user_handle: 'hash', lock_reset_switch: 'hash',
      tempkey: 'count', device: 'count', kv_migration: 'count',
      challenge: 'live', attempt_limit: 'live', audit: 'live',
    },
    required: ['epoch', 'password', 'passkey', 'user_handle', 'lock_reset_switch'],
    rename: (t) => t, migrations: 'workers/space-core/migrations',
  },
];
export const GATE_SOURCES = ['gateway', 'share', 'status', 'kv'];

/** 内部表：不搬（迁移记录各库自己的；sqlite_sequence 由显式 id 自动更新；_cf_* 是 Cloudflare 自己的） */
export const isInternal = (t) => /^(sqlite_|_cf_|d1_migrations)/.test(t) || t === MARKER_TABLE;

/**
 * 导出文件改表名并按表计行。只认 PRAGMA 行和 INSERT INTO "<表>" (…) VALUES(…); 行（wrangler d1 export 的格式，值里的换行导出成 char(10)，一行一条）。
 * @param {string} sql @param {(t:string)=>string} rename @param {Set<string>} allow 旧表名白名单
 * @returns {{ sql: string, counts: Record<string, number> }} counts 按新表名
 */
export function rewriteExport(sql, rename, allow) {
  const out = [];
  /** @type {Record<string, number>} */
  const counts = {};
  for (const line of String(sql).split('\n')) {
    if (!line.trim()) continue;
    if (/^PRAGMA [a-z_]+\s*=\s*[A-Za-z0-9]+;$/.test(line)) { out.push(line); continue; }
    const m = /^INSERT INTO "([A-Za-z0-9_]+)" \(/.exec(line);
    if (!m) throw new Error('unexpected line in export: ' + line.slice(0, 40).replace(/'.*$/, "'…"));
    if (!allow.has(m[1])) throw new Error('export has a table outside the list: ' + m[1]);
    if (!/\);$/.test(line)) throw new Error('INSERT not terminated on one line: ' + m[1]);
    const to = rename(m[1]);
    counts[to] = (counts[to] || 0) + 1;
    out.push('INSERT INTO "' + to + '" (' + line.slice(m[0].length));
  }
  return { sql: out.join('\n') + '\n', counts };
}

/** 行集合的指纹：每行按列名排序后 JSON，再整体排序后 sha256（与行顺序无关）。 @param {Array<Record<string, any>>} rows */
export function rowsHash(rows) {
  const lines = rows.map((r) => JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]]))).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** 旧表的级别和白名单检查。 @returns {{ tables: string[], problems: string[] }} */
export function planTables(src, oldTables) {
  const tables = oldTables.filter((t) => !isInternal(t)).sort();
  const problems = [];
  for (const t of tables) if (!(t in src.tables)) problems.push(src.key + ': table ' + t + ' in ' + src.old.name + ' is not in the cutover list');
  for (const t of src.required) if (!tables.includes(t)) problems.push(src.key + ': required table ' + t + ' missing in ' + src.old.name);
  return { tables, problems };
}

// ---------------------------------------------------------------------------------------------------------------- Cloudflare

/** @param {{api?:string, account:string, token:string, fetch?:typeof fetch}} cfg */
export function cloudflare(cfg) {
  const f = cfg.fetch || fetch;
  const base = (cfg.api || DEFAULT_API).replace(/\/+$/, '') + '/accounts/' + cfg.account;
  const headers = { Authorization: 'Bearer ' + cfg.token };
  async function call(method, p, body, raw) {
    const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(60000) };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    const res = await f(base + p, init);
    if (raw) {
      if (res.status === 404) return null;
      if (res.status !== 200) throw new Error(method + ' ' + p.split('?')[0] + ' → HTTP ' + res.status);
      return Buffer.from(await res.arrayBuffer());
    }
    let j = null;
    try { j = await res.json(); } catch {}
    if (res.status !== 200 || !j || !j.success) {
      throw new Error(method + ' ' + p.split('?')[0] + ' → HTTP ' + res.status + ' ' + JSON.stringify((j && j.errors) || []).slice(0, 300));
    }
    return j;
  }
  return {
    /** @param {string} db @param {string} sql @param {any[]} [params] */
    async query(db, sql, params = []) {
      const j = await call('POST', '/d1/database/' + db + '/query', { sql, params });
      const first = Array.isArray(j.result) ? j.result[0] : null;
      return (first && first.results) || [];
    },
    /** 全部键（带 metadata / expiration），cursor 翻页 @param {string} ns */
    async kvKeys(ns) {
      const out = [];
      let cursor = '';
      for (;;) {
        const j = await call('GET', '/storage/kv/namespaces/' + ns + '/keys?limit=1000' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
        out.push(...j.result);
        cursor = (j.result_info && j.result_info.cursor) || '';
        if (!cursor) return out;
      }
    },
    /** @param {string} ns @param {string} key @returns {Promise<Buffer|null>} */
    kvGet(ns, key) { return call('GET', '/storage/kv/namespaces/' + ns + '/values/' + encodeURIComponent(key), undefined, true); },
    /** @param {string} ns @param {Array<object>} items */
    async kvPut(ns, items) { for (let i = 0; i < items.length; i += 1000) await call('PUT', '/storage/kv/namespaces/' + ns + '/bulk', items.slice(i, i + 1000)); },
  };
}

/** wrangler（固定版本，同 deploy.yml 的 WRANGLER_VERSION）。配置是临时写的，只登记旧库和新库，绑定名 OLD / NEW。 */
export function wranglerRunner(dir) {
  const version = process.env.WRANGLER_VERSION || '';
  const run = (args) => execFileSync('npx', ['--yes', 'wrangler' + (version ? '@' + version : ''), ...args, '-c', path.join(dir, 'wrangler.toml')],
    { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const config = (src) => writeFileSync(path.join(dir, 'wrangler.toml'), [
    'name = "d1-cutover"', 'main = "x.js"', 'compatibility_date = "2026-10-09"',
    '[[d1_databases]]', 'binding = "OLD"', 'database_name = "' + src.old.name + '"', 'database_id = "' + src.old.id + '"',
    '[[d1_databases]]', 'binding = "NEW"', 'database_name = "' + TARGET.name + '"', 'database_id = "' + TARGET.id + '"', ''].join('\n'));
  return {
    exportData(src, tables) {
      config(src);
      const file = path.join(dir, src.key + '.export.sql');
      run(['d1', 'export', 'OLD', '--remote', '--no-schema', '-y', '--output', file, ...tables.flatMap((t) => ['--table', t])]);
      return readFileSync(file, 'utf8');
    },
    importSql(src, sql) {
      config(src);
      const file = path.join(dir, src.key + '.import.sql');
      writeFileSync(file, sql);
      run(['d1', 'execute', 'NEW', '--remote', '-y', '--file', file]);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------- D1

const q = (t) => '"' + t.replace(/"/g, '') + '"';
async function tableNames(cf, db) {
  return (await cf.query(db, "SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name);
}
async function count(cf, db, t) { return Number((await cf.query(db, 'SELECT COUNT(*) AS n FROM ' + q(t)))[0].n); }
/** 旧表的列名（PRAGMA table_info）。旧库的表可能是代码兜底 SCHEMA 建的，比迁移少后加的列（如 user_handle.legacy_handle），指纹只比旧表有的列。 */
async function colsOf(cf, db, t) { return (await cf.query(db, 'PRAGMA table_info(' + q(t) + ')')).map((r) => r.name); }
const selectCols = (t, cols) => 'SELECT ' + cols.map(q).join(', ') + ' FROM ' + q(t);
async function hashOf(cf, db, t, cols) { return rowsHash(await cf.query(db, selectCols(t, cols))); }

/** 本机 node:sqlite：按三套迁移建出新库的表（dry-run 用） */
async function localTarget() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  for (const s of SOURCES) {
    const dir = path.join(REPO, s.migrations);
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(path.join(dir, f), 'utf8'));
  }
  return db;
}

async function markers(cf) {
  const have = await tableNames(cf, TARGET.id);
  if (!have.includes(MARKER_TABLE)) return new Map();
  return new Map((await cf.query(TARGET.id, 'SELECT source, done_at, counts FROM ' + MARKER_TABLE)).map((r) => [r.source, r]));
}
async function writeMarker(cf, source, counts) {
  await cf.query(TARGET.id, 'CREATE TABLE IF NOT EXISTS ' + MARKER_TABLE + ' (source TEXT PRIMARY KEY, done_at INTEGER NOT NULL, counts TEXT NOT NULL)');
  await cf.query(TARGET.id, 'INSERT INTO ' + MARKER_TABLE + ' (source, done_at, counts) VALUES (?, ?, ?) ON CONFLICT (source) DO UPDATE SET done_at = excluded.done_at, counts = excluded.counts',
    [source, Date.now(), JSON.stringify(counts)]);
}

/**
 * @param {{ cf: ReturnType<typeof cloudflare>, wr: ReturnType<typeof wranglerRunner>, mode: 'dry-run'|'apply'|'verify', kvKeys?: number|null,
 *           log?: (s:string)=>void, sources?: typeof SOURCES }} o
 * @returns {Promise<{ ok: boolean, errors: string[], warnings: string[], report: Record<string, any> }>}
 */
export async function runD1(o) {
  const log = o.log || ((s) => process.stdout.write(s + '\n'));
  const errors = [];
  const warnings = [];
  const report = {};
  const cf = o.cf;
  const newTables = new Set(await tableNames(cf, TARGET.id));
  const marks = await markers(cf);
  const local = o.mode === 'dry-run' ? await localTarget() : null;
  const localTables = local ? new Set(local.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)) : null;

  for (const src of o.sources || SOURCES) {
    /* 正式：前一个来源失败就停（不往下搬）；dry-run / verify 全部报告 */
    if (o.mode === 'apply' && errors.length) break;
    const r = report[src.key] = { tables: {}, marker: marks.has(src.key) };
    const { tables, problems } = planTables(src, await tableNames(cf, src.old.id));
    if (problems.length) { errors.push(...problems); continue; }
    const want = localTables || newTables;
    const missing = tables.map(src.rename).filter((t) => !want.has(t));
    if (missing.length) {
      errors.push(src.key + ': tables missing in ' + (local ? 'local migrations' : TARGET.name + ' (run d1 migrations apply first)') + ': ' + missing.join(', '));
      continue;
    }
    /* 旧库此刻（导出前）的指纹 / 行数：凭证表在导出前后都要一致 */
    const before = {};
    for (const t of tables) {
      const cols = src.tables[t] === 'hash' ? await colsOf(cf, src.old.id, t) : null;
      before[t] = { n: await count(cf, src.old.id, t), cols, h: cols ? await hashOf(cf, src.old.id, t, cols) : null };
    }

    let fileCounts = null;
    if (o.mode !== 'verify' && !(o.mode === 'apply' && r.marker)) {
      const exp = rewriteExport(o.wr.exportData(src, tables), src.rename, new Set(tables));
      fileCounts = exp.counts;
      if (o.mode === 'dry-run') {
        for (const t of tables) local.exec('DELETE FROM ' + q(src.rename(t)));
        local.exec(exp.sql);
        for (const t of tables) {
          const nt = src.rename(t);
          const got = Number(local.prepare('SELECT COUNT(*) AS n FROM ' + q(nt)).get().n);
          if (got !== (fileCounts[nt] || 0)) errors.push(src.key + ': local import ' + nt + ' has ' + got + ' rows, export has ' + (fileCounts[nt] || 0));
          if (src.tables[t] === 'hash' && rowsHash(local.prepare(selectCols(nt, before[t].cols)).all().map((x) => ({ ...x }))) !== before[t].h) {
            errors.push(src.key + ': local import of ' + nt + ' differs from ' + src.old.name + ' (changed during export?)');
          }
          const remote = newTables.has(nt) ? await count(cf, TARGET.id, nt) : null;
          r.tables[nt] = { old: before[t].n, export: fileCounts[nt] || 0, local: got, target_now: remote };
          if (remote && !r.marker) warnings.push(src.key + ': ' + TARGET.name + '.' + nt + ' already has ' + remote + ' rows (no marker yet: the real run clears them first)');
        }
        continue;
      }
      /* 正式：没有标记 = 新代码还没在用（gate 没放行），先清空这个来源的表再导入，可重跑 */
      for (const t of tables) await cf.query(TARGET.id, 'DELETE FROM ' + q(src.rename(t)));
      if (exp.sql.trim()) o.wr.importSql(src, exp.sql);
      log(src.key + ': imported ' + Object.values(fileCounts).reduce((a, b) => a + b, 0) + ' rows into ' + TARGET.name);
    } else if (r.marker) {
      try { fileCounts = JSON.parse(marks.get(src.key).counts); } catch { fileCounts = null; }
    }

    let bad = false;
    for (const t of tables) {
      const nt = src.rename(t);
      const level = src.tables[t];
      const n = await count(cf, TARGET.id, nt);
      const oldNow = await count(cf, src.old.id, t);
      const row = r.tables[nt] = { old: oldNow, export: fileCounts ? (fileCounts[nt] || 0) : null, target: n, level };
      if (fileCounts && o.mode === 'apply' && !r.marker && n !== row.export) { errors.push(src.key + ': ' + nt + ' has ' + n + ' rows, export had ' + row.export); bad = true; }
      if (level === 'hash') {
        const h = await hashOf(cf, TARGET.id, nt, before[t].cols);
        row.hash = h.slice(0, 12);
        if (h !== await hashOf(cf, src.old.id, t, before[t].cols) || h !== before[t].h) {
          (o.mode === 'verify' ? warnings : errors).push(src.key + ': ' + nt + ' content differs between ' + src.old.name + ' and ' + TARGET.name +
            (o.mode === 'verify' ? '' : ' (credentials changed during the cutover? run it again)'));
          bad = true;
        }
      } else if (n !== oldNow) {
        const msg = src.key + ': ' + nt + ' rows ' + src.old.name + '=' + oldNow + ' ' + TARGET.name + '=' + n;
        if (level === 'count' && o.mode !== 'verify') { errors.push(msg); bad = true; } else warnings.push(msg + (level === 'live' ? ' (still written by the old Worker until the new deploy)' : ''));
      }
    }
    if (o.mode === 'apply' && !r.marker && !bad) { await writeMarker(cf, src.key, fileCounts || {}); r.marker = true; log(src.key + ': verified, marker written'); }
  }
  if (o.mode === 'apply' && o.kvKeys != null && !errors.length) { await writeMarker(cf, 'kv', { keys: o.kvKeys }); report.kv = { marker: true, keys: o.kvKeys }; }
  return { ok: errors.length === 0, errors, warnings, report };
}

// ---------------------------------------------------------------------------------------------------------------- KV

/** @param {{ cf: ReturnType<typeof cloudflare>, mode: 'dry-run'|'apply'|'verify', log?: (s:string)=>void, settleMs?: number }} o */
export async function runKv(o) {
  const log = o.log || ((s) => process.stdout.write(s + '\n'));
  const errors = [];
  const keys = await o.cf.kvKeys(KV.from.id);
  const before = (await o.cf.kvKeys(KV.to.id)).length;
  log('kv: ' + KV.from.name + ' has ' + keys.length + ' keys; ' + KV.to.name + ' has ' + before);
  if (o.mode === 'dry-run') return { ok: true, errors, keys: keys.length };
  /** @type {Map<string, Buffer>} */
  const values = new Map();
  for (const k of keys) {
    const v = await o.cf.kvGet(KV.from.id, k.name);
    if (v == null) { errors.push('kv: ' + k.name + ' vanished from ' + KV.from.name); continue; }
    values.set(k.name, v);
  }
  if (o.mode === 'apply' && !errors.length) {
    await o.cf.kvPut(KV.to.id, keys.filter((k) => values.has(k.name)).map((k) => ({
      key: k.name, value: values.get(k.name).toString('base64'), base64: true,
      ...(k.expiration ? { expiration: k.expiration } : {}), ...(k.metadata !== undefined ? { metadata: k.metadata } : {}),
    })));
    log('kv: wrote ' + values.size + ' keys');
  }
  /* KV 最终一致：新值最多一分钟内可读，读不到 / 不一样就等一会儿再看 */
  const deadline = Date.now() + (o.settleMs == null ? 90000 : o.settleMs);
  for (;;) {
    const diff = [];
    const now = await o.cf.kvKeys(KV.to.id);
    const names = new Set(now.map((k) => k.name));
    for (const k of keys) {
      if (!names.has(k.name)) { diff.push(k.name + ' missing'); continue; }
      const v = await o.cf.kvGet(KV.to.id, k.name);
      if (!v || !values.get(k.name) || !v.equals(values.get(k.name))) diff.push(k.name + ' differs');
    }
    if (now.length !== keys.length) diff.push('key count ' + KV.from.name + '=' + keys.length + ' ' + KV.to.name + '=' + now.length);
    if (!diff.length) { log('kv: ' + keys.length + ' keys, all values identical'); break; }
    if (o.mode === 'verify') {
      /* 部署后核对：site:* 由部署 / Cron 重建，新值和旧库不同是正常的，只报 warning；其余键（ai:models 等手写值）仍须一致 */
      for (const d of diff) {
        if (/^site:\S+ differs$/.test(d)) log('::warning::kv: ' + d + ' (rebuilt by deploy / cron, expected)');
        else errors.push('kv: ' + d);
      }
      if (!errors.length) log('kv: verify OK (only rebuilt site:* keys differ)');
      break;
    }
    if (Date.now() > deadline) { errors.push(...diff.map((d) => 'kv: ' + d)); break; }
    await new Promise((res) => setTimeout(res, 10000));
  }
  return { ok: errors.length === 0, errors, keys: keys.length };
}

// ---------------------------------------------------------------------------------------------------------------- gate

/** @returns {Promise<{ ready: boolean, have: string[] }>} */
export async function gate(cf) {
  const m = await markers(cf);
  return { ready: GATE_SOURCES.every((s) => m.has(s)), have: GATE_SOURCES.filter((s) => m.has(s)) };
}

// ---------------------------------------------------------------------------------------------------------------- CLI

async function main(argv) {
  const [cmd, ...rest] = argv;
  const mode = rest.includes('--dry-run') ? 'dry-run' : rest.includes('--verify') ? 'verify' : 'apply';
  const account = process.env.CLOUDFLARE_ACCOUNT_ID || '';
  const token = process.env.CLOUDFLARE_API_TOKEN || '';
  if (!account || !token) { process.stdout.write('::error::CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN missing\n'); return 1; }
  const cf = cloudflare({ account, token, api: process.env.CF_API_BASE });
  const out = process.env.GITHUB_OUTPUT;
  if (cmd === 'gate') {
    const g = await gate(cf);
    process.stdout.write('d1-cutover gate: ' + (g.ready ? 'ready' : 'NOT ready') + ' (markers: ' + (g.have.join(', ') || 'none') + ')\n');
    if (!g.ready) process.stdout.write('::warning::主站数据还没搬进 ' + TARGET.name + '（.github/workflows/d1-cutover.yml 没跑完）：本次跳过 ai / status / curio-core / daymark-core / space-core 部署\n');
    if (out) writeFileSync(out, 'ready=' + g.ready + '\n', { flag: 'a' });
    return 0;
  }
  if (cmd === 'kv') {
    const r = await runKv({ cf, mode });
    for (const e of r.errors) process.stdout.write('::error::' + e + '\n');
    if (out) writeFileSync(out, 'keys=' + r.keys + '\n', { flag: 'a' });
    return r.ok ? 0 : 1;
  }
  if (cmd === 'd1') {
    const i = rest.indexOf('--kv-keys');
    const kvKeys = i >= 0 && /^\d+$/.test(rest[i + 1] || '') ? Number(rest[i + 1]) : null;
    if (mode === 'apply' && kvKeys == null) { process.stdout.write('::error::--kv-keys <n> required (the kv job must succeed first)\n'); return 1; }
    const dir = mkdtempSync(path.join(tmpdir(), 'd1-cutover-'));
    try {
      const r = await runD1({ cf, wr: wranglerRunner(dir), mode, kvKeys });
      process.stdout.write(JSON.stringify(r.report, null, 2) + '\n');
      for (const w of r.warnings) process.stdout.write('::warning::' + w + '\n');
      for (const e of r.errors) process.stdout.write('::error::' + e + '\n');
      process.stdout.write('d1-cutover ' + mode + ': ' + (r.ok ? 'OK' : 'FAILED') + '\n');
      return r.ok ? 0 : 1;
    } finally {
      rmSync(dir, { recursive: true, force: true }); /* 导出里有锁屏凭证：不留文件 */
    }
  }
  process.stdout.write('usage: d1-cutover.mjs d1|kv|gate [--dry-run|--verify] [--kv-keys N]\n');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { process.stdout.write('::error::' + String((e && e.message) || e).slice(0, 500) + '\n'); process.exit(1); });
}
