/**
 * WebAuthn 依赖方红线（命名 v2 一律不动）：
 * - wrangler.toml 正式 SGX_RP_ID = "styrigx.com"、SGX_ORIGIN = "https://styrigx.com"（账号和网关两份）；rp.id 一变，所有通行密钥都失效
 * - 注册 challenge 的 rp.id === 'styrigx.com'、user.id = 账号 handle（沿用，不新建第二个）；登录 / 再验证 challenge 的 rpId === 'styrigx.com'
 * - 断言验证：rpIdHash 对不上、origin 对不上都拒
 *
 * 运行：node --test tests/workers/account/rp.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keys, makeEnv, post, full, seedPasskey, setHandles, assertion, one, resetTicket } from './_fixtures.mjs';

before(keys);
const REPO = new URL('../../../', import.meta.url).pathname;

test('wrangler.toml：账号和网关的 SGX_RP_ID / SGX_ORIGIN 钉死 styrigx.com', () => {
  for (const f of ['workers/account/wrangler.toml', 'workers/space-core/wrangler.toml']) {
    const toml = readFileSync(REPO + f, 'utf8');
    assert.match(toml, /^SGX_RP_ID = "styrigx\.com"$/m, f);
    assert.match(toml, /^SGX_ORIGIN = "https:\/\/styrigx\.com"$/m, f);
  }
});

test('注册 challenge（keys / reset）：rp.id === styrigx.com；user.id = 账号 handle 并沿用；user.name = AccountPasskey', async () => {
  const env = makeEnv();
  setHandles(env, 'HANDLE-original-bytes', 'LEGACY-original-bytes');
  const a = await seedPasskey(env);
  const j = await (await post(env, 'keys', { action: 'passkey-add-challenge' }, await full())).json();
  assert.equal(j.rp.id, 'styrigx.com');
  assert.equal(j.rpId, 'styrigx.com');
  assert.deepEqual([j.user.id, j.user.name, j.user.displayName, j.rp.name], ['HANDLE-original-bytes', 'AccountPasskey', 'Sloan Gray', 'Styrigx']);
  assert.deepEqual(j.excludeCredentials, [{ id: a.credId, type: 'public-key' }]);
  const r = await (await post(env, 'reset', { action: 'passkey-add-challenge' }, { 'sgx-account-reset': await resetTicket() })).json();
  assert.equal(r.rp.id, 'styrigx.com');
  assert.equal(r.user.id, 'HANDLE-original-bytes');
  assert.deepEqual(one(env, 'SELECT handle, legacy_handle FROM account_user_handle'), { handle: 'HANDLE-original-bytes', legacy_handle: 'LEGACY-original-bytes' }, 'handle 一个字节都没动');
});

test('登录 / 再验证 challenge：rpId === styrigx.com', async () => {
  const env = makeEnv();
  await seedPasskey(env);
  assert.equal((await (await post(env, 'session', { action: 'passkey-challenge' })).json()).rpId, 'styrigx.com');
  assert.equal((await (await post(env, 'reauth', { action: 'passkey-challenge' }, await full())).json()).rpId, 'styrigx.com');
});

test('断言：rpIdHash 不对（别的 RP 签的）/ origin 不对 → 403 verify，不签票', async () => {
  const env = makeEnv({ SGX_RP_ID: 'example.com' });
  const { kp, credId } = await seedPasskey(env);
  const ch = await (await post(env, 'session', { action: 'passkey-challenge' })).json();
  assert.equal(ch.rpId, 'example.com');
  const cred = await assertion(kp, credId, ch.challenge, null); /* 断言按 styrigx.com 的 rpIdHash 签 */
  const r = await post(env, 'session', { action: 'passkey', cid: ch.cid, credential: cred });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'verify');
  const env2 = makeEnv({ SGX_ORIGIN: 'https://other.example' });
  const k2 = await seedPasskey(env2);
  const ch2 = await (await post(env2, 'session', { action: 'passkey-challenge' })).json();
  const r2 = await post(env2, 'session', { action: 'passkey', cid: ch2.cid, credential: await assertion(k2.kp, k2.credId, ch2.challenge, null) });
  assert.equal((await r2.json()).error, 'verify');
  assert.equal(r2.headers.get('Set-Cookie'), null);
});
