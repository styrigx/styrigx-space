/**
 * scripts/migrate-account-auth.mjs（账号拆分 PR2：账号认证数据 styrigx-auth-gateway → styrigx-account，恢复开关表改名）。
 * 不访问网络：两个库都是 node:sqlite 内存库，套一层 D1 REST query 的替身（同 kv-migration.test.mjs 的 restD1）；
 * main() 用本地 HTTP 替身（CF_API_BASE）跑子进程，核对 --preview 的库 id 和退出码。
 *
 * 覆盖：--dry-run / apply / --lock-reset-switch / --verify / --cleanup --confirm / --preview；幂等重跑；中途失败重跑补齐；
 * 合并规则（verify 用）每条规则；cleanup 必须先 verify；预览两边同库。
 * PR4 删掉了切换期专用的 --reconcile / --reverse（cleanup 之后没有旧边可合并 / 可写回）及其用例。
 *
 * 运行：node --test tests/workers/account/migrate-account-auth.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  run, mergeRow, FAMILIES, MARKERS, splitSql, readAccountSchema, d1IdIn, resolveDbIds, modeOf,
  ACCOUNT_SCHEMA_FILE, SWITCH_CREATE, SWITCH_COPY,
} from '../../../scripts/migrate-account-auth.mjs';
import { SCHEMA as GATEWAY_SCHEMA } from '../../../workers/account/src/lib/d1-state.js';

const ROOT = new URL('../../../', import.meta.url).pathname;
const SCRIPT = ROOT + 'scripts/migrate-account-auth.mjs';
const GW_MIG = ROOT + 'workers/auth-gateway/migrations/';
const AC_MIG = ROOT + 'workers/account/migrations/';
const NOW = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;
const PREVIEW_DB = '1339bb0b-f9f8-4e3d-b413-ff07ca28ce69';

/* ---------- 替身 ---------- */

/** 网关 0007（user_handle 加 legacy_handle，预览共库兼容） */
const GW_LEGACY_MIG = '0007_user_handle_legacy_handle.sql';
/** 网关 0009（PR4 删旧开关表）：脚本处理的是 cleanup 之前的网关库，这里的替身只跑到 0008 */
const GW_DROP_MIG = '0009_drop_recovery_switch.sql';
/**
 * 网关库（cleanup 之前的样子）：跑网关迁移到 0008（0001 recovery_switch + 0005 / 0006 认证表 + 0007 legacy_handle 列 + 0008 lock_reset_switch）。
 * before0007 = true：只跑到 0006（0007 之前的老库：user_handle 没有 legacy_handle，测脚本的防御性 ALTER 补列）。
 */
function gatewayDb(before0007) {
  const raw = new DatabaseSync(':memory:');
  for (const f of readdirSync(GW_MIG).filter((x) => x.endsWith('.sql')).sort()) {
    if (f >= GW_DROP_MIG) continue;
    if (before0007 && f >= GW_LEGACY_MIG) continue;
    raw.exec(readFileSync(GW_MIG + f, 'utf8'));
  }
  return raw;
}
/** 账号库（PR2 之前的样子）：只有 0001 / 0002（0003 由 apply 读文件建） */
function accountDb() {
  const raw = new DatabaseSync(':memory:');
  for (const f of ['0001_wellbeing.sql', '0002_settings_sync.sql']) raw.exec(readFileSync(AC_MIG + f, 'utf8'));
  return raw;
}
/** D1 REST query 替身：{ results, meta: { changes } }；failWhen 命中的语句抛 HTTP 500 */
function rest(raw, name, calls) {
  const api = {
    raw,
    failWhen: (_sql, _params) => false,
    async d1(sql, params) {
      calls.push(name + ': ' + sql);
      if (api.failWhen(sql, params || [])) throw new Error('D1 query HTTP 500');
      const st = raw.prepare(sql);
      if (/^\s*SELECT\b/i.test(sql)) return { results: st.all(...(params || [])).map((r) => ({ ...r })), meta: { changes: 0 } };
      const r = st.run(...(params || []));
      return { results: [], meta: { changes: Number(r.changes || 0) } };
    },
  };
  return api;
}
function pair(opts) {
  const calls = [];
  const G = gatewayDb(opts && opts.before0007);
  const A = opts && opts.sameDb ? G : accountDb();
  const apis = { gateway: rest(G, 'G', calls), account: rest(A, 'A', calls), sameDb: !!(opts && opts.sameDb) };
  return { G, A, apis, calls };
}
const go = (apis, mode, extra) => run(apis, Object.assign({ mode, now: NOW }, extra || {}));

const pk = (credId, extra) => JSON.stringify(Object.assign({ name: 'k-' + credId, provider: '', aaguid: '', createdAt: NOW - 10 * DAY, lastUsedAt: 0, credId, publicKey: { kty: 'EC', x: 'PUBX' }, signCount: 3, uv: 1 }, extra || {}));
const pw = (hash, updatedAt) => JSON.stringify({ salt: 'SALT', hash, iterations: 600000, peppered: true, updatedAt });
const dev = (id, extra) => JSON.stringify(Object.assign({ deviceId: id, by: 'password', createdAt: NOW - 5 * DAY, lastSeen: NOW - DAY }, extra || {}));

