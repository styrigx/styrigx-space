/**
 * 账号拆分 PR2b：账号 Worker 的 /api/account 身份接口（workers/account/src/identity/）。
 * 从网关 tests/workers/auth-gateway/account.test.mjs、account-devices.test.mjs 复制改写：
 * - 身份只看网关写的规范头（X-Styrigx-Lock-Role 必须 admin，logout / reauth-clear 除外），不读锁屏会话 cookie
 * - 客户端地址 / 国家 / 城市读 X-Styrigx-Client-*（不读 CF-Connecting-IP、request.cf）
 * - action 名、错误码、cookie、票格式与网关一致；网关签的账号票这里照样认（切换不掉线）
 * - 与网关有意不同：首次配置不推 Lock 纪元、不查「与锁屏密码相同」、不查锁屏通行密钥、legacy_handle 读本库
 * - 新增：GET configured、device-revoke-all；安全事件写审计
 * - 存储在账号库（D1_ACCOUNT_AUTH），空库第一次请求按本库 0003 建表（user_handle 带 legacy_handle）
 * 账号根密钥（root-reauth / root-reset / audit-list）见 account-root.test.mjs。
 *
 * 运行：node --test tests/workers/account/account-identity.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { postReq } from '../_harness.mjs';
import { makeAccountD1 } from './_d1.mjs';
import { readLockIdentity, readClientContext } from '../../../workers/account/src/lib/lock-identity.js';
import {
  K, keys, makeEnv, post, get, accSession, reauth, reset, full, pickCookie, setCookies, one, all, raw, epochOf, setEpoch,
  seedPassword, seedPasskey, setHandles, assertion, passkeyLogin, makeAttestationCredential,
  account, session, devices, store, realm, IP, URL_, TEST_DEVICE_ID, idHeaders,
} from './_identity.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;
const ID_DIR = REPO + 'workers/account/src/identity/';

before(keys);

/** 让匹配 pred 的 SQL 抛错的 D1 包装（测 fail closed） */
function failing(db, pred) {
  return {
    ...db,
    prepare(sql) {
      const st = db.prepare(sql);
      if (!pred(sql)) return st;
      const boom = { bind: () => boom, first: async () => { throw new Error('D1 down'); }, all: async () => { throw new Error('D1 down'); }, run: async () => { throw new Error('D1 down'); } };
      return boom;
    },
  };
}
const events = (env) => all(env, "SELECT path, ok, ip_prefix FROM audit WHERE realm = 'account' ORDER BY ts, id").map((r) => r.path);
const parseSess = (v) => { const [by, epoch, authAt, exp, deviceId] = v.split('.'); return { by, epoch: +epoch, authAt: +authAt, exp: +exp, deviceId }; };

/* ================= 身份头 ================= */

test('readLockIdentity：白名单——role 只认 admin / visitor，by 只认 password / passkey / tempkey，其它值当作没有；tempkeyId 只给访客', () => {
  const r = (h) => readLockIdentity(new Request(URL_, { headers: h }).headers);
  assert.deepEqual(r({ 'X-Styrigx-Lock-Role': 'admin', 'X-Styrigx-Lock-By': 'passkey' }), { role: 'admin', by: 'passkey', tempkeyId: '' });
  assert.deepEqual(r({ 'x-styrigx-lock-role': 'visitor', 'x-styrigx-lock-by': 'tempkey', 'x-styrigx-lock-tempkey-id': 'tk_1' }), { role: 'visitor', by: 'tempkey', tempkeyId: 'tk_1' });
  assert.equal(r({}), null);
  assert.equal(r({ 'X-Styrigx-Lock-Role': 'Admin' }), null, '大小写不同也不认');
  assert.equal(r({ 'X-Styrigx-Lock-Role': 'root' }), null);
  assert.equal(r({ 'X-Sgx-Role': 'admin' }), null, '旧头名不认');
  assert.equal(r({ 'X-Styrigx-Lock-Role': 'admin', 'X-Styrigx-Lock-By': 'magic' }).by, '');
  assert.equal(r({ 'X-Styrigx-Lock-Role': 'admin', 'X-Styrigx-Lock-Tempkey-Id': 'tk_1' }).tempkeyId, '', 'admin 不带 tempkeyId');
  assert.equal(account.isAdmin(new Request(URL_, { headers: { 'X-Styrigx-Lock-Role': 'visitor' } })), false);
});

test('clientAddress：读 X-Styrigx-Client-Address；不认 CF-Connecting-IP / X-Forwarded-For；格式不对或没有 → unknown', () => {
  const c = (h) => account.clientAddress(new Request(URL_, { headers: h }));
  assert.equal(c({ 'X-Styrigx-Client-Address': '1.2.3.4' }), '1.2.3.4');
  assert.equal(c({ 'X-Styrigx-Client-Address': '2001:db8::1' }), '2001:db8::1');
  assert.equal(c({ 'CF-Connecting-IP': '5.6.7.8', 'X-Forwarded-For': '9.9.9.9' }), 'unknown');
  assert.equal(c({ 'X-Styrigx-Client-Address': 'evil; drop' }), 'unknown');
  assert.equal(c({ 'X-Styrigx-Client-Address': '1'.repeat(80) }), 'unknown');
});

test('readClientContext：address 只认 IP 字符（≤64）；country ≤4、city ≤40 且无控制字符，不合规整项 → \'\'；没有 headers → 三项空', () => {
  const c = (h) => readClientContext(new Request(URL_, { headers: h }).headers);
  assert.deepEqual(c({ 'X-Styrigx-Client-Address': ' 1.2.3.4 ', 'X-Styrigx-Client-Country': 'JP', 'X-Styrigx-Client-City': 'Tokyo' }), { address: '1.2.3.4', country: 'JP', city: 'Tokyo' });
  assert.deepEqual(c({ 'X-Styrigx-Client-Address': 'evil; drop', 'X-Styrigx-Client-Country': 'JAPAN', 'X-Styrigx-Client-City': 'x'.repeat(41) }), { address: '', country: '', city: '' });
  assert.deepEqual(c({ 'X-Styrigx-Client-City': 'Tok\u0007yo' }), { address: '', country: '', city: '' });
  assert.deepEqual(c({ 'CF-IPCountry': 'US' }), { address: '', country: '', city: '' }, '不读 Cloudflare 自己的头');
  assert.deepEqual(readClientContext(null), { address: '', country: '', city: '' });
  assert.equal(readLockIdentity(null), null);
  assert.equal(readLockIdentity({}), null);
});

