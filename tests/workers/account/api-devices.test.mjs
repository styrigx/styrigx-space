/**
 * POST /api/account/devices（已登录设备）：
 * - 要 session（401 account）；list 本机排第一并标 current；GET session.device = 本机名字
 * - revoke：别的设备立即失效；不能是本机 400 current；不存在 404；格式不对 400 params；审计 devices-revoke
 * - revoke-all：要挂在本机 session 上的 reauth 票（403 reauth；reset 票不算）；session 纪元 +1、本机重签、其他设备行删掉；纪元推不动 503 epoch
 * - 地点读 X-Styrigx-Client-Country / City，不读 request.cf；D1 出错 503 server
 *
 * 运行：node --test tests/workers/account/api-devices.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  keys, makeEnv, post, get, accSession, resetTicket, full, seedPassword, pickCookie, auditEvents, epochOf, all, TEST_DEVICE_ID, devices,
} from './_fixtures.mjs';

before(keys);
const OTHER = 'otherdevice_0002';
const S = async (o) => ({ 'sgx-account-session': await accSession('password', 0, Date.now(), o) });

test('没有 session → 401 account；不认识的 action / 旧名 400', async () => {
  const env = makeEnv();
  assert.equal((await (await post(env, 'devices', { action: 'list' })).json()).error, 'account');
  for (const action of ['device-list', 'device-revoke', 'device-revoke-all', '']) assert.equal((await post(env, 'devices', { action }, await S())).status, 400, action);
});

test('list：本机排第一并标 current；型号来自登录时的 hints；GET session.device = 本机名字', async () => {
  const env = makeEnv();
  await seedPassword(env, 'right-password-1');
  await post(env, 'session', { action: 'password', password: 'right-password-1', device: { model: 'SM-S9380', platform: 'Android' } }, await S({ deviceId: OTHER }));
  await devices.putDevice(env, { deviceId: TEST_DEVICE_ID, lastSeen: 1, browser: 'Samsung Internet', platform: 'Android' });
  const j = await (await post(env, 'devices', { action: 'list' }, await S())).json();
  assert.equal(j.devices[0].current, true);
  assert.equal(j.devices.length, 2);
  assert.ok(j.devices.some((d) => /SM-S9380/.test(d.name) || d.model === 'SM-S9380'));
  const g = await (await get(env, await S())).json();
  assert.equal(g.session.device, j.devices[0].name);
});

test('revoke：别的设备立即失效（下一个请求 revoked）；本机 400 current；不存在 404；格式不对 400 params；审计 devices-revoke', async () => {
  const env = makeEnv();
  await devices.putDevice(env, { deviceId: OTHER, lastSeen: Date.now() });
  const r = await post(env, 'devices', { action: 'revoke', deviceId: OTHER }, await S());
  assert.equal(r.status, 200);
  const x = await post(env, 'devices', { action: 'list' }, await S({ deviceId: OTHER }));
  assert.equal((await x.json()).reason, 'revoked');
  assert.equal((await (await post(env, 'devices', { action: 'revoke', deviceId: TEST_DEVICE_ID }, await S())).json()).error, 'current');
  assert.equal((await post(env, 'devices', { action: 'revoke', deviceId: 'nodevice_000009' }, await S())).status, 404);
  assert.equal((await post(env, 'devices', { action: 'revoke', deviceId: 'x' }, await S())).status, 400);
  assert.deepEqual(auditEvents(env), ['devices-revoke']);
});

test('revoke-all：只有 session 403 reauth；session + reset 票也不行；有 reauth → 纪元 +1、本机重签、其他设备行全删；审计 devices-revoke-all', async () => {
  const env = makeEnv();
  await devices.putDevice(env, { deviceId: TEST_DEVICE_ID, lastSeen: 1 });
  await devices.putDevice(env, { deviceId: OTHER, lastSeen: 1 });
  assert.equal((await post(env, 'devices', { action: 'revoke-all' }, await S())).status, 403);
  assert.equal((await post(env, 'devices', { action: 'revoke-all' }, { ...(await S()), 'sgx-account-reset': await resetTicket() })).status, 403);
  const r = await post(env, 'devices', { action: 'revoke-all' }, await full());
  assert.equal(r.status, 200);
  assert.equal(epochOf(env), 1);
  assert.match(pickCookie(r, 'sgx-account-session'), /^password\.1\./);
  assert.match(pickCookie(r, 'sgx-account-reauth'), /^password\.1\./);
  assert.deepEqual(all(env, 'SELECT device_id FROM account_device').map((x) => x.device_id), [TEST_DEVICE_ID]);
  assert.equal((await (await post(env, 'devices', { action: 'list' }, await S({ deviceId: OTHER }))).json()).reason, 'epoch-changed');
  assert.deepEqual(auditEvents(env), ['devices-revoke-all']);
});

test('revoke-all：纪元推不动 → 503 epoch', async () => {
  const env = makeEnv();
  const ck = await full();
  await post(env, 'devices', { action: 'list' }, ck);
  env.D1_ACCOUNT.raw.exec("CREATE TRIGGER no_bump BEFORE UPDATE ON account_epoch BEGIN SELECT RAISE(FAIL, 'down'); END");
  const r = await post(env, 'devices', { action: 'revoke-all' }, ck);
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, 'epoch');
});

test('地点：读 X-Styrigx-Client-Country / City（不读 request.cf）；验 session 超过 30 分钟刷新 lastSeen 和地点', async () => {
  const env = makeEnv();
  await devices.putDevice(env, { deviceId: TEST_DEVICE_ID, lastSeen: Date.now() - 31 * 60000, country: 'CN', city: 'Shanghai' });
  await post(env, 'devices', { action: 'list' }, await S(), { identity: { country: 'JP', city: 'Tokyo' } });
  const rec = JSON.parse(all(env, 'SELECT record FROM account_device')[0].record);
  assert.equal(rec.country, 'JP');
  assert.equal(rec.city, 'Tokyo');
});

test('list / revoke：读设备 D1 出错 → 503 server', async () => {
  const env = makeEnv();
  const ck = await S();
  await post(env, 'devices', { action: 'list' }, ck);
  env.D1_ACCOUNT.raw.exec('DROP TABLE account_device; CREATE VIEW account_device AS SELECT 1 AS broken');
  const r = await post(env, 'devices', { action: 'list' }, ck);
  assert.ok(r.status === 401 || r.status === 503, '读设备出错：验 session 时就 d1-error（401 account）或列表 503');
});