/** 切换前网关库里的样子（值里的大写串都是「不许出现在输出里」的） */
function seed(G) {
  const x = (sql, ...p) => G.prepare(sql).run(...p);
  x("INSERT INTO epoch VALUES ('lock', 4), ('account', 9)");
  x("INSERT INTO password VALUES ('lock', ?), ('account', ?)", pw('LOCKHASH', NOW - 20 * DAY), pw('ACCTHASH', NOW - 10 * DAY));
  x("INSERT INTO passkey VALUES ('lock', 'LOCKPK1', ?), ('account', 'ACCTPK1', ?), ('account', 'ACCTPK2', ?)", pk('LOCKPK1'), pk('ACCTPK1'), pk('ACCTPK2'));
  x("INSERT INTO user_handle (realm, handle) VALUES ('lock', 'LOCKHANDLE'), ('account', 'ACCTHANDLE')");
  x("INSERT INTO challenge VALUES ('account', 'c1', 'login', 'CHALLENGEVALUE', ?), ('lock', 'c2', 'auth', 'LOCKCH', ?)", NOW + 300000, NOW + 300000);
  const lim = "INSERT INTO attempt_limit (realm, kind, bucket, count, strikes, locked_until, window_start, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
  x(lim, 'account', 'password', '1.2.3.x', 2, 1, 0, 0, NOW + 3600000);
  x(lim, 'account', 'password', '9.9.9.x', 5, 0, 0, 0, NOW - 1); /* 过期 */
  x(lim, 'root', 'rootkey', '5.5.5.x', 3, 0, 0, 0, NOW + 3600000);
  x(lim, 'root', 'rootkey', '*', 7, 0, 0, NOW - 60000, NOW + 3600000);
  x(lim, 'lock', 'password', '1.2.3.x', 1, 0, 0, 0, NOW + 3600000);
  const dv = 'INSERT INTO device (realm, device_id, record, last_seen, revoked_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)';
  x(dv, 'account', 'DEV1', dev('DEV1'), NOW - DAY, 0, NOW + 300 * DAY);
  x(dv, 'account', 'DEV2', dev('DEV2'), NOW - 2 * DAY, NOW - DAY, NOW + 300 * DAY); /* 已退出 */
  x(dv, 'account', 'DEV3', dev('DEV3'), 0, 0, NOW - 1); /* 过期 */
  const au = 'INSERT INTO audit (realm, id, ts, ip_prefix, ok, decoy, via, path, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
  x(au, 'root', 'r1', NOW - DAY, '1.1.1.x', 1, 0, '', 'account-reauth', NOW + 6 * DAY);
  x(au, 'root', 'r2', NOW - DAY, '1.1.1.x', 0, 0, '', 'account-reset', NOW + 6 * DAY);
  x(au, 'root', 'r3', NOW - DAY, '1.1.1.x', 1, 0, '', 'lock-reauth', NOW + 6 * DAY);
  x(au, 'root', 'r4', NOW - DAY, '1.1.1.x', 1, 0, 'switch', 'lock-reset', NOW + 6 * DAY);
  x(au, 'root', 'r5', NOW - 8 * DAY, '1.1.1.x', 1, 0, '', 'account-reauth', NOW - 1); /* 过期 */
  x(au, 'root', 'r6', NOW - DAY, '1.1.1.x', 1, 0, '', 'other', NOW + 6 * DAY); /* 不认识的 path：不拷 */
  x("INSERT INTO tempkey (realm, id, name, code_hash, link, created_at, revoked_at, expires_at) VALUES ('lock', 'TK1', 'n', 'CODEHASH', 0, ?, 0, ?)", NOW, NOW + DAY);
  x("INSERT INTO recovery_switch VALUES ('SW_USED', ?, 1), ('SW_TIMING', ?, 0), ('SW_UNSEEN', 0, 0)", NOW - 3 * DAY, NOW - 3600000);
}

const tables = (raw) => raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
const rows = (raw, sql, ...p) => raw.prepare(sql).all(...p).map((r) => ({ ...r }));
const one = (raw, sql, ...p) => { const r = raw.prepare(sql).get(...p); return r ? { ...r } : null; };
function snapshot(raw) {
  const out = {};
  for (const t of tables(raw)) out[t] = rows(raw, 'SELECT * FROM ' + t + ' ORDER BY 1, 2');
  return out;
}
async function applied(opts) {
  const p = pair(opts);
  seed(p.G);
  const r = await go(p.apis, 'apply');
  assert.equal(r.ok, true);
  return p;
}

/* ---------- 0003 ---------- */

test('0003_account_auth.sql：9 张表；结构照搬网关 0005 / 0006（保留 realm 列）；user_handle 多 legacy_handle；脚本读这个文件、不内嵌第二份', () => {
  const stmts = readAccountSchema();
  const created = stmts.map((s) => (s.match(/^CREATE TABLE IF NOT EXISTS (\w+)/) || [])[1]).filter(Boolean);
  assert.deepEqual(created.sort(), ['attempt_limit', 'audit', 'challenge', 'data_migration', 'device', 'epoch', 'passkey', 'password', 'user_handle']);
  for (const s of stmts) assert.match(s, /^CREATE (TABLE|INDEX) IF NOT EXISTS /, s);
  const A = new DatabaseSync(':memory:');
  for (const s of stmts) A.exec(s);
  const G = gatewayDb(true);
  const cols = (db, t) => rows(db, 'PRAGMA table_info(' + t + ')').map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk]);
  for (const t of ['epoch', 'password', 'passkey', 'challenge', 'attempt_limit', 'device', 'audit']) assert.deepEqual(cols(A, t), cols(G, t), t);
  assert.deepEqual(cols(A, 'user_handle'), [...cols(G, 'user_handle'), ['legacy_handle', 'TEXT', 1, "''", 0]]);
  /* 网关 0007 补的列与 0003 自带的同一定义 */
  assert.deepEqual(cols(gatewayDb(), 'user_handle'), cols(A, 'user_handle'));
  assert.deepEqual(rows(A, "PRAGMA index_info('audit_ts')").map((r) => r.name), ['realm', 'ts']);
  /* 没有锁屏的表 */
  for (const t of ['tempkey', 'recovery_switch', 'lock_reset_switch', 'kv_migration']) assert.ok(!created.includes(t), t);
  /* 和网关 SCHEMA 同一套列定义（d1-state 共享模块不改就能用） */
  for (const s of GATEWAY_SCHEMA.filter((x) => /TABLE IF NOT EXISTS (epoch|password|passkey|challenge|attempt_limit|device|audit) /.test(x))) assert.ok(stmts.includes(s), s);
  const src = readFileSync(SCRIPT, 'utf8');
  assert.ok(src.includes(ACCOUNT_SCHEMA_FILE));
  assert.doesNotMatch(src, /CREATE TABLE IF NOT EXISTS (epoch|password|passkey|user_handle|device|audit|attempt_limit|data_migration)\b/, '建表语句只在 0003 里');
  /* 方案 9.4 lock_reset_switch 迁移的两条语句（原文；网关 0007 已被 legacy_handle 占用，迁移编号顺延为 0008） */
  assert.equal(SWITCH_CREATE, 'CREATE TABLE IF NOT EXISTS lock_reset_switch (hash TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0)');
  assert.equal(SWITCH_COPY, 'INSERT OR IGNORE INTO lock_reset_switch (hash, first_seen, used) SELECT hash, first_seen, used FROM recovery_switch');
  /* 与网关 migrations/0008_lock_reset_switch.sql 逐条一致（预览走迁移、生产由本脚本执行，同一段 SQL） */
  assert.deepEqual(splitSql(readFileSync(GW_MIG + '0008_lock_reset_switch.sql', 'utf8')), [SWITCH_CREATE, SWITCH_COPY]);
  assert.deepEqual(splitSql('-- a; b\nCREATE x (a);\n\n  -- c\nCREATE y;'), ['CREATE x (a)', 'CREATE y']);
});

