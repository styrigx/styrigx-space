/**
 * 全站搜索 /api/search（网关这一侧，2026-10-22）。头像只存 KV_PROFILE 的测试随头像搬到 tests/workers/account/。
 * 运行：node --test tests/workers/auth-gateway/search-api.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { testLockSession } from './_tickets.mjs';
import { makeKV, genKeyPair, authD1For } from '../_harness.mjs';

const API = '../../../workers/auth-gateway/src/api/';
const KERNEL = '../../../workers/auth-gateway/src/core/';

let LOCK, ACCOUNT, OTHER;
const ROOT_KEY = 'test-root-key-account-123';
const PEPPER = 'test-pepper-acc';

function envFor(kv, overrides = {}) {
  return {
    KV_LOCK_DOOR: kv, D1_LOCK_AUTH: authD1For(kv), D1_ACCOUNT_AUTH: authD1For(kv), D1_ROOT_AUTH: authD1For(kv), KV_ACCOUNT_LOGIN: kv,
    SGX_ROOT_KEY: ROOT_KEY,
    SGX_LOCK_PRIVATE: LOCK.priv,
    SGX_LOCK_PUBLIC: LOCK.pub,
    SGX_ACCOUNT_PRIVATE: ACCOUNT.priv,
    SGX_ACCOUNT_PUBLIC: ACCOUNT.pub,
    SGX_PW_PEPPER: PEPPER,
    SGX_RP_ID: 'styrigx.com',
    SGX_ORIGIN: 'https://styrigx.com',
    ...overrides,
  };
}

function getReq(url, headers = {}) {
  return new Request(url, { method: 'GET', headers });
}

async function adminSess(epoch = 0) {
  const { signLockSessionTicket } = await import(KERNEL + 'lock-session.js');
  return await testLockSession(LOCK.priv, epoch, 'admin', 'password');
}
async function visitorSess() {
  const { signLockSessionTicket } = await import(KERNEL + 'lock-session.js');
  return await testLockSession(LOCK.priv, 0, 'visitor');
}
function cookies(o) {
  return Object.entries(o).filter(([, v]) => v).map(([k, v]) => k + '=' + v).join('; ');
}
function setCookies(res) {
  return res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('Set-Cookie') || ''];
}
function pickCookie(res, name) {
  for (const c of setCookies(res)) {
    if (c.startsWith(name + '=')) return c.split(';')[0].slice(name.length + 1);
  }
  return null;
}




/** 账号 Worker AccountVerifier 替身（P2-2）：Cookie 里有 sgx-account-session=ok → 有账号会话；=boom → RPC 抛错；否则没有 */
function fakeVerifier(calls) {
  return {
    async authorize(cookie, ctx, opts) {
      if (calls) calls.push({ cookie, opts });
      if (/sgx-account-session=boom/.test(cookie)) throw new Error('rpc');
      if (/sgx-account-session=ok/.test(cookie)) return { ok: true, reason: 'ok', deviceId: 'devtestdevtest01', scopes: ['curio.write', 'daymark.write'], reauth: false };
      return { ok: false, reason: 'missing' };
    },
  };
}
async function searchCall(kv, q, cookieObj, svc, host, verifier) {
  const m = await import(API + 'search.js');
  const req = new Request('https://' + (host || 'styrigx.com') + '/api/search?q=' + encodeURIComponent(q) + '&lang=zh', { headers: { Cookie: cookies(cookieObj) } });
  const env = Object.assign(envFor(kv), svc === undefined ? {} : { SEARCH: svc }, { ACCOUNT_VERIFIER: verifier === undefined ? fakeVerifier() : verifier });
  return await m.onRequestGet({ request: req, env });
}
function fakeSearch(log) {
  return {
    async fetch(req) {
      log.push({ url: req.url, role: req.headers.get('X-Sgx-Role'), acc: req.headers.get('X-Styrigx-Account-Session'), device: req.headers.get('X-Styrigx-Account-Device'), scopes: req.headers.get('X-Styrigx-Account-Scopes'), cookie: req.headers.get('Cookie') });
      return new Response(JSON.stringify({ ok: true, q: 'x', hits: [] }), { status: 200 });
    },
  };
}

/* 测试钥匙：before 里生成（不算一条用例，单独跑某条用例时也会先执行） */
before(async () => {
  LOCK = await genKeyPair(); ACCOUNT = await genKeyPair(); OTHER = await genKeyPair();
});

test('/api/search：没会话 401，不转发', async () => {
  const log = [];
  const r = await searchCall(makeKV(), '主题', {}, fakeSearch(log));
  assert.equal(r.status, 401);
  assert.equal(log.length, 0);
});

test('/api/search：有账号会话才写 X-Styrigx-Account-Session: 1（不看锁屏角色）；不再写 X-Sgx-Role；参数原样带过去', async () => {
  const log = [];
  const calls = [];
  const v = fakeVerifier(calls);
  let r = await searchCall(makeKV(), '主题', { 'sgx-lock-session': await adminSess() }, fakeSearch(log), undefined, v);
  assert.equal(r.status, 200);
  r = await searchCall(makeKV(), '主题', { 'sgx-lock-session': await adminSess(), 'sgx-account-session': 'ok' }, fakeSearch(log), undefined, v);
  assert.equal(r.status, 200);
  r = await searchCall(makeKV(), '主题', { 'sgx-lock-session': await visitorSess(), 'sgx-account-session': 'ok' }, fakeSearch(log), undefined, v);
  assert.equal(r.status, 200);
  assert.deepEqual(log.map((x) => x.acc), [null, '1', '1']);
  assert.deepEqual(log.map((x) => x.role), [null, null, null]);
  assert.equal(log[1].device, 'devtestdevtest01');
  assert.equal(log[1].scopes, 'curio.write daymark.write');
  assert.ok(log.every((x) => x.cookie === null), '不转 cookie');
  assert.ok(calls.every((c) => c.opts && c.opts.reauth === false), '搜索不要复验结论');
  const u = new URL(log[0].url);
  assert.equal(u.pathname, '/search');
  assert.equal(u.searchParams.get('q'), '主题');
  assert.equal(u.searchParams.get('lang'), 'zh');
});

