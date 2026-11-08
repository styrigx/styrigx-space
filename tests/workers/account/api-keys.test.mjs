/**
 * POST /api/account/keys（账号安全）：
 * - 要 session（401 account）；passkey-list 只要 session，其余要挂在本机 session 上的 reauth 票（403 reauth，带 reason）
 * - password-set：少于 8 位 400 short、缺 400 params、缺 pepper 503 config；首次设置不轮换；已有密码 → 轮换
 * - 轮换：session 纪元 +1、本机 session 按原 deviceId / by / authAt 重签、reauth 按原到期时间重签、其他设备行删掉
 * - passkey-add-challenge（用途 keys-add）/ passkey-add：存进 account_passkey（字段顺序固定、name 清洗、provider 存 id）；不轮换
 * - passkey-delete：先轮换再删；纪元推不动 → 503 epoch、钥匙还在
 * - passkey-rename：清洗、限 40 字；空名 400；不存在 404；不轮换
 * - 审计 keys-<action>
 *
 * 运行：node --test tests/workers/account/api-keys.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  K, keys, makeEnv, post, accSession, reauthTicket, full, seedPassword, seedPasskey, setHandles, makeAttestationCredential,
  pickCookie, setCookies, auditEvents, epochOf, all, one, TEST_DEVICE_ID, devices, session,
} from './_fixtures.mjs';

before(keys);

test('没有 session → 401 account；改动没有 reauth 票 / 过期 / 别的钥匙签 / 纪元不对 / 别的设备的 → 403 reauth；passkey-list 只要 session', async () => {
  const env = makeEnv();
  let r = await post(env, 'keys', { action: 'passkey-list' });
  assert.deepEqual(await r.json(), { ok: false, error: 'account', reason: 'no-cookie' });
  const s = await accSession();
  r = await post(env, 'keys', { action: 'passkey-list' }, { 'sgx-account-session': s });
  assert.equal(r.status, 200);
  const cases = [
    [{}, 'no-cookie'],
    [{ 'sgx-account-reauth': await reauthTicket('password', 0, { iat: Date.now() - 200000 }) }, 'expired'],
    [{ 'sgx-account-reauth': await reauthTicket('password', 0, { priv: K.OTHER.priv }) }, 'bad-sig'],
    [{ 'sgx-account-reauth': await reauthTicket('password', 3) }, 'epoch-changed'],
    [{ 'sgx-account-reauth': await reauthTicket('password', 0, { deviceId: 'otherdevice_0002' }) }, 'other-device'],
    [{ 'sgx-account-reauth': s }, 'bad-format'], /* session 票冒充：时长超过 3 分钟 */
  ];
  for (const [extra, reason] of cases) {
    const x = await post(env, 'keys', { action: 'passkey-rename', credId: 'x', name: 'y' }, { 'sgx-account-session': s, ...extra });
    assert.equal(x.status, 403, reason);
    assert.deepEqual(await x.json(), { ok: false, error: 'reauth', reason });
  }
  for (const action of ['password-change', 'passkey-register', 'passkey-register-challenge', '']) assert.equal((await post(env, 'keys', { action }, await full())).status, 400, action);
});

test('passkey-list：{ userHandle, userName:AccountPasskey, displayName, keys[] }；只读 handle、不新建；provider 只给认识的 id', async () => {
  const env = makeEnv();
  await seedPasskey(env, { name: '我的手机', provider: 'Samsung Pass' });
  const j = await (await post(env, 'keys', { action: 'passkey-list' }, { 'sgx-account-session': await accSession() })).json();
  assert.equal(j.userHandle, '');
  assert.equal(j.userName, 'AccountPasskey');
  assert.equal(j.displayName, 'Sloan Gray');
  assert.deepEqual(Object.keys(j.keys[0]), ['credId', 'name', 'provider', 'createdAt', 'lastUsedAt']);
  assert.equal(j.keys[0].provider, '', '旧显示名已由 0005 改成 id；代码不再认旧值');
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM account_user_handle').n, 0);
  setHandles(env, 'HANDLE');
  assert.equal((await (await post(env, 'keys', { action: 'passkey-list' }, { 'sgx-account-session': await accSession() })).json()).userHandle, 'HANDLE');
});