/* ---------- --dry-run ---------- */

test('--dry-run：只发 SELECT、不建表；打印每类计数和标记状态；输出不含任何值', async () => {
  const { G, A, apis, calls } = pair();
  seed(G);
  const before = snapshot(G);
  const res = await go(apis, 'dry-run');
  assert.equal(res.ok, true);
  assert.equal(res.written, 0);
  for (const c of calls) assert.match(c, /^[GA]: SELECT /, c);
  assert.deepEqual(snapshot(G), before);
  assert.deepEqual(tables(A), ['settings_sync', 'wb_daily'], '账号库不建表');
  const out = res.lines.join('\n');
  assert.match(out, /^account-epoch: 1 row\(s\) planned$/m);
  assert.match(out, /^account-passkey: 2 row\(s\) planned$/m);
  assert.match(out, /^account-device: 2 row\(s\) planned$/m, '过期设备不算');
  assert.match(out, /^account-attempt-limit: 1 row\(s\) planned$/m);
  assert.match(out, /^root-attempt-limit-account: 2 row\(s\) planned$/m);
  assert.match(out, /^root-audit-account: 2 row\(s\) planned$/m);
  assert.match(out, /^root-audit-lock: 2 row\(s\) planned$/m);
  assert.match(out, /^lock-reset-switch: 3 recovery_switch row\(s\) planned$/m);
  assert.match(out, /not copied: account challenge 1, root audit with other paths 1/);
  assert.match(out, /lock user handle \(→ legacy_handle\): 1/);
  for (const v of ['LOCKHASH', 'ACCTHASH', 'SALT', 'PUBX', 'LOCKHANDLE', 'ACCTHANDLE', 'CHALLENGEVALUE', 'CODEHASH']) assert.ok(!out.includes(v), v);
  /* 拷过以后再 dry-run：标出会跳过 */
  await go(apis, 'apply');
  const n = calls.length;
  const again = await go(apis, 'dry-run');
  for (const c of calls.slice(n)) assert.match(c, /^[GA]: SELECT /, c);
  assert.match(again.lines.join('\n'), /account-password: 1 row\(s\) planned \(already migrated: will be skipped\)/);
  assert.match(again.lines.join('\n'), /lock-reset-switch: 3 recovery_switch row\(s\) planned \(already migrated: will be skipped\)/);
});

/* ---------- apply ---------- */

