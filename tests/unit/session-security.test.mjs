/**
 * 2.4.1 锁屏服务端安全测试（node --test）。
 *
 * 覆盖用例（对应 Gray 7 类修复的第 1/2/3/4/5/6 项中需要服务端断言的部分）：
 * - sgx-verified 设置/清除走同一函数、属性只定义一处（含 Domain=.styrigx.com）
 * - getSessionEpoch：KV 出错抛错；key 不存在才当 0；bump 出错绝不写入
 * - /api/session-epoch：KV 未绑定/读取出错 → 503；key 不存在 → {epoch:0}
 * - owner-password：verify 通过后 Set-Cookie 带 Domain；KV 出错 → 503；
 *   lockout 后 epoch+1、清 cookie 带 Domain、KV 出错 → 503 且不写入
 * - _middleware：缺 SGX_ED25519_PUBLIC 时生产环境 fail closed（只放白名单）；
 *   过期 cookie 被拒；旧 epoch cookie 被拒；伪造签名被拒；
 *   未验证的非白名单路径 302 到 https://styrigx.com/?lock=1&return=<站内路径>
 *   （Cache-Control: no-store，不再返回 200 锁屏 HTML）；
 *   ?return= 只接受站内路径（/ 开头，非 //、/\），非法一律回首页 /；
 *   isSafeReturnPath 导出供复用
 * - /api/session-check：有效会话 200 {ok:true}，否则 401
 * - 三个解锁接口（password/verify/passkey）成功时 Set-Cookie 属性齐全：
 *   Path=/、Secure、HttpOnly、SameSite=Lax、Domain=.styrigx.com
 *
 * 运行：node --test tests/unit/
 * 说明：mock KV 只替代 Cloudflare KV（外部环境敏感项），被测的是自家逻辑；
 * Ed25519 测试密钥在测试内临时生成，不用生产密钥、不进仓库。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  setVerifiedCookie,
  clearVerifiedCookie,
  signSessionCookie,
  parseSessionCookie,
  getSessionEpoch,
  bumpSessionEpoch,
  SESSION_MAX_AGE,
} from '../../functions/_lib/session.js';
import { hmacSign, b64urlEnc, ed25519Sign } from '../../functions/_lib/crypto.js';
import { onRequestPost as pwPost } from '../../functions/api/owner-password.js';
import { onRequestGet as epochGet } from '../../functions/api/session-epoch.js';
import { onRequest as mw } from '../../functions/_middleware.js';

/* ---------- mock KV ---------- */

function makeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k, type) {
      if (!store.has(k)) return null;
      const v = store.get(k);
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
    async list() { return { keys: [] }; },
  };
}

/* 读取抛错的 KV（模拟 KV 故障） */
function makeBrokenKV(method = 'get') {
  const kv = makeKV();
  kv[method] = async () => { throw new Error('KV simulated failure'); };
  return kv;
}

/* put 时抛错的 KV（模拟 bump 写入阶段故障） */
function makePutBrokenKV(initial = {}) {
  const kv = makeKV(initial);
  const origPut = kv.put;
  kv.putCalls = 0;
  kv.put = async (k, v) => { kv.putCalls++; throw new Error('KV put failure'); };
  return kv;
}

/* ---------- Ed25519 测试密钥（临时生成） ---------- */

function derToPem(der, label) {
  const b64 = Buffer.from(der).toString('base64');
  const lines = b64.match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

let TEST_PRIV_PEM = '';
let TEST_PUB_PEM = '';

async function genTestKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const privDer = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
  const pubDer = await crypto.subtle.exportKey('spki', kp.publicKey);
  TEST_PRIV_PEM = derToPem(privDer, 'PRIVATE KEY');
  TEST_PUB_PEM = derToPem(pubDer, 'PUBLIC KEY');
}

/* owner-auth token（测试内签发，与服务端 verifyOwnerToken 同逻辑） */
async function mintOwnerToken(secret) {
  const raw = JSON.stringify({ scope: 'owner-auth', exp: Date.now() + 300000 });
  const payload = b64urlEnc(new TextEncoder().encode(raw));
  const sig = await hmacSign(secret, 'owner-auth|', payload);
  return payload + '.' + sig;
}

