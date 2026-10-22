/**
 * 全站搜索 /api/search（网关这一侧，2026-10-22）+ 头像分库（ACCOUNT_KV，旧库兜底）。
 * 运行：node --test tests/workers/auth-gateway/search-api.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

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
    OWNER_KV: kv,
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

async function ownerSess(epoch = 0) {
  const { signSessionCookie } = await import(KERNEL + 'session.js');
  return await signSessionCookie(LOCK.priv, epoch, 'owner', 'owner');
}
async function visitorSess() {
  const { signSessionCookie } = await import(KERNEL + 'session.js');
  return await signSessionCookie(LOCK.priv, 0, 'visitor', 'owner');
}
async function accTicket(by = 'password', authAt = Date.now(), epoch = 0, priv) {
  const { signAccountTicket } = await import(KERNEL + 'account-session.js');
  return await signAccountTicket(priv || ACCOUNT.priv, by, epoch, authAt);
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

async function doorTicket(by = 'password', epoch = 0, priv, now) {
  const { signDoorTicket } = await import(KERNEL + 'door.js');
  return await signDoorTicket(priv || ACCOUNT.priv, 'account', by, epoch, now);
}
/* 管理操作要账号门票：测试里带了账号会话又没显式给 sgx-door（键不存在）时，自动补一张同纪元的门票；
   要测「没有门票」就显式传 'sgx-door': '' */
async function withDoor(cookieObj) {
  const o = { ...(cookieObj || {}) };
  if (o['sgx-account'] && !('sgx-door' in o)) {
    const by = String(o['sgx-account']).split('.')[0];
    const ep = parseInt(String(o['sgx-account']).split('.')[1], 10) || 0;
    o['sgx-door'] = await doorTicket(by, ep);
  }
  return o;
}
async function accountPost(kv, body, cookieObj, envOverrides) {
  const { onRequestPost } = await import(API + 'account.js');
  const co = await withDoor(cookieObj);
  return await onRequestPost({ request: postReq('https://styrigx.com/api/account', body, { Cookie: cookies(co) }), env: envFor(kv, envOverrides) });
}
async function accountGet(kv, cookieObj, envOverrides) {
  const { onRequestGet } = await import(API + 'account.js');
  return await onRequestGet({ request: getReq('https://styrigx.com/api/account', { Cookie: cookies(cookieObj) }), env: envFor(kv, envOverrides) });
}
async function seedPassword(kv, pw) {
  const { makePasswordRecord } = await import(KERNEL + 'password.js');
  await kv.put('owner-pw', JSON.stringify(await makePasswordRecord(pw, PEPPER)));
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

test('/api/search：站长转发带 owner，访客带 visitor；参数原样带过去', async () => {
  const log = [];
  let r = await searchCall(makeKV(), '主题', { 'sgx-verified': await ownerSess() }, fakeSearch(log));
  assert.equal(r.status, 200);
  r = await searchCall(makeKV(), '主题', { 'sgx-verified': await visitorSess() }, fakeSearch(log));
  assert.equal(r.status, 200);
  assert.deepEqual(log.map((x) => x.role), ['owner', 'visitor']);
  const u = new URL(log[0].url);
  assert.equal(u.pathname, '/search');
  assert.equal(u.searchParams.get('q'), '主题');
  assert.equal(u.searchParams.get('lang'), 'zh');
});

test('/api/search：没绑定 503；上游抛错 503；空查询直接空结果；超长 400', async () => {
  const sess = { 'sgx-verified': await ownerSess() };
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
  r = await handleSubsite(new Request('https://blog.styrigx.com/api/search?q=a', { headers: { Cookie: 'sgx-verified=' + await visitorSess() } }), env, origin);
  assert.equal(r.status, 200);
  assert.equal(log[0].role, 'visitor');
  r = await handleSubsite(new Request('https://blog.styrigx.com/api/search?q=a', { method: 'POST', headers: { Cookie: 'sgx-verified=' + await visitorSess() } }), env, origin);
  assert.equal(r.status, 405);
});

test('头像分库：新库没有时读旧库；上传写新库并清旧库', async () => {
  const { avatarKv, legacyAvatarKv, KEY_VER, keyOf } = await import(KERNEL + 'avatar.js');
  const oldKv = makeKV({ [KEY_VER]: 'v1' });
  const newKv = makeKV();
  const env = { OWNER_KV: oldKv, ACCOUNT_KV: newKv };
  assert.equal(avatarKv(env), newKv);
  assert.equal(legacyAvatarKv(env), oldKv);
  assert.equal(avatarKv({ OWNER_KV: oldKv }), oldKv);
  assert.equal(legacyAvatarKv({ OWNER_KV: oldKv }), null);
  const m = await import(API + '../avatar/[file].js');
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  oldKv.getWithMetadata = async (k) => (k === keyOf(96) ? { value: png.buffer, metadata: { type: 'image/png' } } : { value: null, metadata: null });
  newKv.getWithMetadata = async () => ({ value: null, metadata: null });
  const r = await m.onRequestGet({ request: new Request('https://styrigx.com/avatar/96.webp'), env, params: { file: '96.webp' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('ETag'), '"v1-96"');
  assert.equal(r.headers.get('Content-Type'), 'image/png');
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

test('/api/status：没会话 401 不转发；站长 / 访客都转到 /summary，原样回', async () => {
  const log = [];
  assert.equal((await statusCall(makeKV(), {}, fakeStatus(log))).status, 401);
  assert.equal(log.length, 0);
  let r = await statusCall(makeKV(), { 'sgx-verified': await ownerSess() }, fakeStatus(log));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, sites: [] });
  assert.equal(r.headers.get('Cache-Control'), 'private, no-store');
  r = await statusCall(makeKV(), { 'sgx-verified': await visitorSess() }, fakeStatus(log));
  assert.equal(r.status, 200);
  assert.deepEqual(log.map((u) => new URL(u).pathname), ['/summary', '/summary']);
});

test('/api/status：没绑定 503；上游抛错 / 回非 200 都是 503', async () => {
  const sess = { 'sgx-verified': await ownerSess() };
  assert.equal((await statusCall(makeKV(), sess, undefined)).status, 503);
  assert.equal((await statusCall(makeKV(), sess, { async fetch() { throw new Error('x'); } })).status, 503);
  assert.equal((await statusCall(makeKV(), sess, fakeStatus([], 503))).status, 503);
});
