/**
 * 账号三张票的格式与验证（lib/ticket.js、core/session.js、core/reauth.js、core/reset.js）：
 * - session 票格式与命名 v2 之前一字不差（"sgx-account-session|by.epoch.authAt.exp.deviceId"）：按旧格式手工签的票照样有效（已登录设备不掉线）
 * - reauth 票带 deviceId，验的时候要同一台设备的有效 session；纪元 = session 纪元
 * - reset 票 by 只会是 recovery-key，纪元 = reset 纪元（和 session 纪元互不影响）
 * - 三张票互相冒充不了（签名串带 cookie 名）；篡改 / 别的钥匙 / 纪元不对 / 过期 / 超时长都无效
 * - 设备：吊销立即生效；不会被复活；列表上限
 *
 * 运行：node --test tests/workers/account/session.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  K, keys, makeEnv, accSession, reauthTicket, resetTicket, setEpoch, epochOf, TEST_DEVICE_ID,
  session, reauthCore, resetCore, devices, config, all,
} from './_fixtures.mjs';

const { ed25519Sign } = await import('../../../workers/account/src/lib/crypto.js');
const ticket = await import('../../../workers/account/src/lib/ticket.js');

before(keys);

/** @param {Record<string,string>} ck */
const reqWith = (ck) => new Request('https://styrigx.com/api/account', { headers: { Cookie: Object.entries(ck).map(([k, v]) => k + '=' + v).join('; ') } });

test('session 票：按命名 v2 之前的格式手工签（"sgx-account-session|by.epoch.authAt.exp.deviceId"）照样有效——已登录设备不掉线', async () => {
  const env = makeEnv();
  setEpoch(env, 7);
  const authAt = Date.now() - 1000;
  const exp = Date.now() + 86400000;
  const payload = 'passkey.7.' + authAt + '.' + exp + '.' + TEST_DEVICE_ID;
  const old = payload + '.' + (await ed25519Sign(K.ACCOUNT.priv, 'sgx-account-session|' + payload));
  const v = await session.verifySession(reqWith({ 'sgx-account-session': old }), env);
  assert.equal(v.ok, true);
  assert.equal(v.by, 'passkey');
  assert.equal(v.authAt, authAt);
  assert.equal(v.deviceId, TEST_DEVICE_ID);
  /* 新代码签出来的就是这个格式 */
  const mine = await accSession('passkey', 7, authAt);
  assert.match(mine, new RegExp('^passkey\\.7\\.' + authAt + '\\.\\d+\\.' + TEST_DEVICE_ID + '\\.[A-Za-z0-9_-]+$'));
});

test('session 票：篡改 deviceId / 别的钥匙签 → bad-sig；纪元不对 → epoch-changed；五段 → bad-format；过期 → expired；吊销 → revoked；缺公钥 → no-pubkey', async () => {
  const env = makeEnv();
  const good = await accSession();
  assert.equal((await session.verifySession(reqWith({ 'sgx-account-session': good }), env)).ok, true);
  const parts = good.split('.');
  parts[4] = 'otherdevice_0002';
  assert.equal((await session.verifySession(reqWith({ 'sgx-account-session': parts.join('.') }), env)).reason, 'bad-sig');
  assert.equal((await session.verifySession(reqWith({ 'sgx-account-session': await accSession('password', 0, Date.now(), { priv: K.OTHER.priv }) }), env)).reason, 'bad-sig');
  assert.equal((await session.verifySession(reqWith({ 'sgx-account-session': await accSession('password', 3) }), env)).reason, 'epoch-changed');
  assert.equal((await session.verifySession(reqWith({ 'sgx-account-session': 'password.0.1.2.sig' }), env)).reason, 'bad-format');
  const t0 = Date.now() - 500 * 86400000;
  assert.equal((await session.verifySession(reqWith({ 'sgx-account-session': await accSession('password', 0, t0, { now: t0 }) }), env)).reason, 'expired');
  assert.equal((await session.verifySession(reqWith({ 'sgx-lock-session': good }), env)).reason, 'no-cookie', '进站会话 cookie 不算');
  await devices.revokeDevice(env, TEST_DEVICE_ID);
  assert.equal((await session.verifySession(reqWith({ 'sgx-account-session': good }), env)).reason, 'revoked');
  assert.equal((await session.verifySession(reqWith({ 'sgx-account-session': good }), makeEnv({ SGX_ACCOUNT_PUBLIC: '' }))).reason, 'no-pubkey');
  assert.equal(ticket.parseTicket(config.TICKET.session, null), null);
});

