/**
 * POST /api/account/reauth（sudo root reauth）：
 * - 要进站会话 + 有效 session（401 account，带 reason）；end 只清 reauth（不要求进站会话）
 * - password / passkey 成功签 3 分钟 reauth 票（带本机 deviceId）；不签 session、session 的 by / authAt 不变
 * - challenge 用途 reauth（session 的 challenge 不通用）；审计 reauth-password / reauth-passkey（成功失败都记）
 * - reset 票不算 session（只有 reset 票 → 401 account）
 *
 * 运行：node --test tests/workers/account/api-reauth.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  keys, makeEnv, post, get, accSession, resetTicket, full, seedPassword, seedPasskey, passkeyLogin, assertion,
  pickCookie, setCookies, auditEvents, TEST_DEVICE_ID, one,
} from './_fixtures.mjs';

before(keys);
const sess = async (o) => ({ 'sgx-account-session': await accSession('passkey', 0, Date.now() - 60000, o) });

test('没有有效 session → 401 account（带 reason）；只有 reset 票也不行；没进站会话 401 session', async () => {
  const env = makeEnv();
  await seedPassword(env, 'right-password-1');
  let r = await post(env, 'reauth', { action: 'password', password: 'right-password-1' });
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { ok: false, error: 'account', reason: 'no-cookie' });
  r = await post(env, 'reauth', { action: 'password', password: 'right-password-1' }, { 'sgx-account-reset': await resetTicket() });
  assert.equal((await r.json()).error, 'account');
  r = await post(env, 'reauth', { action: 'password', password: 'right-password-1' }, await sess(), { identity: { session: '' } });
  assert.equal((await r.json()).error, 'session');
  assert.equal((await post(env, 'reauth', { action: 'reauth-clear' }, await sess())).status, 400);
});

test('password 成功：签 reauth（3 分钟、带本机 deviceId），不签 session；GET reauth.expiresAt ≈ 3 分钟后；审计 reauth-password', async () => {
  const env = makeEnv();
  await seedPassword(env, 'right-password-1');
  const ck = await sess();
  const r = await post(env, 'reauth', { action: 'password', password: 'right-password-1' }, ck);
  assert.equal(r.status, 200);
  assert.deepEqual(setCookies(r).map((c) => c.split('=')[0]), ['sgx-account-reauth']);
  assert.match(setCookies(r)[0], /Max-Age=180/);
  const t = pickCookie(r, 'sgx-account-reauth');
  assert.match(t, new RegExp('^password\\.0\\.\\d+\\.\\d+\\.' + TEST_DEVICE_ID + '\\.'));
  const g = await (await get(env, { ...ck, 'sgx-account-reauth': t })).json();
  assert.equal(g.session.by, 'passkey', 'session 的 by 不变');
  assert.ok(Math.abs(g.reauth.expiresAt - (Date.now() + 180000)) < 5000);
  assert.deepEqual(auditEvents(env), ['reauth-password']);
  const w = await post(env, 'reauth', { action: 'password', password: 'nope-nope' }, ck);
  assert.equal((await w.json()).error, 'wrong');
  assert.deepEqual(auditEvents(env), ['reauth-password', 'reauth-password:fail']);
});

test('passkey：challenge 用途 reauth；成功签 reauth(by=passkey)；session 的 challenge 拿来 reauth 不行', async () => {
  const env = makeEnv();
  const { kp, credId } = await seedPasskey(env);
  const ck = await sess();
  const r = await passkeyLogin(env, kp, credId, null, {}, ck, undefined, 'reauth');
  assert.equal(r.status, 200);
  assert.match(pickCookie(r, 'sgx-account-reauth'), /^passkey\./);
  assert.equal(pickCookie(r, 'sgx-account-session'), null);
  const sch = await (await post(env, 'session', { action: 'passkey-challenge' })).json();
  const x = await post(env, 'reauth', { action: 'passkey', cid: sch.cid, credential: await assertion(kp, credId, sch.challenge, null, { signCount: 5 }) }, ck);
  assert.equal((await x.json()).error, 'challenge');
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM account_challenge WHERE purpose = ?', 'reauth').n, 0, '用掉的删了');
  assert.deepEqual(auditEvents(env), ['reauth-passkey', 'reauth-passkey:fail']);
});

test('end：只清 reauth（不碰 session、reset），不要求进站会话', async () => {
  const env = makeEnv();
  const r = await post(env, 'reauth', { action: 'end' }, { ...(await full()), 'sgx-account-reset': await resetTicket() }, { identity: null });
  assert.equal(r.status, 200);
  assert.deepEqual(setCookies(r).map((c) => c.split('=')[0]), ['sgx-account-reauth']);
});

test('缺签名钥匙 → 503 config；缺 RP → passkey 503 config', async () => {
  const env = makeEnv({ SGX_ACCOUNT_PRIVATE: '' });
  const r0 = await post(env, 'reauth', { action: 'password', password: 'x' }, await sess());
  assert.equal(r0.status, 503, '验 session 只要公钥；签不出 reauth → 503 config（先于比对密码）');
  assert.equal((await r0.json()).error, 'config');
  const env2 = makeEnv({ SGX_RP_ID: '' });
  await seedPasskey(env2);
  const r = await post(env2, 'reauth', { action: 'passkey-challenge' }, await sess());
  assert.equal(r.status, 503);
});