test('lib/lock-identity.js：账号侧只读——导出头名常量 + readLockIdentity / readClientContext，没有写头 / 剥头的函数；不 import 任何东西', async () => {
  const mod = await import('../../../workers/account/src/lib/lock-identity.js');
  assert.deepEqual(Object.keys(mod).sort(), ['CLIENT_CONTEXT_HEADERS', 'LOCK_IDENTITY_HEADERS', 'readClientContext', 'readLockIdentity']);
  const src = readFileSync(new URL('../../../workers/account/src/lib/lock-identity.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^\s*import\s/m);
  assert.equal('readLockIdentity' in account, false, 'identity/account.js 不再自带一份白名单');
});

test('GET：没有身份头 / 访客 / 不认识的角色 → 401 session；只带锁屏会话 cookie 也不算（不验锁屏会话）', async () => {
  const env = makeEnv();
  for (const identity of [null, { role: 'visitor', by: 'tempkey' }, { role: 'owner' }]) {
    const r = await get(env, {}, { identity });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error, 'session');
  }
  const r = await get(env, { 'sgx-lock-session': 'password.admin.0.9999999999999..sig' }, { identity: null });
  assert.equal(r.status, 401);
});

test('POST：除 logout / reauth-clear 外每个 action 都要 admin 身份（401 session，不读不写库）', async () => {
  const env = makeEnv();
  const actions = ['login-challenge', 'login-passkey', 'login-password', 'passkey-list', 'passkey-register-challenge', 'passkey-register',
    'passkey-delete', 'passkey-rename', 'password-change', 'device-list', 'device-revoke', 'device-revoke-all', 'root-reauth', 'root-reset', 'audit-list', 'nope'];
  const before = env.D1_ACCOUNT_AUTH.statements.length;
  for (const action of actions) {
    for (const identity of [null, { role: 'visitor', by: 'tempkey', tempkeyId: 'tk1' }]) {
      const r = await post(env, { action, key: 'x', password: 'whatever-123' }, await full(), { identity });
      assert.equal(r.status, 401, action);
      assert.equal((await r.json()).error, 'session', action);
    }
  }
  assert.equal(env.D1_ACCOUNT_AUTH.statements.length, before, '一条 SQL 都没发');
});

test('logout / reauth-clear：不要身份、不要会话（幂等）；logout 清会话和两张短票，reauth-clear 只清两张短票', async () => {
  const env = makeEnv();
  const lo = await post(env, { action: 'logout' }, {}, { identity: null });
  assert.equal(lo.status, 200);
  const sc = setCookies(lo);
  assert.equal(sc.length, 3);
  assert.ok(sc[0].startsWith('sgx-account-session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'));
  assert.ok(sc[1].startsWith('sgx-account-reauth=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'));
  assert.ok(sc[2].startsWith('sgx-account-reset=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'));
  const rc = await post(env, { action: 'reauth-clear' }, {}, { identity: { role: 'visitor' } });
  assert.equal(rc.status, 200);
  assert.deepEqual(setCookies(rc).map((c) => c.split('=')[0]), ['sgx-account-reauth', 'sgx-account-reset']);
});

test('请求本身：跨站 Origin 403 origin；坏 JSON 400 body；不认识的 action 400 action；非 POST 405', async () => {
  const env = makeEnv();
  const x = await account.onRequestPost({ request: postReq(URL_, { action: 'logout' }, { Origin: 'https://evil.example', ...idHeaders() }), env });
  assert.equal(x.status, 403);
  const b = await account.onRequestPost({ request: new Request(URL_, { method: 'POST', headers: { Origin: 'https://styrigx.com', ...idHeaders() }, body: '{oops' }), env });
  assert.equal(b.status, 400);
  assert.equal((await b.json()).error, 'body');
  const a = await post(env, { action: 'what' }, {});
  assert.equal(a.status, 400);
  assert.equal((await a.json()).error, 'action');
  const m = await account.onRequestPost({ request: new Request(URL_, { method: 'PUT', headers: idHeaders() }), env });
  assert.equal(m.status, 405);
});

test('账号库没绑（D1_ACCOUNT_AUTH 缺）：GET / POST 500 config；logout 照常', async () => {
  const env = makeEnv({ D1_ACCOUNT_AUTH: undefined });
  assert.equal((await get(env)).status, 500);
  const r = await post(env, { action: 'login-password', password: 'x-123456789' });
  assert.equal(r.status, 500);
  assert.equal((await r.json()).error, 'config');
  assert.equal((await post(env, { action: 'logout' })).status, 200);
});

/* ================= GET ================= */

test('GET 新库：{ ok, password:false, passkey:false, ready:true, configured:false, session/reauth/reset:null }（字段同网关 + configured）', async () => {
  const r = await get(makeEnv());
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, password: false, passkey: false, ready: true, configured: false, session: null, reauth: null, reset: null });
  assert.equal(r.headers.get('Cache-Control'), 'private, no-store');
});

test('GET configured：只有密码 → true；只有通行密钥 → true', async () => {
  const e1 = makeEnv();
  await seedPassword(e1, 'pw-12345678');
  const j1 = await (await get(e1)).json();
  assert.equal(j1.password, true);
  assert.equal(j1.configured, true);
  const e2 = makeEnv();
  await seedPasskey(e2);
  const j2 = await (await get(e2)).json();
  assert.deepEqual([j2.password, j2.passkey, j2.configured], [false, true, true]);
});

test('GET 有账号会话：session { by, authAt, expiresAt, device }；没 reauth 票 reauth=null；400 天前登录也还有效', async () => {
  const env = makeEnv();
  const authAt = Date.now() - 30 * 24 * 3600 * 1000;
  const j = await (await get(env, { 'sgx-account-session': await accSession('passkey', 0, authAt) })).json();
  assert.equal(j.session.by, 'passkey');
  assert.equal(j.session.authAt, authAt);
  assert.ok(j.session.expiresAt > Date.now() + 399 * 24 * 3600 * 1000);
  assert.equal(j.reauth, null);
  const j2 = await (await get(env, await full('password'))).json();
  assert.equal(j2.reauth.by, 'password');
  assert.ok(j2.reauth.expiresAt <= Date.now() + 180000);
});

test('GET reset 票：没有账号会话也显示 reset；reauth 票没有会话不认', async () => {
  const env = makeEnv();
  const j = await (await get(env, { 'sgx-account-reset': await reset(0), 'sgx-account-reauth': await reauth('password', 0) })).json();
  assert.deepEqual(j.reset && j.reset.by, 'root');
  assert.equal(j.reauth, null);
  assert.equal(j.session, null);
});

test('GET：缺账号钥匙 ready=false（照样 200）；读凭证 D1 出错 → 503 server', async () => {
  const j = await (await get(makeEnv({ SGX_ACCOUNT_PRIVATE: '' }))).json();
  assert.equal(j.ready, false);
  const env = makeEnv();
  env.D1_ACCOUNT_AUTH = failing(env.D1_ACCOUNT_AUTH, (s) => /FROM password/.test(s));
  const r = await get(env);
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, 'server');
});

/* ================= login-password ================= */

test('login-password：未设置 403 not-set；错误 403 wrong；都不签 cookie；空 / 非字符串 400 params', async () => {
  const env = makeEnv();
  let r = await post(env, { action: 'login-password', password: 'whatever-123' });
  assert.equal((await r.json()).error, 'not-set');
  await seedPassword(env, 'right-password-1');
  r = await post(env, { action: 'login-password', password: 'wrong-password-1' });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'wrong');
  assert.equal(r.headers.get('Set-Cookie'), null);
  for (const password of ['', 123, null]) {
    const p = await post(env, { action: 'login-password', password });
    assert.equal(p.status, 400);
    assert.equal((await p.json()).error, 'params');
  }
});

