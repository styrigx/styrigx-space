/**
 * POST /api/account/reset（sudo root reset）拿到 reset 票以后（core/reset.js finishReset 等）：
 * - 只认 reset 票（没有 / reauth 票 / 只有 session → 401 reset，带 reason）；end 只清 reset 票
 * - password-set / passkey-list / passkey-add-challenge / passkey-add / passkey-delete：都不碰会话（不推纪元、不删设备行）
 * - 账号没配置时 reset 是唯一入口：设第一把凭证后正常登录
 * - finish { signOut }：all / others / none；三种都让 reset 纪元 +1（票用完即废）、清 reset cookie、审计 reset-finish-<值>
 * - 和会话互不顶替：reset 票进不了 /api/account/keys（reauth 票也进不了 /api/account/reset）
 *
 * 运行：node --test tests/workers/account/reset.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  keys, makeEnv, post, get, accSession, reauthTicket, resetTicket, full, seedPassword, seedPasskey, makeAttestationCredential,
  pickCookie, setCookies, auditEvents, epochOf, all, one, TEST_DEVICE_ID, devices, RECOVERY_KEY,
} from './_fixtures.mjs';

before(keys);
const X = async (epoch = 0) => ({ 'sgx-account-reset': await resetTicket(epoch) });
const seedDevices = async (env) => {
  for (const id of [TEST_DEVICE_ID, 'otherdevice_0002', 'otherdevice_0003']) await devices.putDevice(env, { deviceId: id, by: 'password', lastSeen: Date.now() });
};
const devIds = (env) => all(env, 'SELECT device_id FROM account_device WHERE revoked_at = 0 ORDER BY device_id').map((r) => r.device_id);

test('只认 reset 票：没有 / reauth 票 / 只有 session → 401 reset（带 reason）；旧 action 名 400；end 只清 reset 票', async () => {
  const env = makeEnv();
  for (const ck of [{}, await full(), { 'sgx-account-session': await accSession() }]) {
    const r = await post(env, 'reset', { action: 'password-set', password: 'new-password-1' }, ck);
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error, 'reset');
  }
  for (const action of ['root-reset', 'reset-finish', 'password-change', 'passkey-register', 'passkey-rename', 'audit-list']) {
    assert.equal((await post(env, 'reset', { action }, await X())).status, 400, action);
  }
  const e = await post(env, 'reset', { action: 'end' }, { ...(await full()), ...(await X()) }, { identity: null });
  assert.deepEqual(setCookies(e).map((c) => c.split('=')[0]), ['sgx-account-reset']);
});

test('账号没配置：恢复密钥 → reset → 设第一把密码 → 正常登录（session 只能从 /session 拿）', async () => {
  const env = makeEnv();
  const r = await post(env, 'reset', { action: 'recovery-key', key: RECOVERY_KEY });
  const ck = { 'sgx-account-reset': pickCookie(r, 'sgx-account-reset') };
  const p = await post(env, 'reset', { action: 'password-set', password: 'first-password-1' }, ck);
  assert.deepEqual(await p.json(), { ok: true, changed: false });
  assert.equal(p.headers.get('Set-Cookie'), null, '不签会话');
  const s = await post(env, 'session', { action: 'password', password: 'first-password-1' });
  assert.equal(s.status, 200);
  assert.deepEqual(auditEvents(env), ['reset-recovery-key', 'reset-password-set', 'session-password']);
});

test('reset 下改凭证不碰会话：password-set（已有密码）/ passkey-delete / passkey-add 都不推纪元、不删设备行、不发 cookie', async () => {
  const env = makeEnv();
  await seedPassword(env, 'old-password-1');
  const { credId } = await seedPasskey(env);
  await seedDevices(env);
  const p = await post(env, 'reset', { action: 'password-set', password: 'new-password-1' }, await X());
  assert.deepEqual(await p.json(), { ok: true, changed: true });
  const d = await post(env, 'reset', { action: 'passkey-delete', credId }, await X());
  assert.equal(d.status, 200);
  const ch = await (await post(env, 'reset', { action: 'passkey-add-challenge' }, await X())).json();
  assert.equal(one(env, 'SELECT purpose FROM account_challenge WHERE id = ?', ch.cid).purpose, 'reset-add');
  const cred = await makeAttestationCredential(ch.challenge, 'styrigx.com', 'https://styrigx.com');
  const a = await post(env, 'reset', { action: 'passkey-add', cid: ch.cid, credential: cred, name: 'new' }, await X());
  assert.deepEqual(await a.json(), { ok: true, credId: cred.id });
  for (const r of [p, d, a]) assert.equal(r.headers.get('Set-Cookie'), null);
  assert.equal(epochOf(env, 'session'), 0);
  assert.equal(epochOf(env, 'reset'), 0);
  assert.equal(devIds(env).length, 3);
  const list = await (await post(env, 'reset', { action: 'passkey-list' }, await X())).json();
  assert.deepEqual(list.keys.map((k) => k.credId), [cred.id]);
  assert.equal(list.userName, 'AccountPasskey');
  assert.deepEqual(auditEvents(env), ['reset-password-set', 'reset-passkey-delete', 'reset-passkey-add']);
  /* 新密码能登录、旧的不行 */
  assert.equal((await post(env, 'session', { action: 'password', password: 'old-password-1' })).status, 403);
  assert.equal((await post(env, 'session', { action: 'password', password: 'new-password-1' })).status, 200);
});

