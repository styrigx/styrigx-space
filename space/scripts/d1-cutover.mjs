#!/usr/bin/env node
/**
 * @fileoverview 进站 v3 L2b（2026-11-09，Gray 08:18 / 08:21 定）：一次性把主站数据从 2026-11-07 合出来的共用库 styrigx-space-gateway 拆进两个新库，
 * 搜索索引 KV 换成同名的 styrigx-space-core（Pages 站 + <站>-core Worker + <站>-core D1 / KV，和奇趣、日刻一个模子）。
 *
 *   D1 styrigx-space-gateway 的网关表（epoch / password / passkey / …，表名不变）→ D1 styrigx-space-core（绑定 D1_SPACE）
 *   D1 styrigx-space-gateway 的 share_link / share_fail                       → D1 styrigx-space-core（同一个绑定 D1_SPACE）
 *   D1 styrigx-space-gateway 的 status_* 七张表                               → D1 styrigx-status（status Worker 自己的库，表名不变）
 *   KV styrigx-space-gateway（全部键：site:*、ai:models、ai:recall:*）        → KV styrigx-space-core
 * 账号 styrigx-account、奇趣 / 日刻 core、预览库 styrigx-test-preview 不动。旧库 / 旧命名空间只读、不删（回滚兜底；L3 删，先列清单）。
 * 2026-11-07 那一次（三个旧库 → styrigx-space-gateway）的版本见 git 历史（PR #304）。
 *
 * 由 .github/workflows/d1-cutover.yml（workflow_dispatch）和 deploy.yml 跑，用法：
 *   node space/scripts/d1-cutover.mjs d1 [--dry-run | --verify] [--kv-keys N]
 *   node space/scripts/d1-cutover.mjs kv [--dry-run | --verify]
 *   node space/scripts/d1-cutover.mjs gate      （deploy.yml 的 d1-cutover-gate：四个搬迁标记都在 → ready=true）
 *   node space/scripts/d1-cutover.mjs resync    （deploy.yml 的 deploy-space-core，部署新绑定之前：凭证类表再和旧库比一遍，变了就整表重拷；见下）
 *   node space/scripts/d1-cutover.mjs switched  （deploy-space-core 部署 + 冒烟通过后：写 switched 标记，之后 resync 一律跳过）
 * 环境：CLOUDFLARE_API_TOKEN（D1 编辑 / KV 编辑，账号级）、CLOUDFLARE_ACCOUNT_ID、WRANGLER_VERSION；CF_API_BASE 只给测试用。
 *
 * D1（每个来源一遍，顺序 status → share → gateway；三个来源同一个旧库）：
 *   1. 列旧库的表（去掉 sqlite_* / _cf_* / d1_migrations* / d1_cutover），和三个来源名单的并集核对：多出来的表或缺了必需表 → 失败（不悄悄丢表）。
 *   2. 新库里对应的表必须已经在（迁移由工作流先跑：space-core 的 D1_SPACE、status 的 styrigx-status，各用各的 migrations_table）。
 *      本脚本不建业务表：表不在 = 迁移没跑，直接失败。
 *   3. wrangler d1 export <旧库> --remote --no-schema --table …（只认 INSERT INTO "<表>" / PRAGMA 行，别的行一律失败）。
 *   4. --dry-run：不写远端。在本机 node:sqlite 上按两套迁移建出新库的表，导入导出的 SQL，逐表比对行数，报告远端新库现状。
 *      正式：这个来源还没有搬迁标记 → 先清空新库里它的那几张表（没有标记 = 还没有新代码在用，见 gate），再 wrangler d1 execute --file 导入。
 *      已有标记 → 不再导入，只核对。
 *   5. 核对（不一致即失败）：
 *      - 每张表：新库行数 = 导出文件里的行数；
 *      - 凭证表（epoch / password / passkey / user_handle / lock_reset_switch）：新库内容 = 旧库此刻的内容（逐行 sha256，与顺序无关）；
 *      - 计数表（tempkey / device / kv_migration、share_link）：新库行数 = 旧库此刻的行数；
 *      - 其余（challenge / attempt_limit / audit / share_fail / 监测全部）：只打 warning（旧 Worker 在新代码部署前还在写）。
 *   6. 全部通过才写搬迁标记（styrigx-space-core 的表 d1_cutover：source / done_at / counts）。deploy.yml 的 d1-cutover-gate 见到
 *      gateway / share / status / kv 四条标记才放行 ai / status / space-core / 奇趣 / 日刻的部署（合并后的 main 推送不会把新绑定部署到空库上）。
 * resync（搬完到切绑定之间旧 Worker 还在写旧库：Gray 可能正好在改解锁密码 / 加通行密钥 / 作废临时钥匙或分享链接）：
 *   部署 space-core 新版本之前，把凭证表 + 计数表（epoch / password / passkey / user_handle / lock_reset_switch / tempkey / device / kv_migration / share_link）
 *   逐表和旧库比指纹；不一样的整表重拷（新库清空 → 按旧库此刻的行插入 → 再比一次，还不一样就失败、不部署）。只在没有 switched 标记时做：
 *   切换成功后新库才是准的，再拿旧库盖它就是丢数据。
 * KV：列旧命名空间全部键（带 metadata / expiration）→ 逐个读值 → bulk 写新命名空间 → 核对键数一致、每个值逐字节一致。
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

/** 旧库：2026-11-07 合出来的主站共用库（只读，不删）。 */
export const OLD = { name: 'styrigx-space-gateway', id: '39d037fe-6ab3-410d-a090-4d7ce8d48d83' };
/** 新库。和 workers/space-core/wrangler.toml 的 D1_SPACE、workers/status/wrangler.toml 的 D1_UPTIME_MONITOR 一致（d1-cutover.test.mjs 核对）。 */
export const TARGETS = {
  core: { name: 'styrigx-space-core', id: '1354c898-aacd-4122-92de-0ae39a3fcc1a' },
  status: { name: 'styrigx-status', id: '38719f10-fdff-43fd-bcbb-387a6b734f55' },
};
/** 搬迁标记都记在 styrigx-space-core 里（gate / resync 只查这一个库） */
export const MARKER_DB = TARGETS.core;
/** 新旧搜索索引 KV 命名空间。新的和 workers/{ai,curio-core,daymark-core}/wrangler.toml 的 KV_SEARCH_INDEX 一致。 */
export const KV = { from: { name: 'styrigx-space-gateway', id: '608cf3e27184481cbca2922950506d87' }, to: { name: 'styrigx-space-core', id: '4bcdb84f205541b9b6c8d230bc2b106f' } };
export const MARKER_TABLE = 'd1_cutover';
export const SWITCHED = 'switched';