test('login-password 成功：sgx-account-session（by=password，400 天，主站 Strict）；设备记一行，地点来自 X-Styrigx-Client-Country / City', async () => {
  const env = makeEnv();
  await seedPassword(env, 'right-password-1');
  const r = await post(env, { action: 'login-password', password: 'right-password-1', device: { model: 'SM-S918B', platform: 'Android' } });
  assert.equal(r.status, 200);
  const sc = setCookies(r).find((c) => c.startsWith('sgx-account-session='));
  assert.match(sc, /^sgx-account-session=password\.0\.\d+\.\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=34560000$/);
  assert.equal(pickCookie(r, 'sgx-account-reauth'), null, '没 reauth:true 不签 reauth 票');
  const devId = parseSess(pickCookie(r, 'sgx-account-session')).deviceId;
  const rec = JSON.parse(one(env, "SELECT record FROM device WHERE realm = 'account' AND device_id = ?", devId).record);
  assert.equal(rec.country, 'CN');
  assert.equal(rec.city, 'Shanghai');
  assert.equal(rec.model, 'SM-S918B');
});

test('login-password reauth:true → 另签 AccountReauthTicket（3 分钟、主站 Strict）；GET 据此返回 reauth.expiresAt', async () => {
  const env = makeEnv();
  await seedPassword(env, 'right-password-1');
  const r = await post(env, { action: 'login-password', password: 'right-password-1', reauth: true });
  const dc = setCookies(r).find((c) => c.startsWith('sgx-account-reauth='));
  assert.match(dc, /^sgx-account-reauth=password\.0\.\d+\.\d+\.[A-Za-z0-9_-]+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=180$/);
  const g = await (await get(env, { 'sgx-account-session': pickCookie(r, 'sgx-account-session'), 'sgx-account-reauth': pickCookie(r, 'sgx-account-reauth') })).json();
  assert.equal(g.reauth.by, 'password');
  /* reauth:"true"（不是布尔）不签 */
  const r2 = await post(env, { action: 'login-password', password: 'right-password-1', reauth: 'true' });
  assert.equal(pickCookie(r2, 'sgx-account-reauth'), null);
});

test('login-password 限速：同 IP 连错 5 次 → 429 cooldown（冷却中密码对也不验），记安全事件 login-password-cooldown；冷却过后对的密码清计数', async () => {
  const env = makeEnv();
  await seedPassword(env, 'right-password-1');
  for (let i = 0; i < 4; i++) assert.equal((await post(env, { action: 'login-password', password: 'wrong-password-1' })).status, 403);
  const fifth = await post(env, { action: 'login-password', password: 'wrong-password-1' });
  assert.equal(fifth.status, 429);
  assert.equal((await fifth.json()).error, 'cooldown');
  assert.deepEqual(events(env), ['login-password-cooldown']);
  assert.equal(one(env, "SELECT ok FROM audit WHERE path = 'login-password-cooldown'").ok, 0);
  const ok = await post(env, { action: 'login-password', password: 'right-password-1' });
  assert.equal(ok.status, 429);
  raw(env).prepare("UPDATE attempt_limit SET locked_until = ? WHERE realm = 'account' AND kind = 'password' AND bucket = ?").run(Date.now() - 1, IP);
  assert.equal((await post(env, { action: 'login-password', password: 'right-password-1' })).status, 200);
  assert.equal(one(env, "SELECT count FROM attempt_limit WHERE realm = 'account' AND kind = 'password' AND bucket = ?", IP), null);
});

test('login-password 限速按网关转来的 X-Styrigx-Client-Address 分桶（CF-Connecting-IP 不算数）', async () => {
  const env = makeEnv();
  await seedPassword(env, 'right-password-1');
  await post(env, { action: 'login-password', password: 'bad-pass-123' }, {}, { identity: { ip: '1.1.1.1' }, headers: { 'CF-Connecting-IP': '7.7.7.7' } });
  await post(env, { action: 'login-password', password: 'bad-pass-123' }, {}, { identity: { ip: '2.2.2.2' }, headers: { 'CF-Connecting-IP': '7.7.7.7' } });
  const buckets = all(env, "SELECT bucket, count FROM attempt_limit WHERE realm = 'account' AND kind = 'password' AND bucket <> '*' ORDER BY bucket");
  assert.deepEqual(buckets, [{ bucket: '1.1.1.1', count: 1 }, { bucket: '2.2.2.2', count: 1 }]);
});

test('login-password：缺账号钥匙 503 config；缺 pepper 503 config；限速 D1 出错 503 server', async () => {
  const e1 = makeEnv({ SGX_ACCOUNT_PUBLIC: '' });
  assert.equal((await (await post(e1, { action: 'login-password', password: 'x-12345678' })).json()).error, 'config');
  const e2 = makeEnv({ SGX_PW_PEPPER: '' });
  const r2 = await post(e2, { action: 'login-password', password: 'x-12345678' });
  assert.equal(r2.status, 503);
  assert.equal((await r2.json()).error, 'config');
  const e3 = makeEnv();
  e3.D1_ACCOUNT_AUTH = failing(e3.D1_ACCOUNT_AUTH, (s) => /attempt_limit/.test(s));
  const r3 = await post(e3, { action: 'login-password', password: 'x-12345678' });
  assert.equal(r3.status, 503);
  assert.equal((await r3.json()).error, 'server');
});

/* ================= login-passkey ================= */

test('login-challenge + login-passkey → 账号会话 by=passkey；challenge 存账号库（realm=account、purpose=login、5 分钟），单次使用', async () => {
  const env = makeEnv();
  const { kp, credId } = await seedPasskey(env);
  const ch = await post(env, { action: 'login-challenge' });
  const cj = await ch.json();
  assert.deepEqual(cj.allowCredentials, [{ id: credId, type: 'public-key' }]);
  assert.equal(cj.rpId, 'styrigx.com');
  const row = one(env, 'SELECT realm, purpose, challenge, expires_at FROM challenge WHERE id = ?', cj.cid);
  assert.equal(row.realm, 'account');
  assert.equal(row.purpose, 'login');
  assert.equal(row.challenge, cj.challenge);
  assert.ok(row.expires_at <= Date.now() + 300000);
  const cred = await assertion(kp, credId, cj.challenge, null);
  const res = await post(env, { action: 'login-passkey', cid: cj.cid, credential: cred });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.ok(pickCookie(res, 'sgx-account-session').startsWith('passkey.0.'));
  const replay = await post(env, { action: 'login-passkey', cid: cj.cid, credential: cred });
  assert.equal(replay.status, 403);
  assert.equal((await replay.json()).error, 'challenge');
});

test('login-passkey userHandle：等于账号 handle 接受；等于 legacy_handle（旧锁屏 handle，本库 user_handle 列）也接受', async () => {
  const env = makeEnv();
  setHandles(env, 'ACCT-H', 'LEGACY-H');
  const { kp, credId } = await seedPasskey(env);
  assert.equal((await passkeyLogin(env, kp, credId, 'ACCT-H')).status, 200);
  assert.equal((await passkeyLogin(env, kp, credId, 'LEGACY-H', {}, undefined, { signCount: 2 })).status, 200);
});

