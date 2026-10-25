/**
 * B1-9 验收测试：访客假入口统一 401（直接调用 Pages Functions 的 onRequestPost，不需要 Miniflare）。
 *
 * 验收标准：
 * 1. KV 全空、KV 有凭证两种情况下，访客提交任意值都返回同一个 401 和同一 body
 * 2. 用 KV 代理计数断言该请求 KV 访问次数为 0（不读存储，也到不了根凭证比对）
 * 3. root-auth 和 lock-reset 都测；lock-reset 再测「带对的 RootKey 也一样」和对照组（无访客会话 → 真比对）
 * 4. looksVisitor 只认六段的 LockSessionTicket（by.role.epoch.exp.tempkeyId.sig）
 *
 * 运行：node --test tests/workers/auth-gateway/b1-9-guest-401.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testLockSession, TEST_TEMPKEY_ID } from './_tickets.mjs';
import { looksVisitor } from '../../../workers/auth-gateway/functions/_kernel/lock-session.js';
import { ed25519Sign } from '../../../workers/auth-gateway/functions/_kernel/crypto.js';
import { onRequestPost as rootAuthPost } from '../../../workers/auth-gateway/functions/api/root-auth.js';
import { onRequestPost as lockResetPost } from '../../../workers/auth-gateway/functions/api/lock-reset.js';
import { genKeyPair } from '../_harness.mjs';

const ROOT_KEY = 'test-root-key-12345';
const EXPECTED_BODY = JSON.stringify({ ok: false, error: 'denied' });

const { priv: PRIV, pub: PUB } = await genKeyPair();
const RP = { SGX_RP_ID: 'styrigx.com', SGX_ORIGIN: 'https://styrigx.com' };

/* 带计数的 KV：get / put / delete / list 都记次数 */
function makeCountingKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  const calls = { get: 0, put: 0, delete: 0, list: 0 };
  return {
    get: async (k, fmt) => {
      calls.get++;
      const v = store.has(k) ? store.get(k) : null;
      if (v === null) return null;
      return fmt === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v) => { calls.put++; store.set(k, v); },
    delete: async (k) => { calls.delete++; store.delete(k); },
    list: async ({ prefix = '' } = {}) => { calls.list++; return { keys: [...store.keys()].filter((n) => n.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
    calls,
    store,
  };
}
const totalCalls = (kv) => kv.calls.get + kv.calls.put + kv.calls.delete + kv.calls.list;

function post(path, body, cookie, ip = '203.0.113.9') {
  const headers = { 'Content-Type': 'application/json', Origin: 'https://styrigx.com', 'CF-Connecting-IP': ip };
  if (cookie) headers.Cookie = cookie;
  return new Request('https://styrigx.com' + path, { method: 'POST', headers, body: JSON.stringify(body) });
}
const env = (kv) => ({ SGX_LOCK_PUBLIC: PUB, SGX_LOCK_PRIVATE: PRIV, SGX_ROOT_KEY: ROOT_KEY, KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv, ...RP });
const visitorCookie = async () => 'sgx-lock-session=' + (await testLockSession(PRIV, 0, 'visitor'));

/* KV 里有凭证：锁屏密码 + 账号层标记（lock-reset 的真路径会读到它们） */
const CONFIGURED = { 'lock-password': JSON.stringify({ h: 'x' }), 'account-configured': '1', 'lock-configured': '1' };

/* ============ looksVisitor ============ */

test('looksVisitor：六段访客票 → true；admin、五段旧格式、乱值、没 cookie → false', async () => {
  const req = (cookie) => new Request('https://styrigx.com/', { headers: cookie ? { Cookie: cookie } : {} });
  const visitor = await testLockSession(PRIV, 0, 'visitor');
  const admin = await testLockSession(PRIV, 0, 'admin');
  assert.equal(visitor.split('.').length, 6, '访客票六段');
  assert.equal(looksVisitor(req('sgx-lock-session=' + visitor)), true);
  assert.equal(looksVisitor(req('a=1; sgx-lock-session=' + visitor + '; b=2')), true, '夹在别的 cookie 中间');
  assert.equal(looksVisitor(req('sgx-lock-session=bad; sgx-lock-session=' + visitor)), true, '同名多值里任一是访客');
  assert.equal(looksVisitor(req('sgx-lock-session=' + admin)), false);
  /* 以前 lock-reset 认的五段格式（没有 tempkeyId 段）已经不是合法票 */
  const p5 = 'tempkey.visitor.0.' + (Date.now() + 3600e3);
  const five = p5 + '.' + (await ed25519Sign(PRIV, 'sgx-lock-session|' + p5));
  assert.equal(five.split('.').length, 5);
  assert.equal(looksVisitor(req('sgx-lock-session=' + five)), false);
  assert.equal(looksVisitor(req('sgx-lock-session=x.visitor.0.1.' + TEST_TEMPKEY_ID + '.sig')), false, 'by 不是 tempkey');
  assert.equal(looksVisitor(req('sgx-lock-session=garbage')), false);
  assert.equal(looksVisitor(req('')), false);
  assert.equal(looksVisitor(req('sgx-lock-reset=' + visitor)), false, '别的 cookie 名不算');
});

/* ============ root-auth ============ */

test('root-auth：访客会话，KV 空 vs 有凭证 → 同一 401/body，KV 一次都不碰', async () => {
  const cookie = await visitorCookie();
  const bodies = [];
  for (const seed of [{}, CONFIGURED]) {
    const kv = makeCountingKv(seed);
    const res = await rootAuthPost({ request: post('/api/root-auth', { key: 'any-value-' + Math.random(), purpose: 'lock-reset' }, cookie), env: env(kv) });
    assert.equal(res.status, 401);
    const body = await res.text();
    assert.equal(body, EXPECTED_BODY);
    bodies.push(body);
    assert.equal(totalCalls(kv), 0, 'KV 访问次数应为 0：' + JSON.stringify(kv.calls));
  }
  assert.equal(bodies[0], bodies[1]);
});

/* ============ lock-reset ============ */

test('lock-reset：访客会话，KV 空 vs 有凭证 → 同一 401/body，KV 一次都不碰', async () => {
  const cookie = await visitorCookie();
  const bodies = [];
  for (const seed of [{}, CONFIGURED]) {
    const kv = makeCountingKv(seed);
    const res = await lockResetPost({ request: post('/api/lock-reset', { action: 'verify', rootKey: 'wrong-' + Math.random() }, cookie), env: env(kv) });
    assert.equal(res.status, 401);
    const body = await res.text();
    assert.equal(body, EXPECTED_BODY);
    bodies.push(body);
    assert.equal(totalCalls(kv), 0, 'KV 访问次数应为 0：' + JSON.stringify(kv.calls));
  }
  assert.equal(bodies[0], bodies[1]);
});

test('lock-reset：访客带对的 RootKey 也是假 401，不比对、不计数、不写审计、不签票', async () => {
  const cookie = await visitorCookie();
  for (const seed of [{}, CONFIGURED]) {
    const kv = makeCountingKv(seed);
    const before = [...kv.store.keys()].sort();
    for (const action of ['verify', 'status', 'challenge']) {
      const res = await lockResetPost({ request: post('/api/lock-reset', { action, rootKey: ROOT_KEY }, cookie), env: env(kv) });
      assert.equal(res.status, 401, action);
      assert.equal(await res.text(), EXPECTED_BODY, action);
      assert.equal(res.headers.get('Set-Cookie'), null, action + '：不签任何票');
    }
    assert.equal(totalCalls(kv), 0, JSON.stringify(kv.calls));
    assert.deepEqual([...kv.store.keys()].sort(), before, '没有 root-fail / root-audit / 开关记录');
  }
});

test('lock-reset：访客假入口先于 Origin / 方法检查（与以前一致），没有 Origin 也是同一个 401', async () => {
  const kv = makeCountingKv();
  const req = new Request('https://styrigx.com/api/lock-reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: await visitorCookie() },
    body: JSON.stringify({ action: 'verify', rootKey: 'x' }),
  });
  const res = await lockResetPost({ request: req, env: env(kv) });
  assert.equal(res.status, 401);
  assert.equal(await res.text(), EXPECTED_BODY);
  assert.equal(totalCalls(kv), 0);
});

test('lock-reset 对照组：没有访客会话 / admin 会话 → 真比对 RootKey（错了 401 auth，计数、写审计）', async () => {
  for (const cookie of ['', 'sgx-lock-session=' + (await testLockSession(PRIV, 0, 'admin'))]) {
    const kv = makeCountingKv();
    const res = await lockResetPost({ request: post('/api/lock-reset', { action: 'verify', rootKey: 'wrong' }, cookie, '198.51.100.7'), env: env(kv) });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { ok: false, error: 'auth' }, '真比对失败是 auth，不是访客的 denied');
    assert.ok(kv.calls.get > 0, '真路径要读限速');
    assert.ok(kv.store.has('root-fail:198.51.100.7'), '真比对失败计入单 IP');
    assert.ok([...kv.store.keys()].some((k) => k.startsWith('root-audit:')), '写审计');
  }
});

test('lock-reset：五段旧格式的「访客」cookie 不再被当成访客（不是合法票，按无会话走真路径）', async () => {
  const p5 = 'tempkey.visitor.0.' + (Date.now() + 3600e3);
  const five = 'sgx-lock-session=' + p5 + '.' + (await ed25519Sign(PRIV, 'sgx-lock-session|' + p5));
  const kv = makeCountingKv();
  const res = await lockResetPost({ request: post('/api/lock-reset', { action: 'verify', rootKey: 'wrong' }, five, '198.51.100.8'), env: env(kv) });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { ok: false, error: 'auth' });
});
