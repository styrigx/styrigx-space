/**
 * /api/ai（GET 模型列表）、/api/status 先用关口（src/gate.js）放进 context.data.lockSession 的会话，
 *   没有再自验：经整条网关（app.js）的已认证请求只验一次进站会话；处理函数单独调用（没有 context.data）仍然正确拒绝。
 *   进门二值（P2-3）：任何 by（含分享链接 by=link）进门都算进门。
 * v5 S1：/api/lock-tempkey、/api/lock-tempkey-unlock 删除——有会话 404（路由表里没了），没会话照常被关口 401（同任何不在白名单的 /api/*）。
 * 「验了几次」按锁屏纪元的读取次数数（verifyLockSession 每验一次读一次 epoch）。
 * P4-2b：/api/search、/api/chat 退役，有会话也 404（路由表里没了）。
 * 运行：node --test tests/workers/space-core/session-once.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import app from '../../../workers/space-core/src/app.js';
import * as ai from '../../../workers/space-core/src/api/ai.js';
import * as status from '../../../workers/space-core/src/api/status.js';
import { testLockSession } from './_tickets.mjs';
import { genKeyPair, makeKV, authD1For } from '../_harness.mjs';

const { priv: PRIV, pub: PUB } = await genKeyPair();
const PW_SESS = await testLockSession(PRIV, 0, 'password');
const LINK_SESS = await testLockSession(PRIV, 0, 'link');
const ORIGIN = 'https://styrigx.com';

const okJson = () => ({ async fetch() { return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }); } });

function env(over = {}) {
  const kv = makeKV();
  const db = authD1For(kv);
  db.setEpoch('lock', 0); /* 纪元行先摆好：每验一次会话恰好一条 SELECT */
  return {
    SGX_ENV: 'production', SGX_SITE: 'space',
    SGX_SPACE_PRIVATE: PRIV, SGX_SPACE_PUBLIC: PUB, SGX_SPACE_PASSWORD_PEPPER: 'test-pepper', SGX_SPACE_TEMPKEY_PEPPER: 'test-pepper',
    SGX_RP_ID: 'styrigx.com', SGX_ORIGIN: ORIGIN,
    D1_SPACE: db, D1_ACCOUNT_AUTH: db, D1_ROOT_AUTH: db,
    AI_SERVICE: okJson(), STATUS: okJson(),
    /* /api/ai 问账号结论（AccountVerifier.authorize 替身；Cookie 里有 sgx-account-session=ok 才算有） */
    ACCOUNT_VERIFIER: { async authorize(c) { return /sgx-account-session=ok/.test(c) ? { ok: true, reason: 'ok', deviceId: 'devtestdevtest01', scopes: ['curio.write'], reauth: false } : { ok: false, reason: 'missing' }; } },
    ...over,
  };
}
const epochReads = (e) => e.D1_SPACE.calls.filter((s) => /^SELECT value FROM epoch/i.test(s)).length;
const ctx = { waitUntil() {} };

