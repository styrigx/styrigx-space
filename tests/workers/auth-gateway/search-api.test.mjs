/**
 * 全站搜索 /api/search（网关这一侧，2026-10-22）。头像只存 KV_PROFILE 的测试随头像搬到 tests/workers/account/。
 * 运行：node --test tests/workers/auth-gateway/search-api.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testLockSession, testAccountSession } from './_tickets.mjs';

const API = '../../../workers/auth-gateway/functions/api/';
const KERNEL = '../../../workers/auth-gateway/functions/_kernel/';

function makeKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(k, type) {
      if (!store.has(k)) return null;
      const v = store.get(k);
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
    async list({ prefix } = {}) {
      return { keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })) };
    },
  };
}

function derToPem(der, label) {
  const b64 = Buffer.from(der).toString('base64');
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
}
async function edPair() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return {
    priv: derToPem(await crypto.subtle.exportKey('pkcs8', kp.privateKey), 'PRIVATE KEY'),
    pub: derToPem(await crypto.subtle.exportKey('spki', kp.publicKey), 'PUBLIC KEY'),
  };
}

let LOCK, ACCOUNT, OTHER;
const ROOT_KEY = 'test-root-key-account-123';
const PEPPER = 'test-pepper-acc';

function envFor(kv, overrides = {}) {
  return {
    KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv,
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

function postReq(url, body, headers = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://styrigx.com', 'CF-Connecting-IP': '10.9.9.9', ...headers },
    body: JSON.stringify(body),
  });
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
async function accTicket(by = 'password', authAt = Date.now(), epoch = 0, priv) {
  const { signAccountSessionTicket } = await import(KERNEL + 'account-session.js');
  return await testAccountSession(priv || ACCOUNT.priv, by, epoch, authAt);
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

async function accountGet(kv, cookieObj, envOverrides) {
  const { onRequestGet } = await import(API + 'account.js');
  return await onRequestGet({ request: getReq('https://styrigx.com/api/account', { Cookie: cookies(cookieObj) }), env: envFor(kv, envOverrides) });
}
async function seedPassword(kv, pw) {
  const { makePasswordRecord } = await import(KERNEL + 'password.js');
  await kv.put('account-password', JSON.stringify(await makePasswordRecord(pw, PEPPER)));
}



async function searchCall(kv, q, cookieObj, svc, host) {
  const m = await import(API + 'search.js');
  const req = new Request('https://' + (host || 'styrigx.com') + '/api/search?q=' + encodeURIComponent(q) + '&lang=zh', { headers: { Cookie: cookies(cookieObj) } });
  return await m.onRequestGet({ request: req, env: Object.assign(envFor(kv), svc === undefined ? {} : { SEARCH: svc }) });
}
function fakeSearch(log) {
  return { async fetch(req) { log.push({ url: req.url, role: req.headers.get('X-Sgx-Role') }); return new Response(JSON.stringify({ ok: true, q: 'x', hits: [] }), { status: 200 }); } };
}

test('setup: 生成测试钥匙', async () => {
  LOCK = await edPair(); ACCOUNT = await edPair(); OTHER = await edPair();
});

test('/api/search：没会话 401，不转发', async () => {
  const log = [];
  const r = await searchCall(makeKV(), '主题', {}, fakeSearch(log));
  assert.equal(r.status, 401);
  assert.equal(log.length, 0);
});

test('/api/search：管理员转发带 admin，访客带 visitor；参数原样带过去', async () => {
  const log = [];
  let r = await searchCall(makeKV(), '主题', { 'sgx-lock-session': await adminSess() }, fakeSearch(log));
  assert.equal(r.status, 200);
  r = await searchCall(makeKV(), '主题', { 'sgx-lock-session': await visitorSess() }, fakeSearch(log));
  assert.equal(r.status, 200);
  assert.deepEqual(log.map((x) => x.role), ['admin', 'visitor']);
  const u = new URL(log[0].url);
  assert.equal(u.pathname, '/search');
  assert.equal(u.searchParams.get('q'), '主题');
  assert.equal(u.searchParams.get('lang'), 'zh');
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

test('子站 /api/search 也走网关：blog 上没会话 401、有会话转发', async () => {
  const { handleSubsite } = await import('../../../workers/auth-gateway/src/subsites.js');
  const log = [];
  const env = Object.assign(envFor(makeKV()), { SEARCH: fakeSearch(log) });
  const origin = async () => new Response('origin', { status: 200 });
  let r = await handleSubsite(new Request('https://blog.styrigx.com/api/search?q=a'), env, origin);
  assert.equal(r.status, 401);
  r = await handleSubsite(new Request('https://blog.styrigx.com/api/search?q=a', { headers: { Cookie: 'sgx-lock-session=' + await visitorSess() } }), env, origin);
  assert.equal(r.status, 200);
  assert.equal(log[0].role, 'visitor');
  r = await handleSubsite(new Request('https://blog.styrigx.com/api/search?q=a', { method: 'POST', headers: { Cookie: 'sgx-lock-session=' + await visitorSess() } }), env, origin);
  assert.equal(r.status, 405);
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
