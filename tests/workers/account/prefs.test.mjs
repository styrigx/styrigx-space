/**
 * 账号云同步 /api/prefs（2026-10-22）：admin lock 会话 + 账号会话；逐项新的赢。
 *
 * 2026-10-24 搬到账号 Worker styrigx-account（workers/account）；会话经网关 verifier.js（_auth.mjs），登录流程仍用网关的 /api/account。
 *
 * 运行：node --test tests/workers/account/prefs.test.mjs
 */
import { wrap } from './_auth.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testLockSession, testAccountSession } from '../auth-gateway/_tickets.mjs';
import { makeKV, genKeyPair } from '../_harness.mjs';

const API = '../../../workers/auth-gateway/functions/api/';
const PREFS = '../../../workers/account/src/api/prefs.js';
const KERNEL = '../../../workers/auth-gateway/functions/_kernel/';

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


async function prefsCall(kv, method, body, cookieObj, origin) {
  const mod = await import(PREFS);
  const m = { onRequestGet: wrap(mod.onRequestGet), onRequestPost: wrap(mod.onRequestPost) };
  const headers = { Cookie: cookies(cookieObj) };
  if (method === 'GET') return await m.onRequestGet({ request: new Request('https://styrigx.com/api/prefs', { headers }), env: envFor(kv) });
  const req = new Request('https://styrigx.com/api/prefs', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Origin: origin || 'https://styrigx.com' }, body: JSON.stringify(body) });
  return await m.onRequestPost({ request: req, env: envFor(kv) });
}

test('setup: 生成测试钥匙', async () => {
  LOCK = await genKeyPair(); ACCOUNT = await genKeyPair(); OTHER = await genKeyPair();
});

test('要 admin lock 会话 + 账号会话：缺一个都 401', async () => {
  const kv = makeKV();
  assert.equal((await prefsCall(kv, 'GET', null, {})).status, 401);
  const sess = await adminSess();
  const r = await prefsCall(kv, 'GET', null, { 'sgx-lock-session': sess });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'account');
  const vis = await visitorSess();
  assert.equal((await prefsCall(kv, 'GET', null, { 'sgx-lock-session': vis, 'sgx-account-session': await accTicket() })).status, 401);
  const ok = await prefsCall(kv, 'GET', null, { 'sgx-lock-session': sess, 'sgx-account-session': await accTicket() });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).items, {});
});

test('POST 合并：逐项新的赢；旧的不覆盖；非 sgx- key / 未来时间 / 超长值丢掉', async () => {
  const kv = makeKV();
  const co = { 'sgx-lock-session': await adminSess(), 'sgx-account-session': await accTicket() };
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
  const co = { 'sgx-lock-session': await adminSess(), 'sgx-account-session': await accTicket() };
  const r = await prefsCall(kv, 'POST', { changes: {} }, co, 'https://evil.example');
  assert.equal(r.status, 403);
});

test('被单独退出的设备（revoked）不能同步', async () => {
  const kv = makeKV();
  const { signAccountSessionTicket } = await import(KERNEL + 'account-session.js');
  const t = await testAccountSession(ACCOUNT.priv, 'password', 0, Date.now(), undefined, 'AAAAAAAAAAAAAAAA');
  await kv.put('account-device-revoked:AAAAAAAAAAAAAAAA', '1');
  const r = await prefsCall(kv, 'GET', null, { 'sgx-lock-session': await adminSess(), 'sgx-account-session': t });
  assert.equal(r.status, 401);
});
