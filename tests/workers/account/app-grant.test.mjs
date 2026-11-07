/**
 * 应用授权记录（workers/account/src/core/app-grant.js、migrations/0004_app_grant.sql；P3-1，设计方案 2.5、4.7）：
 * - 0004：只建 app_grant 一张表（IF NOT EXISTS、只建表、幂等）；APP_GRANT_SCHEMA 与 0004 列结构一致
 * - 种子 ensureSeed：空表 + 无标记 → 同一批次写满 6 行 + 标记（补种标记同时写上）；已有标记 + 0 行（用户已取消完）→ 不再种；重复跑、并发跑都只种一次；
 *   表里已有行但无标记 → 不动已有行，只补标记；空库（迁移没跑）兜底建表
 * - 补种 SEED_SUPPLEMENTS（2026-11-07 个人资料 app-grant-seed-2）：已切换的库下次 ensureSeed 补上新应用一行 + 标记，已有行不动；
 *   用户取消后不再补；补种前 readGrantState.pending 列出新应用（grantedScopes 按已授权算）
 * - addGrant / revokeGrant / readGrantState：写回、DELETE、只读；未知应用抛错
 *
 * 运行：node --test tests/workers/account/app-grant.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { makeAccountD1, APP_GRANT_SQL } from './_d1.mjs';

const CORE = '../../../workers/account/src/core/';
const g = await import(CORE + 'app-grant.js');
const scopes = await import(CORE + 'scopes.js');

const APPS5 = ['curio', 'daymark', 'prefs', 'wellbeing', 'avatar', 'profile'];
const env = (db = makeAccountD1()) => ({ D1_ACCOUNT_AUTH: db });
const WHO = { deviceId: 'devtestdevtest01', by: 'passkey' };
const rows = (e) => e.D1_ACCOUNT_AUTH.rows('app_grant').map((r) => ({ ...r }));
const marks = (e) => e.D1_ACCOUNT_AUTH.rows('data_migration').filter((m) => m.name === g.SEED_MARK).length;
const colsOf = (raw) => raw.prepare('PRAGMA table_info(app_grant)').all().map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, pk: c.pk }));

test('0004：只建 app_grant（IF NOT EXISTS、只建表），跑两次不出错；APP_GRANT_SCHEMA 与 0004 列结构一致', () => {
  const a = new DatabaseSync(':memory:');
  a.exec(APP_GRANT_SQL);
  a.exec(APP_GRANT_SQL);
  const sqlOnly = APP_GRANT_SQL.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
  assert.equal((sqlOnly.match(/\bCREATE\b/gi) || []).length, 1);
  assert.match(sqlOnly, /CREATE TABLE IF NOT EXISTS app_grant\b/);
  assert.doesNotMatch(sqlOnly, /\b(DROP|ALTER|DELETE|UPDATE|INSERT)\b/i, '迁移只建表');
  const b = new DatabaseSync(':memory:');
  for (const s of g.APP_GRANT_SCHEMA) b.exec(s);
  assert.deepEqual(colsOf(b), colsOf(a));
  assert.deepEqual(colsOf(a), [
    { name: 'app', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'record', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'granted_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ]);
});

test('应用 id = 作用域表的应用（顺序即授权卡顺序）；scopesOfApp；isAppId', () => {
  assert.deepEqual([...g.APP_IDS], APPS5);
  assert.deepEqual([...g.APP_IDS], scopes.SCOPES.map((s) => s.app));
  assert.deepEqual(g.scopesOfApp('curio'), ['curio.write']);
  assert.deepEqual(g.scopesOfApp('book'), []);
  for (const x of ['', 'book', 'Curio', null, 1]) assert.equal(g.isAppId(x), false, String(x));
});

test('种子：空表 + 无标记 → 同一批次写满 6 行 + 标记（record 带作用域、设备、登录方式）', async () => {
  const e = env();
  assert.equal(await g.ensureSeed(e, WHO), true);
  const r = rows(e);
  assert.deepEqual(r.map((x) => x.app).sort(), APPS5.slice().sort());
  for (const x of r) {
    assert.deepEqual(JSON.parse(x.record), { v: 1, scopes: g.scopesOfApp(x.app), deviceId: WHO.deviceId, by: WHO.by });
    assert.ok(x.granted_at > 0);
  }
  assert.equal(marks(e), 1);
  const batches = e.D1_ACCOUNT_AUTH.statements.filter((s) => /INSERT INTO app_grant/.test(s));
  assert.equal(batches.length, 1, '6 行一条语句写完（补种只写标记）');
  const st = await g.readGrantState(e);
  assert.equal(st.seeded, true);
  assert.equal(st.rows.length, 6);
  assert.deepEqual(st.pending, []);
});

test('种子：重复跑幂等；已有标记 + 0 行（用户取消完）→ 不再种', async () => {
  const e = env();
  await g.ensureSeed(e, WHO);
  const before = rows(e);
  assert.equal(await g.ensureSeed(e, WHO), false);
  assert.deepEqual(rows(e), before);
  for (const app of APPS5) await g.revokeGrant(e, app);
  assert.equal(rows(e).length, 0);
  assert.equal(await g.ensureSeed(e, WHO), false);
  assert.equal(rows(e).length, 0);
  assert.equal(marks(e), 1);
  assert.deepEqual(await g.readGrantState(e), { seeded: true, rows: [], pending: [] });
});

test('种子：两个请求并发也只种一次（条件写在 SQL 里，同一个 batch）', async () => {
  const e = env();
  const r = await Promise.all([g.ensureSeed(e, WHO), g.ensureSeed(e, { deviceId: 'otherdevice_0002', by: 'password' })]);
  assert.equal(r.filter(Boolean).length, 1);
  assert.equal(rows(e).length, 6);
  assert.equal(new Set(rows(e).map((x) => JSON.parse(x.record).deviceId)).size, 1, '6 行来自同一次种子');
  assert.equal(marks(e), 1);
});

test('种子：表里已有行但没有标记 → 不动已有行，只补标记', async () => {
  const e = env();
  e.D1_ACCOUNT_AUTH.raw.prepare('INSERT INTO app_grant (app, record, granted_at) VALUES (?, ?, 7)').run('curio', JSON.stringify({ v: 1, scopes: ['curio.write'] }));
  assert.equal(await g.ensureSeed(e, WHO), false);
  assert.deepEqual(rows(e).map((x) => [x.app, x.granted_at]), [['curio', 7]]);
  assert.equal(marks(e), 1);
});

test('readGrantState 只读：无标记 → seeded=false；不写库', async () => {
  const e = env();
  assert.deepEqual(await g.readGrantState(e), { seeded: false, rows: [], pending: [] });
  const writes = e.D1_ACCOUNT_AUTH.statements.filter((s) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(s));
  assert.deepEqual(writes, []);
});

test('addGrant / revokeGrant：写回覆盖（新授权时间、新设备）、DELETE；未知应用抛错', async () => {
  const e = env();
  await g.ensureSeed(e, WHO);
  await g.revokeGrant(e, 'daymark');
  assert.ok(!rows(e).some((x) => x.app === 'daymark'));
  await g.addGrant(e, 'daymark', { deviceId: 'otherdevice_0002', by: 'password' });
  const d = rows(e).find((x) => x.app === 'daymark');
  assert.deepEqual(JSON.parse(d.record), { v: 1, scopes: ['daymark.write'], deviceId: 'otherdevice_0002', by: 'password' });
  await g.addGrant(e, 'daymark', WHO);
  assert.equal(rows(e).filter((x) => x.app === 'daymark').length, 1, '覆盖不重复');
  await assert.rejects(() => g.addGrant(e, 'book', WHO), /bad app/);
  await assert.rejects(() => g.revokeGrant(e, '', WHO), /bad app/);
});

test('空库（迁移没跑）：第一次种子按 0003 + 0004 兜底建表后照常', async () => {
  const e = env(makeAccountD1({ migrations: false }));
  assert.equal(await g.ensureSeed(e, WHO), true);
  assert.equal(rows(e).length, 6);
  assert.equal(marks(e), 1);
});

test('scopesOfRows：每行只认属于本应用、在作用域表里的作用域', () => {
  assert.deepEqual(g.scopesOfRows([
    { app: 'curio', scopes: ['curio.write', 'daymark.write'] },
    { app: 'book', scopes: ['book.write'] },
    { app: 'prefs', scopes: ['prefs.sync', 'prefs.sync'] },
    null,
  ]), ['curio.write', 'prefs.sync']);
});

/* ---------------- 补种（2026-11-07 个人资料） ---------------- */