test('login-passkey userHandle 都不对 → 403 verify；没有 legacy_handle 时只认账号 handle', async () => {
  const env = makeEnv();
  setHandles(env, 'ACCT-H', '');
  const { kp, credId } = await seedPasskey(env);
  for (const uh of ['OTHER', 'LEGACY-H']) {
    const r = await passkeyLogin(env, kp, credId, uh);
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, 'verify');
    assert.equal(r.headers.get('Set-Cookie'), null);
  }
});

test('login-passkey：没有账号通行密钥 → login-challenge 403 not-set；不认识的钥匙 403 unknown-key', async () => {
  const env = makeEnv();
  const c = await post(env, { action: 'login-challenge' });
  assert.equal(c.status, 403);
  assert.equal((await c.json()).error, 'not-set');
  await seedPasskey(env);
  const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const cj = await (await post(env, { action: 'login-challenge' })).json();
  const r = await post(env, { action: 'login-passkey', cid: cj.cid, credential: await assertion(other, 'unknownCred', cj.challenge) });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'unknown-key');
});

test('login-passkey：断言没有 UV → 403 uv-required；signCount / lastUsedAt 成功后写回；reauth:true 另签 reauth 票（by=passkey）', async () => {
  const env = makeEnv();
  const { kp, credId } = await seedPasskey(env);
  const cj = await (await post(env, { action: 'login-challenge' })).json();
  const r = await post(env, { action: 'login-passkey', cid: cj.cid, credential: await assertion(kp, credId, cj.challenge, null, { uv: false }) });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'uv-required');
  const ok = await passkeyLogin(env, kp, credId, null, { reauth: true });
  assert.equal(ok.status, 200);
  assert.ok(pickCookie(ok, 'sgx-account-reauth').startsWith('passkey.0.'));
  const rec = JSON.parse(one(env, 'SELECT record FROM passkey WHERE credential_id = ?', credId).record);
  assert.equal(rec.signCount, 1);
  assert.ok(rec.lastUsedAt > 0);
});

test('通行密钥 action：缺 SGX_RP_ID / SGX_ORIGIN → 503 config', async () => {
  const env = makeEnv({ SGX_RP_ID: '' });
  await seedPasskey(env);
  for (const action of ['login-challenge', 'login-passkey']) {
    const r = await post(env, { action });
    assert.equal(r.status, 503, action);
    assert.equal((await r.json()).error, 'config');
  }
  const r = await post(env, { action: 'passkey-register-challenge' }, await full());
  assert.equal(r.status, 503);
});

/* ================= 管理门槛 ================= */

test('管理 action：没有账号会话也没有 reset 票 → 401 account（带 reason）', async () => {
  const env = makeEnv();
  for (const action of ['passkey-list', 'password-change', 'passkey-delete', 'device-list', 'device-revoke', 'device-revoke-all']) {
    const r = await post(env, { action, password: 'new-password-1', credId: 'x', deviceId: 'abcdefgh1' });
    assert.equal(r.status, 401, action);
    const j = await r.json();
    assert.equal(j.error, 'account');
    assert.equal(j.reason, 'no-cookie');
  }
});

test('改动要 AccountReauthTicket：没有 / 过期 / 别的钥匙签 / 纪元不对 / 拿会话票冒充 → 403 reauth；只读 passkey-list 不要票', async () => {
  const env = makeEnv();
  const s = await accSession('password');
  const body = { action: 'password-change', password: 'new-password-123' };
  const bad = [
    '',
    await reauth('password', 0, { now: Date.now() - 181000 }),
    await reauth('password', 0, { priv: K.OTHER.priv }),
    await reauth('password', 5),
    s,
  ];
  for (const t of bad) {
    const r = await post(env, body, { 'sgx-account-session': s, 'sgx-account-reauth': t });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, 'reauth');
  }
  assert.equal(one(env, 'SELECT * FROM password'), null, '一次都没改成');
  assert.equal((await post(env, { action: 'passkey-list' }, { 'sgx-account-session': s })).status, 200);
});

test('AccountResetTicket（没有账号会话）：能列 / 改密码 / 删通行密钥（by=root），不签会话；设备 action 一律 401 account', async () => {
  const env = makeEnv();
  await seedPassword(env, 'old-account-password-1');
  const base = { 'sgx-account-reset': await reset(0) };
  const l = await post(env, { action: 'passkey-list' }, base);
  assert.equal((await l.json()).by, 'root');
  const r = await post(env, { action: 'password-change', password: 'brand-new-pass-1' }, base);
  assert.deepEqual(await r.json(), { ok: true, changed: true });
  assert.equal(epochOf(env), 1);
  assert.equal(pickCookie(r, 'sgx-account-session'), null);
  assert.ok(pickCookie(r, 'sgx-account-reset').startsWith('root.1.'), 'reset 票重签到新纪元');
  for (const action of ['device-list', 'device-revoke', 'device-revoke-all']) {
    assert.equal((await post(env, { action, deviceId: 'abcdefgh1' }, { 'sgx-account-reset': await reset(1) })).status, 401, action);
  }
});

test('有账号会话但没有 reauth 票：带 reset 票也放行凭证改动（同网关）', async () => {
  const env = makeEnv();
  const r = await post(env, { action: 'password-change', password: 'brand-new-pass-1' }, { 'sgx-account-session': await accSession(), 'sgx-account-reset': await reset(0) });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, changed: false });
});

/* ================= password-change ================= */

test('password-change：少于 8 位 400 short；缺 / 非字符串 400 params；缺 pepper 503 config', async () => {
  const env = makeEnv();
  const c = await full();
  let r = await post(env, { action: 'password-change', password: 'short' }, c);
  assert.equal((await r.json()).error, 'short');
  r = await post(env, { action: 'password-change' }, c);
  assert.equal((await r.json()).error, 'params');
  r = await post(makeEnv({ SGX_PW_PEPPER: '' }), { action: 'password-change', password: 'long-enough-1' }, c);
  assert.equal(r.status, 503);
});

test('password-change 首次设置：changed=false、不推 Account 纪元；不推 Lock 纪元也不重签锁屏会话（拆分后读不到锁屏）；configured 变 true；记安全事件', async () => {
  const env = makeEnv();
  const r = await post(env, { action: 'password-change', password: 'first-pass-123' }, { 'sgx-account-reset': await reset(0) });
  assert.deepEqual(await r.json(), { ok: true, changed: false });
  assert.equal(epochOf(env), 0);
  assert.equal(r.headers.get('Set-Cookie'), null, '没有任何 cookie（网关原来会重签 sgx-lock-session）');
  assert.equal(one(env, "SELECT COUNT(*) AS n FROM epoch WHERE realm <> 'account'").n, 0, '不碰任何别的纪元');
  assert.equal((await (await get(env)).json()).configured, true);
  assert.deepEqual(events(env), ['password-change']);
});

