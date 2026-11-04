/**
 * /api/search、/api/status、/api/chat、/api/lock-tempkey 先用关口（src/gate.js）放进 context.data.lockSession 的会话，
 *   没有再自验：经整条网关（app.js）的已认证请求只验一次锁屏会话；处理函数单独调用（没有 context.data）仍然正确拒绝。
 *   进门二值（P2-3）：任何 by（含临时钥匙）进门都算进门；lock-tempkey list 只要进门，create / revoke 另要锁侧复验。
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
const PW_SESS = await testLockSession(PRIV, 0, 'password');
const TEMPKEY = await testLockSession(PRIV, 0, 'tempkey');
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
  ['GET /api/search', () => get('/api/search?q=hugo', PW_SESS)],
  ['GET /api/status', () => get('/api/status', PW_SESS)],
  ['GET /api/chat', () => withAccount(get('/api/chat', PW_SESS))],
  ['POST /api/chat', () => withAccount(post('/api/chat', { messages: [{ role: 'user', text: 'hi' }] }, PW_SESS))],
  ['POST /api/lock-tempkey', () => post('/api/lock-tempkey', { action: 'list' }, PW_SESS)],
];

for (const [name, mk] of CASES) {
  test(name + '：经整条网关的已认证请求只验一次锁屏会话', async () => {
    const e = env();
    const res = await app.fetch(mk(), e, ctx);
    assert.equal(res.status, 200, name + ' 应放行');
    assert.equal(epochReads(e), 1, name + ' 锁屏会话只验一次（关口那次）');
  });
}

test('没有 context.data：各处理函数回落到自验，没会话照样拒绝；临时钥匙进门也是进门', async () => {
  const e = env();
  assert.equal((await search.onRequestGet({ request: get('/api/search?q=x'), env: e })).status, 401);
  assert.equal((await status.onRequestGet({ request: get('/api/status'), env: e })).status, 401);
  assert.equal((await chat.onRequestGet({ request: get('/api/chat'), env: e })).status, 401);
  /* 临时钥匙进门、没账号会话：chat 401 account（不是按角色 403） */
  const tkChat = await chat.onRequestGet({ request: get('/api/chat', TEMPKEY), env: e });
  assert.equal(tkChat.status, 401);
  assert.equal((await tkChat.json()).error, 'account');
  assert.equal((await chat.onRequestPost({ request: post('/api/chat', { messages: [] }), env: e })).status, 401);
  assert.equal((await tempkey.onRequestPost({ request: post('/api/lock-tempkey', { action: 'list' }), env: e })).status, 401);
  /* 临时钥匙进门：list 只要进门 → 200；create 没有锁侧复验 → 401 reauth */
  assert.equal((await tempkey.onRequestPost({ request: post('/api/lock-tempkey', { action: 'list' }, TEMPKEY), env: e })).status, 200);
  const tkCreate = await tempkey.onRequestPost({ request: post('/api/lock-tempkey', { action: 'create', name: 'x', hours: 1 }, TEMPKEY), env: e });
  assert.equal(tkCreate.status, 401);
  assert.equal((await tkCreate.json()).error, 'reauth');
  /* 有效会话、没有 context.data：自验通过 */
  assert.equal((await search.onRequestGet({ request: get('/api/search?q=x', PW_SESS), env: e })).status, 200);
  assert.equal((await tempkey.onRequestPost({ request: post('/api/lock-tempkey', { action: 'list' }, PW_SESS), env: e })).status, 200);
});

test('context.data.lockSession 有结论就用它：关口判无效 → 拒绝（即使 cookie 有效）；不再自验', async () => {
  const e = env();
  const data = { lockSession: { ok: false, by: '' } };
  assert.equal((await search.onRequestGet({ request: get('/api/search?q=x', PW_SESS), env: e, data })).status, 401);
  assert.equal((await status.onRequestGet({ request: get('/api/status', PW_SESS), env: e, data })).status, 401);
  assert.equal((await chat.onRequestGet({ request: get('/api/chat', PW_SESS), env: e, data })).status, 401);
  assert.equal((await tempkey.onRequestPost({ request: post('/api/lock-tempkey', { action: 'list' }, PW_SESS), env: e, data })).status, 401);
  assert.equal(epochReads(e), 0, '没有再验');
});

test('关口给的是临时钥匙进门的结论：lock-tempkey list 200、create 401 reauth（临时钥匙进门不算复验）；chat 没账号会话 401 account；都不再验', async () => {
  const e = env();
  const data = { lockSession: { ok: true, by: 'tempkey' } };
  assert.equal((await tempkey.onRequestPost({ request: post('/api/lock-tempkey', { action: 'list' }), env: e, data })).status, 200);
  const c = await tempkey.onRequestPost({ request: post('/api/lock-tempkey', { action: 'create', name: 'x', hours: 1 }), env: e, data });
  assert.equal(c.status, 401);
  assert.equal((await c.json()).error, 'reauth');
  const ch = await chat.onRequestGet({ request: get('/api/chat'), env: e, data });
  assert.equal(ch.status, 401);
  assert.equal((await ch.json()).error, 'account');
  assert.equal(epochReads(e), 0, '用的是关口结论，没有再验');
});

test('context.data 里不是会话结论（缺 ok）→ 不信，回落自验', async () => {
  const e = env();
  const data = { lockSession: { by: 'password' } };
  assert.equal((await search.onRequestGet({ request: get('/api/search?q=x'), env: e, data })).status, 401);
});
