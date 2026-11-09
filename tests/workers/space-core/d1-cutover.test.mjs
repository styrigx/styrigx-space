/**
 * 主站数据合库一次性搬迁（space/scripts/d1-cutover.mjs，2026-11）：旧库 styrigx-auth-gateway / styrigx-share / styrigx-status
 * 和旧 KV styrigx-search-index → 主站共用的 styrigx-space-gateway。Cloudflare 用 node:sqlite + 内存 KV 替身。
 * 运行：node --test tests/workers/space-core/d1-cutover.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  SOURCES, TARGET, KV, MARKER_TABLE, rewriteExport, rowsHash, planTables, runD1, runKv, gate,
} from '../../../space/scripts/d1-cutover.mjs';

let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch {}
const REPO = new URL('../../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, REPO), 'utf8');
const execDir = (db, dir) => { for (const f of readdirSync(new URL(dir + '/', REPO)).filter((x) => x.endsWith('.sql')).sort()) db.exec(read(dir + '/' + f)); };

/** wrangler d1 export --no-schema 的行格式（tests 里自己拼，和真导出一样：一行一条，换行写成 char(10)） */
function exportOf(db, tables) {
  const lit = (v) => v == null ? 'NULL' : typeof v === 'number' || typeof v === 'bigint' ? String(v)
    : String(v).includes('\n') ? "replace('" + String(v).replace(/'/g, "''").replace(/\n/g, '\\n') + "','\\n',char(10))" : "'" + String(v).replace(/'/g, "''") + "'";
  const out = ['PRAGMA defer_foreign_keys=TRUE;'];
  for (const t of tables) {
    for (const r of db.prepare('SELECT * FROM "' + t + '"').all()) {
      const ks = Object.keys(r);
      out.push('INSERT INTO "' + t + '" (' + ks.map((k) => '"' + k + '"').join(',') + ') VALUES(' + ks.map((k) => lit(r[k])).join(',') + ');');
    }
  }
  return out.join('\n');
}

/** 假 Cloudflare：每个库 id 一个 node:sqlite */
function fakeWorld({ codeSchemaGateway = false } = {}) {
  const dbs = {};
  const mk = (id) => (dbs[id] = new sqlite.DatabaseSync(':memory:'));
  const oldG = mk(SOURCES[2].old.id);
  if (codeSchemaGateway) {
    /* 线上旧网关库：从没跑过 migrations apply（没有 d1_migrations），表由代码兜底 SCHEMA 建，user_handle 没有 0007 的 legacy_handle 列 */
    execDir(oldG, 'workers/space-core/migrations');
    oldG.exec('DROP TABLE user_handle'); oldG.exec('CREATE TABLE user_handle (realm TEXT PRIMARY KEY, handle TEXT NOT NULL)');
  } else {
    execDir(oldG, 'workers/space-core/migrations');
    oldG.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT)'); oldG.exec("INSERT INTO d1_migrations (name) VALUES ('x')");
  }
  const oldS = mk(SOURCES[1].old.id); execDir(oldS, 'workers/space-core/migrations-share-archive');
  const oldT = mk(SOURCES[0].old.id); execDir(oldT, 'workers/status/migrations-archive');
  const neu = mk(TARGET.id);
  /* 迁移由工作流先跑：三个 Worker 目录各自 migrations apply */
  for (const d of ['workers/space-core/migrations', 'workers/space-core/migrations-share', 'workers/status/migrations']) execDir(neu, d);
  oldG.exec("INSERT INTO epoch VALUES ('lock', 7)");
  oldG.exec("INSERT INTO password VALUES ('lock', '{\"h\":\"PWHASH\"}')");
  oldG.exec("INSERT INTO passkey VALUES ('lock', 'cred1', '{\"pub\":\"PUBX\",\"n\":1}'), ('lock', 'cred2', 'multi\nline ''q''')");
  oldG.exec("INSERT INTO user_handle (realm, handle) VALUES ('lock', 'HANDLE')");
  oldG.exec("INSERT INTO lock_reset_switch (hash, first_seen, used) VALUES ('h1', 1, 0)");
  oldG.exec("INSERT INTO audit (realm, id, ts, ip_prefix, ok, expires_at) VALUES ('lock', 'a1', 1, '1.2.3', 1, 9)");
  oldS.exec("INSERT INTO share_link (id, code, target, created_at, expires_at) VALUES ('l1', 'c1', '/', 1, 2), ('l2', 'c2', '/blog/', 1, 2)");
  oldT.exec("INSERT INTO checks (site, at, ok, code, ms) VALUES ('space', 1, 1, 200, 5), ('ai', 2, 0, 0, 10000)");
  oldT.exec("INSERT INTO incidents (site, started_at, cause) VALUES ('ai', 2, 'timeout')");
  oldT.exec("INSERT INTO state (site, fails, first_fail_at) VALUES ('ai', 3, 2)");
  oldT.exec("INSERT INTO usage (id, fetched_at, data) VALUES (1, 5, '{}')");
  const cf = {
    async query(id, sql, params = []) {
      const st = dbs[id].prepare(sql);
      return /^\s*(SELECT|PRAGMA)/i.test(sql) ? st.all(...params).map((r) => ({ ...r })) : (st.run(...params), []);
    },
  };
  const calls = [];
  const wr = {
    exportData(src, tables) { calls.push('export ' + src.key); return exportOf(dbs[src.old.id], tables); },
    importSql(src, sql) { calls.push('import ' + src.key); dbs[TARGET.id].exec(sql); },
  };
  return { dbs, cf, wr, calls, oldG, oldS, oldT, neu };
}