test('finish：signOut 不对 400 params；没有 reset 票 401 reset', async () => {
  const env = makeEnv();
  for (const signOut of [undefined, '', 'All', 'everyone', true]) assert.equal((await post(env, 'reset', { action: 'finish', signOut }, await X())).status, 400, String(signOut));
  assert.equal((await post(env, 'reset', { action: 'finish', signOut: 'all' }, await full())).status, 401);
});

test('finish others（本机已登录）：session 纪元 +1、本机按原 by/authAt 重签、删其他设备行、清本机 reauth 和 reset；回登出台数；审计 reset-finish-others', async () => {
  const env = makeEnv();
  await seedDevices(env);
  const authAt = Date.now() - 9000;
  const ck = { 'sgx-account-session': await accSession('passkey', 0, authAt), 'sgx-account-reauth': await reauthTicket('passkey'), ...(await X()) };
  const r = await post(env, 'reset', { action: 'finish', signOut: 'others' }, ck);
  assert.deepEqual(await r.json(), { ok: true, signOut: 'others', signedOut: 2 });
  assert.equal(epochOf(env, 'session'), 1);
  assert.equal(epochOf(env, 'reset'), 1);
  const s = pickCookie(r, 'sgx-account-session');
  assert.match(s, new RegExp('^passkey\\.1\\.' + authAt + '\\.'));
  const cleared = setCookies(r).filter((c) => /Max-Age=0/.test(c)).map((c) => c.split('=')[0]);
  assert.deepEqual(cleared.sort(), ['sgx-account-reauth', 'sgx-account-reset']);
  assert.deepEqual(devIds(env), [TEST_DEVICE_ID]);
  assert.deepEqual(auditEvents(env), ['reset-finish-others']);
  const again = await post(env, 'reset', { action: 'password-set', password: 'x-password-1' }, ck);
  assert.equal((await again.json()).reason, 'epoch-changed', '这张 reset 票用完即废');
});

test('finish others（本机没登录）= all：纪元 +1、全部设备行删掉、不签 session', async () => {
  const env = makeEnv();
  await seedDevices(env);
  const r = await post(env, 'reset', { action: 'finish', signOut: 'others' }, await X());
  assert.deepEqual(await r.json(), { ok: true, signOut: 'others', signedOut: 3 });
  assert.equal(pickCookie(r, 'sgx-account-session'), '');
  assert.deepEqual(devIds(env), []);
});

test('finish all（本机已登录）：纪元 +1、不重签、清本机 session + reauth + reset、删全部设备行；审计 reset-finish-all', async () => {
  const env = makeEnv();
  await seedDevices(env);
  const ck = { ...(await full()), ...(await X()) };
  const r = await post(env, 'reset', { action: 'finish', signOut: 'all' }, ck);
  assert.deepEqual(await r.json(), { ok: true, signOut: 'all', signedOut: 3 });
  for (const c of setCookies(r)) assert.match(c, /Max-Age=0/);
  assert.deepEqual(setCookies(r).map((c) => c.split('=')[0]).sort(), ['sgx-account-reauth', 'sgx-account-reset', 'sgx-account-session', 'sgx-account-signed-in']);
  assert.deepEqual(devIds(env), []);
  assert.equal((await (await get(env, ck)).json()).session, null);
  assert.deepEqual(auditEvents(env), ['reset-finish-all']);
});

test('finish none：会话一律不动（session 纪元、设备行、cookie），只让 reset 票作废并清掉；审计 reset-finish-none', async () => {
  const env = makeEnv();
  await seedDevices(env);
  const ck = { ...(await full()), ...(await X()) };
  const r = await post(env, 'reset', { action: 'finish', signOut: 'none' }, ck);
  assert.deepEqual(await r.json(), { ok: true, signOut: 'none', signedOut: 0 });
  assert.equal(epochOf(env, 'session'), 0);
  assert.equal(epochOf(env, 'reset'), 1);
  assert.deepEqual(setCookies(r).map((c) => c.split('=')[0]), ['sgx-account-reset']);
  assert.equal(devIds(env).length, 3);
  assert.ok((await (await get(env, ck)).json()).session);
  assert.deepEqual(auditEvents(env), ['reset-finish-none']);
});

test('互不顶替：reset 票进不了 /api/account/keys（401 account）；session + reset 票也不算 reauth（403 reauth）', async () => {
  const env = makeEnv();
  await seedPassword(env, 'old-password-1');
  let r = await post(env, 'keys', { action: 'password-set', password: 'new-password-1' }, await X());
  assert.equal((await r.json()).error, 'account');
  r = await post(env, 'keys', { action: 'password-set', password: 'new-password-1' }, { 'sgx-account-session': await accSession(), ...(await X()) });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'reauth');
  r = await post(env, 'devices', { action: 'revoke-all' }, { 'sgx-account-session': await accSession(), ...(await X()) });
  assert.equal((await r.json()).error, 'reauth');
});

test('passkey-delete：不存在 404 not-found；缺 credId 400 params', async () => {
  const env = makeEnv();
  assert.equal((await post(env, 'reset', { action: 'passkey-delete', credId: 'nope' }, await X())).status, 404);
  assert.equal((await post(env, 'reset', { action: 'passkey-delete' }, await X())).status, 400);
});
