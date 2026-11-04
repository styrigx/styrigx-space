/**
 * /api/search、/api/status、/api/chat、/api/lock-tempkey 先用关口（src/gate.js）放进 context.data.lockSession 的会话，
 *   没有再自验：经整条网关（app.js）的已认证请求只验一次锁屏会话；处理函数单独调用（没有 context.data）仍然正确拒绝。
 *   lock-tempkey 的 admin 角色再验保留。
 * 「验了几次」按锁屏纪元的读取次数数（verifyLockSession 每验一次读一次 epoch）。
 * 运行：node --test tests/workers/auth-gateway/session-once.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import app from '../../../workers/auth-gateway/src/app.js';
import * as search from '../../../workers/auth-gateway/src/api/search.js';
import * as status from '../../../workers/auth-gateway/src/api/status.js';
import * as chat from '../../../workers/auth-gateway/src/api/chat.js';
import * as tempkey from '../../../workers/auth-gateway/src/api/lock-tempkey.js';
import { testLockSession } from './_tickets.mjs';
import { genKeyPair, makeKV, authD1For } from '../_harness.mjs';

const { priv: PRIV, pub: PUB } = await genKeyPair();
const ADMIN = await testLockSession(PRIV, 0, 'admin');
const VISITOR = await testLockSession(PRIV, 0, 'visitor');
const ORIGIN = 'https://styrigx.com';

const okJson = () => ({ async fetch() { return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }); } });

function env(over = {}) {
  const kv = makeKV();
  const db = authD1For(kv);
  db.setEpoch('lock', 0); /* 纪元行先摆好：每验一次会话恰好一条 SELECT */
  return {
    SGX_ENV: 'production', SGX_SITE: 'space',
    SGX_LOCK_PRIVATE: PRIV, SGX_LOCK_PUBLIC: PUB, SGX_PW_PEPPER: 'test-pepper',
    SGX_RP_ID: 'styrigx.com', SGX_ORIGIN: ORIGIN,
    D1_LOCK_AUTH: db, D1_ACCOUNT_AUTH: db, D1_ROOT_AUTH: db,
    SEARCH: okJson(), STATUS: okJson(), CHAT: okJson(),
    /* P2-2：/api/chat 要账号会话、/api/search 问账号结论（AccountVerifier.authorize 替身；Cookie 里有 sgx-account-session=ok 才算有） */
    ACCOUNT_VERIFIER: { async authorize(c) { return /sgx-account-session=ok/.test(c) ? { ok: true, reason: 'ok', deviceId: 'devtestdevtest01', scopes: ['curio.write'], reauth: false } : { ok: false, reason: 'missing' }; } },
    ...over,
  };
}
const epochReads = (e) => e.D1_LOCK_AUTH.calls.filter((s) => /^SELECT value FROM epoch/i.test(s)).length;
const ctx = { waitUntil() {} };

function get(path, cookie) {
  const headers = {};
  if (cookie) headers.Cookie = 'sgx-lock-session=' + cookie;
  return new Request(ORIGIN + path, { method: 'GET', headers });
}
function post(path, body, cookie) {
  const headers = { Origin: ORIGIN, 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = 'sgx-lock-session=' + cookie;
  return new Request(ORIGIN + path, { method: 'POST', headers, body: JSON.stringify(body) });
}

/** 再带上账号会话 cookie（P2-2：/api/chat 要账号会话） @param {Request} r */
function withAccount(r) {
  const h = new Headers(r.headers);
  h.set('Cookie', (h.get('Cookie') || '') + '; sgx-account-session=ok');
  return new Request(r, { headers: h });
}

const CASES = [
  ['GET /api/search', () => get('/api/search?q=hugo', ADMIN)],
  ['GET /api/status', () => get('/api/status', ADMIN)],
  ['GET /api/chat', () => withAccount(get('/api/chat', ADMIN))],
  ['POST /api/chat', () => withAccount(post('/api/chat', { messages: [{ role: 'user', text: 'hi' }] }, ADMIN))],
  ['POST /api/lock-tempkey', () => post('/api/lock-tempkey', { action: 'list' }, ADMIN)],
];

for (const [name, mk] of CASES) {
  test(name + '：经整条网关的已认证请求只验一次锁屏会话', async () => {
    const e = env();
    const res = await app.fetch(mk(), e, ctx);
    assert.equal(res.status, 200, name + ' 应放行');
    assert.equal(epochReads(e), 1, name + ' 锁屏会话只验一次（关口那次）');
  });
}

test('没有 context.data：各处理函数回落到自验，没会话 / 访客照样拒绝', async () => {
  const e = env();
  assert.equal((await search.onRequestGet({ request: get('/api/search?q=x'), env: e })).status, 401);
  assert.equal((await status.onRequestGet({ request: get('/api/status'), env: e })).status, 401);
  assert.equal((await chat.onRequestGet({ request: get('/api/chat'), env: e })).status, 401);
  assert.equal((await chat.onRequestGet({ request: get('/api/chat', VISITOR), env: e })).status, 403);
  assert.equal((await chat.onRequestPost({ request: post('/api/chat', { messages: [] }), env: e })).status, 401);
  assert.equal((await tempkey.onRequestPost({ request: post('/api/lock-tempkey', { action: 'list' }), env: e })).status, 401);
  assert.equal((await tempkey.onRequestPost({ request: post('/api/lock-tempkey', { action: 'list' }, VISITOR), env: e })).status, 401);
  /* 有效会话、没有 context.data：自验通过 */
  assert.equal((await search.onRequestGet({ request: get('/api/search?q=x', ADMIN), env: e })).status, 200);
  assert.equal((await tempkey.onRequestPost({ request: post('/api/lock-tempkey', { action: 'list' }, ADMIN), env: e })).status, 200);
});

test('context.data.lockSession 有结论就用它：关口判无效 → 拒绝（即使 cookie 有效）；不再自验', async () => {
  const e = env();
  const data = { lockSession: { ok: false, role: null } };
  assert.equal((await search.onRequestGet({ request: get('/api/search?q=x', ADMIN), env: e, data })).status, 401);
  assert.equal((await status.onRequestGet({ request: get('/api/status', ADMIN), env: e, data })).status, 401);
  assert.equal((await chat.onRequestGet({ request: get('/api/chat', ADMIN), env: e, data })).status, 401);
  assert.equal((await tempkey.onRequestPost({ request: post('/api/lock-tempkey', { action: 'list' }, ADMIN), env: e, data })).status, 401);
  assert.equal(epochReads(e), 0, '没有再验');
});

test('lock-tempkey：关口给的是访客会话 → 401（admin 角色再验保留，即使 cookie 是有效 admin）；chat 访客 → 403', async () => {
  const e = env();
  const data = { lockSession: { ok: true, role: 'visitor', by: 'tempkey' } };
  assert.equal((await tempkey.onRequestPost({ request: post('/api/lock-tempkey', { action: 'list' }, ADMIN), env: e, data })).status, 401);
  assert.equal((await tempkey.onRequestPost({ request: post('/api/lock-tempkey', { action: 'list' }), env: e, data })).status, 401);
  assert.equal((await chat.onRequestGet({ request: get('/api/chat', ADMIN), env: e, data })).status, 403);
  assert.equal(epochReads(e), 0, '用的是关口结论，没有再验');
});

test('context.data 里不是会话结论（缺 ok）→ 不信，回落自验', async () => {
  const e = env();
  const data = { lockSession: { role: 'admin' } };
  assert.equal((await search.onRequestGet({ request: get('/api/search?q=x'), env: e, data })).status, 401);
});