test('库 id / 命名空间 id 与各 wrangler.toml 一致（脚本里写死的和绑定的是同一个）', () => {
  for (const w of ['space-core', 'status']) assert.ok(read('workers/' + w + '/wrangler.toml').includes('database_id = "' + TARGET.id + '"'), w);
  for (const w of ['ai', 'curio-core', 'daymark-core']) assert.ok(read('workers/' + w + '/wrangler.toml').includes('id = "' + KV.to.id + '"'), w);
  assert.equal(TARGET.name, 'styrigx-space-gateway');
  assert.deepEqual(SOURCES.map((s) => s.old.name), ['styrigx-status', 'styrigx-share', 'styrigx-auth-gateway']);
});

test('rewriteExport：只认 PRAGMA / 单行 INSERT；改表名并按新表名计数；名单外的表、别的语句一律失败', () => {
  const sql = 'PRAGMA defer_foreign_keys=TRUE;\nINSERT INTO "checks" ("site","at") VALUES(\'a\',1);\nINSERT INTO "checks" ("site","at") VALUES(\'INSERT INTO "x" (\',2);\n';
  const r = rewriteExport(sql, (t) => 'status_' + t, new Set(['checks']));
  assert.deepEqual(r.counts, { status_checks: 2 });
  assert.match(r.sql, /^PRAGMA defer_foreign_keys=TRUE;\nINSERT INTO "status_checks" \("site","at"\) VALUES\('a',1\);\nINSERT INTO "status_checks" \("site","at"\) VALUES\('INSERT INTO "x" \(',2\);\n$/);
  assert.throws(() => rewriteExport('INSERT INTO "d1_migrations" ("id") VALUES(1);', (t) => t, new Set(['checks'])), /outside the list/);
  assert.throws(() => rewriteExport('DROP TABLE checks;', (t) => t, new Set(['checks'])), /unexpected line/);
  assert.throws(() => rewriteExport('CREATE TABLE checks (a);', (t) => t, new Set(['checks'])), /unexpected line/);
});

test('planTables：旧库多出名单外的表 / 缺必需表 → 报问题；内部表（d1_migrations*、sqlite_*、_cf_*）不搬', () => {
  const g = SOURCES[2];
  assert.deepEqual(planTables(g, ['epoch', 'password', 'passkey', 'user_handle', 'lock_reset_switch', 'd1_migrations', 'sqlite_sequence', '_cf_KV']).problems, []);
  assert.match(planTables(g, ['epoch', 'password', 'passkey', 'user_handle', 'lock_reset_switch', 'bm_link']).problems.join(), /bm_link .* not in the cutover list/);
  assert.match(planTables(g, ['epoch', 'password']).problems.join(), /required table passkey missing/);
  /* 新库三套表不重名：网关原表名、share_*、status_* */
  const all = SOURCES.flatMap((s) => Object.keys(s.tables).map(s.rename));
  assert.equal(new Set(all).size, all.length);
});

test('rowsHash 与行顺序、列顺序无关；内容一变就变', () => {
  const a = [{ x: 1, y: 'a' }, { x: 2, y: 'b' }];
  assert.equal(rowsHash(a), rowsHash([{ y: 'b', x: 2 }, { y: 'a', x: 1 }]));
  assert.notEqual(rowsHash(a), rowsHash([{ x: 1, y: 'a' }, { x: 2, y: 'c' }]));
});

