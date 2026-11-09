/**
 * migrations/0005_account_tables.sql（命名 v2：账号表改名 account_*、去掉 realm 列）：
 * - WebAuthn 红线：user_handle 的 handle / legacy_handle 逐字节照抄；passkey 的 credential_id 和 record 里的
 *   credId / publicKey / signCount / aaguid 逐字节不变，只有显示用的 provider / name 被归一
 * - session 纪元照抄旧 account 纪元（已登录设备不掉线）；reset 纪元从 0 开始
 * - 账号密码不搬（pepper 换了）；challenge 不搬；rootkey 计数改名 recovery-key；审计 path → event
 * - 应用授权：把旧种子逻辑的效果写成行（没种过 → 写满；种过但没补 profile → 补 profile；都补过 → 不动），然后 app_grant → account_grant
 * - 只删 realm='account' 的旧行：预览库里网关的锁屏行（realm='lock'）一行不动；旧表都还在（P4 再 DROP）
 * - 按 CI 预览库的真实顺序（网关全部迁移 → 账号 0001–0005，同一个库）跑也不出错
 *
 * 运行：node --test tests/workers/account/migration-0005.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { MIGRATION_FILES, migrationSql, ACCOUNT_SQL, ACCOUNT_TABLES } from './_d1.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;
const BEFORE = MIGRATION_FILES.filter((f) => f < '0005');
const OLD_TABLES = ['epoch', 'password', 'passkey', 'user_handle', 'challenge', 'attempt_limit', 'device', 'audit'];

/** 跑到 0004 为止的库 */
function oldDb() {
  const db = new DatabaseSync(':memory:');
  for (const f of BEFORE) db.exec(migrationSql(f));
  return db;
}
const rows = (db, sql, ...p) => db.prepare(sql).all(...p).map((r) => ({ ...r }));

