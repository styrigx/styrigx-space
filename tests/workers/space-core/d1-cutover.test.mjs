/**
 * 进站 v3 L2b 一次性搬迁（space/scripts/d1-cutover.mjs，2026-11-09）：旧共用库 styrigx-space-gateway
 * → D1 styrigx-space-core（网关 + 分享链接）/ styrigx-status（监测），KV styrigx-space-gateway → styrigx-space-core；
 * 以及切绑定前的 resync（凭证 / 钥匙 / 分享链接表搬完后又变了 → 整表重拷）。Cloudflare 用 node:sqlite + 内存 KV 替身。
 * 运行：node --test tests/workers/space-core/d1-cutover.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  SOURCES, OLD, TARGETS, MARKER_DB, KV, MARKER_TABLE, SWITCHED, RESYNC_TABLES, rewriteExport, rowsHash, planTables, runD1, runKv, runResync, markSwitched, gate,
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

/** 假 Cloudflare：每个库 id 一个 node:sqlite。旧库 = 2026-11-07 合出来的 styrigx-space-gateway（网关旧迁移 + 分享链接旧迁移 + 监测基线 + 上次的搬迁标记） */
function fakeWorld() {
  const dbs = {};
  const mk = (id) => (dbs[id] = new sqlite.DatabaseSync(':memory:'));
  const old = mk(OLD.id);
  execDir(old, 'workers/space-core/migrations-archive/gateway');
  old.exec(read('workers/space-core/migrations-archive/share/0003_baseline_space_gateway.sql'));
  execDir(old, 'workers/status/migrations');
  for (const t of ['d1_migrations_gateway', 'd1_migrations_share', 'd1_migrations_status']) old.exec('CREATE TABLE ' + t + ' (id INTEGER PRIMARY KEY, name TEXT)');
  old.exec('CREATE TABLE d1_cutover (source TEXT PRIMARY KEY, done_at INTEGER NOT NULL, counts TEXT NOT NULL)');
  old.exec("INSERT INTO d1_cutover VALUES ('gateway', 1, '{}'), ('share', 1, '{}'), ('status', 1, '{}'), ('kv', 1, '{}')");
  const core = mk(TARGETS.core.id);
  const status = mk(TARGETS.status.id);
  /* 迁移由工作流先跑：space-core 一份基线、status 一份基线 */
  execDir(core, 'workers/space-core/migrations');
  execDir(status, 'workers/status/migrations');
  old.exec("INSERT INTO epoch VALUES ('lock', 7)");
  old.exec("INSERT INTO password VALUES ('lock', '{\"h\":\"PWHASH\"}')");
  old.exec("INSERT INTO passkey VALUES ('lock', 'cred1', '{\"pub\":\"PUBX\",\"n\":1}'), ('lock', 'cred2', 'multi\nline ''q''')");
  old.exec("INSERT INTO user_handle (realm, handle, legacy_handle) VALUES ('lock', 'HANDLE', '')");
  old.exec("INSERT INTO lock_reset_switch (hash, first_seen, used) VALUES ('h1', 1, 0)");
  old.exec("INSERT INTO tempkey (realm, id, name, code_hash, link, created_at, revoked_at, expires_at) VALUES ('lock', 'k1', 'n', NULL, 1, 1, 0, 9e12)");
  old.exec("INSERT INTO audit (realm, id, ts, ip_prefix, ok, expires_at) VALUES ('lock', 'a1', 1, '1.2.3', 1, 9)");
  old.exec("INSERT INTO share_link (id, code, target, created_at, expires_at) VALUES ('l1', 'c1', '/', 1, 2), ('l2', 'c2', '/blog/', 1, 2)");
  old.exec("INSERT INTO status_checks (site, at, ok, code, ms) VALUES ('space', 1, 1, 200, 5), ('ai', 2, 0, 0, 10000)");
  old.exec("INSERT INTO status_incidents (site, started_at, cause) VALUES ('ai', 2, 'timeout')");
  old.exec("INSERT INTO status_state (site, fails, first_fail_at) VALUES ('ai', 3, 2)");
  old.exec("INSERT INTO status_usage (id, fetched_at, data) VALUES (1, 5, '{}')");
  const calls = [];
  const cf = {
    async query(id, sql, params = []) {
      calls.push(['query', id, sql.split(' ')[0]]);
      const st = dbs[id].prepare(sql);
      return /^\s*(SELECT|PRAGMA)/i.test(sql) ? st.all(...params).map((r) => ({ ...r })) : (st.run(...params), []);
    },
  };
  const wrCalls = [];
  const wr = {
    exportData(src, tables) { wrCalls.push('export ' + src.key); return exportOf(dbs[src.old.id], tables); },
    importSql(src, sql) { wrCalls.push('import ' + src.key); dbs[src.target.id].exec(sql); },
  };
  return { dbs, cf, wr, calls, calls2: wrCalls, wrCalls, old, core, status };
}
const n = (db, t) => db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n;
const hashT = (db, t) => rowsHash(db.prepare('SELECT * FROM ' + t).all().map((x) => ({ ...x })));
const marks = (w) => w.core.prepare('SELECT source FROM ' + MARKER_TABLE + ' ORDER BY source').all().map((x) => x.source);