function postReq(url, body, headers = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/* 在 owner-pw 记录里预置密码 test-pass-12345（100000 次迭代与服务端一致） */
async function seedPassword(kv, password = 'test-pass-12345') {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  const b64e = (buf) => Buffer.from(buf).toString('base64');
  await kv.put('owner-pw', JSON.stringify({
    salt: b64e(salt.buffer), hash: b64e(bits), iterations: 100000, updatedAt: Date.now(),
  }));
}

/* ================================================================
 * 1. cookie 设置/清除统一
 * ================================================================ */

test('setVerifiedCookie 属性只定义一处（含 Domain=.styrigx.com）', async () => {
  await genTestKeys();
  const h = new Headers();
  setVerifiedCookie(h, '0.123.sig');
  const sc = h.get('Set-Cookie');
  assert.match(sc, /^sgx-verified=0\.123\.sig; /);
  assert.match(sc, /Domain=\.styrigx\.com/);
  assert.match(sc, /Path=\//);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /Secure/);
  assert.match(sc, /SameSite=Lax/);
  assert.match(sc, new RegExp(`Max-Age=${SESSION_MAX_AGE}`));
  assert.equal(SESSION_MAX_AGE, 43200);
});

test('clearVerifiedCookie 用相同 Domain/Path 并正确过期', () => {
  const h = new Headers();
  clearVerifiedCookie(h);
  const sc = h.get('Set-Cookie');
  assert.match(sc, /^sgx-verified=; /);
  assert.match(sc, /Domain=\.styrigx\.com/);
  assert.match(sc, /Path=\//);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /Secure/);
  assert.match(sc, /SameSite=Lax/);
  assert.match(sc, /Max-Age=0/);
  assert.match(sc, /Expires=Thu, 01 Jan 1970/);
});

/* ================================================================
 * 2. getSessionEpoch / bumpSessionEpoch
 * ================================================================ */

test('getSessionEpoch：key 不存在才当 0；有值返回值', async () => {
  assert.equal(await getSessionEpoch(makeKV()), 0);
  assert.equal(await getSessionEpoch(makeKV({ 'session-epoch': '7' })), 7);
});

test('getSessionEpoch：KV 读取出错抛错', async () => {
  await assert.rejects(() => getSessionEpoch(makeBrokenKV('get')), /KV simulated failure/);
});

test('bumpSessionEpoch：0→1，N→N+1；出错绝不写入', async () => {
  assert.equal(await bumpSessionEpoch(makeKV()), 1);
  const kv = makeKV({ 'session-epoch': '4' });
  assert.equal(await bumpSessionEpoch(kv), 5);
  assert.equal(kv.store.get('session-epoch'), '5');

  const broken = makePutBrokenKV({ 'session-epoch': '9' });
  await assert.rejects(() => bumpSessionEpoch(broken), /KV put failure/);
  /* 写入失败：原值不动（杜绝 epoch 变小） */
  assert.equal(broken.store.get('session-epoch'), '9');
  assert.equal(broken.putCalls, 1);
});

test('bumpSessionEpoch：读取出错时不写入（旧 cookie 不复活）', async () => {
  const kv = makeBrokenKV('get');
  let putCalled = false;
  kv.put = async () => { putCalled = true; };
  await assert.rejects(() => bumpSessionEpoch(kv), /KV simulated failure/);
  assert.equal(putCalled, false);
});

/* ================================================================
 * 3. /api/session-epoch
 * ================================================================ */

test('session-epoch：KV 未绑定 → 503', async () => {
  const r = await epochGet({ env: {} });
  assert.equal(r.status, 503);
});

test('session-epoch：KV 读取出错 → 503（不再返回 {epoch:0}）', async () => {
  const r = await epochGet({ env: { OWNER_KV: makeBrokenKV('get') } });
  assert.equal(r.status, 503);
  const j = await r.json();
  assert.equal(j.ok, false);
});

test('session-epoch：key 不存在 → 200 {epoch:0}', async () => {
  const r = await epochGet({ env: { OWNER_KV: makeKV() } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { epoch: 0 });
});

test('session-epoch：有值 → 200 {epoch:N}', async () => {
  const r = await epochGet({ env: { OWNER_KV: makeKV({ 'session-epoch': '3' }) } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { epoch: 3 });
});

/* ================================================================
 * owner-password：verify / lockout
 * ================================================================ */

test('password verify 通过：Set-Cookie 带 Domain=.styrigx.com（Ed25519 格式）', async () => {
  const kv = makeKV();
  await seedPassword(kv);
  const env = { OWNER_KV: kv, SESSION_SECRET: 'test-secret', SGX_ED25519_PRIVATE: TEST_PRIV_PEM };
  const r = await pwPost({ request: postReq('https://styrigx.com/api/owner-password', { action: 'verify', password: 'test-pass-12345' }), env });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  const sc = r.headers.get('Set-Cookie');
  assert.match(sc, /Domain=\.styrigx\.com/);
  assert.match(sc, /Max-Age=43200/);
  const parsed = parseSessionCookie(sc.split(';')[0].split('=')[1]);
  assert.ok(parsed);
  assert.equal(parsed.epoch, 0);
  assert.ok(parsed.exp > Date.now());
  assert.equal(parsed.sig.length > 10, true);
});

test('password verify：KV 读取 session-epoch 出错 → 503（不签发会话）', async () => {
  const kv = makeKV();
  await seedPassword(kv);
  /* 只让 session-epoch 的 get 抛错 */
  const origGet = kv.get.bind(kv);
  kv.get = async (k, t) => {
    if (k === 'session-epoch') throw new Error('KV boom');
    return origGet(k, t);
  };
  const env = { OWNER_KV: kv, SESSION_SECRET: 'test-secret', SGX_ED25519_PRIVATE: TEST_PRIV_PEM };
  const r = await pwPost({ request: postReq('https://styrigx.com/api/owner-password', { action: 'verify', password: 'test-pass-12345' }), env });
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('Set-Cookie'), null);
});

test('password verify：密码错误 → 403（不签发）', async () => {
  const kv = makeKV();
  await seedPassword(kv);
  const env = { OWNER_KV: kv, SESSION_SECRET: 's', SGX_ED25519_PRIVATE: TEST_PRIV_PEM };
  const r = await pwPost({ request: postReq('https://styrigx.com/api/owner-password', { action: 'verify', password: 'nope-nope-nope' }), env });
  assert.equal(r.status, 403);
  assert.equal(r.headers.get('Set-Cookie'), null);
});

test('lockout：epoch+1、清 cookie 带 Domain；KV 写入出错 → 503 且 epoch 不变', async () => {
  const kv = makeKV({ 'session-epoch': '2' });
  const env = { OWNER_KV: kv, SESSION_SECRET: 's' };
  const token = await mintOwnerToken('s');
  const r = await pwPost({ request: postReq('https://styrigx.com/api/owner-password', { action: 'lockout', token }), env });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal(kv.store.get('session-epoch'), '3');
  const sc = r.headers.get('Set-Cookie');
  assert.match(sc, /^sgx-verified=; /);
  assert.match(sc, /Domain=\.styrigx\.com/);
  assert.match(sc, /Max-Age=0/);

  /* 写入失败 → 503，epoch 保持原值 */
  const broken = makePutBrokenKV({ 'session-epoch': '5' });
  const r2 = await pwPost({
    request: postReq('https://styrigx.com/api/owner-password', { action: 'lockout', token }),
    env: { OWNER_KV: broken, SESSION_SECRET: 's' },
  });
  assert.equal(r2.status, 503);
  assert.equal(broken.store.get('session-epoch'), '5');
});

test('change/remove 密码：KV 出错 → 503', async () => {
  const broken = makePutBrokenKV();
  const env = { OWNER_KV: broken, SESSION_SECRET: 's' };
  const token = await mintOwnerToken('s');
  /* set 会先写 owner-pw 成功，然后 bump 抛错 → 503 */
  const r = await pwPost({
    request: postReq('https://styrigx.com/api/owner-password', { action: 'set', token, password: 'another-pass-1' }),
    env,
  });
  assert.equal(r.status, 503);
});

/* ================================================================
 * _middleware
 * ================================================================ */

function mwCtx(url, { cookie = '', env = {} } = {}) {
  const headers = {};
  if (cookie) headers['Cookie'] = 'sgx-verified=' + cookie;
  return {
    request: new Request(url, { headers }),
    next: async () => new Response('NEXT-BY-APP', { status: 200 }),
    env,
  };
}

const PROD_ENV = () => ({
  SGX_ENV: 'production',
  SGX_SITE: 'space',
  SGX_ED25519_PUBLIC: TEST_PUB_PEM,
  OWNER_KV: makeKV(),
});
const PROD_URL = 'https://styrigx.com/settings/';

async function validCookie(epoch = 0) {
  return await signSessionCookie(TEST_PRIV_PEM, epoch);
}

test('middleware：生产环境缺 SGX_ED25519_PUBLIC → fail closed（非白名单 302 到首页锁屏）', async () => {
  const env = { SGX_ENV: 'production', SGX_SITE: 'space', OWNER_KV: makeKV() };
  const r = await mw(mwCtx(PROD_URL, { env }));
  assert.equal(r.status, 302);
  const loc = r.headers.get('Location');
  assert.ok(loc.startsWith('https://styrigx.com/?lock=1&return='));
  assert.equal(decodeURIComponent(loc.slice(loc.indexOf('return=') + 7)), '/settings/');
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  /* 白名单路径放行 */
  const r2 = await mw(mwCtx('https://styrigx.com/api/owner-status', { env }));
  assert.equal(await r2.text(), 'NEXT-BY-APP');
  const r3 = await mw(mwCtx('https://styrigx.com/', { env }));
  assert.equal(await r3.text(), 'NEXT-BY-APP');
});

test('middleware：有公钥但无 cookie → 302 到首页锁屏；有效 cookie → 放行', async () => {
  const r = await mw(mwCtx(PROD_URL, { env: PROD_ENV() }));
  assert.equal(r.status, 302);
  assert.ok(r.headers.get('Location').startsWith('https://styrigx.com/?lock=1&return='));

  const r2 = await mw(mwCtx(PROD_URL, { cookie: await validCookie(0), env: PROD_ENV() }));
  assert.equal(await r2.text(), 'NEXT-BY-APP');
});

test('middleware：未带 cookie 访问内页 → 302，return 是站内路径', async () => {
  const target = 'https://styrigx.com/browser/?x=1';
  const r = await mw(mwCtx(target, { env: PROD_ENV() }));
  assert.equal(r.status, 302);
  const loc = r.headers.get('Location');
  assert.ok(loc.startsWith('https://styrigx.com/?lock=1&return='));
  /* return 解码后是站内路径（含 query），不是完整 URL */
  assert.equal(decodeURIComponent(loc.slice(loc.indexOf('return=') + 7)), '/browser/?x=1');
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
});

test('middleware：有效签名 cookie 访问内页 → 200 正文（不是锁屏）', async () => {
  const r = await mw(mwCtx(PROD_URL, { cookie: await validCookie(0), env: PROD_ENV() }));
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'NEXT-BY-APP');
  assert.equal(r.headers.get('Location'), null);
});

test('middleware：过期 cookie 被拒（302 到首页锁屏）', async () => {
  const payload = '0.' + (Date.now() - 1000);
  const sig = await ed25519Sign(TEST_PRIV_PEM, payload);
  const env = PROD_ENV();
  const r = await mw(mwCtx(PROD_URL, { cookie: payload + '.' + sig, env }));
  assert.equal(r.status, 302);
  assert.ok(r.headers.get('Location').startsWith('https://styrigx.com/?lock=1&return='));
});

test('middleware：伪造签名被拒（302 到首页锁屏）', async () => {
  const env = PROD_ENV();
  const r = await mw(mwCtx(PROD_URL, { cookie: '0.9999999999999.badsig', env }));
  assert.equal(r.status, 302);
  assert.ok(r.headers.get('Location').startsWith('https://styrigx.com/?lock=1&return='));
});

test('middleware：lockout 后旧 epoch cookie 失效', async () => {
  const kv = makeKV({ 'session-epoch': '0' });
  const env = { SGX_ENV: 'production', SGX_SITE: 'space', SGX_ED25519_PUBLIC: TEST_PUB_PEM, OWNER_KV: kv };
  const oldCookie = await signSessionCookie(TEST_PRIV_PEM, 0);
  /* 旧 cookie 有效 */
  const r1 = await mw(mwCtx(PROD_URL, { cookie: oldCookie, env }));
  assert.equal(await r1.text(), 'NEXT-BY-APP');
  /* bump（模拟 lockout） */
  await bumpSessionEpoch(kv);
  /* 旧 cookie 失效 → 302 到首页锁屏 */
  const r2 = await mw(mwCtx(PROD_URL, { cookie: oldCookie, env }));
  assert.equal(r2.status, 302);
  assert.ok(r2.headers.get('Location').startsWith('https://styrigx.com/?lock=1&return='));
  /* 新 cookie 有效 */
  const newCookie = await signSessionCookie(TEST_PRIV_PEM, 1);
  const r3 = await mw(mwCtx(PROD_URL, { cookie: newCookie, env }));
  assert.equal(await r3.text(), 'NEXT-BY-APP');
});

test('middleware：非生产环境不锁', async () => {
  const r = await mw(mwCtx('http://localhost:8931/settings/', { env: {} }));
  assert.equal(await r.text(), 'NEXT-BY-APP');
});

test('middleware：?return= 只接受站内路径，非法一律回首页 /', async () => {
  const env = PROD_ENV();
  const cookie = await validCookie(0);

  async function tryReturn(ret) {
    const r = await mw(mwCtx(
      'https://styrigx.com/?lock=1&return=' + encodeURIComponent(ret),
      { cookie, env }
    ));
    return r;
  }

  /* 合法站内路径 → 302 到该路径 */
  let r = await tryReturn('/settings/');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('Location'), '/settings/');

  r = await tryReturn('/browser/?x=1');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('Location'), '/browser/?x=1');

  /* 完整 URL 不再接受 → 回首页 */
  r = await tryReturn('https://styrigx.com/settings/');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('Location'), '/');

  /* 外部域名 → 回首页 */
  r = await tryReturn('https://evil.com/');
  assert.equal(r.headers.get('Location'), '/');

  /* 后缀欺骗 → 回首页 */
  r = await tryReturn('https://styrigx.com.evil.com/');
  assert.equal(r.headers.get('Location'), '/');

  /* 协议相对 URL → 回首页 */
  r = await tryReturn('//evil.com/');
  assert.equal(r.headers.get('Location'), '/');

  /* 反斜杠 trick → 回首页 */
  r = await tryReturn('/\\evil.com/');
  assert.equal(r.headers.get('Location'), '/');

  /* javascript: → 回首页 */
  r = await tryReturn('javascript:alert(1)');
  assert.equal(r.headers.get('Location'), '/');

  /* 无会话时不跳转（走正常锁流程，'/' 白名单放行） */
  r = await mw(mwCtx(
    'https://styrigx.com/?lock=1&return=' + encodeURIComponent('/settings/'),
    { env }
  ));
  assert.equal(r.headers.get('Location'), null);
  assert.equal(await r.text(), 'NEXT-BY-APP');
});