/** 模拟「上线前已切换」的库：seed-1 标记 + 5 个老应用的行，没有 seed-2 */
function oldSeeded() {
  const e = env();
  const raw = e.D1_ACCOUNT_AUTH.raw;
  for (const app of ['curio', 'daymark', 'prefs', 'wellbeing', 'avatar']) {
    raw.prepare('INSERT INTO app_grant (app, record, granted_at) VALUES (?, ?, 7)').run(app, JSON.stringify({ v: 1, scopes: g.scopesOfApp(app), deviceId: 'old', by: 'password' }));
  }
  raw.prepare('INSERT INTO data_migration (name, migrated_at) VALUES (?, 1)').run(g.SEED_MARK);
  return e;
}
const sup2 = (e) => e.D1_ACCOUNT_AUTH.rows('data_migration').filter((m) => m.name === 'app-grant-seed-2').length;

test('补种表：app-grant-seed-2 只补个人资料 profile；补种的应用都在作用域表里', () => {
  assert.deepEqual(g.SEED_SUPPLEMENTS.map((x) => ({ mark: x.mark, apps: [...x.apps] })), [{ mark: 'app-grant-seed-2', apps: ['profile'] }]);
  for (const x of g.SEED_SUPPLEMENTS) for (const a of x.apps) assert.equal(g.isAppId(a), true, a);
  assert.ok(Object.isFrozen(g.SEED_SUPPLEMENTS));
});