test('库 id / 命名空间 id 与各 wrangler.toml 一致（脚本里写死的和绑定的是同一个）；旧库只在脚本里', () => {
  assert.ok(read('workers/space-core/wrangler.toml').includes('database_id = "' + TARGETS.core.id + '"'));
  assert.ok(read('workers/status/wrangler.toml').includes('database_id = "' + TARGETS.status.id + '"'));
  for (const w of ['ai', 'curio-core', 'daymark-core']) assert.ok(read('workers/' + w + '/wrangler.toml').includes('id = "' + KV.to.id + '"'), w);
  assert.deepEqual([OLD.name, TARGETS.core.name, TARGETS.status.name, KV.from.name, KV.to.name],
    ['styrigx-space-gateway', 'styrigx-space-core', 'styrigx-status', 'styrigx-space-gateway', 'styrigx-space-core']);
  assert.equal(MARKER_DB, TARGETS.core);
  assert.deepEqual(SOURCES.map((s) => [s.key, s.old.name, s.target.name]),
    [['status', 'styrigx-space-gateway', 'styrigx-status'], ['share', 'styrigx-space-gateway', 'styrigx-space-core'], ['gateway', 'styrigx-space-gateway', 'styrigx-space-core']]);
  for (const w of ['space-core', 'status', 'ai', 'curio-core', 'daymark-core']) {
    const code = read('workers/' + w + '/wrangler.toml').replace(/#.*$/gm, '');
    assert.ok(!code.includes(OLD.id) && !code.includes(KV.from.id), w + '：绑定里不再有旧库 / 旧命名空间');
  }
});

test('rewriteExport：只认 PRAGMA / 单行 INSERT；按表计数；名单外的表、别的语句一律失败', () => {
  const sql = 'PRAGMA defer_foreign_keys=TRUE;\nINSERT INTO "status_checks" ("site","at") VALUES(\'a\',1);\nINSERT INTO "status_checks" ("site","at") VALUES(\'INSERT INTO "x" (\',2);\n';
  const r = rewriteExport(sql, (t) => t, new Set(['status_checks']));
  assert.deepEqual(r.counts, { status_checks: 2 });
  assert.equal(r.sql, sql);
  assert.throws(() => rewriteExport('INSERT INTO "d1_migrations" ("id") VALUES(1);', (t) => t, new Set(['status_checks'])), /outside the list/);
  assert.throws(() => rewriteExport('DROP TABLE checks;', (t) => t, new Set(['checks'])), /unexpected line/);
});

test('planTables：旧库的表按来源分（三个来源同一个旧库）；名单外的表 / 缺必需表 → 报问题；内部表（d1_migrations*、d1_cutover、sqlite_*、_cf_*）不搬', () => {
  const all = SOURCES.flatMap((s) => Object.keys(s.tables));
  assert.equal(new Set(all).size, all.length, '一张表只属于一个来源');
  const p = planTables(all.concat(['d1_migrations_gateway', 'd1_cutover', 'sqlite_sequence', '_cf_KV']));
  assert.deepEqual(p.problems, []);
  assert.deepEqual(p.bySource.share, ['share_fail', 'share_link']);
  assert.equal(p.bySource.status.length, 7);
  assert.match(planTables(all.concat(['bm_link'])).problems.join(), /bm_link .* not in the cutover list/);
  assert.match(planTables(all.filter((t) => t !== 'passkey')).problems.join(), /gateway: required table passkey missing/);
  assert.deepEqual(RESYNC_TABLES.slice().sort(), ['device', 'epoch', 'kv_migration', 'lock_reset_switch', 'passkey', 'password', 'share_link', 'tempkey', 'user_handle']);
});

test('rowsHash 与行顺序、列顺序无关；内容一变就变', () => {
  const a = [{ x: 1, y: 'a' }, { x: 2, y: 'b' }];
  assert.equal(rowsHash(a), rowsHash([{ y: 'b', x: 2 }, { y: 'a', x: 1 }]));
  assert.notEqual(rowsHash(a), rowsHash([{ x: 1, y: 'a' }, { x: 2, y: 'c' }]));
});

test('dry-run：不写远端（不导入、不清表、不写标记），本机按迁移建表导入后逐表行数一致；旧库里上次的 d1_cutover 不当业务表', { skip: !sqlite }, async () => {
  const w = fakeWorld();
  const r = await runD1({ cf: w.cf, wr: w.wr, mode: 'dry-run', log: () => {} });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(w.wrCalls, ['export status', 'export share', 'export gateway']);
  assert.equal(n(w.core, 'passkey'), 0, '远端新库没被写');
  assert.equal(w.core.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = '" + MARKER_TABLE + "'").get().n, 0);
  assert.deepEqual(r.report.status.tables.status_checks, { old: 2, export: 2, local: 2, target_now: 0 });
  assert.deepEqual(r.report.gateway.tables.passkey, { old: 2, export: 2, local: 2, target_now: 0 });
  assert.equal((await gate(w.cf)).ready, false);
});

test('正式：三个来源各进各的新库 + 逐表核对 + 标记写在 styrigx-space-core；凭证逐行一致；KV 标记写上后 gate 放行；重跑不再导入', { skip: !sqlite }, async () => {
  const w = fakeWorld();
  const logs = [];
  const r = await runD1({ cf: w.cf, wr: w.wr, mode: 'apply', kvKeys: 3, log: (s) => logs.push(s) });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(w.wrCalls, ['export status', 'import status', 'export share', 'import share', 'export gateway', 'import gateway']);
  for (const t of ['epoch', 'password', 'passkey', 'user_handle', 'lock_reset_switch', 'tempkey']) assert.equal(hashT(w.core, t), hashT(w.old, t), t);
  assert.equal(w.core.prepare("SELECT record FROM passkey WHERE credential_id = 'cred2'").get().record, "multi\nline 'q'");
  assert.equal(n(w.core, 'share_link'), 2);
  assert.equal(n(w.status, 'status_checks'), 2);
  assert.equal(w.status.prepare('SELECT id FROM status_incidents').get().id, 1, '自增 id 原样');
  assert.equal(w.status.prepare('SELECT first_fail_at FROM status_state').get().first_fail_at, 2);
  /* 监测只进 styrigx-status，网关 / 分享只进 styrigx-space-core */
  assert.equal(w.core.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'status_%'").get().n, 0);
  assert.equal(w.status.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('passkey', 'share_link')").get().n, 0);
  assert.deepEqual(marks(w), ['gateway', 'kv', 'share', 'status']);
  assert.equal((await gate(w.cf)).ready, true);
  /* 旧库一行没动（只读） */
  assert.equal(n(w.old, 'passkey'), 2);
  assert.equal(n(w.old, 'd1_cutover'), 4);
  /* 输出里没有任何凭证内容 */
  assert.ok(!JSON.stringify(r).includes('PUBX') && !JSON.stringify(r).includes('PWHASH') && !logs.join().includes('HANDLE'));
  /* 重跑：已有标记 → 只核对，不再导出导入 */
  w.wrCalls.length = 0;
  const again = await runD1({ cf: w.cf, wr: w.wr, mode: 'apply', kvKeys: 3, log: () => {} });
  assert.deepEqual(again.errors, []);
  assert.deepEqual(w.wrCalls, []);
  /* 部署后 verify：只报告 */
  const v = await runD1({ cf: w.cf, wr: w.wr, mode: 'verify', log: () => {} });
  assert.deepEqual(v.errors, []);
});

test('没有标记的来源：新库里已有的行先清空再导入（可重跑，不会主键冲突）；没有 --kv-keys 不写 kv 标记 → gate 不放行', { skip: !sqlite }, async () => {
  const w = fakeWorld();
  w.core.exec("INSERT INTO share_link (id, code, target, created_at, expires_at) VALUES ('l1', 'c1', '/', 1, 2), ('zz', 'zz', '/', 1, 2)");
  const r = await runD1({ cf: w.cf, wr: w.wr, mode: 'apply', kvKeys: null, log: () => {} });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(w.core.prepare('SELECT id FROM share_link ORDER BY id').all().map((x) => x.id), ['l1', 'l2']);
  assert.equal((await gate(w.cf)).ready, false);
});

test('失败即停：旧库多出名单外的表 / 新库缺表（迁移没跑）/ 导入后行数对不上 / 凭证在搬迁中变了 → 不写标记', { skip: !sqlite }, async () => {
  let w = fakeWorld();
  w.old.exec('CREATE TABLE bm_link (id INTEGER)');
  let r = await runD1({ cf: w.cf, wr: w.wr, mode: 'apply', kvKeys: 1, log: () => {} });
  assert.match(r.errors.join(), /table bm_link in styrigx-space-gateway is not in the cutover list/);
  assert.deepEqual(w.wrCalls, [], '一张都没搬');
  assert.equal((await gate(w.cf)).ready, false);

  w = fakeWorld();
  w.status.exec('DROP TABLE status_quota');
  r = await runD1({ cf: w.cf, wr: w.wr, mode: 'apply', kvKeys: 1, log: () => {} });
  assert.match(r.errors.join(), /status: tables missing in styrigx-status \(run d1 migrations apply first\): status_quota/);

  w = fakeWorld();
  const imp = w.wr.importSql;
  w.wr.importSql = (src, sql) => imp(src, src.key === 'share' ? sql.split('\n').filter((l) => !l.includes("'l2'")).join('\n') : sql);
  r = await runD1({ cf: w.cf, wr: w.wr, mode: 'apply', kvKeys: 1, log: () => {} });
  assert.match(r.errors.join(), /share: share_link has 1 rows, export had 2/);
  assert.deepEqual(marks(w), ['status'], 'share 失败就停：gateway / kv 都没搬、没写标记');

  w = fakeWorld();
  const exp = w.wr.exportData;
  w.wr.exportData = (src, tables) => { const s = exp(src, tables); if (src.key === 'gateway') w.old.exec("UPDATE passkey SET record = 'NEW' WHERE credential_id = 'cred1'"); return s; };
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
    if (src.key === 'status') w.old.exec("INSERT INTO status_checks (site, at, ok, code, ms) VALUES ('space', 9, 1, 200, 5)");
    if (src.key === 'share') w.old.exec("INSERT INTO share_link (id, code, target, created_at, expires_at) VALUES ('l3', 'c3', '/', 1, 2)");
  };
  const r = await runD1({ cf: w.cf, wr: w.wr, mode: 'apply', kvKeys: 1, log: () => {} });
  assert.match(r.warnings.join(), /status: status_checks rows styrigx-space-gateway=3 styrigx-status=2/);
  assert.match(r.errors.join(), /share: share_link rows styrigx-space-gateway=3 styrigx-space-core=2/);
});

test('resync：搬完之后旧库里改了解锁密码 / 加了通行密钥 / 作废了分享链接 → 部署前整表重拷，没变的表不碰；写了 switched 之后一律跳过', { skip: !sqlite }, async () => {
  const w = fakeWorld();
  assert.deepEqual((await runD1({ cf: w.cf, wr: w.wr, mode: 'apply', kvKeys: 3, log: () => {} })).errors, []);
  /* 搬完、切绑定之前：旧 Worker 还在写旧库 */
  w.old.exec("UPDATE password SET record = '{\"h\":\"NEWPW\"}' WHERE realm = 'lock'");
  w.old.exec("INSERT INTO passkey VALUES ('lock', 'cred3', '{\"pub\":\"P3\"}')");
  w.old.exec("UPDATE share_link SET revoked_at = 5 WHERE id = 'l1'");
  w.old.exec("INSERT INTO status_checks (site, at, ok, code, ms) VALUES ('space', 9, 1, 200, 5)");
  const logs = [];
  const r = await runResync({ cf: w.cf, log: (s) => logs.push(s) });
  assert.deepEqual(r.errors, []);
  assert.equal(r.skipped, false);
  assert.deepEqual(Object.keys(r.copied).sort(), ['passkey', 'password', 'share_link']);
  assert.deepEqual(r.copied, { password: 1, passkey: 3, share_link: 2 });
  for (const t of RESYNC_TABLES) assert.equal(hashT(w.core, t), hashT(w.old, t), t);
  assert.equal(n(w.status, 'status_checks'), 2, '监测（live）不管');
  assert.ok(!logs.join().includes('NEWPW') && !logs.join().includes('P3'), '日志里没有凭证内容');
  /* 切换成功：写 switched → 之后旧库再变也不拿它盖新库 */
  await markSwitched(w.cf);
  w.old.exec("UPDATE password SET record = 'STALE' WHERE realm = 'lock'");
  const after = await runResync({ cf: w.cf, log: () => {} });
  assert.deepEqual([after.ok, after.skipped], [true, true]);
  assert.notEqual(w.core.prepare("SELECT record FROM password WHERE realm = 'lock'").get().record, 'STALE');
  assert.ok(marks(w).includes(SWITCHED));
  /* switched 不影响 gate */
  assert.equal((await gate(w.cf)).ready, true);
});

test('resync：没有搬迁标记 → 失败（不部署）；行多的表分批插入（每条语句不超过 D1 的 100 个参数）；什么都没变 → 一张都不碰', { skip: !sqlite }, async () => {
  let w = fakeWorld();
  let r = await runResync({ cf: w.cf, log: () => {} });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /no cutover marker gateway in styrigx-space-core/);

  w = fakeWorld();
  assert.deepEqual((await runD1({ cf: w.cf, wr: w.wr, mode: 'apply', kvKeys: 3, log: () => {} })).errors, []);
  w.calls.length = 0;
  r = await runResync({ cf: w.cf, log: () => {} });
  assert.deepEqual([r.ok, Object.keys(r.copied).length], [true, 0]);
  assert.ok(!w.calls.some(([op, id, verb]) => id === TARGETS.core.id && /^(DELETE|INSERT)$/.test(verb)), '没变就不写');
  /* 250 条分享链接（11 列 → 每条语句最多 8 行） */
  const ins = w.old.prepare("INSERT INTO share_link (id, code, target, created_at, expires_at) VALUES (?, ?, '/', 1, 2)");
  for (let i = 0; i < 250; i++) ins.run('b' + i, 'code' + i);
  const big = [];
  const q0 = w.cf.query;
  w.cf.query = async (id, sql, params = []) => { if (/^INSERT INTO "share_link"/.test(sql)) big.push(params.length); return q0(id, sql, params); };
  r = await runResync({ cf: w.cf, log: () => {} });
  assert.deepEqual(r.errors, []);
  assert.equal(r.copied.share_link, 252);
  assert.ok(big.length > 1 && big.every((p) => p <= 100), big.join(','));
  assert.equal(hashT(w.core, 'share_link'), hashT(w.old, 'share_link'));
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
  assert.match(r.errors.join(), /key count styrigx-space-gateway=3 styrigx-space-core=4/);
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

test('工作流 d1-cutover.yml：只手动触发、dry_run 默认 true；kv → d1 顺序；正式先跑两套迁移；不上传导出文件、不删旧库；deploy.yml 的部署 job 等 gate，space-core 部署前 resync、冒烟后 switched', () => {
  const y = read('.github/workflows/d1-cutover.yml');
  assert.match(y, /^on:\n  workflow_dispatch:\n/m);
  assert.doesNotMatch(y, /^\s+(push|pull_request|schedule):/m);
  assert.match(y, /dry_run:\n\s+description: [^\n]+\n\s+type: boolean\n\s+default: true/);
  assert.match(y, /\n  d1:\n(?:.*\n)*?    needs: kv\n/);
  assert.ok(y.includes('(cd workers/status && npx --yes "wrangler@$WRANGLER_VERSION" d1 migrations apply styrigx-status --remote)'), 'status');
  assert.ok(y.includes('(cd workers/space-core && npx --yes "wrangler@$WRANGLER_VERSION" d1 migrations apply D1_SPACE --remote)'), 'space-core');
  assert.doesNotMatch(y, /D1_SHARE_LINK/);
  assert.doesNotMatch(y, /upload-artifact/);
  assert.doesNotMatch(y, /d1 (delete|execute [^\n]*DROP)|kv namespace delete/i, '不删旧库 / 旧命名空间');
  const wf = read('.github/workflows/deploy.yml');
  assert.match(wf, /\n  d1-cutover-gate:\n/);
  for (const job of ['deploy-ai-worker', 'deploy-status-worker', 'deploy-curio-core', 'deploy-daymark-core', 'deploy-space-core']) {
    const body = wf.slice(wf.indexOf('\n  ' + job + ':\n') + 1).split(/\n  [a-z0-9-]+:\n/)[0];
    assert.match(body, /needs\.d1-cutover-gate\.outputs\.ready == 'true'/, job);
    assert.match(body, /\n    needs: \[[^\]]*d1-cutover-gate[^\]]*\]/, job);
  }
  const core = wf.slice(wf.indexOf('\n  deploy-space-core:\n') + 1).split(/\n  [a-z0-9-]+:\n/)[0];
  assert.ok(core.indexOf('d1-cutover.mjs resync') > 0 && core.indexOf('d1-cutover.mjs resync') < core.indexOf('command: deploy\n'));
  assert.ok(core.indexOf('d1-cutover.mjs switched') > core.indexOf("redir \"https://styrigx.com/s/smoke"));
  assert.match(core, /redir "https:\/\/styrigx\.com\/s\/smoke\$\(date \+%s\)x+" 302 'https:\/\/styrigx\.com\/\?entry=1'/);
});