test('apply：账号库建表（0003）并逐行原样拷贝；root 审计 / 限速按方案分到账号和锁屏；challenge / 过期行不拷；开关表拷到 lock_reset_switch；旧库原样', async () => {
  const { G, A, apis } = pair();
  seed(G);
  const gBefore = snapshot(G);
  const res = await go(apis, 'apply');
  assert.equal(res.ok, true);
  for (const t of ['epoch', 'password', 'passkey', 'user_handle', 'challenge', 'attempt_limit', 'device', 'audit', 'data_migration']) assert.ok(tables(A).includes(t), t);
  assert.deepEqual(rows(A, 'SELECT * FROM epoch'), [{ realm: 'account', value: 9 }], '纪元原样（会话不失效）');
  assert.deepEqual(rows(A, 'SELECT * FROM password'), [{ realm: 'account', record: pw('ACCTHASH', NOW - 10 * DAY) }]);
  assert.deepEqual(rows(A, 'SELECT * FROM passkey ORDER BY credential_id'), [
    { realm: 'account', credential_id: 'ACCTPK1', record: pk('ACCTPK1') }, { realm: 'account', credential_id: 'ACCTPK2', record: pk('ACCTPK2') }]);
  assert.deepEqual(rows(A, 'SELECT * FROM user_handle'), [{ realm: 'account', handle: 'ACCTHANDLE', legacy_handle: 'LOCKHANDLE' }]);
  assert.equal(rows(A, 'SELECT * FROM challenge').length, 0, 'challenge 不拷');
  assert.deepEqual(rows(A, 'SELECT device_id, revoked_at FROM device ORDER BY device_id'), [{ device_id: 'DEV1', revoked_at: 0 }, { device_id: 'DEV2', revoked_at: NOW - DAY }], '含已退出的；过期的不拷');
  assert.deepEqual(rows(A, 'SELECT * FROM device'), rows(G, "SELECT * FROM device WHERE device_id IN ('DEV1', 'DEV2') ORDER BY device_id"));
  assert.deepEqual(rows(A, 'SELECT realm, kind, bucket, count FROM attempt_limit ORDER BY kind, bucket'), [
    { realm: 'account', kind: 'password', bucket: '1.2.3.x', count: 2 },
    { realm: 'account', kind: 'rootkey', bucket: '*', count: 7 },
    { realm: 'account', kind: 'rootkey', bucket: '5.5.5.x', count: 3 }]);
  assert.deepEqual(rows(A, 'SELECT realm, id, path, via FROM audit ORDER BY id'), [
    { realm: 'account', id: 'r1', path: 'root-reauth', via: '' }, { realm: 'account', id: 'r2', path: 'root-reset', via: '' }]);
  /* 锁屏那一半留在网关库，realm 改 lock（拷一份，root 原行到 cleanup 才删） */
  assert.deepEqual(rows(G, "SELECT id, path, via FROM audit WHERE realm = 'lock' ORDER BY id"), [{ id: 'r3', path: 'lock-reauth', via: '' }, { id: 'r4', path: 'lock-reset', via: 'switch' }]);
  assert.deepEqual(rows(G, "SELECT bucket, count, window_start FROM attempt_limit WHERE realm = 'lock' AND kind = 'rootkey' ORDER BY bucket"),
    [{ bucket: '*', count: 7, window_start: NOW - 60000 }, { bucket: '5.5.5.x', count: 3, window_start: 0 }]);
  assert.deepEqual(rows(G, 'SELECT * FROM lock_reset_switch ORDER BY hash'), rows(G, 'SELECT * FROM recovery_switch ORDER BY hash'));
  assert.equal(rows(G, 'SELECT * FROM lock_reset_switch').length, 3);
  /* 旧库：除了新加的 lock 行和 lock_reset_switch，一行没动 */
  const gAfter = snapshot(G);
  delete gAfter.lock_reset_switch;
  delete gBefore.lock_reset_switch; /* 网关 0008_lock_reset_switch.sql 在测试库里先建了空表（同预览）；生产不跑迁移，表由 apply / --lock-reset-switch 建 */
  gAfter.audit = gAfter.audit.filter((r) => r.realm !== 'lock');
  gAfter.attempt_limit = gAfter.attempt_limit.filter((r) => !(r.realm === 'lock' && r.kind === 'rootkey'));
  assert.deepEqual(gAfter, gBefore);
  /* 标记：每类一条 + 拷过的 passkey / device 主键 */
  const marks = rows(A, 'SELECT name FROM data_migration ORDER BY name').map((r) => r.name);
  for (const m of MARKERS) assert.ok(marks.includes(m), m);
  for (const m of ['account-passkey:ACCTPK1', 'account-passkey:ACCTPK2', 'account-device:DEV1', 'account-device:DEV2']) assert.ok(marks.includes(m), m);
  assert.equal(marks.length, MARKERS.length + 4);
  for (const v of ['ACCTHASH', 'PUBX', 'HANDLE']) assert.ok(!res.lines.join('\n').includes(v), v);
});

test('apply 幂等：再跑一次不写任何行；切换后新库改过 / 删过的不会被旧库盖回去', async () => {
  const { G, A, apis } = await applied();
  const snapA = snapshot(A);
  const snapG = snapshot(G);
  const again = await go(apis, 'apply');
  assert.equal(again.written, 0);
  assert.deepEqual(snapshot(A), snapA);
  assert.deepEqual(snapshot(G), snapG);
  assert.match(again.lines.join('\n'), /account-passkey: already migrated, skipped/);
  /* 新库上线后：删了一把通行密钥、改了密码、纪元推进；旧库又新加了开关行（由 --lock-reset-switch 处理） */
  A.exec("DELETE FROM passkey WHERE credential_id = 'ACCTPK1'; UPDATE epoch SET value = 30; UPDATE password SET record = 'NEW'");
  G.exec("INSERT INTO recovery_switch VALUES ('SW_LATE', 0, 0)");
  const third = await go(apis, 'apply');
  assert.equal(third.written, 0);
  assert.equal(one(A, "SELECT COUNT(*) AS n FROM passkey WHERE credential_id = 'ACCTPK1'").n, 0, '删掉的不写回来');
  assert.equal(one(A, 'SELECT value FROM epoch').value, 30, '纪元不回退');
  assert.equal(one(A, 'SELECT record FROM password').record, 'NEW');
  assert.equal(one(G, "SELECT COUNT(*) AS n FROM lock_reset_switch WHERE hash = 'SW_LATE'").n, 0, 'apply 有标记就跳过；补齐是 --lock-reset-switch 的事');
});

test('apply 中途失败：该类不写标记；再跑一次补齐，已写的不重复；之后 verify 通过', async () => {
  const { G, A, apis } = pair();
  seed(G);
  let n = 0;
  apis.account.failWhen = (sql) => /INTO passkey/.test(sql) && ++n === 2; /* 第二把通行密钥写失败 */
  await assert.rejects(go(apis, 'apply'), /HTTP 500/);
  assert.equal(one(A, 'SELECT COUNT(*) AS n FROM passkey').n, 1);
  assert.equal(one(A, "SELECT COUNT(*) AS n FROM data_migration WHERE name = 'account-passkey'").n, 0, '没写完不写标记');
  assert.equal(one(A, "SELECT COUNT(*) AS n FROM data_migration WHERE name = 'account-password'").n, 1, '前面写完的类有标记');
  assert.equal((await go(apis, 'verify')).ok, false);
  apis.account.failWhen = () => false;
  /* 网关库那边（开关表）也失败一次 */
  apis.gateway.failWhen = (sql) => sql === SWITCH_COPY;
  await assert.rejects(go(apis, 'apply'), /HTTP 500/);
  assert.equal(one(A, "SELECT COUNT(*) AS n FROM data_migration WHERE name = 'lock-reset-switch'").n, 0);
  assert.equal(one(A, 'SELECT COUNT(*) AS n FROM passkey').n, 2, '第二次跑已把通行密钥补齐（不重复）');
  assert.equal(one(A, "SELECT COUNT(*) AS n FROM data_migration WHERE name = 'account-passkey'").n, 1);
  apis.gateway.failWhen = () => false;
  const res = await go(apis, 'apply');
  assert.equal(res.ok, true);
  assert.match(res.lines.join('\n'), /account-passkey: already migrated, skipped/);
  assert.match(res.lines.join('\n'), /lock-reset-switch: 3 row\(s\) written/);
  assert.equal(rows(G, 'SELECT * FROM lock_reset_switch').length, 3);
  const v = await go(apis, 'verify');
  assert.equal(v.ok, true, v.mismatches.join('\n'));
});