test('/api/search：账号绑定缺失 / RPC 抛错 → 照常搜，但不写账号结论头（fail closed，不给私密）', async () => {
  const log = [];
  const ck = { 'sgx-lock-session': await adminSess(), 'sgx-account-session': 'ok' };
  assert.equal((await searchCall(makeKV(), '主题', ck, fakeSearch(log), undefined, null)).status, 200);
  assert.equal((await searchCall(makeKV(), '主题', { ...ck, 'sgx-account-session': 'boom' }, fakeSearch(log), undefined, fakeVerifier())).status, 200);
  assert.deepEqual(log.map((x) => x.acc), [null, null]);
});

test('/api/search：没进门不问账号', async () => {
  const calls = [];
  const r = await searchCall(makeKV(), '主题', { 'sgx-account-session': 'ok' }, fakeSearch([]), undefined, fakeVerifier(calls));
  assert.equal(r.status, 401);
  assert.equal(calls.length, 0);
});

test('/api/search：没绑定 503；上游抛错 503；空查询直接空结果；超长 400', async () => {
  const sess = { 'sgx-lock-session': await adminSess() };
  assert.equal((await searchCall(makeKV(), 'a', sess, null)).status, 503);
  assert.equal((await searchCall(makeKV(), 'a', sess, { fetch() { throw new Error('x'); } })).status, 503);
  const r = await searchCall(makeKV(), '', sess, null);
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).hits, []);
  assert.equal((await searchCall(makeKV(), 'x'.repeat(101), sess, null)).status, 400);
});

test('子站的 /api/search（合并 PR3 起同源，在主域名根上）：没会话 401、有会话转发、POST 405；子站关口不再有自己的 /api/search，旧图志一律 301', async () => {
  const worker = (await import('../../../workers/auth-gateway/src/app.js')).default;
  const { handleSubsite } = await import('../../../workers/auth-gateway/src/gate.js');
  const log = [];
  const env = Object.assign(envFor(makeKV()), { SGX_SITE: 'space', SEARCH: fakeSearch(log) });
  const CTX = { waitUntil() {} };
  let r = await worker.fetch(new Request('https://styrigx.com/api/search?q=a'), env, CTX);
  assert.equal(r.status, 401);
  r = await worker.fetch(new Request('https://styrigx.com/api/search?q=a', { headers: { Cookie: 'sgx-lock-session=' + await visitorSess() } }), env, CTX);
  assert.equal(r.status, 200);
  assert.equal(log[0].role, null, 'P2-2 起不写 X-Sgx-Role');
  assert.equal(log[0].acc, null, '没账号会话不写结论头');
  r = await worker.fetch(new Request('https://styrigx.com/api/search?q=a', { method: 'POST', headers: { Cookie: 'sgx-lock-session=' + await visitorSess() } }), env, CTX);
  assert.equal(r.status, 405);
  /* 子站关口只认主域名的子站前缀：别的地址一律 404（不回源） */
  const origin = async () => new Response('origin', { status: 200 });
  assert.equal((await handleSubsite(new Request('https://atlas.styrigx.com/api/search?q=a'), env, origin)).status, 404);
  r = await worker.fetch(new Request('https://atlas.styrigx.com/api/search?q=a', { headers: { Cookie: 'sgx-lock-session=' + await visitorSess() } }), env, CTX);
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('Location'), 'https://styrigx.com/api/search?q=a');
  assert.equal(log.length, 1, '旧图志不转发');
});

/* ---- 站点监测 /api/status（2026-10-22）：同样是网关只做门，转给 styrigx-status ---- */
async function statusCall(kv, cookieObj, svc) {
  const m = await import(API + 'status.js');
  const req = new Request('https://styrigx.com/api/status', { headers: { Cookie: cookies(cookieObj) } });
  return await m.onRequestGet({ request: req, env: Object.assign(envFor(kv), svc === undefined ? {} : { STATUS: svc }) });
}
function fakeStatus(log, status = 200) {
  return { async fetch(req) { log.push(req.url); return new Response(JSON.stringify({ ok: status === 200, sites: [] }), { status }); } };
}

test('/api/status：没会话 401 不转发；管理员 / 访客都转到 /summary，原样回', async () => {
  const log = [];
  assert.equal((await statusCall(makeKV(), {}, fakeStatus(log))).status, 401);
  assert.equal(log.length, 0);
  let r = await statusCall(makeKV(), { 'sgx-lock-session': await adminSess() }, fakeStatus(log));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, sites: [] });
  assert.equal(r.headers.get('Cache-Control'), 'private, no-store');
  r = await statusCall(makeKV(), { 'sgx-lock-session': await visitorSess() }, fakeStatus(log));
  assert.equal(r.status, 200);
  assert.deepEqual(log.map((u) => new URL(u).pathname), ['/summary', '/summary']);
});

test('/api/status：没绑定 503；上游抛错 / 回非 200 都是 503', async () => {
  const sess = { 'sgx-lock-session': await adminSess() };
  assert.equal((await statusCall(makeKV(), sess, undefined)).status, 503);
  assert.equal((await statusCall(makeKV(), sess, { async fetch() { throw new Error('x'); } })).status, 503);
  assert.equal((await statusCall(makeKV(), sess, fakeStatus([], 503))).status, 503);
});
