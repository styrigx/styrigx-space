/**
 * POST /api/account/grants（应用授权，经 AccountService 命名入口）：
 * - 授权只看 account_grant 的行（空库经 0005 写满 6 个应用，同线上首次切换）；list 只读
 * - revoke 删行回新列表、不要 reauth，下一次授权结论（AccountVerifier.authorize）立即不含
 * - add 要挂在本机 session 上的 reauth 票（403 reauth；reset 票、别的设备的 reauth 票不算）
 * - 都要进站会话 + session；授权时的设备退出后 device.gone；D1 出错 503
 *
 * 运行：node --test tests/workers/account/api-grants.test.mjs
 */
import './_cf-workers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postReq } from '../_harness.mjs';
import { makeAccountD1 } from './_d1.mjs';
import { K, keys, idHeaders, accSession, reauthTicket, resetTicket, TEST_DEVICE_ID } from './_fixtures.mjs';

const SRC = '../../../workers/account/src/';
const ep = { ...(await import(SRC + 'rpc/account-service.js')), ...(await import(SRC + 'rpc/account-verifier.js')) };
await keys();
const CTX = { waitUntil() {} };
const ORIGIN = 'https://styrigx.com';

function makeEnv() {
  return { env: { SGX_ENV: 'production', D1_ACCOUNT: makeAccountD1(), SGX_ACCOUNT_PRIVATE: K.ACCOUNT.priv, SGX_ACCOUNT_PUBLIC: K.ACCOUNT.pub, SGX_RP_ID: 'styrigx.com', SGX_ORIGIN: ORIGIN } };
}
const service = (env) => new ep.AccountService(CTX, env);
const accCookie = async (o) => 'sgx-account-session=' + (await accSession('password', 0, Date.now(), o));

const APPS = ['curio', 'daymark', 'prefs', 'wellbeing', 'avatar', 'profile'];
const ALL = ['avatar.write', 'curio.write', 'daymark.write', 'prefs.sync', 'profile.write', 'wellbeing.write'];
/** POST /api/account/grants 经 AccountService（进站会话身份头 + 给定 cookie） @param {any} env @param {any} body @param {string} [cookie] */
const grantPost = (env, body, cookie) => service(env).fetch(postReq(ORIGIN + '/api/account/grants', body, { ...idHeaders(), ...(cookie ? { Cookie: cookie } : {}) }));
const reauthCookie = async (o) => 'sgx-account-reauth=' + (await reauthTicket('password', 0, o));
/** 网关问的授权结论（AccountVerifier.authorize） @param {any} env @param {string} cookie */
const scopesNow = async (env, cookie) => (await new ep.AccountVerifier(CTX, env).authorize(cookie, {}, {})).scopes;

test('grants list：回 6 项（作用域表顺序、名字、作用域、授权时间）；只读，调多少次都不写授权行', async () => {
  const { env } = makeEnv();
  const ck = await accCookie();
  const r = await grantPost(env, { action: 'list' }, ck);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.deepEqual(j.grants.map((g) => g.app), APPS);
  assert.deepEqual(j.grants.map((g) => g.name), ['Curio', 'Daymark', 'Settings sync', 'Digital wellbeing', 'Avatar', 'Profile']);
  assert.deepEqual(j.grants.map((g) => g.scopes), [['curio.write'], ['daymark.write'], ['prefs.sync'], ['wellbeing.write'], ['avatar.write'], ['profile.write']]);
  assert.deepEqual(j.grants[0].sensitive, ['POST /curio/api/import']);
  for (const g of j.grants) {
    assert.equal(g.granted, true, g.app + '（空库经 0005 写满）');
    assert.ok(g.grantedAt > 0, g.app);
    assert.deepEqual(g.device, { name: '', gone: true }, '0005 补的行没有授权设备');
  }
  const t0 = env.D1_ACCOUNT.rows('account_grant').map((x) => x.granted_at);
  await grantPost(env, { action: 'list' }, ck);
  assert.deepEqual(env.D1_ACCOUNT.rows('account_grant').map((x) => x.granted_at), t0);
});

test('grants：要进站会话（401 session）+ 账号会话（401 account；只有 reset 票也不行）；不认识的 action 400', async () => {
  const { env } = makeEnv();
  for (const action of ['list', 'revoke', 'add']) {
    let r = await service(env).fetch(postReq(ORIGIN + '/api/account/grants', { action, app: 'curio' }, {}));
    assert.equal(r.status, 401, action);
    r = await grantPost(env, { action, app: 'curio' });
    assert.equal(r.status, 401, action);
    assert.equal((await r.json()).error, 'account', action);
    r = await grantPost(env, { action, app: 'curio' }, 'sgx-account-reset=' + (await resetTicket()));
    assert.equal(r.status, 401, action + '：reset 票不算账号会话');
  }
  for (const action of ['grant-list', 'grant-add', '']) {
    const r = await grantPost(env, { action }, await accCookie());
    assert.equal(r.status, 400, action);
    assert.equal((await r.json()).error, 'action');
  }
});