/* ---------- --lock-reset-switch ---------- */

test('--lock-reset-switch：类标记已在（apply 过）也照样拷——旧表后来新加的行补进新表，旧表里后来计时 / 用掉的推到新表；旧表和账号数据不动；可重复跑；之后 verify 通过', async () => {
  const { G, A, apis, calls } = await applied();
  /* apply 之后、部署改名代码之前，旧代码还在读写 recovery_switch：开始计时、用掉一个，Sloan 又插了一行 */
  G.prepare("UPDATE recovery_switch SET first_seen = ? WHERE hash = 'SW_UNSEEN'").run(NOW - 500);
  G.exec("UPDATE recovery_switch SET used = 1 WHERE hash = 'SW_TIMING'");
  G.exec("INSERT INTO recovery_switch VALUES ('SW_LATE', 0, 0)");
  assert.equal((await go(apis, 'verify')).ok, false, '旧表变了，verify 先不过');
  const oldBefore = rows(G, 'SELECT * FROM recovery_switch ORDER BY hash');
  const snapA = snapshot(A);
  const n = calls.length;
  const res = await go(apis, 'lock-reset-switch');
  assert.equal(res.ok, true);
  assert.match(res.lines.join('\n'), /^lock-reset-switch: 1 row\(s\) copied, 2 row\(s\) updated \(4 recovery_switch \/ 4 lock_reset_switch\)$/m);
  assert.deepEqual(rows(G, 'SELECT * FROM lock_reset_switch ORDER BY hash'), oldBefore, '新表与旧表一致');
  assert.deepEqual(rows(G, 'SELECT * FROM recovery_switch ORDER BY hash'), oldBefore, '旧表不动');
  assert.deepEqual(snapshot(A), snapA, '账号库不动（标记已在）');
  for (const c of calls.slice(n)) assert.match(c, /^G: |^A: SELECT |^A: INSERT OR IGNORE INTO data_migration /, c);
  assert.ok(!calls.slice(n).some((c) => /^G: .*\b(epoch|password|passkey|user_handle|device|audit|attempt_limit|challenge|tempkey)\b/.test(c)), '只碰开关表');
  const again = await go(apis, 'lock-reset-switch');
  assert.equal(again.written, 0, '重复跑不写');
  const v = await go(apis, 'verify');
  assert.equal(v.ok, true, v.mismatches.join('\n'));
});

test('--lock-reset-switch：新表已经更严（已用 / 更早计时）不会被旧表放宽；没 apply 过时建表、拷全部行、补标记；旧表不在时什么都不拷', async () => {
  const { G, A, apis } = pair();
  seed(G);
  G.exec(SWITCH_CREATE);
  G.prepare("INSERT INTO lock_reset_switch VALUES ('SW_UNSEEN', ?, 1)").run(NOW - 50);
  const res = await go(apis, 'lock-reset-switch');
  assert.equal(res.ok, true);
  assert.deepEqual(rows(G, 'SELECT hash, first_seen, used FROM lock_reset_switch ORDER BY hash'), [
    { hash: 'SW_TIMING', first_seen: NOW - 3600000, used: 0 },
    { hash: 'SW_UNSEEN', first_seen: NOW - 50, used: 1 },
    { hash: 'SW_USED', first_seen: NOW - 3 * DAY, used: 1 },
  ]);
  assert.equal(tables(A).includes('data_migration'), false, '账号库没建过 data_migration：不建表、不写标记');
  /* 账号库有 data_migration（apply 过的样子）时补上类标记 */
  const p2 = pair();
  seed(p2.G);
  p2.A.exec('CREATE TABLE data_migration (name TEXT PRIMARY KEY, migrated_at INTEGER NOT NULL)');
  await go(p2.apis, 'lock-reset-switch');
  assert.deepEqual(rows(p2.A, 'SELECT name FROM data_migration'), [{ name: 'lock-reset-switch' }]);
  assert.equal(rows(p2.G, 'SELECT * FROM lock_reset_switch').length, 3);
  /* 旧表已被 DROP（cleanup 之后）：只确保新表在 */
  const p3 = pair();
  p3.G.exec('DROP TABLE recovery_switch');
  const r3 = await go(p3.apis, 'lock-reset-switch');
  assert.match(r3.lines.join('\n'), /no recovery_switch table, nothing to copy/);
  assert.ok(tables(p3.G).includes('lock_reset_switch'));
});

/* ---------- --verify ---------- */

