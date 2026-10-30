/**
 * 最后一把锁屏凭证（账号拆分 PR3，方案第 2 节、第 15 节 U3）。
 *
 * - 锁屏凭证任何时候都不许删到 0（403 last-key）：网关读不到账号凭证，不再按「账号是否已配置」放行。
 * - lock-entry 只回锁屏自己的 passkey / password，不再有 resetOnly / accountConfigured；
 *   realm='account' 的行（正式网关库 PR4 已删，这里故意摆一行）不算锁屏凭证，网关也不读。
 * - 空站（无任何锁屏凭证）→ passkey / password 都是 false（A 启动流程保留，根凭证代开入口仍显示）。
 * - 网关运行时不碰 KV（生产残留 layer:lock-emptied 不读不写）。
 *
 * 运行：node --test tests/workers/auth-gateway/last-key.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { testLockSession, testTicket } from './_tickets.mjs';
import { makeKV, genKeyPair, postReq, authD1For } from '../_harness.mjs';

let LOCK_PRIV = '', LOCK_PUB = '';
const envFor = (kv, extra = {}) => ({
  D1_LOCK_AUTH: authD1For(kv),
  SGX_LOCK_PRIVATE: LOCK_PRIV,
  SGX_LOCK_PUBLIC: LOCK_PUB,
  SGX_RP_ID: 'styrigx.com',
  SGX_ORIGIN: 'https://styrigx.com',
  SGX_PW_PEPPER: 'test-pepper',
  ...extra,
});

/** 直接写 D1（kv 只当作这份 D1 替身的钥匙，网关不读 KV）；realm 'account' = 拆分前遗留的账号行 */
function seedKey(kv, credId, realm) {
  authD1For(kv).putPasskey(realm, {
    name: 'test', provider: '', aaguid: '', createdAt: 1, lastUsedAt: 0,
    credId, publicKey: {}, signCount: 0, uv: 1,
  });
}
async function seedPw(kv, realm, password) {
  const { makePasswordRecord } = await import('../../../workers/auth-gateway/functions/_kernel/lib/password.js');
  authD1For(kv).putPassword(realm, await makePasswordRecord(password, 'test-pepper'));
}
/** admin 锁屏会话 + LockReauthTicket（进锁屏凭证管理的门） */
async function manageCookie() {
  const sess = await testLockSession(LOCK_PRIV, 0, 'admin', 'password');
  const reauth = await testTicket(LOCK_PRIV, 'LockReauthTicket', 'password', 0);
  return 'sgx-lock-session=' + sess + '; sgx-lock-reauth=' + reauth;
}

before(async () => {
  ({ priv: LOCK_PRIV, pub: LOCK_PUB } = await genKeyPair());
});

test('lock-entry：只有遗留的账号凭证、没有锁屏凭证 → passkey / password 都是 false；不再返回 resetOnly / accountConfigured', async () => {
  const { onRequestGet } = await import('../../../workers/auth-gateway/functions/api/lock-entry.js');
  const kv = makeKV({ 'layer:lock-emptied': '1' }); /* 生产 KV 里的残留：网关运行时不读 KV */
  await seedPw(kv, 'account', 'account-password-123');
  seedKey(kv, 'acct-key-0001', 'account');
  const res = await onRequestGet({ env: envFor(kv) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, passkey: false, password: false });
  assert.deepEqual(kv._calls, { get: 0, put: 0, delete: 0, list: 0 }, '网关运行时一次都没碰 KV');
});

test('lock-entry：有锁屏密码 → password=true、passkey=false；空站 → 两个 false；没绑锁屏库 → 按已配置（两个 true）', async () => {
  const { onRequestGet } = await import('../../../workers/auth-gateway/functions/api/lock-entry.js');
  const kv = makeKV();
  await seedPw(kv, 'lock', 'lock-password-1234');
  assert.deepEqual(await (await onRequestGet({ env: envFor(kv) })).json(), { ok: true, passkey: false, password: true });
  assert.deepEqual(await (await onRequestGet({ env: envFor(makeKV()) })).json(), { ok: true, passkey: false, password: false });
  assert.deepEqual(await (await onRequestGet({ env: {} })).json(), { ok: true, passkey: true, password: true });
  const broken = makeKV();
  authD1For(broken).failOn = () => true;
  assert.deepEqual(await (await onRequestGet({ env: envFor(broken) })).json(), { ok: true, passkey: true, password: true }, '读失败按已配置');
});

test('删最后一把锁屏通行密钥（没有锁屏密码）→ 403 last-key，即使库里有遗留的账号凭证；钥匙还在', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/lock-passkey.js');
  const kv = makeKV();
  seedKey(kv, 'lock-key-0001', 'lock');
  await seedPw(kv, 'account', 'account-password-123');
  seedKey(kv, 'acct-key-0001', 'account');
  const res = await onRequestPost({
    request: postReq('https://styrigx.com/api/lock-passkey', { action: 'delete', credId: 'lock-key-0001' }, { Cookie: await manageCookie() }),
    env: envFor(kv),
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'last-key');
  assert.ok(authD1For(kv).passkey('lock', 'lock-key-0001'), '没删');
});

test('删锁屏密码且没有锁屏通行密钥 → 403 last-key（即使库里有遗留的账号凭证）；有锁屏通行密钥时可删', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/lock-password.js');
  const kv = makeKV();
  await seedPw(kv, 'lock', 'lock-password-1234');
  await seedPw(kv, 'account', 'account-password-123');
  const res = await onRequestPost({
    request: postReq('https://styrigx.com/api/lock-password', { action: 'remove' }, { Cookie: await manageCookie() }),
    env: envFor(kv),
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'last-key');
  assert.ok(authD1For(kv).rows('password').some((r) => r.realm === 'lock'), '锁屏密码还在');

  const kv2 = makeKV();
  await seedPw(kv2, 'lock', 'lock-password-1234');
  seedKey(kv2, 'lock-key-0002', 'lock');
  const res2 = await onRequestPost({
    request: postReq('https://styrigx.com/api/lock-password', { action: 'remove' }, { Cookie: await manageCookie() }),
    env: envFor(kv2),
  });
  assert.equal(res2.status, 200, await res2.clone().text());
  assert.equal(authD1For(kv2).rows('password').some((r) => r.realm === 'lock'), false, '有通行密钥兜底时删掉');
});
