/**
 * 账号 Worker 命名入口（workers/account/src/entrypoints.js、worker.js；账号拆分 PR2c）：
 * - worker.js：默认导出 = index.js 的 default（公开路由行为不变），另导出 AccountService / AccountVerifier
 * - AccountService：只信网关转发来的身份头（白名单校验，复用 identity/account.js readLockIdentity），不问 AUTH；
 *   路由 = 现有三条 + /api/account；门（gate.js）结论同默认 fetch
 * - 信任边界：同名 x-styrigx-* 头打到默认 fetch 不起作用（会话照旧问网关 AuthVerifier），默认 fetch 没有 /api/account；
 *   AccountService 无条件信任这些头，前提是网关剥掉入站同名头（方案第 3 节第一道保险，PR3）
 * - AccountVerifier.accountSession(cookieHeader, clientContext)：正反例，只验不签
 *
 * 运行：node --test tests/workers/account/account-entrypoints.test.mjs
 */
import './_cf-workers.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { gatewayVerifier } from './_auth.mjs';
import { testLockSession } from '../auth-gateway/_tickets.mjs';
import { genKeyPair, withAuthD1, postReq } from '../_harness.mjs';
import { makeAccountD1 } from './_d1.mjs';
import { K, keys, idHeaders, accSession, seedPassword, setEpoch, one, PEPPER, ROOT_KEY, TEST_DEVICE_ID, pickCookie } from './_identity.mjs';

const SRC = '../../../workers/account/src/';
const { WorkerEntrypoint } = await import('cloudflare:workers');
const index = await import(SRC + 'index.js');
const worker = await import(SRC + 'worker.js');
const ep = await import(SRC + 'entrypoints.js');
const { _resetSecretCache } = await import(SRC + 'secrets.js');

await keys();
const { priv: LOCK_PRIV, pub: LOCK_PUB } = await genKeyPair();
const CTX = { waitUntil() {} };
const ORIGIN = 'https://styrigx.com';

beforeEach(() => _resetSecretCache());

/** 账号 Worker env：账号库（三个绑定同一个库）+ 账号钥匙；AUTH 默认是会记调用的网关替身 */
function makeEnv(over = {}) {
  const db = makeAccountD1();
  const calls = [];
  const gw = gatewayVerifier(withAuthD1({ SGX_LOCK_PUBLIC: LOCK_PUB }));
  const env = {
    SGX_ENV: 'production',
    D1_ACCOUNT_AUTH: db,
    D1_SETTINGS_SYNC: db,
    D1_WELLBEING: db,
    KV_PROFILE: { get: async () => null, getWithMetadata: async () => ({ value: null, metadata: null }), put: async () => {}, delete: async () => {} },
    ASSETS: { fetch: async () => new Response('DEFAULT', { status: 200 }) },
    SGX_ACCOUNT_PRIVATE: K.ACCOUNT.priv,
    SGX_ACCOUNT_PUBLIC: K.ACCOUNT.pub,
    SGX_ACCOUNT_ROOT_KEY: ROOT_KEY,
    SGX_PW_PEPPER: PEPPER,
    SGX_RP_ID: 'styrigx.com',
    SGX_ORIGIN: ORIGIN,
    AUTH: {
      lockSession: (c) => { calls.push('lock'); return gw.lockSession(c); },
      accountSession: (c, m) => { calls.push('account'); return gw.accountSession(c, m); },
    },
    ...over,
  };
  return { env, calls };
}

const service = (env) => new ep.AccountService(CTX, env);
const req = (path, o = {}) => new Request(ORIGIN + path, { method: o.method || 'GET', headers: { Origin: ORIGIN, ...(o.headers || {}) }, body: o.body });
const accCookie = async (o) => 'sgx-account-session=' + (await accSession('password', 0, Date.now(), o));

/* ---------------- 导出 ---------------- */