test('--verify：apply 前失败（列出缺的标记和主键）；apply 后通过；只发 SELECT；新库落后或开关表缺行就失败、只列主键', async () => {
  const { G, A, apis, calls } = pair();
  seed(G);
  const pre = await go(apis, 'verify');
  assert.equal(pre.ok, false);
  assert.ok(pre.mismatches.includes('account-epoch (marker missing: apply not finished)'), pre.mismatches.join('\n'));
  assert.ok(pre.mismatches.includes('account-passkey passkey {"realm":"account","credential_id":"ACCTPK1"} (missing)'), pre.mismatches.join('\n'));
  assert.ok(pre.mismatches.includes('lock-reset-switch lock_reset_switch {"hash":"SW_USED"} (missing)'), pre.mismatches.join('\n'));
  assert.deepEqual(tables(A), ['settings_sync', 'wb_daily'], 'verify 不建表');
  for (const c of calls) assert.match(c, /^[GA]: SELECT /, c);
  await go(apis, 'apply');
  const n = calls.length;
  const ok = await go(apis, 'verify');
  assert.equal(ok.ok, true, ok.mismatches.join('\n'));
  assert.match(ok.lines[ok.lines.length - 1], /^verify OK$/);
  for (const c of calls.slice(n)) assert.match(c, /^[GA]: SELECT /, c);
  /* 新库比旧库「更新 / 更严」不算不一致 */
  A.exec("UPDATE epoch SET value = 50; UPDATE device SET revoked_at = 1 WHERE device_id = 'DEV1'");
  assert.equal((await go(apis, 'verify')).ok, true);
  /* 落后 / 缺行 → 失败，逐条列主键 */
  A.exec("UPDATE epoch SET value = 1; DELETE FROM audit WHERE id = 'r1'");
  G.exec("UPDATE lock_reset_switch SET used = 0 WHERE hash = 'SW_USED'; DELETE FROM attempt_limit WHERE realm = 'lock' AND bucket = '*'");
  const bad = await go(apis, 'verify');
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.mismatches.sort(), [
    'account-epoch epoch {"realm":"account"} (value)',
    'lock-reset-switch lock_reset_switch {"hash":"SW_USED"} (used/first_seen)',
    'root-attempt-limit-lock attempt_limit {"realm":"lock","kind":"rootkey","bucket":"*"} (missing)',
    'root-audit-account audit {"realm":"account","id":"r1"} (missing)',
  ]);
  const out = bad.lines.join('\n') + bad.mismatches.join('\n');
  for (const v of ['ACCTHASH', 'PUBX', 'HANDLE']) assert.ok(!out.includes(v), v);
});

/* ---------- --cleanup --confirm ---------- */

test('--cleanup：没有 --confirm 拒绝；verify 不过什么都不删；verify 过了删网关库 realm=account / root 的行并 DROP recovery_switch，锁屏和账号库不动', async () => {
  const { G, A, apis, calls } = await applied();
  await assert.rejects(go(apis, 'cleanup'), /--confirm/);
  /* verify 不过（新库落后：旧库有个没拷过来的新设备） */
  G.prepare("INSERT INTO device VALUES ('account', 'DEVLATE', ?, 0, 0, ?)").run(dev('DEVLATE'), NOW + DAY);
  const snapG = snapshot(G);
  const n = calls.length;
  const no = await go(apis, 'cleanup', { confirm: true });
  assert.equal(no.ok, false);
  assert.match(no.lines.join('\n'), /cleanup aborted: nothing deleted/);
  assert.deepEqual(snapshot(G), snapG);
  for (const c of calls.slice(n)) assert.match(c, /^[GA]: SELECT /, c);
  /* 新库补上那台设备（新库不落后）后 → 删 */
  A.prepare("INSERT INTO device VALUES ('account', 'DEVLATE', ?, 0, 0, ?)").run(dev('DEVLATE'), NOW + DAY);
  const aSnap = snapshot(A);
  const lockBefore = Object.fromEntries(['epoch', 'password', 'passkey', 'user_handle', 'challenge', 'attempt_limit', 'audit', 'tempkey', 'lock_reset_switch']
    .map((t) => [t, rows(G, 'SELECT * FROM ' + t + (t === 'lock_reset_switch' ? '' : " WHERE realm = 'lock'") + ' ORDER BY 1, 2')]));
  const res = await go(apis, 'cleanup', { confirm: true });
  assert.equal(res.ok, true, res.mismatches.join('\n'));
  assert.match(res.lines.join('\n'), /verify OK/);
  for (const t of ['epoch', 'password', 'passkey', 'user_handle', 'challenge', 'attempt_limit', 'device', 'audit']) {
    assert.equal(one(G, "SELECT COUNT(*) AS n FROM " + t + " WHERE realm IN ('account', 'root')").n, 0, t);
  }
  assert.ok(!tables(G).includes('recovery_switch'));
  for (const [t, want] of Object.entries(lockBefore)) {
    assert.deepEqual(rows(G, 'SELECT * FROM ' + t + (t === 'lock_reset_switch' ? '' : " WHERE realm = 'lock'") + ' ORDER BY 1, 2'), want, t + ' 锁屏的行不动');
  }
  assert.deepEqual(snapshot(A), aSnap, '账号库不动');
});

/* ---------- 预览：两边同一个库 ---------- */

test('预览（两边同一个库 styrigx-test-preview）：网关 0007 已带 legacy_handle 列，apply 不再 ALTER、不报错并填上；root 行照样分；verify 通过；cleanup 不删账号自己的行', async () => {
  const { G, apis, calls } = pair({ sameDb: true });
  seed(G);
  const res = await go(apis, 'apply');
  assert.equal(res.ok, true);
  assert.doesNotMatch(res.lines.join('\n'), /added column/);
  assert.ok(!calls.some((c) => /ALTER TABLE/.test(c)), '列已存在：防御性 ALTER 跳过');
  assert.deepEqual(one(G, "SELECT handle, legacy_handle FROM user_handle WHERE realm = 'account'"), { handle: 'ACCTHANDLE', legacy_handle: 'LOCKHANDLE' });
  assert.deepEqual(one(G, "SELECT handle, legacy_handle FROM user_handle WHERE realm = 'lock'"), { handle: 'LOCKHANDLE', legacy_handle: '' });
  assert.deepEqual(rows(G, "SELECT id, path FROM audit WHERE realm = 'account' ORDER BY id"), [{ id: 'r1', path: 'root-reauth' }, { id: 'r2', path: 'root-reset' }]);
  assert.equal(one(G, "SELECT COUNT(*) AS n FROM attempt_limit WHERE realm = 'account' AND kind = 'rootkey'").n, 2);
  assert.equal(one(G, "SELECT COUNT(*) AS n FROM passkey WHERE realm = 'account'").n, 2, '同一行，不重复');
  assert.equal((await go(apis, 'apply')).written, 0);
  const v = await go(apis, 'verify');
  assert.equal(v.ok, true, v.mismatches.join('\n'));
  const c = await go(apis, 'cleanup', { confirm: true });
  assert.equal(c.ok, true);
  assert.match(c.lines.join('\n'), /same database/);
  assert.equal(one(G, "SELECT COUNT(*) AS n FROM audit WHERE realm = 'root'").n, 0);
  assert.equal(one(G, "SELECT COUNT(*) AS n FROM passkey WHERE realm = 'account'").n, 2, "realm='account' 就是账号自己的行，不删");
  assert.equal(one(G, "SELECT value FROM epoch WHERE realm = 'account'").value, 9);
});

