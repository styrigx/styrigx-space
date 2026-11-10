/**
 * 网关写身份头的一侧（账号拆分 PR3，方案第 3 节）：
 * - src/core/lock-identity.js：头名常量、stripInternalHeaders、writeLockIdentity（只写白名单里的值）
 * - 授权骨架 P2-1：有身份时额外写 X-Styrigx-Space-Session: 1（与 X-Styrigx-Space-Level 并存）；没身份不写；浏览器伪造的同名头剥掉
 * - src/app.js 第一步剥掉外来的 x-styrigx-* / x-sgx-legacy；账号路径（src/router.js 的 FORWARDING）门过了才经 ACCOUNT 转发，
 *   身份头由网关按验过的进站会话写；ACCOUNT 没绑 / 出错 → 503 upstream（fail closed）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mod from '../../../workers/space-core/src/core/lock-identity.js';
import {
  LOCK_IDENTITY_HEADERS, CLIENT_CONTEXT_HEADERS, INTERNAL_HEADER_PREFIX, stripInternalHeaders, writeLockIdentity,
} from '../../../workers/space-core/src/core/lock-identity.js';
import { FORWARDING, matchForwarding } from '../../../workers/space-core/src/router.js';
import { testLockSession, TEST_LINK_ID } from './_tickets.mjs';
import { genKeyPair, authD1For, makeKV } from '../_harness.mjs';

const worker = (await import('../../../workers/space-core/src/app.js')).default;
const { _resetSecretCache } = await import('../../../workers/space-core/src/secrets.js');
const { priv: PRIV, pub: PUB } = await genKeyPair();
const CTX = { waitUntil() {} };

test('导出：三个头名常量 + stripInternalHeaders / writeLockIdentity（网关只写不读）', () => {
  assert.deepEqual(Object.keys(mod).sort(), ['CLIENT_CONTEXT_HEADERS', 'INTERNAL_HEADER_PREFIX', 'LOCK_IDENTITY_HEADERS', 'stripInternalHeaders', 'writeLockIdentity']);
});

test('头名逐字固定', () => {
  assert.deepEqual({ ...LOCK_IDENTITY_HEADERS }, {
    session: 'X-Styrigx-Space-Session',
    by: 'X-Styrigx-Space-By',
    linkId: 'X-Styrigx-Space-Link-Id',
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

test('stripInternalHeaders：任意大小写的 x-styrigx-* 和旧前缀 x-sgx-* 都删，别的头不动', () => {
  const h = new Headers({ 'X-STYRIGX-LOCK-LEVEL': 'password', 'x-styrigx-whatever': '1', 'X-SGX-LEGACY': 'password', 'x-sgx-other': '1', Cookie: 'a=1', 'X-Other': 'keep' });
  stripInternalHeaders(h);
  assert.deepEqual([...h.keys()].sort(), ['cookie', 'x-other']);
});

test('writeLockIdentity：先剥再写；进门（by 只作审计，linkId 只在 by=link 时写；v5 S1 起 by=tempkey 不认）；ok 不是 true → 不写身份头；上下文不合规的项不写', () => {
  const w = (s, c, init) => Object.fromEntries([...writeLockIdentity(new Headers(init || {}), s, c)]);
  assert.deepEqual(w({ ok: true, by: 'password', linkId: 'lk1' }, { address: '1.2.3.4', country: 'JP', city: 'Tokyo' }, { 'X-Styrigx-Space-By': 'link' }), {
    'x-styrigx-space-session': '1', 'x-styrigx-space-by': 'password',
    'x-styrigx-client-address': '1.2.3.4', 'x-styrigx-client-country': 'JP', 'x-styrigx-client-city': 'Tokyo',
  });
  assert.deepEqual(w({ ok: true, by: 'link', linkId: 'lk_01' }, {}), {
    'x-styrigx-space-session': '1', 'x-styrigx-space-by': 'link', 'x-styrigx-space-link-id': 'lk_01',
  });
  assert.deepEqual(w({ ok: true, by: 'tempkey', tempkeyId: 'tk_01', linkId: 'tk_01' }, {}), { 'x-styrigx-space-session': '1' }, 'v5 S1：by=tempkey 不在白名单，不写 By / Link-Id');
  assert.deepEqual(w({ ok: true, by: 'owner' }, {}, { 'X-Styrigx-Space-Session': '1' }), { 'x-styrigx-space-session': '1' }, '不认识的 by 不写 By，进门照写');
  assert.deepEqual(w({ ok: 'yes', by: 'password' }, {}, { 'X-Styrigx-Space-Session': '1' }), {}, '外来的头剥掉，ok 不是 true 不写');
  assert.deepEqual(w({ ok: false, by: 'password' }, {}, { 'x-styrigx-space-session': '1' }), {}, 'ok:false → 也不写 Lock-Session');
  assert.deepEqual(w(null, { address: 'evil; x', country: 'JAPAN', city: 'a\u0007b' }), {});
});

test('转发表：六条（2026-11-07 加个人资料 /api/profile）都转给 ACCOUNT；/api/* 只认路径本身或子路径（/api/prefsX 不转）；页面不转', () => {
  assert.deepEqual(FORWARDING.map((r) => r.path), ['/api/account', '/api/prefs', '/api/avatar', '/api/wellbeing', '/api/profile', '/avatar/']);
  for (const r of FORWARDING) assert.deepEqual(Object.keys(r).sort(), ['binding', 'path'], '转发表只管转给谁；要不要进站只看 gate.js 访问表');
  assert.equal(matchForwarding('/account/profile/'), null, '个人资料页面不转发');
  for (const r of FORWARDING) assert.equal(r.binding, 'ACCOUNT');
  assert.equal(matchForwarding('/api/prefs/x').path, '/api/prefs');
  assert.equal(matchForwarding('/avatar/96.webp').path, '/avatar/');
  for (const p of ['/api/prefsX', '/api/accounts', '/account/', '/api/lock-entry', '/avatar']) assert.equal(matchForwarding(p), null, p);
});

/* ---------- 经 worker.fetch 的转发 ---------- */