test('reauth 票：挂在本机 session 上——同一 deviceId 才有效；没有 session → no-session；别的设备 → other-device；纪元跟 session 走', async () => {
  const env = makeEnv();
  const s = await session.verifySession(reqWith({ 'sgx-account-session': await accSession() }), env);
  const rv = await reauthCore.verifyReauth(reqWith({ 'sgx-account-reauth': await reauthTicket() }), env, s);
  assert.equal(rv.ok, true);
  assert.equal(rv.by, 'password');
  assert.equal((await reauthCore.verifyReauth(reqWith({ 'sgx-account-reauth': await reauthTicket() }), env, { ok: false })).reason, 'no-session');
  assert.equal((await reauthCore.verifyReauth(reqWith({ 'sgx-account-reauth': await reauthTicket('password', 0, { deviceId: 'otherdevice_0002' }) }), env, s)).reason, 'other-device');
  setEpoch(env, 1);
  assert.equal((await reauthCore.verifyReauth(reqWith({ 'sgx-account-reauth': await reauthTicket() }), env, s)).reason, 'epoch-changed');
  /* 3 分钟，不许更长：手工签一张 exp − iat 超时长的 → bad-format */
  const iat = Date.now();
  const long = await ticket.signTicket(K.ACCOUNT.priv, config.TICKET.reauth, { by: 'password', epoch: 1, at: iat, exp: iat + 181000, deviceId: TEST_DEVICE_ID });
  assert.equal((await reauthCore.verifyReauth(reqWith({ 'sgx-account-reauth': long }), env, s)).reason, 'bad-format');
  const old = await reauthTicket('password', 1, { iat: Date.now() - 200000 });
  assert.equal((await reauthCore.verifyReauth(reqWith({ 'sgx-account-reauth': old }), env, s)).reason, 'expired');
});

test('reset 票：by = recovery-key；纪元 = reset 纪元（session 纪元推进不影响它，反之亦然）', async () => {
  const env = makeEnv();
  const x = await resetTicket(0);
  assert.match(x, /^recovery-key\.0\.\d+\.\d+\.[A-Za-z0-9_-]+$/);
  assert.equal((await resetCore.verifyReset(reqWith({ 'sgx-account-reset': x }), env)).ok, true);
  setEpoch(env, 5, 'session');
  assert.equal((await resetCore.verifyReset(reqWith({ 'sgx-account-reset': x }), env)).ok, true, 'session 纪元不管 reset 票');
  setEpoch(env, 1, 'reset');
  assert.equal((await resetCore.verifyReset(reqWith({ 'sgx-account-reset': x }), env)).reason, 'epoch-changed');
  assert.equal(epochOf(env, 'session'), 5);
});

test('三张票互相冒充不了：session 票值放进 reauth / reset cookie、reauth 票放进 reset cookie 都无效（签名串带 cookie 名）', async () => {
  const env = makeEnv();
  const s = await accSession();
  const r = await reauthTicket();
  const sv = await session.verifySession(reqWith({ 'sgx-account-session': s }), env);
  assert.equal((await reauthCore.verifyReauth(reqWith({ 'sgx-account-reauth': s }), env, sv)).ok, false);
  assert.equal((await resetCore.verifyReset(reqWith({ 'sgx-account-reset': r }), env)).ok, false);
  assert.equal((await session.verifySession(reqWith({ 'sgx-account-session': r }), env)).ok, false);
  /* 同样 5 段的 reauth 去掉 deviceId 也不行 */
  const iat = Date.now();
  const fake = await ticket.signTicket(K.ACCOUNT.priv, config.TICKET.reauth, { by: 'password', epoch: 0, at: iat, exp: iat + 180000, deviceId: TEST_DEVICE_ID });
  assert.equal((await resetCore.verifyReset(reqWith({ 'sgx-account-reset': fake.split('.').filter((_, i) => i !== 4).join('.') }), env)).ok, false);
});