test('dry-run：不写远端（不导入、不清表、不写标记），本机按迁移建表导入后逐表行数一致', { skip: !sqlite }, async () => {
  const w = fakeWorld();
  const r = await runD1({ cf: w.cf, wr: w.wr, mode: 'dry-run', log: () => {} });
  assert.deepEqual(r.errors, []);
  assert.ok(r.ok);
  assert.deepEqual(w.calls, ['export status', 'export share', 'export gateway']);
  assert.equal(w.neu.prepare('SELECT COUNT(*) AS n FROM passkey').get().n, 0, '远端新库没被写');
  assert.equal(w.neu.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = '" + MARKER_TABLE + "'").get().n, 0);
  assert.deepEqual(r.report.status.tables.status_checks, { old: 2, export: 2, local: 2, target_now: 0 });
  assert.deepEqual(r.report.gateway.tables.passkey, { old: 2, export: 2, local: 2, target_now: 0 });
  assert.equal((await gate(w.cf)).ready, false);
});

test('正式：三个来源导入 + 逐表核对 + 写标记；凭证逐行一致；status 改了表名、自增 id 原样；KV 标记写上后 gate 放行；重跑不再导入', { skip: !sqlite }, async () => {
  const w = fakeWorld();
  const logs = [];
  const r = await runD1({ cf: w.cf, wr: w.wr, mode: 'apply', kvKeys: 3, log: (s) => logs.push(s) });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(w.calls, ['export status', 'import status', 'export share', 'import share', 'export gateway', 'import gateway']);
  for (const t of ['epoch', 'password', 'passkey', 'user_handle', 'lock_reset_switch']) {
    assert.equal(rowsHash(w.neu.prepare('SELECT * FROM ' + t).all().map((x) => ({ ...x }))), rowsHash(w.oldG.prepare('SELECT * FROM ' + t).all().map((x) => ({ ...x }))), t);
  }
  assert.equal(w.neu.prepare("SELECT record FROM passkey WHERE credential_id = 'cred2'").get().record, "multi\nline 'q'");
  assert.equal(w.neu.prepare('SELECT COUNT(*) AS n FROM share_link').get().n, 2);
  assert.equal(w.neu.prepare('SELECT COUNT(*) AS n FROM status_checks').get().n, 2);
  assert.equal(w.neu.prepare('SELECT id FROM status_incidents').get().id, 1);
  assert.equal(w.neu.prepare('SELECT first_fail_at FROM status_state').get().first_fail_at, 2);
  assert.deepEqual(w.neu.prepare('SELECT source FROM ' + MARKER_TABLE + ' ORDER BY source').all().map((x) => x.source), ['gateway', 'kv', 'share', 'status']);
  assert.equal((await gate(w.cf)).ready, true);
  /* 输出里没有任何凭证内容 */
  assert.ok(!JSON.stringify(r).includes('PUBX') && !JSON.stringify(r).includes('PWHASH') && !logs.join().includes('HANDLE'));
  /* 重跑：已有标记 → 只核对，不再导出导入 */
  w.calls.length = 0;
  const again = await runD1({ cf: w.cf, wr: w.wr, mode: 'apply', kvKeys: 3, log: () => {} });
  assert.deepEqual(again.errors, []);
  assert.deepEqual(w.calls, []);
});

test('没有标记的来源：新库里已有的行先清空再导入（可重跑，不会主键冲突）；没有 --kv-keys 不写 kv 标记 → gate 不放行', { skip: !sqlite }, async () => {
  const w = fakeWorld();
  w.neu.exec("INSERT INTO share_link (id, code, target, created_at, expires_at) VALUES ('l1', 'c1', '/', 1, 2), ('zz', 'zz', '/', 1, 2)");
  const r = await runD1({ cf: w.cf, wr: w.wr, mode: 'apply', kvKeys: null, log: () => {} });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(w.neu.prepare('SELECT id FROM share_link ORDER BY id').all().map((x) => x.id), ['l1', 'l2']);
  assert.equal((await gate(w.cf)).ready, false);
});

test('失败即停：旧库多出名单外的表 / 新库缺表（迁移没跑）/ 导入后行数对不上 / 凭证在搬迁中变了 → 不写标记', { skip: !sqlite }, async () => {
  let w = fakeWorld();
  w.oldG.exec('CREATE TABLE bm_link (id INTEGER)');
  let r = await runD1({ cf: w.cf, wr: w.wr, mode: 'apply', kvKeys: 1, log: () => {} });
  assert.match(r.errors.join(), /gateway: table bm_link/);
  assert.equal((await gate(w.cf)).ready, false);

  w = fakeWorld();
  w.neu.exec('DROP TABLE status_quota');
  r = await runD1({ cf: w.cf, wr: w.wr, mode: 'apply', kvKeys: 1, log: () => {} });
  assert.match(r.errors.join(), /status: tables missing in styrigx-space-gateway \(run d1 migrations apply first\): status_quota/);

  w = fakeWorld();
  const imp = w.wr.importSql;
  w.wr.importSql = (src, sql) => imp(src, src.key === 'share' ? sql.split('\n').filter((l) => !l.includes("'l2'")).join('\n') : sql);
  r = await runD1({ cf: w.cf, wr: w.wr, mode: 'apply', kvKeys: 1, log: () => {} });
  assert.match(r.errors.join(), /share: share_link has 1 rows, export had 2/);
  assert.deepEqual(w.neu.prepare('SELECT source FROM ' + MARKER_TABLE + ' ORDER BY source').all().map((x) => x.source), ['status'], 'share 失败就停：gateway / kv 都没搬、没写标记');

  w = fakeWorld();
  const exp = w.wr.exportData;
  w.wr.exportData = (src, tables) => { const s = exp(src, tables); if (src.key === 'gateway') w.oldG.exec("UPDATE passkey SET record = 'NEW' WHERE credential_id = 'cred1'"); return s; };
  r = await runD1({ cf: w.cf, wr: w.wr, mode: 'apply', kvKeys: 1, log: () => {} });
  assert.match(r.errors.join(), /gateway: passkey content differs .*run it again/);
  assert.equal((await gate(w.cf)).ready, false);
  /* 重跑（没标记 → 清空再搬）就过 */
  w.wr.exportData = exp;
  r = await runD1({ cf: w.cf, wr: w.wr, mode: 'apply', kvKeys: 1, log: () => {} });
  assert.deepEqual(r.errors, []);
  assert.equal((await gate(w.cf)).ready, true);
});

test('计数表（share_link）旧库在核对时多了行 → 失败；live 表（监测）只打 warning', { skip: !sqlite }, async () => {
  const w = fakeWorld();
  const imp = w.wr.importSql;
  w.wr.importSql = (src, sql) => {
    imp(src, sql);
    if (src.key === 'status') w.oldT.exec("INSERT INTO checks (site, at, ok, code, ms) VALUES ('space', 9, 1, 200, 5)");
    if (src.key === 'share') w.oldS.exec("INSERT INTO share_link (id, code, target, created_at, expires_at) VALUES ('l3', 'c3', '/', 1, 2)");
  };
  const r = await runD1({ cf: w.cf, wr: w.wr, mode: 'apply', kvKeys: 1, log: () => {} });
  assert.match(r.warnings.join(), /status: status_checks rows styrigx-status=3 styrigx-space-gateway=2/);
  assert.match(r.errors.join(), /share: share_link rows styrigx-share=3 styrigx-space-gateway=2/);
});

test('KV：dry-run 只列键；正式整命名空间照搬（值逐字节、带 metadata / expiration），键数和每个值都核对；读回不一致 → 失败', async () => {
  const ns = { [KV.from.id]: new Map([['site:space', { v: Buffer.from('{"a":1}') }], ['ai:models', { v: Buffer.from('{"default":"x"}'), metadata: { m: 1 } }], ['bin', { v: Buffer.from([0, 255, 10]) }]]), [KV.to.id]: new Map() };
  const puts = [];
  const cf = {
    async kvKeys(id) { return [...ns[id]].map(([name, e]) => ({ name, ...(e.metadata ? { metadata: e.metadata } : {}) })); },
    async kvGet(id, k) { const e = ns[id].get(k); return e ? e.v : null; },
    async kvPut(id, items) { puts.push(...items); for (const it of items) ns[id].set(it.key, { v: Buffer.from(it.value, it.base64 ? 'base64' : 'utf8'), metadata: it.metadata }); },
  };
  let r = await runKv({ cf, mode: 'dry-run', log: () => {} });
  assert.deepEqual([r.ok, r.keys, puts.length], [true, 3, 0]);
  r = await runKv({ cf, mode: 'apply', log: () => {}, settleMs: 0 });
  assert.deepEqual(r.errors, []);
  assert.equal(r.keys, 3);
  assert.deepEqual(puts.find((p) => p.key === 'ai:models').metadata, { m: 1 });
  assert.ok(ns[KV.to.id].get('bin').v.equals(Buffer.from([0, 255, 10])));
  /* 新命名空间里多了旧的没有的键 / 值不同 → 失败 */
  ns[KV.to.id].set('extra', { v: Buffer.from('x') });
  r = await runKv({ cf, mode: 'verify', log: () => {}, settleMs: 0 });
  assert.match(r.errors.join(), /key count styrigx-search-index=3 styrigx-space-gateway=4/);
  /* 部署后核对：site:* 被部署 / Cron 重建 → 只 warning；手写键（ai:models）不同 → 仍失败 */
  ns[KV.to.id].delete('extra');
  ns[KV.to.id].set('site:space', { v: Buffer.from('{"a":2}') });
  const lines = [];
  r = await runKv({ cf, mode: 'verify', log: (s) => lines.push(s), settleMs: 0 });
  assert.deepEqual(r.errors, []);
  assert.match(lines.join('\n'), /::warning::kv: site:space differs/);
  ns[KV.to.id].set('ai:models', { v: Buffer.from('{"default":"y"}'), metadata: { m: 1 } });
  r = await runKv({ cf, mode: 'verify', log: () => {}, settleMs: 0 });
  assert.match(r.errors.join(), /kv: ai:models differs/);
});

test('工作流 d1-cutover.yml：只手动触发、dry_run 默认 true；kv → d1 顺序；正式先跑三套迁移；不上传导出文件；deploy.yml 的部署 job 等 gate', () => {
  const y = read('.github/workflows/d1-cutover.yml');
  assert.match(y, /^on:\n  workflow_dispatch:\n/m);
  assert.doesNotMatch(y, /^\s+(push|pull_request|schedule):/m);
  assert.match(y, /dry_run:\n\s+description: [^\n]+\n\s+type: boolean\n\s+default: true/);
  assert.match(y, /\n  d1:\n(?:.*\n)*?    needs: kv\n/);
  assert.ok(y.includes('(cd workers/status && npx --yes "wrangler@$WRANGLER_VERSION" d1 migrations apply styrigx-space-gateway --remote)'), 'status');
  /* 进站 v3 L2：短链迁移并进 space-core（同一个库两个绑定，按绑定名跑） */
  for (const b of ['D1_SHARE_LINK', 'D1_SPACE']) {
    assert.ok(y.includes('(cd workers/space-core && npx --yes "wrangler@$WRANGLER_VERSION" d1 migrations apply ' + b + ' --remote)'), b);
  }
  assert.doesNotMatch(y, /upload-artifact/);
  assert.doesNotMatch(y, /d1 (delete|execute [^\n]*DROP)|kv namespace delete/i, '不删旧库 / 旧命名空间');
  const wf = read('.github/workflows/deploy.yml');
  assert.match(wf, /\n  d1-cutover-gate:\n/);
  for (const job of ['deploy-ai-worker', 'deploy-status-worker', 'deploy-curio-core', 'deploy-daymark-core', 'deploy-space-core']) {
    const body = wf.slice(wf.indexOf('\n  ' + job + ':\n') + 1).split(/\n  [a-z0-9-]+:\n/)[0];
    assert.match(body, /needs\.d1-cutover-gate\.outputs\.ready == 'true'/, job);
    assert.match(body, /\n    needs: \[[^\]]*d1-cutover-gate[^\]]*\]/, job);
  }
});

