/**
 * 网关写身份头的一侧（账号拆分 PR3，方案第 3 节）：
 * - functions/_kernel/lib/lock-identity.js：头名常量、stripInternalHeaders、writeLockIdentity（只写白名单里的值）
 * - src/index.js 第一步剥掉外来的 x-styrigx-* / x-sgx-role；账号路径（src/forwarding.js）门过了才经 ACCOUNT 转发，
 *   身份头由网关按验过的锁屏会话写；ACCOUNT 没绑 / 出错 → 503 upstream（fail closed）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mod from '../../../workers/auth-gateway/functions/_kernel/lib/lock-identity.js';
import {
  LOCK_IDENTITY_HEADERS, CLIENT_CONTEXT_HEADERS, INTERNAL_HEADER_PREFIX, stripInternalHeaders, writeLockIdentity,
} from '../../../workers/auth-gateway/functions/_kernel/lib/lock-identity.js';
import { FORWARDING, matchForwarding } from '../../../workers/auth-gateway/src/forwarding.js';
import { testLockSession } from './_tickets.mjs';
import { genKeyPair, authD1For, makeKV } from '../_harness.mjs';

const worker = (await import('../../../workers/auth-gateway/src/index.js')).default;
const { _resetSecretCache } = await import('../../../workers/auth-gateway/src/secrets.js');
const { priv: PRIV, pub: PUB } = await genKeyPair();
const CTX = { waitUntil() {} };

test('导出：三个头名常量 + stripInternalHeaders / writeLockIdentity（网关只写不读）', () => {
  assert.deepEqual(Object.keys(mod).sort(), ['CLIENT_CONTEXT_HEADERS', 'INTERNAL_HEADER_PREFIX', 'LOCK_IDENTITY_HEADERS', 'stripInternalHeaders', 'writeLockIdentity']);
});

test('头名逐字固定', () => {
  assert.deepEqual({ ...LOCK_IDENTITY_HEADERS }, {
    role: 'X-Styrigx-Lock-Role',
    by: 'X-Styrigx-Lock-By',
    tempkeyId: 'X-Styrigx-Lock-Tempkey-Id',
  });
  assert.deepEqual({ ...CLIENT_CONTEXT_HEADERS }, {
    address: 'X-Styrigx-Client-Address',
    country: 'X-Styrigx-Client-Country',
    city: 'X-Styrigx-Client-City',
  });
  assert.equal(INTERNAL_HEADER_PREFIX, 'x-styrigx-');
});

test('常量冻结，不可改', () => {
  assert.ok(Object.isFrozen(LOCK_IDENTITY_HEADERS));
  assert.ok(Object.isFrozen(CLIENT_CONTEXT_HEADERS));
});

test('所有头名都以内部前缀开头（小写比较），且互不重复', () => {
  const all = [...Object.values(LOCK_IDENTITY_HEADERS), ...Object.values(CLIENT_CONTEXT_HEADERS)];
  for (const h of all) assert.ok(h.toLowerCase().startsWith(INTERNAL_HEADER_PREFIX), h);
  assert.equal(new Set(all.map((h) => h.toLowerCase())).size, all.length);
  const hd = new Headers();
  for (const h of all) hd.set(h, '1');
  assert.equal([...hd.keys()].length, all.length);
});

test('stripInternalHeaders：任意大小写的 x-styrigx-* 和旧 x-sgx-role 都删，别的头不动', () => {
  const h = new Headers({ 'X-STYRIGX-LOCK-ROLE': 'admin', 'x-styrigx-whatever': '1', 'X-Sgx-Role': 'admin', Cookie: 'a=1', 'X-Sgx-Other': 'keep' });
  stripInternalHeaders(h);
  assert.deepEqual([...h.keys()].sort(), ['cookie', 'x-sgx-other']);
});

test('writeLockIdentity：先剥再写；admin / 访客（带合规 tempkeyId）；不认识的角色、ok:false → 不写身份头；上下文不合规的项不写', () => {
  const w = (s, c, init) => Object.fromEntries([...writeLockIdentity(new Headers(init || {}), s, c)]);
  assert.deepEqual(w({ ok: true, role: 'admin', by: 'password', tempkeyId: 'tk1' }, { address: '1.2.3.4', country: 'JP', city: 'Tokyo' }, { 'X-Styrigx-Lock-Role': 'visitor' }), {
    'x-styrigx-lock-role': 'admin', 'x-styrigx-lock-by': 'password',
    'x-styrigx-client-address': '1.2.3.4', 'x-styrigx-client-country': 'JP', 'x-styrigx-client-city': 'Tokyo',
  });
  assert.deepEqual(w({ ok: true, role: 'visitor', by: 'tempkey', tempkeyId: 'tk_01' }, {}), {
    'x-styrigx-lock-role': 'visitor', 'x-styrigx-lock-by': 'tempkey', 'x-styrigx-lock-tempkey-id': 'tk_01',
  });
  assert.deepEqual(w({ ok: true, role: 'owner' }, {}, { 'X-Styrigx-Lock-Role': 'admin' }), {}, '外来的头剥掉，不认识的角色不写');
  assert.deepEqual(w({ ok: false, role: 'admin' }, {}), {});
  assert.deepEqual(w(null, { address: 'evil; x', country: 'JAPAN', city: 'a\u0007b' }), {});
});

test('转发表：五条都转给 ACCOUNT；/api/* 只认路径本身或子路径（/api/prefsX 不转）；页面不转', () => {
  assert.deepEqual(FORWARDING.map((r) => r.path), ['/api/account', '/api/prefs', '/api/avatar', '/api/wellbeing', '/avatar/']);
  for (const r of FORWARDING) assert.equal(r.binding, 'ACCOUNT');
  assert.equal(matchForwarding('/api/prefs/x').path, '/api/prefs');
  assert.equal(matchForwarding('/avatar/96.webp').path, '/avatar/');
  for (const p of ['/api/prefsX', '/api/accounts', '/account/', '/api/lock-entry', '/avatar']) assert.equal(matchForwarding(p), null, p);
});

/* ---------- 经 worker.fetch 的转发 ---------- */