const same = (t) => t;
/**
 * 三个来源（同一个旧库）。tables：表名 → 级别（hash 内容必须一致 / count 行数必须一致 / live 只打 warning）；required：旧库里必须有的表。
 * 表名新旧一样（rename 恒等，留着是为了导出改写那一步的接口不变）。migrations：建新库表的迁移目录（dry-run 在本机按它建表）。
 */
export const SOURCES = [
  {
    key: 'status', old: OLD, target: TARGETS.status,
    tables: { status_checks: 'live', status_state: 'live', status_hourly: 'live', status_daily: 'live', status_incidents: 'live', status_usage: 'live', status_quota: 'live' },
    required: ['status_checks', 'status_state', 'status_hourly', 'status_daily', 'status_incidents', 'status_usage', 'status_quota'],
    rename: same, migrations: 'workers/status/migrations',
  },
  {
    key: 'share', old: OLD, target: TARGETS.core,
    tables: { share_link: 'count', share_fail: 'live' },
    required: ['share_link', 'share_fail'],
    rename: same, migrations: 'workers/space-core/migrations',
  },
  {
    key: 'gateway', old: OLD, target: TARGETS.core,
    tables: {
      epoch: 'hash', password: 'hash', passkey: 'hash', user_handle: 'hash', lock_reset_switch: 'hash',
      tempkey: 'count', device: 'count', kv_migration: 'count',
      challenge: 'live', attempt_limit: 'live', audit: 'live',
    },
    required: ['epoch', 'password', 'passkey', 'user_handle', 'lock_reset_switch'],
    rename: same, migrations: 'workers/space-core/migrations',
  },
];
export const GATE_SOURCES = ['gateway', 'share', 'status', 'kv'];
/** resync 的表：网关 / 分享链接里级别是 hash 或 count 的（凭证、钥匙、链接；live 的计数 / 审计不管） */
export const RESYNC_TABLES = SOURCES.filter((s) => s.target === TARGETS.core)
  .flatMap((s) => Object.entries(s.tables).filter(([, l]) => l !== 'live').map(([t]) => t));

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

