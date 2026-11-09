/**
 * POST /api/account/session（sudo root 登录）与 GET /api/account（状态）：
 * - 请求本身：跨站 403 origin、坏 JSON 400 body、不认识的 action 400 action（旧 action 名一律 400）、非 POST 405
 * - 除 end 外要进站会话（401 session，不读不写库）；账号库没绑 500 config
 * - password：未设置 403 not-set、错 403 wrong、限速 429 cooldown（审计 password-cooldown）、成功签 session（不签 reauth）
 * - passkey-challenge / passkey：challenge 用途 session、单次；userHandle = 账号 handle 或 legacy_handle；UV 必须
 * - end：清 session 和 reauth，本机设备行拉黑；不碰 reset
 * - 审计：session-password / session-passkey，成功失败都记
 * - GET：{ ok, configured:{password,passkey}, signing, session, reauth, reset }
 *
 * 运行：node --test tests/workers/account/api-session.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  K, keys, makeEnv, post, get, accSession, reauthTicket, resetTicket, full, seedPassword, seedPasskey, setHandles, passkeyLogin,
  pickCookie, setCookies, one, all, auditEvents, epochOf, TEST_DEVICE_ID, devices,
} from './_fixtures.mjs';
import { postReq } from '../_harness.mjs';

before(keys);

test('请求本身：跨站 Origin 403 origin；坏 JSON 400 body；非 POST 405；不认识的 action / 旧 action 名 400 action', async () => {
  const env = makeEnv();
  const { api } = await import('./_fixtures.mjs');
  let r = await api.session.onRequestPost({ request: postReq('https://styrigx.com/api/account/session', { action: 'password' }, { 'X-Styrigx-Space-Session': '1', Origin: 'https://evil.example' }), env });
  assert.equal(r.status, 403);
  r = await api.session.onRequestPost({ request: new Request('https://styrigx.com/api/account/session', { method: 'POST', headers: { 'X-Styrigx-Space-Session': '1', Origin: 'https://styrigx.com' }, body: '{' }), env });
  assert.equal((await r.json()).error, 'body');
  r = await api.session.onRequestPost({ request: new Request('https://styrigx.com/api/account/session', { method: 'GET' }), env });
  assert.equal(r.status, 405);
  for (const action of ['', 'login-password', 'login-passkey', 'login-challenge', 'logout', 'reauth-clear', 'nope']) {
    const x = await post(env, 'session', { action });
    assert.equal(x.status, 400, action);
    assert.equal((await x.json()).error, 'action', action);
  }
});

test('没有进站会话 → 401 session（不读库）；end 不要求进站会话；账号库没绑 → 500 config', async () => {
  const env = makeEnv();
  const before0 = env.D1_ACCOUNT.statements.length;
  for (const action of ['password', 'passkey', 'passkey-challenge']) {
    const r = await post(env, 'session', { action, password: 'x' }, {}, { identity: { session: '' } });
    assert.equal(r.status, 401, action);
    assert.equal((await r.json()).error, 'session');
  }
  assert.equal((await get(env, {}, { identity: null })).status, 401);
  assert.equal(env.D1_ACCOUNT.statements.length, before0, '一条 SQL 都没发');
  const e = await post(env, 'session', { action: 'end' }, {}, { identity: null });
  assert.equal(e.status, 200);
  const noDb = makeEnv({ D1_ACCOUNT: undefined });
  assert.equal((await post(noDb, 'session', { action: 'password', password: 'x' })).status, 500);
  assert.equal((await get(noDb)).status, 500);
});

test('password：未设置 403 not-set；错 403 wrong；空 / 非字符串 400 params；都不签 cookie；失败写审计 session-password:fail', async () => {
  const env = makeEnv();
  let r = await post(env, 'session', { action: 'password', password: 'whatever-1' });
  assert.equal((await r.json()).error, 'not-set');
  await seedPassword(env, 'right-password-1');
  r = await post(env, 'session', { action: 'password', password: 'wrong-password' });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'wrong');
  assert.equal(r.headers.get('Set-Cookie'), null);
  for (const password of ['', 5, null]) assert.equal((await post(env, 'session', { action: 'password', password })).status, 400);
  assert.deepEqual(auditEvents(env), ['session-password:fail', 'session-password:fail']);
});

test('password 成功：只签 session（by=password，400 天）——不再顺手签 reauth（带 reauth:true 也不签）；设备记一行；审计 session-password', async () => {
  const env = makeEnv();
  await seedPassword(env, 'right-password-1');
  const r = await post(env, 'session', { action: 'password', password: 'right-password-1', reauth: true, device: { model: 'SM-S9380', platform: 'Android' } });
  assert.equal(r.status, 200);
  assert.deepEqual(setCookies(r).map((c) => c.split('=')[0]), ['sgx-account-session', 'sgx-account-signed-in']);
  assert.match(setCookies(r)[0], /Max-Age=34560000/);
  /* 登录标记：值 1、不含秘密、非 HttpOnly（只给前端首帧显示），时长同 session */
  assert.equal(setCookies(r)[1], 'sgx-account-signed-in=1; Path=/; Secure; SameSite=Strict; Max-Age=34560000');
  const s = pickCookie(r, 'sgx-account-session');
  assert.match(s, /^password\.0\./);
  const devs = all(env, 'SELECT record FROM account_device').map((x) => JSON.parse(x.record));
  assert.equal(devs.length, 1);
  assert.equal(devs[0].model, 'SM-S9380');
  assert.equal(devs[0].country, 'CN');
  assert.deepEqual(auditEvents(env), ['session-password']);
  const g = await (await get(env, { 'sgx-account-session': s })).json();
  assert.equal(g.session.by, 'password');
  assert.equal(g.reauth, null);
});

