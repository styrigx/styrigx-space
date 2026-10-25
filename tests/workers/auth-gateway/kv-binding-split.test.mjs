/**
 * KV 绑定按域分（realms.js 头注释）：lock-* / root-* 只经 KV_LOCK_DOOR，account-* 只经 KV_ACCOUNT_LOGIN。
 *
 * 线上两个绑定是同一个 namespace，读错绑定也不会出错，所以单靠功能测试发现不了。这里把两个绑定换成
 * 同一份存储上的两个「只认自己前缀」的视图：越界的读写照常执行（流程不被打断），但记下来，最后断言一条都没有。
 *
 * 跑的流程：锁屏 / 账号两域的真实入口——
 * root-auth（lock-reset / account-reset / lock-reauth / account-reauth）、lock-entry、lock-password set / verify / change、
 * account（GET 状态、password-change、login-password、passkey-list、login-challenge、device-list）、
 * lock-reset（challenge、带账号密码证明的 verify）、lock-passkey challenge、lock-reauth status、layer-status、lock-credentials。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testLockSession, testTicket } from './_tickets.mjs';
import { makePasswordRecord } from '../../../workers/auth-gateway/functions/_kernel/password.js';
import { genKeyPair } from '../_harness.mjs';

const API = '../../../workers/auth-gateway/functions/api/';

/** 同一份存储上的两个视图；越界访问记进 violations */
function splitKV() {
  const store = new Map();
  const violations = [];
  const view = (name, ok) => {
    const check = (op, k) => { if (!ok(k)) violations.push(name + ' ' + op + ' ' + k); };
    return {
      async get(k, type) {
        check('get', k);
        if (!store.has(k)) return null;
        const v = store.get(k);
        return type === 'json' ? JSON.parse(v) : v;
      },
      async put(k, v) { check('put', k); store.set(k, String(v)); },
      async delete(k) { check('delete', k); store.delete(k); },
      async list({ prefix } = {}) {
        check('list', prefix || '');
        return { keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((n) => ({ name: n })), list_complete: true };
      },
    };
  };
  const lock = view('KV_LOCK_DOOR', (k) => k.startsWith('lock-') || k.startsWith('root-'));
  const account = view('KV_ACCOUNT_LOGIN', (k) => k.startsWith('account-'));
  return { store, lock, account, violations };
}

const ROOT_KEY = 'split-root-key-123456';
const PEPPER = 'split-pepper';
let LOCK, ACCOUNT;

