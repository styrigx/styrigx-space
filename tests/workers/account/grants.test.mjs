/**
 * 应用授权（workers/account/src/core/grants.js，表 account_grant）：
 * - 应用 id = 作用域表的应用（顺序即授权卡顺序）；scopesOfApp / isAppId
 * - listGrants 只读；addGrant 写回覆盖、revokeGrant DELETE；未知应用抛错
 * - 没有种子逻辑（命名 v2 删了 ensureSeed / data_migration）：授权只看行；空库（迁移没跑）兜底建表后是 0 行 = 没授权
 * - scopesOfRows：每行只认属于本应用、在作用域表里的作用域
 *
 * 运行：node --test tests/workers/account/grants.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeAccountD1 } from './_d1.mjs';

const CORE = '../../../workers/account/src/core/';
const g = await import(CORE + 'grants.js');
const scopes = await import(CORE + 'scopes.js');

const APPS = ['curio', 'daymark', 'prefs', 'wellbeing', 'avatar', 'profile'];
const env = (db = makeAccountD1()) => ({ D1_ACCOUNT: db });
const rows = (e) => e.D1_ACCOUNT.rows('account_grant').map((r) => ({ ...r }));

test('应用 id = 作用域表的应用（顺序即授权卡顺序）；scopesOfApp；isAppId', () => {
  assert.deepEqual([...g.APP_IDS], APPS);
  assert.deepEqual([...g.APP_IDS], scopes.SCOPES.map((s) => s.app));
  assert.deepEqual(g.scopesOfApp('curio'), ['curio.write']);
  assert.deepEqual(g.scopesOfApp('book'), []);
  for (const x of ['', 'book', 'Curio', null, 1]) assert.equal(g.isAppId(x), false, String(x));
});

test('listGrants：只读；空库经 0005 写满 6 个应用；revoke / add 改行', async () => {
  const e = env();
  const before = e.D1_ACCOUNT.statements.length;
  const l = await g.listGrants(e);
  assert.deepEqual(l.map((r) => r.app).sort(), APPS.slice().sort());
  assert.ok(e.D1_ACCOUNT.statements.slice(before).every((s) => /^\s*SELECT/i.test(s)), '只发 SELECT');
  await g.revokeGrant(e, 'curio');
  assert.equal(rows(e).some((r) => r.app === 'curio'), false);
  await g.revokeGrant(e, 'curio');
  await g.addGrant(e, 'curio', { deviceId: 'devtestdevtest01', by: 'passkey' });
  const row = rows(e).find((r) => r.app === 'curio');
  assert.deepEqual(JSON.parse(row.record), { v: 1, scopes: ['curio.write'], deviceId: 'devtestdevtest01', by: 'passkey' });
  await assert.rejects(() => g.addGrant(e, 'book', {}), /bad app/);
  await assert.rejects(() => g.revokeGrant(e, 'book'), /bad app/);
});

test('没有种子：空库（迁移没跑）兜底建表后 0 行；取消完也不会再种；源码里没有 seed / data_migration', async () => {
  const e = env(makeAccountD1({ migrations: false }));
  assert.deepEqual(await g.listGrants(e), []);
  const e2 = env();
  for (const a of APPS) await g.revokeGrant(e2, a);
  assert.deepEqual(await g.listGrants(e2), []);
  const src = readFileSync(new URL(CORE + 'grants.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.doesNotMatch(src, /seed|data_migration|SUPPLEMENT/i);
});

test('listGrants：不在作用域表里的应用行不认；坏 JSON 的 record 当没有作用域', async () => {
  const e = env();
  e.D1_ACCOUNT.raw.prepare("INSERT INTO account_grant (app, record, granted_at) VALUES ('book', '{}', 1)").run();
  e.D1_ACCOUNT.raw.prepare("UPDATE account_grant SET record = 'not json' WHERE app = 'prefs'").run();
  const l = await g.listGrants(e);
  assert.equal(l.some((r) => r.app === 'book'), false);
  assert.deepEqual(l.find((r) => r.app === 'prefs').scopes, []);
});

test('scopesOfRows：每行只认属于本应用、在作用域表里的作用域', () => {
  assert.deepEqual(g.scopesOfRows([
    { app: 'curio', scopes: ['curio.write', 'daymark.write', 'nope.x'] },
    { app: 'prefs', scopes: ['prefs.sync'] },
    { app: 'book', scopes: ['book.write'] },
  ]), ['curio.write', 'prefs.sync']);
  assert.deepEqual(g.scopesOfRows(null), []);
});