test('预览老库（网关 0007 之前，user_handle 没有 legacy_handle）：apply 的防御性 ALTER 补列并填上；再跑不重复补', async () => {
  const { G, apis } = pair({ sameDb: true, before0007: true });
  seed(G);
  const res = await go(apis, 'apply');
  assert.equal(res.ok, true);
  assert.match(res.lines.join('\n'), /user_handle: added column legacy_handle/);
  assert.deepEqual(one(G, "SELECT handle, legacy_handle FROM user_handle WHERE realm = 'account'"), { handle: 'ACCTHANDLE', legacy_handle: 'LOCKHANDLE' });
  const again = await go(apis, 'apply');
  assert.equal(again.ok, true);
  assert.doesNotMatch(again.lines.join('\n'), /added column/);
});

test('预览迁移顺序（CI：网关全部迁移 → 账号 0001–0003，同一个内存库）：不报错，user_handle 带 legacy_handle；网关代码只写 realm、handle 时新列取默认', () => {
  const raw = gatewayDb();
  for (const f of readdirSync(AC_MIG).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(AC_MIG + f, 'utf8'));
  const names = rows(raw, 'PRAGMA table_info(user_handle)').map((c) => c.name);
  assert.deepEqual(names, ['realm', 'handle', 'legacy_handle']);
  raw.prepare('INSERT OR IGNORE INTO user_handle (realm, handle) VALUES (?, ?)').run('lock', 'H');
  assert.deepEqual(one(raw, "SELECT * FROM user_handle WHERE realm = 'lock'"), { realm: 'lock', handle: 'H', legacy_handle: '' });
});

/* ---------- 合并规则（纯函数） ---------- */

test('mergeRow：每条规则只把目标边往更新 / 更严推，从不放宽', () => {
  const F = Object.fromEntries(FAMILIES.map((f) => [f.name, f]));
  const c = (fam, marks) => ({ marks: new Set(marks || []), dstCols: fam.new.cols || fam.cols });
  const ops = (name, s, d, marks) => mergeRow(F[name], s, d, c(F[name], marks)).map((o) => o.op + ':' + o.why);
  assert.deepEqual(ops('account-epoch', { realm: 'account', value: 3 }, { realm: 'account', value: 5 }), []);
  assert.deepEqual(ops('account-epoch', { realm: 'account', value: 7 }, { realm: 'account', value: 5 }), ['update:value']);
  const d0 = { realm: 'account', device_id: 'D', record: '{}', last_seen: 5, revoked_at: 0, expires_at: 10 };
  assert.deepEqual(ops('account-device', Object.assign({}, d0, { revoked_at: 9, record: '{"x":1}' }), d0), ['update:revoked_at']);
  assert.deepEqual(ops('account-device', Object.assign({}, d0, { revoked_at: 0, last_seen: 1 }), Object.assign({}, d0, { revoked_at: 4 })), [], '已退出的不会被改回');
  assert.deepEqual(ops('account-device', d0, null), ['insert:missing', 'baseline:baseline']);
  assert.deepEqual(ops('account-device', d0, null, ['account-device:D']), [], '拷过、目标边删了：不补回');
  assert.deepEqual(ops('account-device', null, d0, ['account-device:D']), [], '设备从不因为源边没有而删');
  const p0 = { realm: 'account', credential_id: 'P', record: pk('P') };
  assert.deepEqual(ops('account-passkey', null, p0, ['account-passkey:P']), ['delete:deleted-on-source']);
  assert.deepEqual(ops('account-passkey', null, p0), [], '目标边新加的不动');
  assert.deepEqual(ops('account-passkey', { ...p0, record: pk('P', { signCount: 1, name: 'renamed' }) }, p0), [], 'signCount 小的不回退');
  assert.deepEqual(ops('account-passkey', { ...p0, record: pk('P', { signCount: 8 }) }, p0), ['update:signCount']);
  const l0 = { realm: 'account', kind: 'rootkey', bucket: '*', count: 3, strikes: 0, locked_until: 0, window_start: 5, expires_at: 9 };
  assert.deepEqual(ops('root-attempt-limit-account', { ...l0, count: 1, window_start: 9 }, l0), ['update:window_start']);
  assert.deepEqual(ops('root-attempt-limit-account', { ...l0, count: 1 }, l0), []);
  const a0 = { realm: 'account', id: 'x', ts: 1, ip_prefix: 'p', ok: 1, decoy: 0, via: '', path: 'root-reset', expires_at: 9 };
  assert.deepEqual(ops('root-audit-account', a0, a0), []);
  assert.deepEqual(ops('root-audit-account', { ...a0, ok: 0 }, a0), ['conflict:row-differs']);
  const u0 = { realm: 'account', handle: 'H', legacy_handle: '' };
  assert.deepEqual(ops('account-user-handle', { ...u0, legacy_handle: 'L' }, u0), ['update:legacy_handle']);
  assert.deepEqual(ops('account-user-handle', { ...u0, handle: 'OTHER' }, u0), ['conflict:handle-differs']);
});

/* ---------- --preview / 库 id / main ---------- */