test('worker.js：默认导出就是 index.js 的 default；AccountService / AccountVerifier 是 WorkerEntrypoint 子类', () => {
  assert.equal(worker.default, index.default);
  assert.deepEqual(Object.keys(worker).sort(), ['AccountService', 'AccountVerifier', 'default']);
  assert.ok(new ep.AccountService(CTX, {}) instanceof WorkerEntrypoint);
  assert.ok(new ep.AccountVerifier(CTX, {}) instanceof WorkerEntrypoint);
  assert.equal(typeof ep.AccountService.prototype.fetch, 'function');
  assert.equal(typeof ep.AccountVerifier.prototype.accountSession, 'function');
  assert.equal(ep.AccountVerifier.prototype.fetch, undefined);
});

test('路由表：默认 fetch 仍只有三条；AccountService = 三条 + /api/account（同一批模块）', () => {
  assert.deepEqual([...index.API_ROUTES.keys()].sort(), ['/api/avatar', '/api/prefs', '/api/wellbeing']);
  assert.deepEqual([...ep.SERVICE_API_ROUTES.keys()].sort(), ['/api/account', '/api/avatar', '/api/prefs', '/api/wellbeing']);
  for (const [k, m] of index.API_ROUTES) assert.equal(ep.SERVICE_API_ROUTES.get(k), m, k);
});

/* ---------------- AccountService ---------------- */

test('AccountService：admin 身份头 → GET /api/account 200（X-SGX-Runtime: account、no-store），不问 AUTH', async () => {
  const { env, calls } = makeEnv();
  const r = await service(env).fetch(req('/api/account', { headers: idHeaders() }));
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.ok, true);
  assert.equal(b.configured, false);
  assert.equal(r.headers.get('X-SGX-Runtime'), 'account');
  assert.match(r.headers.get('Cache-Control'), /no-store/);
  assert.deepEqual(calls, []);
});

test('AccountService：没有身份头 → /api/* 401 {ok:false}（门）；头像文件照旧公开；没有 AUTH 绑定也不出错', async () => {
  const { env, calls } = makeEnv({ AUTH: undefined });
  for (const [m, p] of [['GET', '/api/account'], ['POST', '/api/account'], ['GET', '/api/prefs'], ['GET', '/api/wellbeing'], ['PUT', '/api/avatar']]) {
    const r = await service(env).fetch(req(p, { method: m, body: m === 'GET' ? undefined : '{}' }));
    assert.equal(r.status, 401, m + ' ' + p);
    assert.deepEqual(await r.json(), { ok: false });
  }
  const av = await service(env).fetch(req('/avatar/96.webp'));
  assert.equal(av.status, 200);
  assert.equal(await av.text(), 'DEFAULT');
  assert.deepEqual(calls, []);
});

test('AccountService：白名单外的身份值（ADMIN / root / 空 / 只有 By 头）一律当作无身份 → 401', async () => {
  const { env } = makeEnv();
  for (const h of [
    { 'X-Styrigx-Lock-Role': 'ADMIN' },
    { 'X-Styrigx-Lock-Role': 'root' },
    { 'X-Styrigx-Lock-Role': '' },
    { 'X-Styrigx-Lock-Role': 'admin,visitor' },
    { 'X-Styrigx-Lock-By': 'password' },
  ]) {
    const r = await service(env).fetch(req('/api/account', { headers: h }));
    assert.equal(r.status, 401, JSON.stringify(h));
  }
});

test('AccountService：访客身份头 → /api/prefs 403 role（门）、/api/account 401 session（接口）', async () => {
  const { env } = makeEnv();
  const h = idHeaders({ role: 'visitor', by: 'tempkey', tempkeyId: 'tk1' });
  let r = await service(env).fetch(req('/api/prefs', { headers: h }));
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { ok: false, error: 'role' });
  r = await service(env).fetch(req('/api/account', { headers: h }));
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'session');
});