test('password-change 已有密码：Account 纪元 +1；当前设备沿用 deviceId / by / authAt 重签；reauth 票按原到期时间重签；其他设备行删掉', async () => {
  const env = makeEnv();
  await seedPassword(env, 'old-account-password-1');
  const authAt = Date.now() - 5000;
  const s = await accSession('passkey', 0, authAt);
  const rt = await reauth('passkey', 0);
  await devices.putDevice(env, { deviceId: TEST_DEVICE_ID, by: 'passkey', lastSeen: Date.now() });
  await devices.putDevice(env, { deviceId: 'otherdevice01', by: 'password', lastSeen: Date.now() });
  const r = await post(env, { action: 'password-change', password: 'brand-new-pass-1' }, { 'sgx-account-session': s, 'sgx-account-reauth': rt });
  assert.deepEqual(await r.json(), { ok: true, changed: true });
  assert.equal(epochOf(env), 1);
  const ns = parseSess(pickCookie(r, 'sgx-account-session'));
  assert.deepEqual([ns.by, ns.epoch, ns.authAt, ns.deviceId], ['passkey', 1, authAt, TEST_DEVICE_ID]);
  const nr = pickCookie(r, 'sgx-account-reauth');
  assert.ok(nr.startsWith('passkey.1.'));
  assert.equal(nr.split('.')[3], rt.split('.')[3], '到期时间不变');
  assert.deepEqual(all(env, 'SELECT device_id FROM device').map((d) => d.device_id), [TEST_DEVICE_ID]);
  /* 旧票失效 */
  assert.equal((await (await get(env, { 'sgx-account-session': s })).json()).session, null);
});

test('password-change：不再有「不得与锁屏密码相同」检查（锁屏密码不在账号库，也不读）', async () => {
  const env = makeEnv();
  const r = await post(env, { action: 'password-change', password: 'lock-pass-123' }, await full());
  assert.equal(r.status, 200);
  const src = readFileSync(ID_DIR + 'account.js', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(src, /same-as-lock|REALM_LOCK|'lock'/);
});

test('新密码真能登录、旧密码不行（pepper 同一个）；records 只写在 realm=account', async () => {
  const env = makeEnv();
  await seedPassword(env, 'old-account-password-1');
  await post(env, { action: 'password-change', password: 'brand-new-pass-1' }, await full());
  assert.equal((await post(env, { action: 'login-password', password: 'old-account-password-1' })).status, 403);
  assert.equal((await post(env, { action: 'login-password', password: 'brand-new-pass-1' })).status, 200);
  assert.deepEqual(all(env, 'SELECT realm FROM password').map((r) => r.realm), ['account']);
});

/* ================= 通行密钥管理 ================= */

test('passkey-list：{ by, userHandle, userName:AccountKey, displayName, keys[] }；只读 handle、不新建', async () => {
  const env = makeEnv();
  const a = await seedPasskey(env, { name: 'Pixel', provider: 'Google 密码管理器', createdAt: 5, lastUsedAt: 6 });
  const j = await (await post(env, { action: 'passkey-list' }, { 'sgx-account-session': await accSession('passkey') })).json();
  assert.equal(j.by, 'passkey');
  assert.equal(j.userHandle, '');
  assert.equal(j.userName, 'AccountKey');
  assert.equal(j.displayName, 'Sloan Gray');
  assert.deepEqual(j.keys, [{ credId: a.credId, name: 'Pixel', provider: 'Google 密码管理器', createdAt: 5, lastUsedAt: 6 }]);
  assert.equal(one(env, 'SELECT * FROM user_handle'), null, 'list 不创建 handle');
  setHandles(env, 'ACCT-H', 'LEGACY-H');
  const j2 = await (await post(env, { action: 'passkey-list' }, { 'sgx-account-session': await accSession('passkey') })).json();
  assert.equal(j2.userHandle, 'ACCT-H', '只给账号 handle，不给 legacy');
});

test('passkey-register-challenge：生成并沿用账号 handle（user.id），user.name=AccountKey，排除已有通行密钥；challenge purpose=register', async () => {
  const env = makeEnv();
  const a = await seedPasskey(env);
  const j = await (await post(env, { action: 'passkey-register-challenge' }, await full())).json();
  assert.ok(j.user.id && j.user.id.length >= 40);
  assert.deepEqual([j.user.name, j.user.displayName, j.rp.id, j.rp.name], ['AccountKey', 'Sloan Gray', 'styrigx.com', 'Styrigx']);
  assert.deepEqual(j.excludeCredentials, [{ id: a.credId, type: 'public-key' }]);
  assert.equal(one(env, 'SELECT purpose FROM challenge WHERE id = ?', j.cid).purpose, 'register');
  const j2 = await (await post(env, { action: 'passkey-register-challenge' }, await full())).json();
  assert.equal(j2.user.id, j.user.id, '第二次沿用');
  assert.equal(one(env, 'SELECT legacy_handle FROM user_handle').legacy_handle, '');
});

test('passkey-register 成功：存进账号库（字段顺序固定、name 清洗）；返回 credId；不重签任何会话（首次配置不推 Lock 纪元）；记安全事件', async () => {
  const env = makeEnv();
  const ch = await (await post(env, { action: 'passkey-register-challenge' }, { 'sgx-account-reset': await reset(0) })).json();
  const cred = await makeAttestationCredential(ch.challenge, 'styrigx.com', 'https://styrigx.com');
  const r = await post(env, { action: 'passkey-register', cid: ch.cid, credential: cred, name: '  我的\u0007手机 ' }, { 'sgx-account-reset': await reset(0) });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  assert.deepEqual(await r.json(), { ok: true, credId: cred.id });
  assert.equal(r.headers.get('Set-Cookie'), null);
  const rec = JSON.parse(one(env, "SELECT record FROM passkey WHERE realm = 'account' AND credential_id = ?", cred.id).record);
  assert.deepEqual(Object.keys(rec), ['name', 'provider', 'aaguid', 'createdAt', 'lastUsedAt', 'credId', 'publicKey', 'signCount', 'uv']);
  assert.equal(rec.name, '我的手机');
  assert.equal(rec.uv, 1);
  assert.equal(epochOf(env), 0);
  assert.equal((await (await get(env)).json()).configured, true);
  assert.deepEqual(events(env), ['passkey-register']);
});

test('passkey-register：challenge 只能用一次（403 challenge）；origin 不对 403 verify；不再有 403 class（锁屏通行密钥不在账号库）', async () => {
  const env = makeEnv();
  const c = await full();
  const ch = await (await post(env, { action: 'passkey-register-challenge' }, c)).json();
  const bad = await makeAttestationCredential(ch.challenge, 'styrigx.com', 'https://evil.example');
  const r1 = await post(env, { action: 'passkey-register', cid: ch.cid, credential: bad }, c);
  assert.equal(r1.status, 403);
  assert.equal((await r1.json()).error, 'verify');
  const r2 = await post(env, { action: 'passkey-register', cid: ch.cid, credential: bad }, c);
  assert.equal((await r2.json()).error, 'challenge');
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM passkey').n, 0);
  assert.doesNotMatch(readFileSync(ID_DIR + 'account.js', 'utf8'), /'class'/);
});

test('passkey-delete：先推纪元再删；当前设备重签、reset 票重签；不存在 404 not-found；缺 credId 400 params；记安全事件', async () => {
  const env = makeEnv();
  const a = await seedPasskey(env);
  const b = await seedPasskey(env);
  const c = await full('passkey');
  assert.equal((await post(env, { action: 'passkey-delete', credId: 'nope' }, c)).status, 404);
  assert.equal((await post(env, { action: 'passkey-delete' }, c)).status, 400);
  const r = await post(env, { action: 'passkey-delete', credId: a.credId }, c);
  assert.equal(r.status, 200);
  assert.equal(epochOf(env), 1);
  assert.ok(pickCookie(r, 'sgx-account-session').startsWith('passkey.1.'));
  assert.deepEqual(all(env, 'SELECT credential_id FROM passkey').map((x) => x.credential_id), [b.credId]);
  assert.deepEqual(events(env), ['passkey-delete']);
});

test('passkey-delete：纪元推进失败 → 503 epoch，钥匙还在（fail closed）', async () => {
  const env = makeEnv();
  const a = await seedPasskey(env);
  const c = await full();
  const db = env.D1_ACCOUNT_AUTH;
  env.D1_ACCOUNT_AUTH = failing(db, (s) => /^UPDATE epoch/.test(s));
  const r = await post(env, { action: 'passkey-delete', credId: a.credId }, c);
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, 'epoch');
  assert.ok(one(env, 'SELECT 1 AS x FROM passkey WHERE credential_id = ?', a.credId));
});