/**
 * 旧库的表和三个来源名单的并集核对，再按来源分。 @param {string[]} oldTables
 * @returns {{ bySource: Record<string, string[]>, problems: string[] }}
 */
export function planTables(oldTables, sources = SOURCES) {
  const tables = oldTables.filter((t) => !isInternal(t)).sort();
  const problems = [];
  const owner = new Map(sources.flatMap((s) => Object.keys(s.tables).map((t) => [t, s.key])));
  for (const t of tables) if (!owner.has(t)) problems.push('table ' + t + ' in ' + OLD.name + ' is not in the cutover list');
  /** @type {Record<string, string[]>} */
  const bySource = {};
  for (const s of sources) {
    bySource[s.key] = tables.filter((t) => owner.get(t) === s.key);
    for (const t of s.required) if (!tables.includes(t)) problems.push(s.key + ': required table ' + t + ' missing in ' + OLD.name);
  }
  return { bySource, problems };
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
    '[[d1_databases]]', 'binding = "NEW"', 'database_name = "' + src.target.name + '"', 'database_id = "' + src.target.id + '"', ''].join('\n'));
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

/** 本机 node:sqlite：按两套迁移（space-core、status；表名不重叠）建出新库的表（dry-run 用） */
async function localTarget() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  for (const m of new Set(SOURCES.map((x) => x.migrations))) {
    const dir = path.join(REPO, m);
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(path.join(dir, f), 'utf8'));
  }
  return db;
}