function get(path, cookie) {
  const headers = {};
  if (cookie) headers.Cookie = 'sgx-space-session=' + cookie;
  return new Request(ORIGIN + path, { method: 'GET', headers });
}
function post(path, body, cookie) {
  const headers = { Origin: ORIGIN, 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = 'sgx-space-session=' + cookie;
  return new Request(ORIGIN + path, { method: 'POST', headers, body: JSON.stringify(body) });
}

/** 再带上账号会话 cookie @param {Request} r */
function withAccount(r) {
  const h = new Headers(r.headers);
  h.set('Cookie', (h.get('Cookie') || '') + '; sgx-account-session=ok');
  return new Request(r, { headers: h });
}

const CASES = [
  ['GET /api/ai', () => get('/api/ai', PW_SESS)],
  ['GET /api/ai（带账号会话）', () => withAccount(get('/api/ai', PW_SESS))],
  ['GET /api/status', () => get('/api/status', PW_SESS)],
];

for (const [name, mk] of CASES) {
  test(name + '：经整条网关的已认证请求只验一次进站会话', async () => {
    const e = env();
    const res = await app.fetch(mk(), e, ctx);
    assert.equal(res.status, 200, name + ' 应放行');
    assert.equal(epochReads(e), 1, name + ' 进站会话只验一次（关口那次）');
  });
}

test('没有 context.data：各处理函数回落到自验，没会话照样拒绝；分享链接进门也是进门', async () => {
  const e = env();
  assert.equal((await ai.onRequestGet({ request: get('/api/ai'), env: e })).status, 401);
  assert.equal((await status.onRequestGet({ request: get('/api/status'), env: e })).status, 401);
  /* 分享链接进门、没账号会话：ai 照样放行（只是 canChoose=false，由 ai Worker 判） */
  assert.equal((await ai.onRequestGet({ request: get('/api/ai', LINK_SESS), env: e })).status, 200);
  assert.equal((await ai.onRequestPost({ request: post('/api/ai', { q: 'hi' }), env: e })).status, 401);
  /* 有效会话、没有 context.data：自验通过 */
  assert.equal((await ai.onRequestGet({ request: get('/api/ai', PW_SESS), env: e })).status, 200);
  assert.equal((await status.onRequestGet({ request: get('/api/status', PW_SESS), env: e })).status, 200);
});

test('context.data.lockSession 有结论就用它：关口判无效 → 拒绝（即使 cookie 有效）；不再自验', async () => {
  const e = env();
  const data = { lockSession: { ok: false, by: '' } };
  assert.equal((await ai.onRequestGet({ request: get('/api/ai', PW_SESS), env: e, data })).status, 401);
  assert.equal((await status.onRequestGet({ request: get('/api/status', PW_SESS), env: e, data })).status, 401);
  assert.equal(epochReads(e), 0, '没有再验');
});

test('关口给的是分享链接进门的结论（by=link）：ai 放行；不再验', async () => {
  const e = env();
  const data = { lockSession: { ok: true, by: 'link', linkId: 'lktesttesttest01' } };
  assert.equal((await ai.onRequestGet({ request: get('/api/ai'), env: e, data })).status, 200);
  assert.equal(epochReads(e), 0, '用的是关口结论，没有再验');
});

test('v5 S1：/api/lock-tempkey、/api/lock-tempkey-unlock 删除——有会话经整条网关 404；没会话被关口 401（不再在白名单里）', async () => {
  for (const p of ['/api/lock-tempkey', '/api/lock-tempkey-unlock']) {
    let res = await app.fetch(post(p, { action: 'list', code: 'ABCD-EFGH-JKMN' }, PW_SESS), env(), ctx);
    assert.equal(res.status, 404, p + ' 有会话');
    res = await app.fetch(post(p, { action: 'list', code: 'ABCD-EFGH-JKMN' }), env(), ctx);
    assert.equal(res.status, 401, p + ' 没会话');
    assert.equal(res.headers.getSetCookie().filter((c) => c.startsWith('sgx-space-session=') && !c.startsWith('sgx-space-session=;')).length, 0, p + ' 不发会话');
  }
});

test('context.data 里不是会话结论（缺 ok）→ 不信，回落自验', async () => {
  const e = env();
  const data = { lockSession: { by: 'password' } };
  assert.equal((await ai.onRequestGet({ request: get('/api/ai'), env: e, data })).status, 401);
});

test('P4-2b：/api/search、/api/chat 退役——有会话经整条网关也是 404', async () => {
  for (const r of [get('/api/search?q=x', PW_SESS), withAccount(get('/api/chat', PW_SESS)), withAccount(post('/api/chat', { messages: [] }, PW_SESS))]) {
    const res = await app.fetch(r, env(), ctx);
    assert.equal(res.status, 404, r.method + ' ' + new URL(r.url).pathname);
  }
});