test('库 id：正式 = 网关 wrangler 的 D1_LOCK_AUTH + 账号 wrangler 的 D1_ACCOUNT_AUTH（不再兜底 D1_SETTINGS_SYNC）；--preview 只读 [env.preview]（styrigx-test-preview）', async () => {
  const prod = resolveDbIds(ROOT, {});
  assert.equal(prod.gateway, '6931d1da-3502-480d-b0bd-de1bc4829d1d');
  assert.equal(prod.account, '03f60d23-9c2f-4f3d-a692-764ccaac6f5d');
  const pv = resolveDbIds(ROOT, { preview: true });
  assert.deepEqual(pv, { gateway: PREVIEW_DB, account: PREVIEW_DB });
  assert.deepEqual(resolveDbIds(ROOT, { gatewayD1: 'g1', accountD1: 'a1' }), { gateway: 'g1', account: 'a1' });
  const toml = '[[d1_databases]]\nbinding = "D1_ACCOUNT_AUTH"\ndatabase_id = "aaaa-1"\n\n[env.preview]\nname = "x"\n\n[[env.preview.d1_databases]]\nbinding = "D1_ACCOUNT_AUTH"\ndatabase_id = "bbbb-2"\n';
  assert.equal(d1IdIn(toml, 'D1_ACCOUNT_AUTH', false), 'aaaa-1');
  assert.equal(d1IdIn(toml, 'D1_ACCOUNT_AUTH', true), 'bbbb-2');
  assert.equal(d1IdIn(toml, 'D1_SETTINGS_SYNC', true), '');
  /* 账号 wrangler 没有 D1_ACCOUNT_AUTH 时直接报错，不退回 D1_SETTINGS_SYNC */
  assert.ok(!readFileSync(SCRIPT, 'utf8').includes("'D1_SETTINGS_SYNC'"));
  assert.equal(modeOf([]), 'apply');
  assert.equal(modeOf(['--preview', '--verify']), 'verify');
  assert.equal(modeOf(['--cleanup', '--confirm']), 'cleanup');
  assert.equal(modeOf(['--lock-reset-switch']), 'lock-reset-switch');
  assert.throws(() => modeOf(['--lock-reset-switch', '--verify']), /pick one mode/);
  assert.throws(() => modeOf(['--verify', '--cleanup']), /pick one mode/);
  /* PR4：切换期专用的 --reconcile / --reverse 已删：明确拒绝，不会落到默认的 apply */
  assert.throws(() => modeOf(['--reconcile']), /removed in PR4/);
  assert.throws(() => modeOf(['--reverse', '--preview']), /removed in PR4/);
  await assert.rejects(go(pair().apis, 'reconcile'), /unknown mode/);
});

/** 本地 D1 REST 替身：库 id → 内存库；记下每次请求的库 id */
async function fakeCf(dbs) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const m = req.url.match(/^\/accounts\/ACC\/d1\/database\/([^/]+)\/query$/);
      const ok = m && req.headers.authorization === 'Bearer TOKEN' && dbs[m[1]];
      if (!ok) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"success":false}'); return; }
      seen.push(m[1]);
      try {
        const { sql, params } = JSON.parse(body);
        const r = await0(dbs[m[1]], sql, params);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, result: [r] }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, errors: [{ message: String(e.message) }] }));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, seen, base: 'http://127.0.0.1:' + server.address().port };
}
function await0(raw, sql, params) {
  const st = raw.prepare(sql);
  if (/^\s*SELECT\b/i.test(sql)) return { results: st.all(...(params || [])), meta: { changes: 0 } };
  const r = st.run(...(params || []));
  return { results: [], meta: { changes: Number(r.changes || 0) } };
}
function runMain(args, base, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { env: Object.assign({ PATH: process.env.PATH, CF_API_BASE: base, CF_API_TOKEN: 'TOKEN', CF_ACCOUNT_ID: 'ACC' }, env || {}) },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

test('main：--preview 只访问预览库 1339bb0b…；正式两个库各自的 id；verify 不一致退出码 1；没有凭据 / cleanup 没 --confirm 直接退出', async () => {
  const pv = gatewayDb();
  seed(pv);
  const G = gatewayDb();
  seed(G);
  const A = accountDb();
  const cf = await fakeCf({ [PREVIEW_DB]: pv, '6931d1da-3502-480d-b0bd-de1bc4829d1d': G, '03f60d23-9c2f-4f3d-a692-764ccaac6f5d': A });
  try {
    const dry = await runMain(['--preview', '--dry-run'], cf.base);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /\(preview\) \(same database\)/);
    assert.deepEqual([...new Set(cf.seen)], [PREVIEW_DB]);
    const ap = await runMain(['--preview'], cf.base);
    assert.equal(ap.code, 0, ap.stderr);
    assert.equal((await runMain(['--preview', '--verify'], cf.base)).code, 0);
    assert.deepEqual([...new Set(cf.seen)], [PREVIEW_DB], '--preview 从头到尾只碰预览库');
    cf.seen.length = 0;
    const bad = await runMain(['--verify'], cf.base);
    assert.equal(bad.code, 1, '正式库还没 apply：verify 失败');
    assert.match(bad.stderr, /mismatch: account-epoch \(marker missing/);
    assert.deepEqual([...new Set(cf.seen)].sort(), ['03f60d23-9c2f-4f3d-a692-764ccaac6f5d', '6931d1da-3502-480d-b0bd-de1bc4829d1d']);
    for (const v of ['ACCTHASH', 'PUBX', 'HANDLE']) assert.ok(!(bad.stdout + bad.stderr).includes(v), v);
    assert.equal((await runMain([], cf.base)).code, 0);
    assert.equal((await runMain(['--verify'], cf.base)).code, 0);
    const noConfirm = await runMain(['--cleanup'], cf.base);
    assert.equal(noConfirm.code, 1);
    assert.match(noConfirm.stderr, /--confirm/);
    const noCreds = await runMain(['--dry-run'], cf.base, { CF_API_TOKEN: '' });
    assert.equal(noCreds.code, 1);
    assert.match(noCreds.stderr, /CF_API_TOKEN and CF_ACCOUNT_ID are required/);
  } finally {
    cf.server.close();
  }
});
