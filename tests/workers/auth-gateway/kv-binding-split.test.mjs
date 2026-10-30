/**
 * D1 绑定按域分（realms.js 头注释，2026-10-27 起网关认证状态全部在 D1，不再绑定 KV）。
 * 账号拆分 PR3：网关只剩锁屏域——realm='lock' 的行（和 recovery_switch）只经 D1_LOCK_AUTH；
 * 库里遗留的 realm='account' / realm='root' 行网关一行都不碰（PR4 清），D1_ACCOUNT_AUTH / D1_ROOT_AUTH 绑定已删。
 *
 * 线上只有一个库，读错 realm 也不会出错，所以单靠功能测试发现不了。这里把 D1_LOCK_AUTH 换成「只认 realm='lock'」的视图：
 * 越界的语句照常执行（流程不被打断），但记下来，最后断言一条都没有。
 * env 里同时放上以前的 KV 绑定名和已删的 D1_ACCOUNT_AUTH / D1_ROOT_AUTH，换成碰一下就抛错的替身：运行时一次都不能碰。
 *
 * 跑的流程：锁屏域的真实入口——root-auth（lock-reset / lock-reauth）、lock-entry、lock-password set / verify / change、
 * lock-reauth status、lock-passkey challenge、lock-credentials、lock-reset（challenge、带锁屏密码证明的 verify）、root-audit。
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
 * D1 替身上的视图（网关只有 D1_LOCK_AUTH = 只认 realm='lock'），只认自己 realm 的行：
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
  return { db, violations, used, lock: view('D1_LOCK_AUTH', 'lock') };
}

const ROOT_KEY = 'split-root-key-123456';
const PEPPER = 'split-pepper';
let LOCK;

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

test('网关只经 D1_LOCK_AUTH 读写 realm=lock 的行；已删的 D1_ACCOUNT_AUTH / D1_ROOT_AUTH 和 KV 一次都不碰：锁屏域的入口跑一遍', async () => {
  LOCK = await genKeyPair();
  const touched = [];
  const d1 = splitD1();
  const env = {
    /* 上线前的 KV 绑定名、账号拆分 PR3 删掉的两个 D1 绑定名：碰一下就抛错的替身 */
    KV_LOCK_DOOR: forbiddenKV('KV_LOCK_DOOR', touched), KV_ACCOUNT_LOGIN: forbiddenKV('KV_ACCOUNT_LOGIN', touched),
    D1_ACCOUNT_AUTH: forbiddenKV('D1_ACCOUNT_AUTH', touched), D1_ROOT_AUTH: forbiddenKV('D1_ROOT_AUTH', touched),
    D1_LOCK_AUTH: d1.lock,
    SGX_ADMIN_KEY: ROOT_KEY, SGX_PW_PEPPER: PEPPER,
    SGX_LOCK_PRIVATE: LOCK.priv, SGX_LOCK_PUBLIC: LOCK.pub,
    SGX_RP_ID: 'styrigx.com', SGX_ORIGIN: 'https://styrigx.com', SGX_ENV: 'production',
  };
  /* 库里遗留的账号行（拆分前写的）：网关不该读到、也不该改 */
  d1.db.putPassword('account', await makePasswordRecord('account-pass-5678', PEPPER));
  d1.db.putPasskey('account', { credId: 'acct-key-0001', publicKey: {}, signCount: 0, uv: 1, name: 'a', provider: '', aaguid: '', createdAt: 1, lastUsedAt: 0 });
  const legacy = JSON.stringify([d1.db.rows('password'), d1.db.rows('passkey')]);
  const call = async (mod, method, req) => (await import(API + mod))[method]({ request: req, env, waitUntil() {} });
  const jar = cookieJar();

  /* 启动站：锁屏什么都没设（遗留的账号凭证不算）→ lock-entry 两个 false；root-auth lock-reset 签 LockResetTicket */
  let r = await call('lock-entry.js', 'onRequestGet', get('/api/lock-entry'));
  assert.deepEqual(await r.json(), { ok: true, passkey: false, password: false });
  r = jar.absorb(await call('root-auth.js', 'onRequestPost', post('/api/root-auth', { key: ROOT_KEY, purpose: 'lock-reset' })));
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));

  /* 用 LockResetTicket 设锁屏密码（不再看账号密码） */
  r = jar.absorb(await call('lock-password.js', 'onRequestPost', post('/api/lock-password', { action: 'set', password: 'lock-pass-1234' }, jar.header())));
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));

  /* 解锁 → admin 锁屏会话 */
  r = jar.absorb(await call('lock-password.js', 'onRequestPost', post('/api/lock-password', { action: 'verify', password: 'lock-pass-1234' }, jar.header())));
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));

  /* 账号的两个 purpose 网关不认了：400 purpose，不比对、不计数 */
  for (const purpose of ['account-reset', 'account-reauth']) {
    r = await call('root-auth.js', 'onRequestPost', post('/api/root-auth', { key: ROOT_KEY, purpose }, jar.header()));
    assert.equal(r.status, 400, purpose);
    assert.equal((await r.json()).error, 'purpose');
  }

  /* 锁屏凭证页：根密钥 lock-reauth → 改锁屏密码（和遗留的账号密码相同也行）、状态、通行密钥 challenge、凭证列表 */
  r = jar.absorb(await call('root-auth.js', 'onRequestPost', post('/api/root-auth', { key: ROOT_KEY, purpose: 'lock-reauth' }, jar.header())));
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  r = await call('lock-reauth.js', 'onRequestPost', post('/api/lock-reauth', { action: 'status' }, jar.header()));
  assert.equal(r.status, 200);
  r = jar.absorb(await call('lock-password.js', 'onRequestPost', post('/api/lock-password', { action: 'change', password: 'account-pass-5678' }, jar.header())));
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  r = await call('lock-passkey.js', 'onRequestPost', post('/api/lock-passkey', { action: 'challenge', type: 'register' }, jar.header()));
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  r = await call('lock-credentials.js', 'onRequestGet', get('/api/lock-credentials', jar.header()));
  assert.ok(r.status === 200 || r.status === 401, String(r.status));
  r = await call('root-audit.js', 'onRequestGet', get('/api/root-audit', jar.header()));
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));

  /* 无法登录 → lock-reset：challenge（没有锁屏通行密钥 → not-set）；根密钥 + 锁屏密码证明 → LockResetTicket(by=password) */
  const anon = cookieJar();
  r = await call('lock-reset.js', 'onRequestPost', post('/api/lock-reset', { action: 'challenge' }));
  assert.equal((await r.json()).error, 'not-set', '没有锁屏通行密钥：回 not-set（遗留的账号通行密钥不算）');
  r = anon.absorb(await call('lock-reset.js', 'onRequestPost', post('/api/lock-reset', { action: 'verify', rootKey: ROOT_KEY, lockProof: { type: 'password', password: 'account-pass-5678' } })));
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  assert.match(anon.header(), /sgx-lock-reset=/);

  /* 锁屏的行都写进去了；遗留的账号行原样没动 */
  assert.deepEqual(d1.db.rows('epoch').map((x) => x.realm), ['lock']);
  assert.equal(JSON.stringify([d1.db.rows('password').filter((x) => x.realm === 'account'), d1.db.rows('passkey')]), JSON.stringify([JSON.parse(legacy)[0], JSON.parse(legacy)[1]]));
  const audits = d1.db.rows('audit');
  assert.ok(audits.length >= 1 && audits.every((x) => x.realm === 'lock'), '锁屏根密钥审计在 realm=lock');
  for (const x of d1.db.rows('attempt_limit')) assert.equal(x.realm, 'lock', JSON.stringify(x));
  for (const x of d1.db.rows('challenge')) assert.equal(x.realm, 'lock', JSON.stringify(x));
  assert.ok(d1.used.lock > 0, JSON.stringify(d1.used));
  assert.deepEqual(d1.violations, []);
  assert.deepEqual(touched, [], '网关运行时碰了 KV 或已删的 D1 绑定');
});