test('grants revoke：删行并回新列表，不要 reauth；下一次授权结论立即不含该作用域；未知应用 400 params；取消完就是 []', async () => {
  const { env } = makeEnv();
  const ck = await accCookie();
  assert.deepEqual(await scopesNow(env, ck), ALL);
  const r = await grantPost(env, { action: 'revoke', app: 'curio' }, ck);
  assert.equal(r.status, 200);
  const curio = (await r.json()).grants.find((g) => g.app === 'curio');
  assert.equal(curio.granted, false);
  assert.equal(curio.device, null);
  assert.deepEqual(await scopesNow(env, ck), ALL.filter((s) => s !== 'curio.write'));
  assert.equal((await grantPost(env, { action: 'revoke', app: 'curio' }, ck)).status, 200, '重复取消：幂等');
  for (const app of ['', 'book', 'CURIO', 'account', 3, null]) {
    const b = await grantPost(env, { action: 'revoke', app }, ck);
    assert.equal(b.status, 400, String(app));
    assert.equal((await b.json()).error, 'params');
  }
  for (const app of APPS) await grantPost(env, { action: 'revoke', app }, ck);
  await grantPost(env, { action: 'list' }, ck);
  assert.equal(env.D1_ACCOUNT.rows('account_grant').length, 0, '不会再种');
  assert.deepEqual(await scopesNow(env, ck), []);
});

test('grants add：没有 reauth 票 → 403 reauth、不写；reset 票、别的设备的 reauth 票都不算；本机 reauth 票 → 写回并回新列表', async () => {
  const { env } = makeEnv();
  const ck = await accCookie();
  await grantPost(env, { action: 'revoke', app: 'curio' }, ck);
  let r = await grantPost(env, { action: 'add', app: 'curio' }, ck);
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'reauth');
  assert.ok(!env.D1_ACCOUNT.rows('account_grant').some((x) => x.app === 'curio'));
  r = await grantPost(env, { action: 'add', app: 'curio' }, 'sgx-account-reset=' + (await resetTicket()) + '; ' + ck);
  assert.equal(r.status, 403, 'reset 票不算 reauth');
  r = await grantPost(env, { action: 'add', app: 'curio' }, ck + '; ' + (await reauthCookie({ deviceId: 'otherdevice_0002' })));
  assert.equal(r.status, 403, '别的设备的 reauth 票不算');
  assert.equal((await r.json()).reason, 'other-device');
  r = await grantPost(env, { action: 'add', app: 'curio' }, ck + '; ' + (await reauthCookie()));
  assert.equal(r.status, 200);
  const curio = (await r.json()).grants.find((g) => g.app === 'curio');
  assert.equal(curio.granted, true);
  assert.equal(curio.by, 'password');
  assert.deepEqual(await scopesNow(env, ck), ALL);
  const row = env.D1_ACCOUNT.rows('account_grant').find((x) => x.app === 'curio');
  assert.deepEqual(JSON.parse(row.record), { v: 1, scopes: ['curio.write'], deviceId: TEST_DEVICE_ID, by: 'password' });
  assert.deepEqual(env.D1_ACCOUNT.rows('account_audit').map((a) => a.event), ['grants-revoke', 'grants-add']);
});

test('grants list：授权时的设备已退出 → device.gone=true（前端显示「已退出的设备」）', async () => {
  const { env } = makeEnv();
  const other = 'otherdevice_0002';
  const ck2 = await accCookie({ deviceId: other });
  await grantPost(env, { action: 'revoke', app: 'curio' }, ck2);
  await grantPost(env, { action: 'add', app: 'curio' }, ck2 + '; ' + (await reauthCookie({ deviceId: other })));
  let j = await (await grantPost(env, { action: 'list' }, await accCookie())).json();
  assert.equal(j.grants.find((g) => g.app === 'curio').device.gone, false);
  const { revokeDevice } = await import(SRC + 'core/devices.js');
  await revokeDevice(env, other);
  j = await (await grantPost(env, { action: 'list' }, await accCookie())).json();
  assert.deepEqual(j.grants.find((g) => g.app === 'curio').device, { name: '', gone: true });
});

test('grants：账号库出错 → 503 server（不抛）', async () => {
  const { env } = makeEnv();
  const ck = await accCookie();
  await grantPost(env, { action: 'list' }, ck);
  env.D1_ACCOUNT.raw.exec('DROP TABLE account_grant; CREATE VIEW account_grant AS SELECT 1 AS broken');
  const r = await grantPost(env, { action: 'revoke', app: 'curio' }, ck);
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, 'server');
});