test('passkey-rename：去控制字符 / 首尾空格、限 40 字；空名 400 params；不存在 404；不推纪元；记安全事件', async () => {
  const env = makeEnv();
  const a = await seedPasskey(env);
  const c = await full();
  const long = '  Galaxy\u0007 S26 ' + 'x'.repeat(60);
  const r = await post(env, { action: 'passkey-rename', credId: a.credId, name: long }, c);
  const want = ('Galaxy S26 ' + 'x'.repeat(60)).slice(0, 40);
  assert.equal((await r.json()).name, want);
  assert.equal(JSON.parse(one(env, 'SELECT record FROM passkey').record).name, want);
  assert.equal((await post(env, { action: 'passkey-rename', credId: a.credId, name: ' \u0001 ' }, c)).status, 400);
  assert.equal((await post(env, { action: 'passkey-rename', credId: 'zzz', name: 'n' }, c)).status, 404);
  assert.equal(epochOf(env), 0);
  assert.deepEqual(events(env), ['passkey-rename']);
});

/* ================= 设备 ================= */

test('登录记一台设备（型号来自 hints）；同一浏览器带着有效会话再登录（再验一次）沿用 deviceId，不多一台', async () => {
  const env = makeEnv();
  await seedPassword(env, 'right-password-1');
  const r1 = await post(env, { action: 'login-password', password: 'right-password-1', device: { model: 'SM-S928B' } });
  const s1 = pickCookie(r1, 'sgx-account-session');
  const r2 = await post(env, { action: 'login-password', password: 'right-password-1', reauth: true }, { 'sgx-account-session': s1 });
  assert.equal(parseSess(pickCookie(r2, 'sgx-account-session')).deviceId, parseSess(s1).deviceId);
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM device').n, 1);
  assert.equal(JSON.parse(one(env, 'SELECT record FROM device').record).model, 'SM-S928B', '新登录没带 hints 也保留旧型号');
});

test('device-list：此设备排第一并标 current；字段齐全；GET session.device = 此设备名字', async () => {
  const env = makeEnv();
  await devices.putDevice(env, { deviceId: 'otherdevice01', by: 'password', model: 'iPhone', platform: 'iOS', lastSeen: Date.now() });
  await devices.putDevice(env, { deviceId: TEST_DEVICE_ID, by: 'passkey', model: 'SM-S918B', platform: 'Android', lastSeen: Date.now() - 60000 });
  const s = await accSession('passkey');
  const j = await (await post(env, { action: 'device-list' }, { 'sgx-account-session': s })).json();
  assert.deepEqual(j.devices.map((d) => [d.deviceId, d.current]), [[TEST_DEVICE_ID, true], ['otherdevice01', false]]);
  assert.deepEqual(Object.keys(j.devices[0]), ['deviceId', 'current', 'name', 'model', 'platform', 'platformVersion', 'browser', 'country', 'city', 'by', 'createdAt', 'lastSeen']);
  assert.equal(j.devices[0].name, 'Galaxy S23 Ultra');
  assert.equal((await (await get(env, { 'sgx-account-session': s })).json()).session.device, 'Galaxy S23 Ultra');
});

test('device-revoke：别的设备立即失效（下一个请求 revoked）；不能退出此设备 400 current；不存在 404；格式不对 400 params；记安全事件', async () => {
  const env = makeEnv();
  await devices.putDevice(env, { deviceId: 'otherdevice01', by: 'password', lastSeen: Date.now() });
  const s = await accSession();
  const c = { 'sgx-account-session': s };
  assert.equal((await (await post(env, { action: 'device-revoke', deviceId: TEST_DEVICE_ID }, c)).json()).error, 'current');
  assert.equal((await post(env, { action: 'device-revoke', deviceId: 'nosuchdevice1' }, c)).status, 404);
  assert.equal((await post(env, { action: 'device-revoke', deviceId: 'a.b' }, c)).status, 400);
  assert.equal((await post(env, { action: 'device-revoke', deviceId: 'otherdevice01' }, c)).status, 200);
  const other = await accSession('password', 0, Date.now(), { deviceId: 'otherdevice01' });
  const r = await post(env, { action: 'device-list' }, { 'sgx-account-session': other });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).reason, 'revoked');
  assert.deepEqual(events(env), ['device-revoke']);
});

test('logout：本机设备行拉黑（revoked_at > 0），同一张票之后不再有效', async () => {
  const env = makeEnv();
  const s = await accSession();
  await post(env, { action: 'logout' }, { 'sgx-account-session': s });
  assert.ok(one(env, 'SELECT revoked_at FROM device WHERE device_id = ?', TEST_DEVICE_ID).revoked_at > 0);
  assert.equal((await (await get(env, { 'sgx-account-session': s })).json()).session, null);
});

test('device-revoke-all（新）：要账号会话 + AccountReauthTicket；Account 纪元 +1，当前设备重签，其他设备行全删、它们的票失效；记安全事件', async () => {
  const env = makeEnv();
  await devices.putDevice(env, { deviceId: 'otherdevice01', by: 'password', lastSeen: Date.now() });
  await devices.putDevice(env, { deviceId: 'otherdevice02', by: 'password', lastSeen: Date.now() });
  await devices.putDevice(env, { deviceId: TEST_DEVICE_ID, by: 'password', lastSeen: Date.now() });
  const otherTicket = await accSession('password', 0, Date.now(), { deviceId: 'otherdevice01' });
  const c = await full('password');
  const r = await post(env, { action: 'device-revoke-all' }, c);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal(epochOf(env), 1);
  const ns = parseSess(pickCookie(r, 'sgx-account-session'));
  assert.deepEqual([ns.epoch, ns.deviceId], [1, TEST_DEVICE_ID]);
  assert.ok(pickCookie(r, 'sgx-account-reauth').startsWith('password.1.'));
  assert.deepEqual(all(env, 'SELECT device_id FROM device').map((d) => d.device_id), [TEST_DEVICE_ID]);
  assert.equal((await (await get(env, { 'sgx-account-session': otherTicket })).json()).session, null);
  assert.equal((await (await get(env, { 'sgx-account-session': pickCookie(r, 'sgx-account-session') })).json()).session.by, 'password');
  assert.deepEqual(events(env), ['device-revoke-all']);
});