test('middleware：无有效会话访问内页 → 302 到首页锁屏（return 为站内路径）', async () => {
  const env = PROD_ENV();
  const original = 'https://styrigx.com/settings/?x=1';
  const r = await mw(mwCtx(original, { env }));
  assert.equal(r.status, 302);
  const loc = r.headers.get('Location');
  assert.ok(loc.startsWith('https://styrigx.com/?lock=1&return='));
  /* return 解码后是站内路径 */
  assert.equal(decodeURIComponent(loc.slice(loc.indexOf('return=') + 7)), '/settings/?x=1');
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
});

/* ================================================================
 * /api/session-check（2.4.1 防循环）
 * ================================================================ */

test('session-check：有效会话 → 200 {ok:true}；无会话/坏会话 → 401', async () => {
  const { onRequestGet: checkGet } = await import('../../functions/api/session-check.js');
  const env = PROD_ENV();

  const mkReq = (cookie) => {
    const headers = {};
    if (cookie) headers['Cookie'] = 'sgx-verified=' + cookie;
    return new Request('https://styrigx.com/api/session-check', { headers });
  };

  let r = await checkGet({ request: mkReq(await validCookie(0)), env });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });

  r = await checkGet({ request: mkReq(''), env });
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { ok: false });

  r = await checkGet({ request: mkReq('0.9999999999999.badsig'), env });
  assert.equal(r.status, 401);
});

