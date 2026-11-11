/**
 * v6 P1 网关 admit 的新路径（workers/space-core/src/core/identity-admit.js + gate.js admit）：
 * - 没有 sgx-session cookie → 不问账号 Worker（线上 P1 没有签发入口，行为不变）
 * - public 接口不问；v6 P4 起旧进站会话删除，旧 sgx-space-session 不算进门
 * - 带 sgx-session → 经 ACCOUNT_VERIFIER.admit(cookie, 方法, 路径) 问；只认 allowed === true
 * - allowed 不是 true / 没 uid / RPC 抛错 / 绑定没有 admit → 401（fail closed）；有 uid 但档不够 → 403 forbidden（2b）
 * - 子站关口同一个 admit
 * - cookie 名与账号 Worker 一致
 * 这里只看网关这一道门：门回 {ok:false}，接口回 {error:'unauthorized'}。
 *
 * 运行：node --test tests/workers/space-core/identity-admit.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAuthD1 } from '../_harness.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;
const worker = (await import(REPO + 'workers/space-core/src/app.js')).default;
const { NEW_SESSION_COOKIE, newSessionAdmits } = await import(REPO + 'workers/space-core/src/core/identity-admit.js');
const { SESSION_COOKIE } = await import(REPO + 'workers/account/src/core/identity-session.js');

const CTX = { waitUntil() {} };
const TOKEN = 'A'.repeat(43);

/** @param {(c:string, m:string, p:string) => any} [admit] */
function env(admit) {
  const calls = [];
  return {
    calls,
    SGX_ENV: 'production', SGX_SITE: 'space',
    D1_SPACE: makeAuthD1(),
    ACCOUNT_VERIFIER: admit === undefined ? { async authorize() { return { ok: false }; } } : {
      async authorize() { return { ok: false }; },
      async admit(c, m, p) { calls.push([c, m, p]); return admit(c, m, p); },
    },
    ASSETS: { async fetch() { return new Response('<!DOCTYPE html><html><body>x</body></html>', { headers: { 'Content-Type': 'text/html' } }); } },
  };
}
function req(e, p, cookie = '', method = 'GET') {
  const headers = { Origin: 'https://styrigx.com' };
  if (cookie) headers.Cookie = cookie;
  return worker.fetch(new Request('https://styrigx.com' + p, { method, headers }), e, CTX);
}
/** 门挡下 = {ok:false} 且没有 error；过了门 = 接口自己的回答 */
const gateBlocked = async (res) => res.status === 401 && !('error' in (await res.clone().json()));

test('cookie 名与账号 Worker 一致', () => {
  assert.equal(NEW_SESSION_COOKIE, SESSION_COOKIE);
});

test('没有 sgx-session：不问账号 Worker，门照旧 401', async () => {
  const e = env(() => ({ allowed: true }));
  assert.equal(await gateBlocked(await req(e, '/api/status')), true);
  assert.equal(await gateBlocked(await req(e, '/api/status', 'sgx-session-x=1; foo=bar')), true);
  assert.deepEqual(e.calls, []);
});

test('public 接口：不问（v6 P4 起旧进站会话删除，旧 sgx-space-session 不算进门）', async () => {
  const e = env(() => ({ allowed: false }));
  const f = await req(e, '/api/geo', 'sgx-session=' + TOKEN);
  assert.notEqual(f.status, 401);
  assert.deepEqual(e.calls, []);
  const old = await req(env(), '/api/status', 'sgx-space-session=password.0.9999999999999.');
  assert.equal(await gateBlocked(old), true, '旧进站 cookie 不再被认');
});

test('带 sgx-session：问 admit(cookie, 方法, 路径)，allowed === true 且有 uid 才过门；档不够 403 forbidden（2b）', async () => {
  const e = env((c, m, p) => ({ allowed: p === '/api/status', uid: 1000 }));
  const r = await req(e, '/api/status', 'sgx-session=' + TOKEN);
  assert.equal(await gateBlocked(r), false, '过了门');
  assert.equal((await r.json()).error, 'upstream', '2b：接口用关口的 v6 结论（不再 401 unauthorized），测试台没有 STATUS 绑定 → 503 upstream');
  assert.deepEqual(e.calls, [['sgx-session=' + TOKEN, 'GET', '/api/status']], '接口不再问第二次');
  const a = await req(e, '/api/space-audit', 'sgx-session=' + TOKEN);
  assert.equal(a.status, 403, '有 v6 身份、档不够：403 不是 401（前端 401 = 没登录）');
  assert.equal((await a.json()).error, 'forbidden');
  /* allowed 却没有 uid（坏回答）：不算进门 */
  assert.equal(await gateBlocked(await req(env(() => ({ allowed: true })), '/api/status', 'sgx-session=' + TOKEN)), true);
});

test('fail closed：allowed 不是 true / RPC 抛错 / 没有 admit / 没绑定 → 401', async () => {
  for (const reply of [() => ({ allowed: 'true' }), () => null, () => ({ ok: true }), () => { throw new Error('rpc'); }]) {
    assert.equal(await gateBlocked(await req(env(reply), '/api/status', 'sgx-session=' + TOKEN)), true);
  }
  assert.equal(await gateBlocked(await req(env(), '/api/status', 'sgx-session=' + TOKEN)), true);
  assert.equal(await newSessionAdmits({}, new Request('https://styrigx.com/api/status', { headers: { Cookie: 'sgx-session=' + TOKEN } })), false);
  assert.equal(await newSessionAdmits({}, null), false);
});

test('子站关口同一个 admit（漏到网关的 /<站>/api/*）', async () => {
  const e = env(() => ({ allowed: false }));
  assert.equal(await gateBlocked(await req(e, '/curio/api/nope', 'sgx-session=' + TOKEN)), true);
  assert.deepEqual(e.calls.map((c) => c.slice(1)), [['GET', '/curio/api/nope']]);
});