function env(extra) {
  return Object.assign({ SGX_ENV: 'production', SGX_SITE: 'space', SGX_SPACE_PUBLIC: PUB, D1_SPACE: authD1For(makeKV()) }, extra || {});
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
const FORGED = { 'X-Styrigx-Space-Level': 'password', 'X-Styrigx-Space-Session': '1', 'x-styrigx-space-by': 'password', 'X-Styrigx-Client-Address': '6.6.6.6', 'X-Sgx-Legacy': 'password' };

test('伪造身份头、没有进站会话：/api/prefs、/api/account、/api/profile、POST /api/wellbeing → 网关 401，账号 Worker 一次都没被调；GET /api/wellbeing 公开，转发时伪造的身份头剥掉', async () => {
  _resetSecretCache();
  const acct = fakeAccount();
  for (const [p, method] of [['/api/prefs', 'GET'], ['/api/account', 'GET'], ['/api/account', 'POST'], ['/api/profile', 'GET'], ['/api/wellbeing', 'POST'], ['/api/wellbeing/x', 'GET']]) {
    const res = await worker.fetch(new Request('https://styrigx.com' + p, { method, headers: FORGED }), env({ ACCOUNT: acct }), CTX);
    assert.equal(res.status, 401, method + ' ' + p);
  }
  assert.equal(acct.seen.length, 0);
  const wb = await worker.fetch(new Request('https://styrigx.com/api/wellbeing', { headers: FORGED }), env({ ACCOUNT: acct }), CTX);
  assert.equal(wb.status, 200);
  assert.equal(acct.seen.length, 1);
  assert.equal(acct.seen[0].headers['x-styrigx-space-session'], undefined, '没进站：不写进站身份头（伪造的也剥了）');
});

test('进门会话：转发原样带 URL / 方法 / 正文 / Cookie / Origin；外来身份头剥掉，按验过的会话重写；客户端上下文取自 CF-Connecting-IP / cf', async () => {
  _resetSecretCache();
  const acct = fakeAccount();
  const ck = 'sgx-space-session=' + (await testLockSession(PRIV, 0, 'passkey'));
  const req = new Request('https://styrigx.com/api/account?x=1', {
    method: 'POST',
    headers: { ...FORGED, 'X-Styrigx-Space-By': 'link', Cookie: ck, Origin: 'https://styrigx.com', 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
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
  assert.equal(f.headers['x-styrigx-space-session'], '1', '进门有效');
  assert.deepEqual(Object.keys(f.headers).filter((k) => k.startsWith('x-styrigx-space-')).sort(), ['x-styrigx-space-by', 'x-styrigx-space-session'], '进门二值：没有等级头');
  assert.equal(f.headers['x-styrigx-space-by'], 'passkey');
  assert.equal(f.headers['x-styrigx-client-address'], '203.0.113.9', '不是客户端伪造的 6.6.6.6');
  assert.equal(f.headers['x-styrigx-client-country'], 'JP');
  assert.equal(f.headers['x-styrigx-client-city'], 'Osaka');
  assert.deepEqual(Object.keys(f.headers).filter((k) => k.startsWith('x-sgx-')), []);
  assert.equal(f.headers['x-styrigx-space-link-id'], undefined);
});

test('分享链接进门（by=link）：/api/prefs、/api/account、/api/wellbeing 都照常转发（网关不按等级拦，进门之后由账号 Worker 看账号会话）；身份头 by=link + linkId', async () => {
  _resetSecretCache();
  const acct = fakeAccount();
  const ck = 'sgx-space-session=' + (await testLockSession(PRIV, 0, 'link'));
  const e = env({ ACCOUNT: acct });
  for (const p of ['/api/prefs', '/api/account', '/api/wellbeing?d=2026-10-30']) {
    const res = await worker.fetch(new Request('https://styrigx.com' + p, { headers: { Cookie: ck, ...FORGED } }), e, CTX);
    assert.equal(res.status, 200, p);
  }
  assert.equal(acct.seen.length, 3);
  for (const s of acct.seen) {
    assert.equal(s.headers['x-styrigx-space-session'], '1');
    assert.equal(s.headers['x-styrigx-space-by'], 'link');
    assert.equal(s.headers['x-styrigx-space-link-id'], TEST_LINK_ID);
  }
});

test('ACCOUNT 没绑 / fetch 抛错 → 503 upstream（不落回网关路由表、不回源）', async () => {
  _resetSecretCache();
  const ck = 'sgx-space-session=' + (await testLockSession(PRIV, 0, 'password'));
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
  const ck = 'sgx-space-session=' + (await testLockSession(PRIV, 0, 'password'));
  const res = await worker.fetch(new Request('https://styrigx.com/api/prefsX', { headers: { Cookie: ck } }), env({ ACCOUNT: acct }), CTX);
  assert.equal(res.status, 404);
  assert.equal(acct.seen.length, 0);
});

test('静态直通和页面回源也先剥头：回源请求里没有外来的 x-styrigx-* / x-sgx-legacy', async () => {
  _resetSecretCache();
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (req) => { seen.push(Object.fromEntries([...req.headers])); return new Response('x', { headers: { 'Content-Type': 'text/css' } }); };
  try {
    await worker.fetch(new Request('https://styrigx.com/css/main.css', { headers: FORGED }), env(), CTX);
    const ck = 'sgx-space-session=' + (await testLockSession(PRIV, 0, 'password'));
    await worker.fetch(new Request('https://styrigx.com/display/', { headers: { ...FORGED, Cookie: ck } }), env(), CTX);
  } finally { globalThis.fetch = orig; }
  assert.equal(seen.length, 2);
  for (const h of seen) {
    for (const k of Object.keys(h)) assert.ok(!k.startsWith('x-styrigx-') && k !== 'x-sgx-legacy', k);
  }
});

test('X-Styrigx-Space-Session（P2-1）：头像文件公开路径无会话转发时不带它；伪造的 Lock-Session 剥掉', async () => {
  _resetSecretCache();
  const acct = fakeAccount();
  const res = await worker.fetch(new Request('https://styrigx.com/avatar/96.webp', { headers: { 'X-Styrigx-Space-Session': '1', 'X-Styrigx-Space-Level': 'password' } }), env({ ACCOUNT: acct }), CTX);
  assert.equal(res.status, 200);
  assert.equal(acct.seen.length, 1);
  assert.equal(acct.seen[0].headers['x-styrigx-space-session'], undefined);
  assert.equal(acct.seen[0].headers['x-styrigx-space-level'], undefined);
});