test('password-set：少于 8 位 400 short；缺 / 非字符串 400 params；缺账号 pepper 503 config', async () => {
  const env = makeEnv();
  const c = await full();
  assert.equal((await (await post(env, 'keys', { action: 'password-set', password: 'short' }, c)).json()).error, 'short');
  assert.equal((await post(env, 'keys', { action: 'password-set' }, c)).status, 400);
  const env2 = makeEnv({ SGX_ACCOUNT_PASSWORD_PEPPER: '' });
  assert.equal((await (await post(env2, 'keys', { action: 'password-set', password: 'long-enough-1' }, c)).json()).error, 'config');
});

test('password-set 首次设置：changed=false、不轮换（不推纪元、不发 cookie）；审计 keys-password-set', async () => {
  const env = makeEnv();
  const r = await post(env, 'keys', { action: 'password-set', password: 'first-password-1' }, await full());
  assert.deepEqual(await r.json(), { ok: true, changed: false });
  assert.equal(r.headers.get('Set-Cookie'), null);
  assert.equal(epochOf(env), 0);
  assert.deepEqual(auditEvents(env), ['keys-password-set']);
  const rec = JSON.parse(one(env, 'SELECT record FROM account_password').record);
  assert.deepEqual(Object.keys(rec), ['salt', 'hash', 'iterations', 'peppered', 'updatedAt']);
  assert.equal(rec.peppered, true);
});

test('password-set 已有密码：session 纪元 +1；本机按原 deviceId / by / authAt 重签；reauth 按原到期时间重签；其他设备行删掉；旧票失效', async () => {
  const env = makeEnv();
  await seedPassword(env, 'old-password-1');
  await devices.putDevice(env, { deviceId: TEST_DEVICE_ID, lastSeen: 1 });
  await devices.putDevice(env, { deviceId: 'otherdevice_0002', lastSeen: 1 });
  const authAt = Date.now() - 7000;
  const ck = { 'sgx-account-session': await accSession('passkey', 0, authAt), 'sgx-account-reauth': await reauthTicket('passkey', 0, { iat: Date.now() - 30000 }) };
  const r = await post(env, 'keys', { action: 'password-set', password: 'new-password-1' }, ck);
  assert.deepEqual(await r.json(), { ok: true, changed: true });
  assert.equal(epochOf(env), 1);
  const s = pickCookie(r, 'sgx-account-session');
  assert.match(s, new RegExp('^passkey\\.1\\.' + authAt + '\\.\\d+\\.' + TEST_DEVICE_ID + '\\.'));
  const ra = pickCookie(r, 'sgx-account-reauth');
  assert.match(ra, /^passkey\.1\./);
  assert.match(setCookies(r).find((c) => c.startsWith('sgx-account-reauth=')), /Max-Age=1[45]\d$/);
  assert.deepEqual(all(env, 'SELECT device_id FROM account_device').map((x) => x.device_id), [TEST_DEVICE_ID]);
  const old = await post(env, 'keys', { action: 'passkey-list' }, { 'sgx-account-session': ck['sgx-account-session'] });
  assert.equal((await old.json()).reason, 'epoch-changed');
  assert.equal((await post(env, 'keys', { action: 'passkey-list' }, { 'sgx-account-session': s })).status, 200);
  assert.equal((await post(env, 'session', { action: 'password', password: 'new-password-1' })).status, 200);
  assert.equal((await post(env, 'session', { action: 'password', password: 'old-password-1' })).status, 403);
});

test('passkey-add-challenge：生成并沿用账号 handle，排除已有的；challenge 用途 keys-add', async () => {
  const env = makeEnv();
  const a = await seedPasskey(env);
  const j = await (await post(env, 'keys', { action: 'passkey-add-challenge' }, await full())).json();
  assert.ok(j.user.id && j.user.id.length >= 40);
  assert.deepEqual(j.excludeCredentials, [{ id: a.credId, type: 'public-key' }]);
  assert.equal(one(env, 'SELECT purpose FROM account_challenge WHERE id = ?', j.cid).purpose, 'keys-add');
  const j2 = await (await post(env, 'keys', { action: 'passkey-add-challenge' }, await full())).json();
  assert.equal(j2.user.id, j.user.id);
  assert.equal(one(env, 'SELECT legacy_handle FROM account_user_handle').legacy_handle, '');
});