/* ================================================================
 * 三个解锁接口：成功时 Set-Cookie 属性（2.4.1 会话诊断）
 * ================================================================ */

function assertSessionCookieAttrs(sc) {
  assert.ok(sc, '必须带 Set-Cookie');
  assert.match(sc, /^sgx-verified=/);
  assert.match(sc, /Path=\//);
  assert.match(sc, /Secure/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Lax/);
  assert.match(sc, /Domain=\.styrigx\.com/);
  assert.match(sc, /Max-Age=43200/);
}

test('password verify 通过：Set-Cookie 属性齐全（Path/Secure/HttpOnly/SameSite=Lax）', async () => {
  const kv = makeKV();
  await seedPassword(kv);
  const env = { OWNER_KV: kv, SESSION_SECRET: 'test-secret', SGX_ED25519_PRIVATE: TEST_PRIV_PEM };
  const r = await pwPost({ request: postReq('https://styrigx.com/api/owner-password', { action: 'verify', password: 'test-pass-12345' }), env });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assertSessionCookieAttrs(r.headers.get('Set-Cookie'));
});

test('verify（Turnstile）通过：Set-Cookie 属性齐全', async () => {
  const { onRequestPost: verifyPost } = await import('../../functions/api/verify.js');
  /* mock Turnstile siteverify（只替代外网接口，逻辑走真实代码） */
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).includes('challenges.cloudflare.com'));
    return Response.json({ success: true, hostname: 'styrigx.com', action: 'sgx-entry' });
  };
  try {
    const kv = makeKV();
    const env = {
      OWNER_KV: kv,
      TURNSTILE_SECRET: 'test-secret',
      SGX_ED25519_PRIVATE: TEST_PRIV_PEM,
    };
    const r = await verifyPost({
      request: postReq('https://styrigx.com/api/verify', { token: 'test-token' }),
      env,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
    assertSessionCookieAttrs(r.headers.get('Set-Cookie'));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('passkey auth 通过：Set-Cookie 属性齐全', async () => {
  const { onRequestPost: pkPost } = await import('../../functions/api/owner-passkey.js');
  const b64url = (buf) => Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  /* 生成测试用 ECDSA P-256 密钥对，写入 KV（模拟已注册的通行密钥） */
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const credId = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const kv = makeKV();
  await kv.put('owner-passkey-index', JSON.stringify([credId]));
  await kv.put('owner-passkey:' + credId.slice(0, 12), JSON.stringify({
    name: 'test-key', credId, publicKey: jwk, signCount: 0, uv: 1,
    createdAt: Date.now(), lastUsedAt: 0,
  }));
  /* 预置 auth challenge */
  const cid = 'test-cid-' + Date.now();
  const challenge = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await kv.put('pk-challenge:' + cid, JSON.stringify({ type: 'auth', challenge, exp: Date.now() + 60000 }));

  const env = {
    OWNER_KV: kv,
    SESSION_SECRET: 'test-secret',
    SGX_ED25519_PRIVATE: TEST_PRIV_PEM,
    SGX_RP_ID: 'styrigx.com',
    SGX_ORIGIN: 'https://styrigx.com',
  };

  /* 构造 WebAuthn 断言 */
  const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('styrigx.com')));
  const authData = new Uint8Array(37);
  authData.set(rpIdHash, 0);
  authData[32] = 0x05; /* UP + UV */
  authData[36] = 1; /* signCount = 1 */
  const clientData = { type: 'webauthn.get', challenge, origin: 'https://styrigx.com' };
  const clientDataJSON = new TextEncoder().encode(JSON.stringify(clientData));
  const cdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON));
  const sigBase = new Uint8Array(authData.length + cdHash.length);
  sigBase.set(authData, 0);
  sigBase.set(cdHash, authData.length);
  const sigDer = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, sigBase);
  /* Node 的 WebCrypto ECDSA 签名是 raw r||s（64 字节），服务端要 DER，先转一下 */
  const rawSig = new Uint8Array(sigDer);
  const rB = rawSig.slice(0, 32);
  const sB = rawSig.slice(32, 64);
  const trim = (v) => {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    v = v.slice(i);
    /* DER 整数高位置 1 时前面补 0x00 */
    if (v[0] >= 0x80) {
      const w = new Uint8Array(v.length + 1);
      w.set(v, 1);
      return w;
    }
    return v;
  };
  const rT = trim(rB), sT = trim(sB);
  const derLen = 2 + rT.length + 2 + sT.length;
  const der = new Uint8Array(2 + derLen);
  let o = 0;
  der[o++] = 0x30; der[o++] = derLen;
  der[o++] = 0x02; der[o++] = rT.length; der.set(rT, o); o += rT.length;
  der[o++] = 0x02; der[o++] = sT.length; der.set(sT, o);
  const sigDerB64 = b64url(der);

  const body = {
    action: 'auth',
    cid,
    credential: {
      id: credId,
      rawId: credId,
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: sigDerB64,
        userHandle: null,
      },
      type: 'public-key',
    },
  };
  const r = await pkPost({ request: postReq('https://styrigx.com/api/owner-passkey', body), env });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  assertSessionCookieAttrs(r.headers.get('Set-Cookie'));
});