test('旧网关库由代码兜底 SCHEMA 建（user_handle 少 legacy_handle 列）：dry-run 与正式都只比旧表有的列，不误报', { skip: !sqlite }, async () => {
  const w = fakeWorld({ codeSchemaGateway: true });
  const d = await runD1({ cf: w.cf, wr: w.wr, mode: 'dry-run', log: () => {} });
  assert.deepEqual(d.errors, []);
  const r = await runD1({ cf: w.cf, wr: w.wr, mode: 'apply', kvKeys: 3, log: () => {} });
  assert.deepEqual(r.errors, []);
  assert.deepEqual({ ...w.neu.prepare('SELECT realm, handle, legacy_handle FROM user_handle').get() }, { realm: 'lock', handle: 'HANDLE', legacy_handle: '' });
  const v = await runD1({ cf: w.cf, wr: w.wr, mode: 'verify', log: () => {} });
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.warnings.filter((x) => /user_handle/.test(x)), []);
});

test('只比旧表有的列：旧表凭证内容一变，dry-run 照样报错', { skip: !sqlite }, async () => {
  const w = fakeWorld({ codeSchemaGateway: true });
  const wr = { ...w.wr, exportData(src, tables) { const sql = w.wr.exportData(src, tables); return src.key === 'gateway' ? sql.replace("'HANDLE'", "'OTHER'") : sql; } };
  const d = await runD1({ cf: w.cf, wr, mode: 'dry-run', log: () => {} });
  assert.match(d.errors.join(), /local import of user_handle differs/);
});