/* 一把旧账号通行密钥（record 原样存，故意带一个奇怪的空格和 key 顺序，验证「逐字节」） */
const PUBKEY = { kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0' };
const OLD_PK_RECORD = JSON.stringify({ name: '通行密钥', provider: 'Samsung Pass', aaguid: '53414d53-554e-4700-0000-000000000000', createdAt: 1730000000000, lastUsedAt: 1731000000000, credId: 'AbC-_dEf0123456789xyz', publicKey: PUBKEY, signCount: 42, uv: 1 });
const OLD_PK2_RECORD = JSON.stringify({ name: '我的手机', provider: '', aaguid: '', createdAt: 1, lastUsedAt: 0, credId: 'ZZZ-cred-2', publicKey: PUBKEY, signCount: 0, uv: 1 });
const HANDLE = 'q3Z_-0aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789AB';
const LEGACY = 'LEGACY_handle-from-lock_9876543210abcdefABCDEF';

function seedOld(db, o = {}) {
  db.exec(`INSERT INTO epoch (realm, value) VALUES ('account', 7), ('lock', 3);`);
  db.prepare("INSERT INTO passkey (realm, credential_id, record) VALUES ('account', ?, ?), ('account', ?, ?), ('lock', 'lock-cred', '{\"credId\":\"lock-cred\"}')")
    .run('AbC-_dEf0123456789xyz', OLD_PK_RECORD, 'ZZZ-cred-2', OLD_PK2_RECORD);
  db.prepare("INSERT INTO user_handle (realm, handle, legacy_handle) VALUES ('account', ?, ?), ('lock', 'LOCKHANDLE', '')").run(HANDLE, LEGACY);
  db.exec(`INSERT INTO password (realm, record) VALUES ('account', '{"hash":"old"}'), ('lock', '{"hash":"lock"}');
INSERT INTO challenge (realm, id, purpose, challenge, expires_at) VALUES ('account', 'c1', 'login', 'x', 99999999999999);
INSERT INTO attempt_limit (realm, kind, bucket, count, strikes, locked_until, window_start, expires_at) VALUES
  ('account', 'rootkey', '10.0.0', 3, 0, 0, 0, 99999999999999), ('account', 'password', '10.0.0', 1, 0, 0, 0, 99999999999999), ('lock', 'rootkey', '10.0.0', 2, 0, 0, 0, 99999999999999);
INSERT INTO device (realm, device_id, record, last_seen, revoked_at, expires_at) VALUES ('account', 'devtestdevtest01', '{"deviceId":"devtestdevtest01"}', 5, 0, 99999999999999), ('lock', 'lockdevice000001', '{}', 1, 0, 99999999999999);
INSERT INTO audit (realm, id, ts, ip_prefix, ok, path, expires_at) VALUES
  ('account', 'a1', 1, '10.0.0.x', 1, 'root-reset', 9), ('account', 'a2', 2, '10.0.0.x', 0, 'login-password-cooldown', 9),
  ('account', 'a3', 3, '10.0.0.x', 1, 'reset-signout-others', 9), ('account', 'a4', 4, '10.0.0.x', 1, 'root-reauth', 9),
  ('lock', 'l1', 1, 'x', 1, 'root-reset', 9);`);
  if (o.seed1) db.exec("INSERT INTO data_migration (name, migrated_at) VALUES ('app-grant-seed-1', 1); INSERT INTO app_grant (app, record, granted_at) VALUES ('curio', '{\"v\":1,\"scopes\":[\"curio.write\"],\"deviceId\":\"d\",\"by\":\"passkey\"}', 123)");
  if (o.seed2) db.exec("INSERT INTO data_migration (name, migrated_at) VALUES ('app-grant-seed-2', 1)");
}

test('WebAuthn 红线：handle / legacy_handle、credential_id、credId / publicKey / signCount / aaguid 逐字节不变；只有 provider / name 归一', () => {
  const db = oldDb();
  seedOld(db);
  const beforePk = rows(db, "SELECT credential_id, record FROM passkey WHERE realm = 'account' ORDER BY credential_id");
  const beforeUh = rows(db, "SELECT handle, legacy_handle FROM user_handle WHERE realm = 'account'")[0];
  db.exec(ACCOUNT_SQL);
  const uh = rows(db, 'SELECT handle, legacy_handle FROM account_user_handle')[0];
  assert.equal(Buffer.compare(Buffer.from(uh.handle), Buffer.from(beforeUh.handle)), 0);
  assert.equal(Buffer.compare(Buffer.from(uh.legacy_handle), Buffer.from(beforeUh.legacy_handle)), 0);
  assert.deepEqual(uh, { handle: HANDLE, legacy_handle: LEGACY });
  const after = rows(db, 'SELECT credential_id, record FROM account_passkey ORDER BY credential_id');
  assert.deepEqual(after.map((r) => r.credential_id), beforePk.map((r) => r.credential_id));
  for (let i = 0; i < after.length; i++) {
    const o = JSON.parse(beforePk[i].record);
    const n = JSON.parse(after[i].record);
    for (const k of ['credId', 'publicKey', 'signCount', 'aaguid', 'createdAt', 'lastUsedAt', 'uv']) {
      assert.equal(JSON.stringify(n[k]), JSON.stringify(o[k]), after[i].credential_id + ' ' + k);
    }
    assert.deepEqual(Object.keys(n), Object.keys(o), '字段和顺序不变');
  }
  const a = JSON.parse(after[0].record);
  assert.equal(a.provider, 'samsung-pass');
  assert.equal(a.name, '', '旧默认名「通行密钥」→ 空（前端按语言显示）');
  const b = JSON.parse(after[1].record);
  assert.equal(b.name, '我的手机', '用户起的名字原样');
  assert.equal(after[1].record, beforePk[1].record, '不需要归一的那把 record 整串一个字节都没动');
});

test('纪元：session = 旧 account 纪元（7）；reset = 0；锁屏纪元不动', () => {
  const db = oldDb();
  seedOld(db);
  db.exec(ACCOUNT_SQL);
  assert.deepEqual(rows(db, 'SELECT name, value FROM account_epoch ORDER BY name'), [{ name: 'reset', value: 0 }, { name: 'session', value: 7 }]);
  assert.deepEqual(rows(db, 'SELECT realm, value FROM epoch'), [{ realm: 'lock', value: 3 }]);
});

test('密码不搬、challenge 不搬；rootkey → recovery-key；设备照抄；审计 path → event（不认识的旧事件不迁）', () => {
  const db = oldDb();
  seedOld(db);
  db.exec(ACCOUNT_SQL);
  assert.equal(rows(db, 'SELECT * FROM account_password').length, 0);
  assert.equal(rows(db, 'SELECT * FROM account_challenge').length, 0);
  assert.deepEqual(rows(db, 'SELECT kind, bucket, count FROM account_attempt_limit ORDER BY kind'), [{ kind: 'password', bucket: '10.0.0', count: 1 }, { kind: 'recovery-key', bucket: '10.0.0', count: 3 }]);
  assert.deepEqual(rows(db, 'SELECT device_id, record, last_seen FROM account_device'), [{ device_id: 'devtestdevtest01', record: '{"deviceId":"devtestdevtest01"}', last_seen: 5 }]);
  assert.deepEqual(rows(db, 'SELECT id, ok, event FROM account_audit ORDER BY id'), [
    { id: 'a1', ok: 1, event: 'reset-recovery-key' }, { id: 'a2', ok: 0, event: 'password-cooldown' }, { id: 'a3', ok: 1, event: 'reset-finish-others' },
  ]);
  const cols = rows(db, 'PRAGMA table_info(account_audit)').map((c) => c.name);
  assert.deepEqual(cols, ['id', 'ts', 'ip_prefix', 'ok', 'event', 'expires_at']);
});

test('只删 realm=account 的旧行：锁屏行一行不动；旧表都还在；新表没有 realm 列', () => {
  const db = oldDb();
  seedOld(db);
  const lockBefore = Object.fromEntries(OLD_TABLES.map((t) => [t, rows(db, 'SELECT * FROM ' + t + " WHERE realm = 'lock'")]));
  db.exec(ACCOUNT_SQL);
  for (const t of OLD_TABLES) {
    assert.deepEqual(rows(db, 'SELECT * FROM ' + t + " WHERE realm = 'lock'"), lockBefore[t], t);
    assert.equal(rows(db, 'SELECT COUNT(*) AS n FROM ' + t + " WHERE realm = 'account'")[0].n, 0, t);
  }
  for (const t of ACCOUNT_TABLES) assert.ok(!rows(db, 'PRAGMA table_info(' + t + ')').some((c) => c.name === 'realm'), t);
  const tables = rows(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
  assert.ok(!tables.includes('app_grant') && !tables.includes('data_migration'));
});

test('应用授权：没种过 → 写满 6 个；种过没补 → 只补 profile（已有行不动）；都补过 → 不动', () => {
  const g = (db) => rows(db, 'SELECT app, record, granted_at FROM account_grant ORDER BY app');
  const a = oldDb();
  seedOld(a);
  a.exec(ACCOUNT_SQL);
  assert.deepEqual(g(a).map((r) => r.app), ['avatar', 'curio', 'daymark', 'prefs', 'profile', 'wellbeing']);
  for (const r of g(a)) assert.deepEqual(JSON.parse(r.record), { v: 1, scopes: [{ prefs: 'prefs.sync' }[r.app] || r.app + '.write'], deviceId: '', by: '' });
  const b = oldDb();
  seedOld(b, { seed1: true });
  b.exec(ACCOUNT_SQL);
  assert.deepEqual(g(b).map((r) => r.app), ['curio', 'profile']);
  assert.equal(g(b)[0].granted_at, 123);
  const c = oldDb();
  seedOld(c, { seed1: true, seed2: true });
  c.exec(ACCOUNT_SQL);
  assert.deepEqual(g(c).map((r) => r.app), ['curio']);
  /* 种过且用户全取消了（0 行 + 两个标记）→ 0 行 */
  const d = oldDb();
  seedOld(d, { seed1: true, seed2: true });
  d.exec('DELETE FROM app_grant');
  d.exec(ACCOUNT_SQL);
  assert.equal(g(d).length, 0);
});

test('CI 预览库顺序：网关全部迁移 → 账号 0001–0005（同一个库）不报错；网关自己的表（tempkey / kv_migration 等）不动', () => {
  const db = new DatabaseSync(':memory:');
  const gwDir = REPO + 'workers/space-core/migrations/';
  for (const f of readdirSync(gwDir).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(gwDir + f, 'utf8'));
  const gwTables = rows(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
  for (const f of MIGRATION_FILES) db.exec(migrationSql(f));
  const all = rows(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
  for (const t of gwTables) assert.ok(all.includes(t), '网关的表还在：' + t);
  for (const t of ACCOUNT_TABLES) assert.ok(all.includes(t), t);
});

test('迁移文件：不 DROP 旧表（P4 才删）；只 DROP data_migration；每条 CREATE 都 IF NOT EXISTS', () => {
  const code = ACCOUNT_SQL.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
  assert.deepEqual([...code.matchAll(/DROP TABLE(?: IF EXISTS)? (\w+)/g)].map((m) => m[1]), ['data_migration']);
  for (const m of code.matchAll(/CREATE (?:TABLE|INDEX)\b[^;]*/g)) assert.match(m[0], /IF NOT EXISTS/);
});