test('device-revoke-all：只有会话没 reauth 票 403 reauth；会话 + reset 票也不行（只认 reauth 票）；纪元推不动 503 epoch', async () => {
  const env = makeEnv();
  const s = await accSession();
  const r1 = await post(env, { action: 'device-revoke-all' }, { 'sgx-account-session': s });
  assert.equal(r1.status, 403);
  assert.equal((await r1.json()).error, 'reauth');
  const r2 = await post(env, { action: 'device-revoke-all' }, { 'sgx-account-session': s, 'sgx-account-reset': await reset(0) });
  assert.equal(r2.status, 403);
  assert.equal(epochOf(env), 0);
  const c = await full();
  env.D1_ACCOUNT_AUTH = failing(env.D1_ACCOUNT_AUTH, (q) => /^UPDATE epoch/.test(q));
  const r3 = await post(env, { action: 'device-revoke-all' }, c);
  assert.equal(r3.status, 503);
  assert.equal((await r3.json()).error, 'epoch');
});

test('设备「上次活动地点」：读 X-Styrigx-Client-Country / City，不读 request.cf；验会话超过 30 分钟刷新 lastSeen 和地点', async () => {
  const req = new Request(URL_, { headers: { 'X-Styrigx-Client-Country': 'JP', 'X-Styrigx-Client-City': 'Tokyo\u0007', 'User-Agent': 'Mozilla/5.0 (Linux; Android 14; SM-S918B Build/X) Chrome/120' } });
  Object.defineProperty(req, 'cf', { value: { country: 'US', city: 'Ashburn' } });
  const info = devices.deviceInfo(req, null);
  assert.deepEqual([info.country, info.city, info.platform, info.browser, info.model], ['JP', '', 'Android', 'Chrome', 'SM-S918B'], '带控制字符的城市整项不认（lib/lock-identity.js readClientContext 白名单）');
  const env = makeEnv();
  await devices.putDevice(env, { deviceId: TEST_DEVICE_ID, by: 'password', country: 'CN', city: 'Beijing', lastSeen: Date.now() - 31 * 60 * 1000 });
  raw(env).prepare('UPDATE device SET last_seen = ?').run(Date.now() - 31 * 60 * 1000);
  await get(env, { 'sgx-account-session': await accSession() }, { identity: { country: 'SG', city: 'Singapore' } });
  const rec = JSON.parse(one(env, 'SELECT record FROM device').record);
  assert.deepEqual([rec.country, rec.city], ['SG', 'Singapore']);
  assert.ok(rec.lastSeen > Date.now() - 5000);
});

test('设备记录不会被复活：已退出的 deviceId 再 putDevice / recordLogin 不改 revoked_at；revokeDevice 对没有的 id 也插一行已退出的', async () => {
  const env = makeEnv();
  await devices.revokeDevice(env, 'ghostdevice01');
  const r0 = one(env, 'SELECT revoked_at, expires_at FROM device WHERE device_id = ?', 'ghostdevice01');
  assert.ok(r0.revoked_at > 0 && r0.expires_at > Date.now() + 399 * 24 * 3600 * 1000);
  await devices.putDevice(env, { deviceId: 'ghostdevice01', by: 'password', lastSeen: Date.now() });
  await devices.recordLogin(env, 'ghostdevice01', 'password', Date.now(), {});
  assert.equal(one(env, 'SELECT revoked_at FROM device WHERE device_id = ?', 'ghostdevice01').revoked_at, r0.revoked_at);
  assert.equal(await devices.isRevoked(env, 'ghostdevice01'), true);
  assert.equal(await devices.getDevice(env, 'ghostdevice01'), null);
});

test('设备列表上限 DEVICE_LIST_MAX=50（最近活跃在前）；当前设备没排进去时单独补上、排第一', async () => {
  const env = makeEnv();
  const now = Date.now();
  for (let i = 0; i < 55; i++) await devices.putDevice(env, { deviceId: 'bulkdevice' + String(i).padStart(3, '0'), by: 'password', lastSeen: now - i });
  await devices.putDevice(env, { deviceId: TEST_DEVICE_ID, by: 'password', lastSeen: now - 100000 });
  const j = await (await post(env, { action: 'device-list' }, { 'sgx-account-session': await accSession() })).json();
  assert.equal(devices.DEVICE_LIST_MAX, 50);
  assert.equal(j.devices.length, 51);
  assert.equal(j.devices[0].deviceId, TEST_DEVICE_ID);
  assert.equal(j.devices[1].deviceId, 'bulkdevice000');
});

/* ================= 票：与网关格式一致 ================= */

test('切换不掉线：网关签的账号会话 / reauth / reset 票（同一对钥匙、同纪元）在账号 Worker 照样有效', async () => {
  const gwSess = await import('../../../workers/auth-gateway/functions/_kernel/account-session.js');
  const gwTickets = await import('../../../workers/auth-gateway/functions/_kernel/tickets.js');
  const env = makeEnv();
  setEpoch(env, 7);
  const s = await gwSess.signAccountSessionTicket(K.ACCOUNT.priv, { by: 'passkey', epoch: 7, authAt: Date.now(), deviceId: TEST_DEVICE_ID });
  const rt = await gwTickets.signAccountReauthTicket(K.ACCOUNT.priv, 'root', 7);
  const xt = await gwTickets.signAccountResetTicket(K.ACCOUNT.priv, 'root', 7);
  const j = await (await get(env, { 'sgx-account-session': s, 'sgx-account-reauth': rt, 'sgx-account-reset': xt })).json();
  assert.equal(j.session.by, 'passkey');
  assert.equal(j.reauth.by, 'root');
  assert.equal(j.reset.by, 'root');
  /* 反过来：这里签的会话票，网关的解析器认同一格式 */
  const mine = await accSession('password', 7);
  assert.deepEqual(gwSess.parseAccountSessionTicket(mine), session.parseAccountSessionTicket(mine));
});

test('账号会话：篡改 deviceId → bad-sig；别的钥匙签 → bad-sig；纪元不对 → epoch-changed；五段旧格式 → bad-format；锁屏会话 cookie 不算', async () => {
  const env = makeEnv();
  const v = async (val, name = 'sgx-account-session') => session.verifyAccountSession(new Request(URL_, { headers: { Cookie: name + '=' + val } }), env);
  const s = await accSession();
  const parts = s.split('.');
  parts[4] = 'tamperdevice01';
  assert.equal((await v(parts.join('.'))).reason, 'bad-sig');
  assert.equal((await v(await accSession('password', 0, Date.now(), { priv: K.OTHER.priv }))).reason, 'bad-sig');
  assert.equal((await v(await accSession('password', 3))).reason, 'epoch-changed');
  assert.equal((await v(s.split('.').filter((_, i) => i !== 4).join('.'))).reason, 'bad-format');
  assert.equal((await v(s, 'sgx-lock-session')).reason, 'no-cookie');
  assert.equal((await v(s)).ok, true);
});