test('passkey-add：字段顺序固定、name 清洗、provider 存 id；不轮换；challenge 单次；origin 不对 403 verify；审计 keys-passkey-add', async () => {
  const env = makeEnv();
  const c = await full();
  const ch = await (await post(env, 'keys', { action: 'passkey-add-challenge' }, c)).json();
  const cred = await makeAttestationCredential(ch.challenge, 'styrigx.com', 'https://styrigx.com');
  const r = await post(env, 'keys', { action: 'passkey-add', cid: ch.cid, credential: cred, name: '  我的\u0007手机 ' }, c);
  assert.deepEqual(await r.json(), { ok: true, credId: cred.id });
  assert.equal(r.headers.get('Set-Cookie'), null);
  const rec = JSON.parse(one(env, 'SELECT record FROM account_passkey WHERE credential_id = ?', cred.id).record);
  assert.deepEqual(Object.keys(rec), ['name', 'provider', 'aaguid', 'createdAt', 'lastUsedAt', 'credId', 'publicKey', 'signCount', 'uv']);
  assert.equal(rec.name, '我的手机');
  assert.equal(epochOf(env), 0);
  assert.equal((await (await post(env, 'keys', { action: 'passkey-add', cid: ch.cid, credential: cred }, c)).json()).error, 'challenge');
  const ch2 = await (await post(env, 'keys', { action: 'passkey-add-challenge' }, c)).json();
  const bad = await makeAttestationCredential(ch2.challenge, 'styrigx.com', 'https://evil.example');
  assert.equal((await (await post(env, 'keys', { action: 'passkey-add', cid: ch2.cid, credential: bad }, c)).json()).error, 'verify');
  assert.deepEqual(auditEvents(env), ['keys-passkey-add']);
});

test('passkey-delete：先轮换再删；本机重签；不存在 404；缺 credId 400；纪元推不动 → 503 epoch、钥匙还在', async () => {
  const env = makeEnv();
  const { credId } = await seedPasskey(env);
  assert.equal((await post(env, 'keys', { action: 'passkey-delete', credId: 'nope' }, await full())).status, 404);
  assert.equal((await post(env, 'keys', { action: 'passkey-delete' }, await full())).status, 400);
  const r = await post(env, 'keys', { action: 'passkey-delete', credId }, await full());
  assert.equal(r.status, 200);
  assert.equal(epochOf(env), 1);
  assert.ok(pickCookie(r, 'sgx-account-session'));
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM account_passkey').n, 0);
  assert.deepEqual(auditEvents(env), ['keys-passkey-delete']);
  const env2 = makeEnv();
  const k2 = await seedPasskey(env2);
  const ck = await full();
  env2.D1_ACCOUNT.raw.exec("CREATE TRIGGER no_bump BEFORE UPDATE ON account_epoch BEGIN SELECT RAISE(FAIL, 'down'); END");
  const x = await post(env2, 'keys', { action: 'passkey-delete', credId: k2.credId }, ck);
  assert.equal(x.status, 503);
  assert.equal((await x.json()).error, 'epoch');
  assert.equal(one(env2, 'SELECT COUNT(*) AS n FROM account_passkey').n, 1);
});

test('passkey-rename：去控制字符 / 首尾空格、限 40 字；空名 400；不存在 404；不轮换；审计 keys-passkey-rename', async () => {
  const env = makeEnv();
  const { credId } = await seedPasskey(env);
  const r = await post(env, 'keys', { action: 'passkey-rename', credId, name: '  ' + 'x'.repeat(50) + '\u0001 ' }, await full());
  assert.deepEqual(await r.json(), { ok: true, name: 'x'.repeat(40) });
  assert.equal(r.headers.get('Set-Cookie'), null);
  assert.equal((await post(env, 'keys', { action: 'passkey-rename', credId, name: ' \u0002 ' }, await full())).status, 400);
  assert.equal((await post(env, 'keys', { action: 'passkey-rename', credId: 'nope', name: 'a' }, await full())).status, 404);
  assert.equal(epochOf(env), 0);
  assert.deepEqual(auditEvents(env), ['keys-passkey-rename']);
  assert.ok(session.signingReady(env));
});
