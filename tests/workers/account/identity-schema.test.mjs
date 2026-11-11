/**
 * v6 身份表（P1，workers/account/migrations/0006_identity.sql）：
 * - 迁移里的 CREATE 语句都 IF NOT EXISTS、带 account_ 前缀
 * - 只建表不放数据、不动旧表：跑 0006 前后旧表的行一模一样；新表全空
 * - 约束：身份栈只有深度 1（访客 → 普通用户 → root 最多三层）；恢复钥匙同一时刻最多一把有效；用户名唯一
 * - 表名都带 account_ 前缀，不和预览共用库里网关的旧表（audit、passkey……）撞名
 * - 没有「no such table」自愈：表只由迁移建，空库直接报错
 *
 * 运行：node --test tests/workers/account/identity-schema.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATION_FILES, migrationSql, IDENTITY_SQL, IDENTITY_TABLES, makeAccountD1 } from './_d1.mjs';

const db = await import('../../../workers/account/src/lib/db.js');

test('0006 的 CREATE 语句全部 IF NOT EXISTS、表名带 account_ 前缀（重复跑不出错）', () => {
  const fromSql = IDENTITY_SQL.split('\n').filter((l) => l.startsWith('CREATE')).map((l) => l.trim().replace(/;$/, ''));
  assert.ok(fromSql.length >= IDENTITY_TABLES.length);
  for (const s of fromSql) assert.match(s, /^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS account_/);
});

test('0006 只建表：前后旧表的行不变，新表全空；重复跑不出错', () => {
  const d = new DatabaseSync(':memory:');
  for (const f of MIGRATION_FILES.filter((x) => x < '0006')) d.exec(migrationSql(f));
  d.exec(`INSERT INTO account_password (id, record) VALUES (1, '{"hash":"h"}'); INSERT INTO account_passkey (credential_id, record) VALUES ('c1', '{}');`);
  const snap = () => ['account_password', 'account_passkey', 'account_user_handle', 'account_grant', 'account_device', 'account_audit']
    .map((t) => JSON.stringify(d.prepare('SELECT * FROM ' + t).all()));
  const before = snap();
  d.exec(IDENTITY_SQL);
  d.exec(IDENTITY_SQL);
  assert.deepEqual(snap(), before);
  for (const t of IDENTITY_TABLES) assert.equal(d.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n, 0, t);
});

test('约束：栈深只能是 1；恢复钥匙最多一把有效；用户名唯一', () => {
  const d = makeAccountD1().raw;
  d.exec("INSERT INTO account_users (uid, name) VALUES (0, 'root'), (1000, 'styrigx')");
  assert.throws(() => d.exec("INSERT INTO account_users (uid, name) VALUES (1001, 'styrigx')"), /UNIQUE/);
  d.exec("INSERT INTO account_session_stack (session_id, depth, uid, epoch, pushed_at, expires_at) VALUES ('s', 1, 0, 0, 1, 2)");
  assert.throws(() => d.exec("INSERT INTO account_session_stack (session_id, depth, uid, epoch, pushed_at, expires_at) VALUES ('s', 2, 0, 0, 1, 2)"), /CHECK/);
  d.exec("INSERT INTO account_recovery_key (id, record, created_at) VALUES ('k1', '{}', 1)");
  assert.throws(() => d.exec("INSERT INTO account_recovery_key (id, record, created_at) VALUES ('k2', '{}', 2)"), /UNIQUE/);
  d.exec("UPDATE account_recovery_key SET used_at = 5 WHERE id = 'k1'");
  d.exec("INSERT INTO account_recovery_key (id, record, created_at) VALUES ('k2', '{}', 2)");
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM account_recovery_key').get().n, 2);
});

test('表名不和网关旧表撞名（预览库共用）：全部 account_ 前缀', () => {
  for (const t of IDENTITY_TABLES) assert.match(t, /^account_/);
  const gateway = ['epoch', 'passkey', 'password', 'user_handle', 'challenge', 'attempt_limit', 'device', 'audit', 'share_link', 'share_fail'];
  for (const t of gateway) assert.ok(!IDENTITY_TABLES.includes(t));
});

test('没有「no such table」自愈（v6 P4 收尾：表只由迁移建）：空库上 onDb 读身份表直接报错，不建表', async () => {
  const d1 = makeAccountD1({ migrations: false });
  const env = { D1_ACCOUNT: d1 };
  await assert.rejects(() => db.onDb(env, (x) => x.prepare('SELECT COUNT(*) AS n FROM account_users').first()), /no such table/);
  const names = d1.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  assert.deepEqual(names, []);
});

test('清扫：account_sessions、account_user_audit 可按 expires_at 清；别的身份表不行', async () => {
  const d1 = makeAccountD1();
  d1.raw.exec("INSERT INTO account_sessions (id, uid, epoch, created_at, expires_at) VALUES ('old', 1000, 0, 1, 5), ('new', 1000, 0, 1, 99999999999999)");
  await db.sweepExpired(d1, 'account_sessions', 10);
  assert.deepEqual(d1.raw.prepare('SELECT id FROM account_sessions').all().map((r) => r.id), ['new']);
  await assert.rejects(() => db.sweepExpired(d1, 'account_users', 10), /bad table/);
});
