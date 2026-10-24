/**
 * 账号云同步 /api/prefs（2026-10-22）：owner lock 会话 + 账号会话；逐项新的赢。
 *
 * 2026-10-24 搬到账号 Worker styrigx-account（workers/account）；会话经网关 verifier.js（_auth.mjs），登录流程仍用网关的 /api/account。
 *
 * 运行：node --test tests/workers/account/prefs.test.mjs
 */
import { signRole } from '../auth-gateway/_tk.mjs';
import { wrap } from './_auth.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const API = '../../../workers/auth-gateway/functions/api/';
const PREFS = '../../../workers/account/src/api/prefs.js';
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
    KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv, KV_SETTINGS_SYNC: kv,
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
  return await signRole(signSessionCookie, LOCK.priv, 0, 'visitor', 'owner');
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


async function prefsCall(kv, method, body, cookieObj, origin) {
  const mod = await import(PREFS);
  const m = { onRequestGet: wrap(mod.onRequestGet), onRequestPost: wrap(mod.onRequestPost) };
  const headers = { Cookie: cookies(cookieObj) };
  if (method === 'GET') return await m.onRequestGet({ request: new Request('https://styrigx.com/api/prefs', { headers }), env: envFor(kv) });
  const req = new Request('https://styrigx.com/api/prefs', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Origin: origin || 'https://styrigx.com' }, body: JSON.stringify(body) });
  return await m.onRequestPost({ request: req, env: envFor(kv) });
}

test('setup: 生成测试钥匙', async () => {
  LOCK = await edPair(); ACCOUNT = await edPair(); OTHER = await edPair();
});

test('要 owner lock 会话 + 账号会话：缺一个都 401', async () => {
  const kv = makeKV();
  assert.equal((await prefsCall(kv, 'GET', null, {})).status, 401);
  const sess = await ownerSess();
  const r = await prefsCall(kv, 'GET', null, { 'sgx-verified': sess });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'account');
  const vis = await visitorSess();
  assert.equal((await prefsCall(kv, 'GET', null, { 'sgx-verified': vis, 'sgx-account': await accTicket() })).status, 401);
  const ok = await prefsCall(kv, 'GET', null, { 'sgx-verified': sess, 'sgx-account': await accTicket() });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).items, {});
});

test('POST 合并：逐项新的赢；旧的不覆盖；非 sgx- key / 未来时间 / 超长值丢掉', async () => {
  const kv = makeKV();
  const co = { 'sgx-verified': await ownerSess(), 'sgx-account': await accTicket() };
  const now = Date.now();
  let r = await prefsCall(kv, 'POST', { changes: {
    'sgx-theme-mode': { v: 'dark', t: now - 1000 },
    'sgx-palette': { v: 'mint', t: now - 1000 },
    'evil': { v: 'x', t: now },
    'sgx-future': { v: 'x', t: now + 3600e3 },
    'sgx-long': { v: 'x'.repeat(601), t: now },
    'sgx-num': { v: 5, t: now },
  } }, co);
  assert.equal(r.status, 200);
  let j = await r.json();
  assert.deepEqual(Object.keys(j.items).sort(), ['sgx-palette', 'sgx-theme-mode']);
  r = await prefsCall(kv, 'POST', { changes: { 'sgx-theme-mode': { v: 'light', t: now - 5000 }, 'sgx-palette': { v: null, t: now } } }, co);
  j = await r.json();
  assert.equal(j.items['sgx-theme-mode'].v, 'dark', '旧的不覆盖');
  assert.equal(j.items['sgx-palette'].v, null, '恢复默认也同步');
  const g = await (await prefsCall(kv, 'GET', null, co)).json();
  assert.deepEqual(g.items, j.items);
});

test('POST 跨源 → 拒绝', async () => {
  const kv = makeKV();
  const co = { 'sgx-verified': await ownerSess(), 'sgx-account': await accTicket() };
  const r = await prefsCall(kv, 'POST', { changes: {} }, co, 'https://evil.example');
  assert.equal(r.status, 403);
});

test('被单独退出的设备（revoked）不能同步', async () => {
  const kv = makeKV();
  const { signAccountTicket } = await import(KERNEL + 'account-session.js');
  const t = await signAccountTicket(ACCOUNT.priv, 'password', 0, Date.now(), undefined, 'AAAAAAAAAAAAAAAA');
  await kv.put('account-revoked:AAAAAAAAAAAAAAAA', '1');
  const r = await prefsCall(kv, 'GET', null, { 'sgx-verified': await ownerSess(), 'sgx-account': t });
  assert.equal(r.status, 401);
});