test('补种：已切换的库（老 5 行 + seed-1）→ 补种前 pending=[profile]；ensureSeed 补上 profile 一行 + 标记，老行不动，返回 false', async () => {
  const e = oldSeeded();
  const st0 = await g.readGrantState(e);
  assert.equal(st0.seeded, true);
  assert.deepEqual(st0.pending, ['profile']);
  assert.equal(await g.ensureSeed(e, WHO), false);
  const r = rows(e);
  assert.deepEqual(r.map((x) => x.app).sort(), APPS5.slice().sort());
  for (const x of r.filter((x) => x.app !== 'profile')) assert.equal(x.granted_at, 7, '老行不动：' + x.app);
  const p = r.find((x) => x.app === 'profile');
  assert.deepEqual(JSON.parse(p.record), { v: 1, scopes: ['profile.write'], deviceId: WHO.deviceId, by: WHO.by });
  assert.equal(sup2(e), 1);
  assert.deepEqual((await g.readGrantState(e)).pending, []);
});

test('补种：只补一次——补完后用户取消 profile，再 ensureSeed 不再补；并发两次也只写一行', async () => {
  const e = oldSeeded();
  await Promise.all([g.ensureSeed(e, WHO), g.ensureSeed(e, { deviceId: 'otherdevice_0002', by: 'password' })]);
  assert.equal(rows(e).filter((x) => x.app === 'profile').length, 1);
  assert.equal(sup2(e), 1);
  await g.revokeGrant(e, 'profile');
  await g.ensureSeed(e, WHO);
  assert.equal(rows(e).some((x) => x.app === 'profile'), false);
  assert.deepEqual((await g.readGrantState(e)).pending, []);
});

test('补种：表里已有行但没有 seed-1 标记（不该出现）→ 只补两条标记，不加行', async () => {
  const e = env();
  e.D1_ACCOUNT_AUTH.raw.prepare('INSERT INTO app_grant (app, record, granted_at) VALUES (?, ?, 7)').run('curio', JSON.stringify({ v: 1, scopes: ['curio.write'] }));
  await g.ensureSeed(e, WHO);
  assert.deepEqual(rows(e).map((x) => x.app), ['curio']);
  assert.equal(sup2(e), 1);
});