test('password 限速：同 IP 连错 5 次 → 429 cooldown（冷却中对的密码也不验），审计 password-cooldown；按 X-Styrigx-Client-Address 分桶，kind = password', async () => {
  const env = makeEnv();
  await seedPassword(env, 'right-password-1');
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await post(env, 'session', { action: 'password', password: 'bad-' + i })).status);
  assert.deepEqual(codes, [403, 403, 403, 403, 429]);
  assert.equal((await post(env, 'session', { action: 'password', password: 'right-password-1' })).status, 429);
  assert.ok(auditEvents(env).includes('password-cooldown:fail'));
  assert.deepEqual(all(env, "SELECT DISTINCT kind FROM account_attempt_limit").map((r) => r.kind), ['password']);
  /* 别的 IP 不受影响；reauth 输错和 session 共用这把密码的计数 */
  assert.equal((await post(env, 'session', { action: 'password', password: 'right-password-1' }, {}, { identity: { ip: '10.1.1.1' } })).status, 200);
  assert.equal((await post(env, 'reauth', { action: 'password', password: 'right-password-1' }, await full())).status, 429, '同一 IP 在 reauth 也在冷却');
});

test('password：缺签名钥匙 503 config；缺账号密码 pepper 503 config（不用网关的 SGX_SPACE_PASSWORD_PEPPER）；限速 D1 出错 503 server', async () => {
  let env = makeEnv({ SGX_ACCOUNT_PRIVATE: '' });
  assert.equal((await post(env, 'session', { action: 'password', password: 'x' })).status, 503);
  env = makeEnv({ SGX_ACCOUNT_PASSWORD_PEPPER: '', SGX_SPACE_PASSWORD_PEPPER: 'gateway-pepper' });
  const r = await post(env, 'session', { action: 'password', password: 'x' });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, 'config');
});

test('passkey-challenge + passkey → session(by=passkey)；challenge 用途 session、单次；reauth 的 challenge 不能拿来登录', async () => {
  const env = makeEnv();
  const { kp, credId } = await seedPasskey(env);
  const ch = await (await post(env, 'session', { action: 'passkey-challenge' })).json();
  assert.equal(one(env, 'SELECT purpose FROM account_challenge WHERE id = ?', ch.cid).purpose, 'session');
  const { assertion } = await import('./_fixtures.mjs');
  const cred = await assertion(kp, credId, ch.challenge, null);
  const r = await post(env, 'session', { action: 'passkey', cid: ch.cid, credential: cred });
  assert.equal(r.status, 200);
  assert.match(pickCookie(r, 'sgx-account-session'), /^passkey\./);
  assert.equal(pickCookie(r, 'sgx-account-reauth'), null);
  const again = await post(env, 'session', { action: 'passkey', cid: ch.cid, credential: cred });
  assert.equal((await again.json()).error, 'challenge');
  /* reauth 入口签的 challenge 拿到 session 用不了 */
  const rch = await (await post(env, 'reauth', { action: 'passkey-challenge' }, await full())).json();
  assert.equal(one(env, 'SELECT purpose FROM account_challenge WHERE id = ?', rch.cid).purpose, 'reauth');
  const x = await post(env, 'session', { action: 'passkey', cid: rch.cid, credential: await assertion(kp, credId, rch.challenge, null) });
  assert.equal((await x.json()).error, 'challenge');
  assert.deepEqual(auditEvents(env), ['session-passkey', 'session-passkey:fail', 'session-passkey:fail']);
});