test('AccountService：/api/prefs 的账号会话在本 Worker 验（账号库），不经 AUTH；没账号会话 401 account', async () => {
  const { env, calls } = makeEnv();
  let r = await service(env).fetch(req('/api/prefs', { headers: idHeaders() }));
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'account');
  r = await service(env).fetch(req('/api/prefs', { headers: { ...idHeaders(), Cookie: await accCookie() } }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  assert.deepEqual(calls, []);
});

test('AccountService：POST /api/account login-password 走通（签账号会话 cookie），Secrets Store 绑定对象也能读', async () => {
  const store = (v) => ({ get: async () => v });
  const { env } = makeEnv({ SGX_ACCOUNT_PRIVATE: store(K.ACCOUNT.priv), SGX_ACCOUNT_PUBLIC: store(K.ACCOUNT.pub), SGX_PW_PEPPER: store(PEPPER), SGX_ACCOUNT_ROOT_KEY: store(ROOT_KEY) });
  await seedPassword({ D1_ACCOUNT_AUTH: env.D1_ACCOUNT_AUTH }, 'right-password-1');
  const r = await service(env).fetch(postReq(ORIGIN + '/api/account', { action: 'login-password', password: 'right-password-1' }, idHeaders()));
  assert.equal(r.status, 200);
  assert.ok(pickCookie(r, 'sgx-account-session'));
  assert.equal(r.headers.get('X-SGX-Runtime'), 'account');
});

test('AccountService：处理中抛错 → 500 internal（仍打 X-SGX-Runtime）', async () => {
  const { env } = makeEnv({ D1_WELLBEING: { prepare() { throw new Error('boom'); } } });
  const bad = new Request(ORIGIN + '/api/account', { headers: idHeaders() });
  Object.defineProperty(bad, 'url', { get() { throw new TypeError('x'); } });
  const r = await service(env).fetch(bad);
  assert.equal(r.status, 500);
  assert.equal((await r.json()).error, 'internal');
  assert.equal(r.headers.get('X-SGX-Runtime'), 'account');
});

/* ---------------- 默认 fetch（公开路由）：与 PR2 前一致，不信同名头 ---------------- */

test('默认 fetch：伪造的 x-styrigx-* admin 头不被信任——没锁屏会话照旧 401，会话仍问 AUTH（AuthVerifier 不认就是没会话）', async () => {
  const { env, calls } = makeEnv();
  for (const p of ['/api/wellbeing', '/api/prefs']) {
    const r = await index.default.fetch(req(p, { headers: { ...idHeaders(), Cookie: 'theme=dark' } }), env, CTX);
    assert.equal(r.status, 401, p);
    assert.deepEqual(await r.json(), { ok: false });
  }
  assert.ok(calls.includes('lock'));
});

test('默认 fetch：没有 /api/account（有效 admin 锁屏会话 + 伪造身份头也是 404 not-found）', async () => {
  const { env } = makeEnv();
  const ck = 'sgx-lock-session=' + (await testLockSession(LOCK_PRIV, 0, 'admin'));
  for (const m of ['GET', 'POST']) {
    const r = await index.default.fetch(req('/api/account', { method: m, headers: { ...idHeaders(), Cookie: ck }, body: m === 'POST' ? '{"action":"login-password"}' : undefined }), env, CTX);
    assert.equal(r.status, 404, m);
    assert.equal((await r.json()).error, 'not-found');
  }
});

test('默认 fetch：有效锁屏会话照旧放行（经 AUTH）；访客 /api/prefs 403 role；头像公开——与 PR2 前同结论', async () => {
  const { env, calls } = makeEnv();
  const admin = 'sgx-lock-session=' + (await testLockSession(LOCK_PRIV, 0, 'admin'));
  const visitor = 'sgx-lock-session=' + (await testLockSession(LOCK_PRIV, 0, 'visitor'));
  let r = await index.default.fetch(req('/api/wellbeing', { headers: { Cookie: admin } }), env, CTX);
  assert.equal(r.status, 200);
  r = await index.default.fetch(req('/api/prefs', { headers: { Cookie: visitor } }), env, CTX);
  assert.equal(r.status, 403);
  r = await index.default.fetch(req('/avatar/32.webp'), env, CTX);
  assert.equal(r.status, 200);
  assert.ok(calls.includes('lock'));
});

/* ---------------- AccountVerifier ---------------- */

test('AccountVerifier：有效账号会话 → { ok:true }，不签发任何东西（纪元不变、只回结论）；设备记录用 clientContext 的 UA / 地点', async () => {
  const { env } = makeEnv();
  const v = new ep.AccountVerifier(CTX, env);
  const r = await v.accountSession(await accCookie(), { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', country: 'JP', city: 'Tokyo' });
  assert.deepEqual(r, { ok: true });
  const ep0 = one({ D1_ACCOUNT_AUTH: env.D1_ACCOUNT_AUTH }, "SELECT value FROM epoch WHERE realm = 'account'");
  assert.ok(!ep0 || Number(ep0.value) === 0);
  const dev = one({ D1_ACCOUNT_AUTH: env.D1_ACCOUNT_AUTH }, "SELECT record FROM device WHERE realm = 'account' AND device_id = ?", TEST_DEVICE_ID);
  assert.ok(dev, '补记设备');
  const rec = JSON.parse(dev.record);
  assert.equal(rec.country, 'JP');
  assert.equal(rec.city, 'Tokyo');
});

test('AccountVerifier：反例——没 cookie / 非字符串 / 只有锁屏会话 / 格式错 / 别的钥匙签 / 纪元变了 / 过期，各回原因代号', async () => {
  const { env } = makeEnv();
  const v = new ep.AccountVerifier(CTX, env);
  const lock = 'sgx-lock-session=' + (await testLockSession(LOCK_PRIV, 0, 'admin'));
  assert.deepEqual(await v.accountSession('', {}), { ok: false, reason: 'no-cookie' });
  assert.deepEqual(await v.accountSession(undefined), { ok: false, reason: 'no-cookie' });
  assert.deepEqual(await v.accountSession({ Cookie: 'x' }), { ok: false, reason: 'no-cookie' });
  assert.deepEqual(await v.accountSession(lock), { ok: false, reason: 'no-cookie' });
  assert.deepEqual(await v.accountSession('sgx-account-session=garbage'), { ok: false, reason: 'bad-format' });
  assert.deepEqual(await v.accountSession(await accCookie({ priv: K.OTHER.priv })), { ok: false, reason: 'bad-sig' });
  const old = 'sgx-account-session=' + (await accSession('password', 0, Date.now() - 500 * 86400000, { now: Date.now() - 500 * 86400000 }));
  assert.deepEqual(await v.accountSession(old), { ok: false, reason: 'expired' });
  setEpoch({ D1_ACCOUNT_AUTH: env.D1_ACCOUNT_AUTH }, 3);
  assert.deepEqual(await v.accountSession(await accCookie()), { ok: false, reason: 'epoch-changed' });
});

test('AccountVerifier：缺钥匙 → no-pubkey；账号库出错 → d1-error，都不抛', async () => {
  let { env } = makeEnv({ SGX_ACCOUNT_PUBLIC: undefined });
  assert.deepEqual(await new ep.AccountVerifier(CTX, env).accountSession(await accCookie()), { ok: false, reason: 'no-pubkey' });
  _resetSecretCache();
  ({ env } = makeEnv({ D1_ACCOUNT_AUTH: { prepare() { throw new Error('down'); }, batch() { throw new Error('down'); } } }));
  assert.deepEqual(await new ep.AccountVerifier(CTX, env).accountSession(await accCookie()), { ok: false, reason: 'd1-error' });
});

test('verifierRequest：只带 Cookie / User-Agent / 地点头，不带锁屏身份头；超长 cookie 截断', () => {
  const r = ep.verifierRequest('a=' + 'x'.repeat(10000), { ua: 'U'.repeat(600), country: 'CN', city: 'Shanghai', role: 'admin' });
  assert.equal(r.headers.get('Cookie').length, 8192);
  assert.equal(r.headers.get('User-Agent').length, 512);
  assert.equal(r.headers.get('X-Styrigx-Client-Country'), 'CN');
  assert.equal(r.headers.get('X-Styrigx-Client-City'), 'Shanghai');
  assert.equal(r.headers.get('X-Styrigx-Lock-Role'), null);
  assert.deepEqual([...r.headers.keys()].sort(), ['cookie', 'user-agent', 'x-styrigx-client-city', 'x-styrigx-client-country']);
});