async function markers(cf) {
  const have = await tableNames(cf, MARKER_DB.id);
  if (!have.includes(MARKER_TABLE)) return new Map();
  return new Map((await cf.query(MARKER_DB.id, 'SELECT source, done_at, counts FROM ' + MARKER_TABLE)).map((r) => [r.source, r]));
}
async function writeMarker(cf, source, counts) {
  await cf.query(MARKER_DB.id, 'CREATE TABLE IF NOT EXISTS ' + MARKER_TABLE + ' (source TEXT PRIMARY KEY, done_at INTEGER NOT NULL, counts TEXT NOT NULL)');
  await cf.query(MARKER_DB.id, 'INSERT INTO ' + MARKER_TABLE + ' (source, done_at, counts) VALUES (?, ?, ?) ON CONFLICT (source) DO UPDATE SET done_at = excluded.done_at, counts = excluded.counts',
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
  /** @type {Map<string, Set<string>>} 新库 id → 表名 */
  const newTablesOf = new Map();
  for (const t of Object.values(TARGETS)) newTablesOf.set(t.id, new Set(await tableNames(cf, t.id)));
  const plan = planTables(await tableNames(cf, OLD.id), o.sources || SOURCES);
  if (plan.problems.length) return { ok: false, errors: plan.problems, warnings, report };
  const marks = await markers(cf);
  const local = o.mode === 'dry-run' ? await localTarget() : null;
  const localTables = local ? new Set(local.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)) : null;

  for (const src of o.sources || SOURCES) {
    /* 正式：前一个来源失败就停（不往下搬）；dry-run / verify 全部报告 */
    if (o.mode === 'apply' && errors.length) break;
    const r = report[src.key] = { tables: {}, marker: marks.has(src.key) };
    const tables = plan.bySource[src.key];
    const TARGET = src.target;
    const newTables = newTablesOf.get(TARGET.id);
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

// ---------------------------------------------------------------------------------------------------------------- resync

/** D1 一条语句最多 100 个绑定参数 */
const MAX_PARAMS = 90;

/**
 * 切绑定之前（deploy-space-core 部署新版本前一步）：RESYNC_TABLES 逐表和旧库比指纹，不一样的整表重拷。
 * 有 switched 标记（已经切过）→ 什么都不做。gateway / share 没有搬迁标记 → 失败（gate 本来就不该放行）。
 * @param {{ cf: ReturnType<typeof cloudflare>, log?: (s:string)=>void }} o
 * @returns {Promise<{ ok: boolean, skipped: boolean, errors: string[], copied: Record<string, number>, same: string[] }>}
 */
export async function runResync(o) {
  const log = o.log || ((s) => process.stdout.write(s + '\n'));
  const cf = o.cf;
  const out = { ok: true, skipped: false, errors: [], copied: {}, same: [] };
  const marks = await markers(cf);
  if (marks.has(SWITCHED)) { out.skipped = true; log('resync: already switched (marker ' + SWITCHED + '), nothing to do'); return out; }
  for (const k of ['gateway', 'share']) if (!marks.has(k)) out.errors.push('resync: no cutover marker ' + k + ' in ' + MARKER_DB.name);
  if (out.errors.length) { out.ok = false; return out; }
  const target = TARGETS.core.id;
  for (const t of RESYNC_TABLES) {
    const cols = await colsOf(cf, OLD.id, t);
    const oldRows = await cf.query(OLD.id, selectCols(t, cols));
    const h = rowsHash(oldRows);
    if (h === await hashOf(cf, target, t, cols)) { out.same.push(t); continue; }
    await cf.query(target, 'DELETE FROM ' + q(t));
    const per = Math.max(1, Math.floor(MAX_PARAMS / cols.length));
    for (let i = 0; i < oldRows.length; i += per) {
      const chunk = oldRows.slice(i, i + per);
      const sql = 'INSERT INTO ' + q(t) + ' (' + cols.map(q).join(', ') + ') VALUES ' + chunk.map(() => '(' + cols.map(() => '?').join(', ') + ')').join(', ');
      await cf.query(target, sql, chunk.flatMap((r) => cols.map((c) => (r[c] === undefined ? null : r[c]))));
    }
    const after = await hashOf(cf, target, t, cols);
    if (after !== h || after !== await hashOf(cf, OLD.id, t, cols)) out.errors.push('resync: ' + t + ' still differs after the copy (written again meanwhile? run the deploy again)');
    out.copied[t] = oldRows.length;
    log('resync: ' + t + ' changed since the cutover → re-copied ' + oldRows.length + ' rows (hash ' + h.slice(0, 12) + ')');
  }
  if (out.same.length) log('resync: unchanged ' + out.same.join(', '));
  out.ok = out.errors.length === 0;
  return out;
}

/** 切换成功（deploy-space-core 部署 + 冒烟通过）后写 switched 标记：之后 resync 一律跳过（新库才是准的）。 */
export async function markSwitched(cf) { await writeMarker(cf, SWITCHED, { at: new Date().toISOString() }); }

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
    if (!g.ready) process.stdout.write('::warning::主站数据还没搬进 ' + TARGETS.core.name + ' / ' + TARGETS.status.name + '（.github/workflows/d1-cutover.yml 没跑完）：本次跳过 ai / status / curio-core / daymark-core / space-core 部署\n');
    if (out) writeFileSync(out, 'ready=' + g.ready + '\n', { flag: 'a' });
    return 0;
  }
  if (cmd === 'resync') {
    const r = await runResync({ cf });
    for (const e of r.errors) process.stdout.write('::error::' + e + '\n');
    if (Object.keys(r.copied).length) process.stdout.write('::warning::resync re-copied ' + Object.keys(r.copied).join(', ') + ' from ' + OLD.name + ' (changed after the cutover)\n');
    return r.ok ? 0 : 1;
  }
  if (cmd === 'switched') {
    await markSwitched(cf);
    process.stdout.write('d1-cutover: marker ' + SWITCHED + ' written in ' + MARKER_DB.name + '\n');
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
  process.stdout.write('usage: d1-cutover.mjs d1|kv|gate|resync|switched [--dry-run|--verify] [--kv-keys N]\n');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { process.stdout.write('::error::' + String((e && e.message) || e).slice(0, 500) + '\n'); process.exit(1); });
}
