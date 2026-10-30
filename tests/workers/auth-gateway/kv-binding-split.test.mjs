/**
 * D1 绑定按域分（realms.js 头注释，2026-10-27 起网关认证状态全部在 D1，不再绑定 KV）：
 * realm='lock' 的行（和 recovery_switch）只经 D1_LOCK_AUTH，realm='account' 只经 D1_ACCOUNT_AUTH，realm='root' 只经 D1_ROOT_AUTH。
 *
 * 线上三个绑定是同一个库，读错绑定也不会出错，所以单靠功能测试发现不了。这里把三个绑定换成
 * 同一个库上的三个「只认自己 realm」的视图：越界的语句照常执行（流程不被打断），但记下来，最后断言一条都没有。
 * env 里同时放上以前的 KV_LOCK_DOOR / KV_ACCOUNT_LOGIN，换成碰一下就抛错的替身：运行时一次都不能碰（没有 KV 回落）。
 *
 * 跑的流程：锁屏 / 账号两域的真实入口——
 * root-auth（lock-reset / account-reset / lock-reauth / account-reauth）、lock-entry、lock-password set / verify / change、
 * account（GET 状态、password-change、login-password、passkey-list、login-challenge、device-list）、
 * lock-reset（challenge、带账号密码证明的 verify）、lock-passkey challenge、lock-reauth status、layer-status、lock-credentials。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testLockSession, testTicket } from './_tickets.mjs';
import { makePasswordRecord } from '../../../workers/auth-gateway/functions/_kernel/lib/password.js';
import { genKeyPair, makeAuthD1, forbiddenKV } from '../_harness.mjs';

const API = '../../../workers/auth-gateway/functions/api/';

/** 有 realm 列的表（0005 / 0006）；recovery_switch、kv_migration 没有 realm 列 */
const REALM_TABLES = /\b(?:FROM|INTO|UPDATE|JOIN)\s+(epoch|passkey|password|user_handle|challenge|attempt_limit|tempkey|device|audit)\b/i;
const REALM_IDS = ['lock', 'account', 'root'];

/**
 * 同一个 D1 替身上的三个视图（D1_LOCK_AUTH / D1_ACCOUNT_AUTH / D1_ROOT_AUTH），每个只认自己 realm 的行：
 * - 碰有 realm 列的表的语句，绑定参数里必须有自己的 realm id；
 * - 参数里出现别的 realm id（'lock' / 'account' / 'root' 原样）算越界；
 * - recovery_switch 只许经 D1_LOCK_AUTH；kv_migration 运行时谁都不许碰（只有导入脚本写）。
 * 越界的语句照常执行（流程不被打断），记进 violations，最后断言一条都没有。
 */
function splitD1() {
  const db = makeAuthD1();
  const violations = [];
  /** @type {Record<string, number>} 每个视图执行过的、碰 realm 表的语句数 */
  const used = { lock: 0, account: 0, root: 0 };
  const view = (name, mine) => {
    const check = (sql, args) => {
      if (/^\s*CREATE /i.test(sql)) return; /* 兜底建表 */
      if (/\bkv_migration\b/i.test(sql)) violations.push(name + ' touches kv_migration: ' + sql);
      if (/\brecovery_switch\b/i.test(sql) && mine !== 'lock') violations.push(name + ' touches recovery_switch: ' + sql);
      for (const a of args) {
        if (typeof a === 'string' && REALM_IDS.includes(a) && a !== mine) violations.push(name + ' binds ' + a + ': ' + sql);
      }
      if (REALM_TABLES.test(sql)) {
        used[mine]++;
        if (!args.includes(mine)) violations.push(name + ' realm table without realm=' + mine + ': ' + sql + ' ' + JSON.stringify(args));
      }
    };
    return {
      prepare(sql) {
        const st = db.prepare(sql);
        let bound = [];
        const exec = (k) => { check(sql, bound); return st._exec(k); };
        const wrapped = {
          bind(...args) { bound = args; st.bind(...args); return wrapped; },
          first: async () => exec('first'),
          all: async () => exec('all'),
          run: async () => exec('run'),
          _exec: exec,
          _sql: sql,
          _args: () => bound,
        };
        return wrapped;
      },
      batch: (stmts) => db.batch(stmts),
    };
  };
  return { db, violations, used, lock: view('D1_LOCK_AUTH', 'lock'), account: view('D1_ACCOUNT_AUTH', 'account'), root: view('D1_ROOT_AUTH', 'root') };
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

test('D1 绑定按域分（三个只认自己 realm 的视图），env 里的 KV 一次都不碰：锁屏 / 账号 / 根凭证的入口跑一遍', async () => {
  LOCK = await genKeyPair();
  ACCOUNT = await genKeyPair();
  const touched = [];
  const d1 = splitD1();
  const env = {
    /* 上线前的两个 KV 绑定名：给一个碰一下就抛错的替身，核对网关运行时不读也不写 KV */
    KV_LOCK_DOOR: forbiddenKV('KV_LOCK_DOOR', touched), KV_ACCOUNT_LOGIN: forbiddenKV('KV_ACCOUNT_LOGIN', touched),
    D1_LOCK_AUTH: d1.lock, D1_ACCOUNT_AUTH: d1.account, D1_ROOT_AUTH: d1.root,
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

  /* 锁屏 / 账号两域的密码确实都写进去了（D1），纪元两域各一行 */
  assert.deepEqual(d1.db.rows('password').map((r) => r.realm).sort(), ['account', 'lock']);
  assert.deepEqual(d1.db.rows('epoch').map((r) => r.realm).sort(), ['account', 'lock']);
  /* 以前在 KV 的状态现在都在 D1 对应 realm 的行里 */
  const devices = d1.db.rows('device');
  assert.ok(devices.length >= 1 && devices.every((r) => r.realm === 'account'), JSON.stringify(devices));
  const limits = d1.db.rows('attempt_limit');
  assert.ok(limits.some((r) => r.realm === 'account' && r.kind === 'password'), JSON.stringify(limits));
  const audits = d1.db.rows('audit');
  assert.ok(audits.length >= 1 && audits.every((r) => r.realm === 'root'), '根凭证审计只在 realm=root');
  const challenges = d1.db.rows('challenge');
  assert.ok(challenges.length >= 1, '注册 challenge 写进 D1');
  for (const r of challenges) assert.ok(r.realm === 'lock' || r.realm === 'account', JSON.stringify(r));
  /* 三个视图都真的被用过（否则「没有越界」是空话） */
  assert.ok(d1.used.lock > 0 && d1.used.account > 0 && d1.used.root > 0, JSON.stringify(d1.used));
  assert.deepEqual(d1.violations, []);
  assert.deepEqual(touched, [], '网关运行时碰了 KV');
});