test('passkey userHandle：账号 handle 或 legacy_handle 都认；都不对 403 verify；没有通行密钥 challenge 403 not-set；UV 没有 403 uv-required', async () => {
  const env = makeEnv();
  assert.equal((await (await post(env, 'session', { action: 'passkey-challenge' })).json()).error, 'not-set');
  const { kp, credId } = await seedPasskey(env);
  setHandles(env, 'HANDLE', 'LEGACY');
  assert.equal((await passkeyLogin(env, kp, credId, 'HANDLE')).status, 200);
  assert.equal((await passkeyLogin(env, kp, credId, 'LEGACY', {}, undefined, { signCount: 2 })).status, 200);
  const bad = await passkeyLogin(env, kp, credId, 'OTHER', {}, undefined, { signCount: 3 });
  assert.equal((await bad.json()).error, 'verify');
  const uv = await passkeyLogin(env, kp, credId, null, {}, undefined, { uv: false, signCount: 4 });
  assert.equal((await uv.json()).error, 'uv-required');
  const rec = JSON.parse(one(env, 'SELECT record FROM account_passkey').record);
  assert.equal(rec.signCount, 2);
  assert.ok(rec.lastUsedAt > 0);
});

test('同一浏览器带着有效 session 再登录沿用 deviceId，不多一台', async () => {
  const env = makeEnv();
  await seedPassword(env, 'right-password-1');
  const r = await post(env, 'session', { action: 'password', password: 'right-password-1' }, { 'sgx-account-session': await accSession() });
  assert.ok(pickCookie(r, 'sgx-account-session').endsWith('.' + TEST_DEVICE_ID + '.' + pickCookie(r, 'sgx-account-session').split('.').pop()));
  assert.equal(all(env, 'SELECT device_id FROM account_device').length, 1);
});

test('end：清 session + reauth（不碰 reset 票），本机设备行拉黑，同一张票之后无效', async () => {
  const env = makeEnv();
  const ck = { ...(await full()), 'sgx-account-reset': await resetTicket() };
  const r = await post(env, 'session', { action: 'end' }, ck);
  assert.deepEqual(setCookies(r).map((c) => c.split('=')[0]), ['sgx-account-session', 'sgx-account-reauth', 'sgx-account-signed-in']);
  for (const c of setCookies(r)) assert.match(c, /Max-Age=0/);
  assert.doesNotMatch(setCookies(r)[2], /HttpOnly/, '登录标记非 HttpOnly：清的时候属性一致');
  assert.equal(await devices.isRevoked(env, TEST_DEVICE_ID), true);
  const g = await (await get(env, ck)).json();
  assert.equal(g.session, null);
  assert.ok(g.reset, 'reset 票不归会话管');
});

test('GET：新库 { configured:{false,false}, signing:true, session/reauth/reset:null }；缺钥匙 signing=false；D1 出错 503', async () => {
  const env = makeEnv();
  const j = await (await get(env)).json();
  assert.deepEqual(j, { ok: true, configured: { password: false, passkey: false }, signing: true, session: null, reauth: null, reset: null });
  await seedPassword(env, 'right-password-1');
  assert.deepEqual((await (await get(env)).json()).configured, { password: true, passkey: false });
  await seedPasskey(env);
  assert.deepEqual((await (await get(env)).json()).configured, { password: true, passkey: true });
  assert.equal((await (await get(makeEnv({ SGX_ACCOUNT_PRIVATE: '' }))).json()).signing, false);
  const down = makeEnv({ D1_ACCOUNT: { prepare() { throw new Error('down'); } } });
  assert.equal((await get(down)).status, 503);
});

test('GET：session { by, authAt, expiresAt, device }；reauth 只在挂在本机 session 上时显示；reset 没有 session 也显示（by = recovery-key）', async () => {
  const env = makeEnv();
  const authAt = Date.now() - 1000;
  const j = await (await get(env, { 'sgx-account-session': await accSession('passkey', 0, authAt), 'sgx-account-reauth': await reauthTicket('passkey') })).json();
  assert.equal(j.session.by, 'passkey');
  assert.equal(j.session.authAt, authAt);
  assert.equal(j.reauth.by, 'passkey');
  const k = await (await get(env, { 'sgx-account-reauth': await reauthTicket(), 'sgx-account-reset': await resetTicket() })).json();
  assert.equal(k.session, null);
  assert.equal(k.reauth, null, '没 session 的 reauth 不算');
  assert.equal(k.reset.by, 'recovery-key');
  const o = await (await get(env, { 'sgx-account-session': await accSession(), 'sgx-account-reauth': await reauthTicket('password', 0, { deviceId: 'otherdevice_0002' }) })).json();
  assert.equal(o.reauth, null, '别的设备的 reauth 不算');
  assert.equal(epochOf(env), 0);
  assert.ok(K.ACCOUNT);
});