function env(extra) {
  return Object.assign({ SGX_ENV: 'production', SGX_SITE: 'space', SGX_LOCK_PUBLIC: PUB, D1_LOCK_AUTH: authD1For(makeKV()) }, extra || {});
}
function fakeAccount() {
  const seen = [];
  return {
    seen,
    async fetch(req) {
      seen.push({ url: req.url, method: req.method, headers: Object.fromEntries([...req.headers]), body: await req.text() });
      return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json', 'X-SGX-Runtime': 'account' } });
    },
  };
}
const FORGED = { 'X-Styrigx-Lock-Role': 'admin', 'x-styrigx-lock-by': 'password', 'X-Styrigx-Client-Address': '6.6.6.6', 'X-Sgx-Role': 'admin' };

test('伪造身份头、没有锁屏会话：/api/prefs、/api/account → 网关 401，账号 Worker 一次都没被调', async () => {
  _resetSecretCache();
  const acct = fakeAccount();
  for (const p of ['/api/prefs', '/api/account', '/api/wellbeing']) {
    const res = await worker.fetch(new Request('https://styrigx.com' + p, { headers: FORGED }), env({ ACCOUNT: acct }), CTX);
    assert.equal(res.status, 401, p);
  }
  assert.equal(acct.seen.length, 0);
});