function post(path, body, cookie) {
  return new Request('https://styrigx.com' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://styrigx.com', 'CF-Connecting-IP': '198.51.100.7', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}
function get(path, cookie) {
  return new Request('https://styrigx.com' + path, { headers: { 'CF-Connecting-IP': '198.51.100.7', ...(cookie ? { Cookie: cookie } : {}) } });
}
/** 收集 Set-Cookie 成 Cookie 头（同名后来的覆盖前面的） */
function cookieJar() {
  const jar = new Map();
  return {
    absorb(res) {
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        const name = pair.slice(0, i);
        const val = pair.slice(i + 1);
        if (/Max-Age=0/i.test(c) || val === '') jar.delete(name); else jar.set(name, val);
      }
      return res;
    },
    set(name, val) { jar.set(name, val); },
    header() { return [...jar].map(([k, v]) => k + '=' + v).join('; '); },
  };
}

test('KV 绑定按域分：锁屏 / 账号两域的入口跑一遍，没有一次越界访问', async () => {
  LOCK = await genKeyPair();
  ACCOUNT = await genKeyPair();
  const kv = splitKV();
  const env = {
    KV_LOCK_DOOR: kv.lock, KV_ACCOUNT_LOGIN: kv.account,
    SGX_ROOT_KEY: ROOT_KEY, SGX_PW_PEPPER: PEPPER,
    SGX_LOCK_PRIVATE: LOCK.priv, SGX_LOCK_PUBLIC: LOCK.pub,
    SGX_ACCOUNT_PRIVATE: ACCOUNT.priv, SGX_ACCOUNT_PUBLIC: ACCOUNT.pub,
    SGX_RP_ID: 'styrigx.com', SGX_ORIGIN: 'https://styrigx.com', SGX_ENV: 'production',
  };
  const call = async (mod, method, req) => (await import(API + mod))[method]({ request: req, env, waitUntil() {} });
  const jar = cookieJar();

  /* 启动站：什么都没设 → root-auth lock-reset 签 LockResetTicket；lock-entry 盘点两域凭证 */
  let r = await call('lock-entry.js', 'onRequestGet', get('/api/lock-entry'));
  assert.equal(r.status, 200);
  r = jar.absorb(await call('root-auth.js', 'onRequestPost', post('/api/root-auth', { key: ROOT_KEY, purpose: 'lock-reset' })));
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));

  /* 用 LockResetTicket 设锁屏密码（会看账号密码是否相同、账号是否已设置） */
  r = jar.absorb(await call('lock-password.js', 'onRequestPost', post('/api/lock-password', { action: 'set', password: 'lock-pass-1234' }, jar.header())));
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));

  /* 解锁 → admin 锁屏会话 */
  r = jar.absorb(await call('lock-password.js', 'onRequestPost', post('/api/lock-password', { action: 'verify', password: 'lock-pass-1234' }, jar.header())));
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));

  /* 账号：根凭证 account-reset → 设账号密码；再用账号密码登录、看状态、列钥匙、列设备 */
  r = jar.absorb(await call('root-auth.js', 'onRequestPost', post('/api/root-auth', { key: ROOT_KEY, purpose: 'account-reset' }, jar.header())));
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  r = jar.absorb(await call('account.js', 'onRequestPost', post('/api/account', { action: 'password-change', password: 'account-pass-5678' }, jar.header())));
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  r = jar.absorb(await call('account.js', 'onRequestPost', post('/api/account', { action: 'login-password', password: 'account-pass-5678' }, jar.header())));
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  r = await call('account.js', 'onRequestGet', get('/api/account', jar.header()));
  assert.equal(r.status, 200);
  r = jar.absorb(await call('root-auth.js', 'onRequestPost', post('/api/root-auth', { key: ROOT_KEY, purpose: 'account-reauth' }, jar.header())));
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  for (const action of ['passkey-list', 'device-list', 'passkey-register-challenge']) {
    r = jar.absorb(await call('account.js', 'onRequestPost', post('/api/account', { action }, jar.header())));
    assert.equal(r.status, 200, action + ' ' + JSON.stringify(await r.clone().json()));
  }
  /* 还没有账号通行密钥：login-challenge 读了钥匙列表后回 not-set */
  r = await call('account.js', 'onRequestPost', post('/api/account', { action: 'login-challenge' }, jar.header()));
  assert.equal((await r.json()).error, 'not-set');
  /* 账号密码错一次（账号域的失败计数） */
  r = await call('account.js', 'onRequestPost', post('/api/account', { action: 'login-password', password: 'nope-nope-nope' }, jar.header()));
  assert.equal(r.status, 403);

  /* 锁屏凭证页：根凭证 lock-reauth → 改锁屏密码（看账号密码是否相同）、状态、通行密钥 challenge、凭证列表 */
  r = jar.absorb(await call('root-auth.js', 'onRequestPost', post('/api/root-auth', { key: ROOT_KEY, purpose: 'lock-reauth' }, jar.header())));
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  r = await call('lock-reauth.js', 'onRequestPost', post('/api/lock-reauth', { action: 'status' }, jar.header()));
  assert.equal(r.status, 200);
  r = await call('lock-password.js', 'onRequestPost', post('/api/lock-password', { action: 'change', password: 'account-pass-5678' }, jar.header()));
  assert.equal((await r.json()).error, 'same-as-account');
  r = jar.absorb(await call('lock-password.js', 'onRequestPost', post('/api/lock-password', { action: 'change', password: 'lock-pass-9999' }, jar.header())));
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  r = await call('lock-passkey.js', 'onRequestPost', post('/api/lock-passkey', { action: 'challenge', type: 'register' }, jar.header()));
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  r = await call('lock-credentials.js', 'onRequestGet', get('/api/lock-credentials', jar.header()));
  assert.ok(r.status === 200 || r.status === 401, String(r.status));
  r = await call('layer-status.js', 'onRequestGet', get('/api/layer-status', jar.header()));
  assert.ok(r.status < 500, String(r.status));

  /* 无法登录 → lock-reset：先 challenge（账号通行密钥的 allowCredentials），再交根凭证 + 账号密码证明 */
  const anon = cookieJar();
  r = await call('lock-reset.js', 'onRequestPost', post('/api/lock-reset', { action: 'challenge' }));
  assert.equal((await r.json()).error, 'not-set', '没有账号通行密钥：读了账号钥匙列表后回 not-set');
  r = await call('lock-reset.js', 'onRequestPost', post('/api/lock-reset', { action: 'verify', rootKey: ROOT_KEY, accountProof: { type: 'password', password: 'account-pass-5678' } }, anon.header()));
  assert.ok(r.status === 200 || r.status === 403, String(r.status));

  /* 锁屏 / 账号两域的键确实都写进去了 */
  const keys = [...kv.store.keys()];
  assert.ok(keys.includes('lock-password') && keys.includes('account-password'), keys.join(','));
  assert.ok(keys.some((k) => k.startsWith('account-device:')), keys.join(','));
  assert.ok(keys.some((k) => k.startsWith('account-password-fail:')), keys.join(','));
  assert.deepEqual(kv.violations, []);
});