test('会话票不能当 reset 票用，reauth 票不能当 reset 票用（签名串带 cookie 名前缀）', async () => {
  const env = makeEnv();
  const r = await post(env, { action: 'passkey-list' }, { 'sgx-account-reset': await reauth('root', 0) });
  assert.equal(r.status, 401);
  const r2 = await post(env, { action: 'passkey-list' }, { 'sgx-account-reset': await accSession() });
  assert.equal(r2.status, 401);
});

test('短票：缺账号钥匙时 issueTicket 503 config；verifyTicket 纪元读不到 d1-error（fail closed）', async () => {
  const h = new Headers();
  assert.deepEqual(await session.issueTicket(makeEnv({ SGX_ACCOUNT_PRIVATE: '' }), h, 'AccountReauthTicket', 'password'), { status: 503, body: { ok: false, error: 'config' } });
  const env = makeEnv();
  const t = await reauth('password', 0);
  env.D1_ACCOUNT_AUTH = failing(env.D1_ACCOUNT_AUTH, (s) => /FROM epoch/.test(s));
  const v = await session.verifyTicket(new Request(URL_, { headers: { Cookie: 'sgx-account-reauth=' + t } }), env, 'AccountReauthTicket');
  assert.equal(v.reason, 'd1-error');
  await assert.rejects(() => session.signTicket(K.ACCOUNT.priv, 'AccountSessionTicket', 'password', 0), /bad ticket/);
});

/* ================= 存储：账号库自己的表 ================= */

test('ACCOUNT_AUTH_SCHEMA 与 migrations/0003_account_auth.sql 逐条一致；ACCOUNT_DB_REALM = REALM_ACCOUNT + schema', async () => {
  const { readAccountSchema } = await import('../../../scripts/migrate-account-auth.mjs');
  assert.deepEqual([...store.ACCOUNT_AUTH_SCHEMA], readAccountSchema(REPO));
  const { schema, ...rest } = store.ACCOUNT_DB_REALM;
  assert.deepEqual(rest, { ...realm.REALM_ACCOUNT });
  assert.equal(schema, store.ACCOUNT_AUTH_SCHEMA);
  assert.ok(Object.isFrozen(store.ACCOUNT_DB_REALM));
});

test('空账号库（迁移没跑）：第一次请求按本库 0003 建表（user_handle 带 legacy_handle，没有 tempkey / kv_migration），之后读写照常', async () => {
  const env = makeEnv({ D1_ACCOUNT_AUTH: makeAccountD1({ migrations: false }) });
  const r = await post(env, { action: 'passkey-register-challenge' }, await full());
  assert.equal(r.status, 200);
  const tables = all(env, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((t) => t.name);
  assert.deepEqual(tables, ['attempt_limit', 'audit', 'challenge', 'data_migration', 'device', 'epoch', 'passkey', 'password', 'user_handle']);
  assert.deepEqual(all(env, 'PRAGMA table_info(user_handle)').map((c) => c.name), ['realm', 'handle', 'legacy_handle']);
  assert.ok(one(env, 'SELECT handle FROM user_handle').handle);
});

test('依赖边界：identity/ 只 import ../lib/ 和本目录；不碰网关、锁屏表、锁屏头以外的东西', () => {
  for (const f of readdirSync(ID_DIR)) {
    const src = readFileSync(ID_DIR + f, 'utf8');
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
      const spec = m[1];
      assert.ok(spec.startsWith('./') || /^\.\.\/lib\/[a-z0-9-]+\.js$/.test(spec), f + ' imports ' + spec);
    }
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /auth-gateway|D1_LOCK_AUTH|SGX_LOCK_|SGX_ROOT_KEY|SGX_ADMIN_KEY|CF-Connecting-IP|request\.cf|tempkey \(|recovery_switch/, f);
  }
});

test('device-list / device-revoke：读设备 D1 出错 → 503 server', async () => {
  const env = makeEnv();
  const s = await accSession();
  /* 会话验证本身要读 device（isRevoked）：只让列表 / 单台读取那两条 SQL 出错 */
  env.D1_ACCOUNT_AUTH = failing(env.D1_ACCOUNT_AUTH, (q) => /ORDER BY last_seen DESC/.test(q));
  const r = await post(env, { action: 'device-list' }, { 'sgx-account-session': s });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, 'server');
});

test('login-challenge：challenge 写不进去 → 500 server；login-passkey 的 challenge 读出错按无效处理 → 403 challenge', async () => {
  const env = makeEnv();
  const { kp, credId } = await seedPasskey(env);
  const db = env.D1_ACCOUNT_AUTH;
  env.D1_ACCOUNT_AUTH = failing(db, (q) => /^INSERT INTO challenge/.test(q));
  const r = await post(env, { action: 'login-challenge' });
  assert.equal(r.status, 500);
  env.D1_ACCOUNT_AUTH = failing(db, (q) => /^DELETE FROM challenge/.test(q));
  const r2 = await post(env, { action: 'login-passkey', cid: 'whatever', credential: await assertion(kp, credId, 'abc') });
  assert.equal(r2.status, 403);
  assert.equal((await r2.json()).error, 'challenge');
});

test('安全事件只记 IP 前缀（不存完整 IP），保留 30 天；写不进去不挡操作', async () => {
  const env = makeEnv();
  await seedPasskey(env);
  const a = await seedPasskey(env);
  await post(env, { action: 'passkey-rename', credId: a.credId, name: 'n1' }, await full(), { identity: { ip: '203.0.113.77' } });
  const row = one(env, "SELECT ip_prefix, ok, ts, expires_at, decoy, via FROM audit WHERE path = 'passkey-rename'");
  assert.deepEqual([row.ip_prefix, row.ok, row.decoy, row.via], ['203.0.113.x', 1, 0, '']);
  assert.equal(row.expires_at - row.ts, 30 * 24 * 3600 * 1000);
  env.D1_ACCOUNT_AUTH = failing(env.D1_ACCOUNT_AUTH, (q) => /^INSERT INTO audit/.test(q));
  const r = await post(env, { action: 'passkey-rename', credId: a.credId, name: 'n2' }, await full());
  assert.equal(r.status, 200);
});

test('login-password 旧记录（无 peppered 标记，按无 pepper 校验）：登录成功后重写成带 pepper 的新记录', async () => {
  const env = makeEnv();
  const { makePasswordRecord } = await import('../../../workers/account/src/lib/password.js');
  const old = await makePasswordRecord('right-password-1', '');
  delete old.peppered;
  raw(env).prepare("INSERT INTO password (realm, record) VALUES ('account', ?)").run(JSON.stringify(old));
  const r = await post(env, { action: 'login-password', password: 'right-password-1' });
  assert.equal(r.status, 200);
  const now = JSON.parse(one(env, 'SELECT record FROM password').record);
  assert.equal(now.peppered, true);
  assert.notEqual(now.hash, old.hash);
  assert.equal((await post(env, { action: 'login-password', password: 'right-password-1' })).status, 200);
});