test('签发：缺签名钥匙 → session / reauth 503 config；纪元读不到 → 503 server；cookie 属性 Path=/; HttpOnly; Secure; SameSite=Strict', async () => {
  const h = new Headers();
  assert.deepEqual(await session.issueSession(makeEnv({ SGX_ACCOUNT_PRIVATE: '' }), h, 'password', {}), { status: 503, body: { ok: false, error: 'config' } });
  assert.deepEqual(await reauthCore.issueReauth(makeEnv({ SGX_ACCOUNT_PUBLIC: '' }), h, 'password', TEST_DEVICE_ID), { status: 503, body: { ok: false, error: 'config' } });
  const down = makeEnv({ D1_ACCOUNT: { prepare() { throw new Error('down'); } } });
  assert.deepEqual(await reauthCore.issueReauth(down, h, 'password', TEST_DEVICE_ID), { status: 503, body: { ok: false, error: 'server' } });
  const env = makeEnv();
  const h2 = new Headers();
  assert.equal(await session.issueSession(env, h2, 'passkey', { deviceId: TEST_DEVICE_ID }), null);
  assert.equal(await reauthCore.issueReauth(env, h2, 'passkey', TEST_DEVICE_ID), null);
  const c = h2.getSetCookie();
  assert.match(c[0], /^sgx-account-session=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=34560000$/);
  assert.equal(c[1], 'sgx-account-signed-in=1; Path=/; Secure; SameSite=Strict; Max-Age=34560000', '登录标记跟着 session 签：值 1、非 HttpOnly、不含秘密');
  assert.match(c[2], /^sgx-account-reauth=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=180$/);
  const h3 = new Headers();
  session.endSession(h3);
  assert.deepEqual(h3.getSetCookie().map((x) => x.split('=')[0]), ['sgx-account-session', 'sgx-account-reauth', 'sgx-account-signed-in'], 'end 连 reauth、登录标记一起清，不碰 reset');
});

test('rotateSessions：session 纪元 +1、本机按原 by / authAt 重签、其他设备行删掉（已退出的行留着）；reissueReauth 不延长剩余时间', async () => {
  const env = makeEnv();
  const authAt = Date.now() - 5000;
  await devices.putDevice(env, { deviceId: TEST_DEVICE_ID, lastSeen: 1 });
  await devices.putDevice(env, { deviceId: 'otherdevice_0002', lastSeen: 1 });
  await devices.revokeDevice(env, 'revokeddevice_03');
  const s = await session.verifySession(reqWith({ 'sgx-account-session': await accSession('passkey', 0, authAt) }), env);
  const rv = await reauthCore.verifyReauth(reqWith({ 'sgx-account-reauth': await reauthTicket('passkey', 0, { iat: Date.now() - 60000 }) }), env, s);
  const h = new Headers();
  const ne = await session.rotateSessions(env, h, s);
  await reauthCore.reissueReauth(env, h, rv, TEST_DEVICE_ID, ne);
  assert.equal(ne, 1);
  assert.equal(epochOf(env), 1);
  const ck = Object.fromEntries(h.getSetCookie().map((c) => c.split(';')[0].split('=')));
  const s2 = await session.verifySession(reqWith(ck), env);
  assert.equal(s2.ok, true);
  assert.equal(s2.authAt, authAt);
  assert.equal(s2.by, 'passkey');
  const r2 = await reauthCore.verifyReauth(reqWith(ck), env, s2);
  assert.equal(r2.ok, true);
  assert.equal(r2.exp, rv.exp, '不延长');
  assert.match(h.getSetCookie()[2], /Max-Age=1[12]\d$/);
  assert.deepEqual(all(env, 'SELECT device_id FROM account_device ORDER BY device_id').map((r) => r.device_id), [TEST_DEVICE_ID, 'revokeddevice_03']);
});

test('设备：已退出的不会被 putDevice / recordLogin 复活；revokeDevice 对没有的 id 也插一行已退出的；列表上限 50、最近活跃在前', async () => {
  const env = makeEnv();
  await devices.revokeDevice(env, 'ghostdevice_0001');
  await devices.putDevice(env, { deviceId: 'ghostdevice_0001', lastSeen: Date.now() });
  await devices.recordLogin(env, 'ghostdevice_0001', 'password', Date.now(), {});
  assert.equal(await devices.isRevoked(env, 'ghostdevice_0001'), true);
  for (let i = 0; i < 55; i++) await devices.putDevice(env, { deviceId: 'dev_' + String(i).padStart(12, '0'), lastSeen: 1000 + i });
  const list = await devices.listDevices(env);
  assert.equal(list.length, devices.DEVICE_LIST_MAX);
  assert.equal(list[0].deviceId, 'dev_000000000054');
});

test('登录标记 sgx-account-signed-in 只给前端首帧显示：单有它不算登录（服务端从不读它）', async () => {
  const env = makeEnv();
  const v = await session.verifySession(reqWith({ 'sgx-account-signed-in': '1' }), env);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'no-cookie');
});