test('admin 会话：转发原样带 URL / 方法 / 正文 / Cookie / Origin；外来身份头剥掉，按验过的会话重写；客户端上下文取自 CF-Connecting-IP / cf', async () => {
  _resetSecretCache();
  const acct = fakeAccount();
  const ck = 'sgx-lock-session=' + (await testLockSession(PRIV, 0, 'admin', 'passkey'));
  const req = new Request('https://styrigx.com/api/account?x=1', {
    method: 'POST',
    headers: { ...FORGED, 'X-Styrigx-Lock-Role': 'visitor', Cookie: ck, Origin: 'https://styrigx.com', 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
    body: '{"action":"device-list"}',
  });
  Object.defineProperty(req, 'cf', { value: { country: 'JP', city: 'Osaka' } });
  const res = await worker.fetch(req, env({ ACCOUNT: acct }), CTX);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-SGX-Runtime'), 'account', '账号写的运行时标记保留（部署冒烟认它）');
  assert.equal(acct.seen.length, 1);
  const f = acct.seen[0];
  assert.equal(f.url, 'https://styrigx.com/api/account?x=1');
  assert.equal(f.method, 'POST');
  assert.equal(f.body, '{"action":"device-list"}');
  assert.equal(f.headers.cookie, ck);
  assert.equal(f.headers.origin, 'https://styrigx.com', '同源在转发后仍成立');
  assert.equal(f.headers['x-styrigx-lock-role'], 'admin');
  assert.equal(f.headers['x-styrigx-lock-by'], 'passkey');
  assert.equal(f.headers['x-styrigx-client-address'], '203.0.113.9', '不是客户端伪造的 6.6.6.6');
  assert.equal(f.headers['x-styrigx-client-country'], 'JP');
  assert.equal(f.headers['x-styrigx-client-city'], 'Osaka');
  assert.equal(f.headers['x-sgx-role'], undefined);
  assert.equal(f.headers['x-styrigx-lock-tempkey-id'], undefined);
});

test('访客会话：/api/prefs、/api/account → 网关 403 role 不转发；/api/wellbeing 转发、身份头写 visitor', async () => {
  _resetSecretCache();
  const acct = fakeAccount();
  const ck = 'sgx-lock-session=' + (await testLockSession(PRIV, 0, 'visitor'));
  const e = env({ ACCOUNT: acct });
  for (const p of ['/api/prefs', '/api/account']) {
    const res = await worker.fetch(new Request('https://styrigx.com' + p, { headers: { Cookie: ck } }), e, CTX);
    assert.equal(res.status, 403, p);
    assert.equal((await res.json()).error, 'role', p);
  }
  assert.equal(acct.seen.length, 0, '访客进不了账号接口');
  const res = await worker.fetch(new Request('https://styrigx.com/api/wellbeing?d=2026-10-30', { headers: { Cookie: ck, ...FORGED } }), e, CTX);
  assert.equal(res.status, 200);
  assert.equal(acct.seen.length, 1);
  assert.equal(acct.seen[0].headers['x-styrigx-lock-role'], 'visitor');
  assert.equal(acct.seen[0].headers['x-styrigx-lock-by'], 'tempkey');
  assert.equal(acct.seen[0].headers['x-styrigx-lock-tempkey-id'], 'tktesttesttest01');
});

test('ACCOUNT 没绑 / fetch 抛错 → 503 upstream（不落回网关路由表、不回源）', async () => {
  _resetSecretCache();
  const ck = 'sgx-lock-session=' + (await testLockSession(PRIV, 0, 'admin', 'password'));
  const orig = globalThis.fetch;
  let origin = 0;
  globalThis.fetch = async () => { origin++; return new Response('PAGE'); };
  try {
    for (const ACCOUNT of [undefined, { fetch: async () => { throw new Error('down'); } }]) {
      for (const p of ['/api/prefs', '/avatar/96.webp']) {
        const res = await worker.fetch(new Request('https://styrigx.com' + p, { headers: { Cookie: ck } }), env({ ACCOUNT }), CTX);
        assert.equal(res.status, 503, p);
        assert.deepEqual(await res.json(), { ok: false, error: 'upstream' });
      }
    }
  } finally { globalThis.fetch = orig; }
  assert.equal(origin, 0);
});

test('不在转发表里的路径（/api/prefsX）不转发：有会话 → 网关路由表 404', async () => {
  _resetSecretCache();
  const acct = fakeAccount();
  const ck = 'sgx-lock-session=' + (await testLockSession(PRIV, 0, 'admin', 'password'));
  const res = await worker.fetch(new Request('https://styrigx.com/api/prefsX', { headers: { Cookie: ck } }), env({ ACCOUNT: acct }), CTX);
  assert.equal(res.status, 404);
  assert.equal(acct.seen.length, 0);
});

test('静态直通和页面回源也先剥头：回源请求里没有外来的 x-styrigx-* / x-sgx-role', async () => {
  _resetSecretCache();
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (req) => { seen.push(Object.fromEntries([...req.headers])); return new Response('x', { headers: { 'Content-Type': 'text/css' } }); };
  try {
    await worker.fetch(new Request('https://styrigx.com/css/main.css', { headers: FORGED }), env(), CTX);
    const ck = 'sgx-lock-session=' + (await testLockSession(PRIV, 0, 'admin', 'password'));
    await worker.fetch(new Request('https://styrigx.com/settings/', { headers: { ...FORGED, Cookie: ck } }), env(), CTX);
  } finally { globalThis.fetch = orig; }
  assert.equal(seen.length, 2);
  for (const h of seen) {
    for (const k of Object.keys(h)) assert.ok(!k.startsWith('x-styrigx-') && k !== 'x-sgx-role', k);
  }
});
