/**
 * B1-9 的会话假入口（v1：凭会话等级写死 401）随 P2-3 进门二值删除（方案 3.3、定案第 6 条）。这里验收删除之后的行为：
 * 1. /api/lock-reset 不看锁屏会话：没有会话、锁屏密码进门、临时钥匙进门 → 一律真比对进站凭证（错了 401 auth，计数、写审计）
 * 2. /api/space-auth purpose=lock-reauth 要先进门（任何进门方式，含临时钥匙进门）：没进门 → 401 session，不比对、不计数、不写审计；
 *    临时钥匙进门 + 正确进站凭证 → 200，签 LockReauthTicket（by=space），进门会话本身不算复验
 * 3. v1 的 6 段票按 bad-format 处理，等于没有会话
 *
 * 运行：node --test tests/workers/auth-gateway/b1-9-guest-401.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testLockSession } from './_tickets.mjs';
import { ed25519Sign } from '../../../workers/auth-gateway/src/lib/crypto.js';
import { onRequestPost as spaceAuthPost } from '../../../workers/auth-gateway/src/api/space-auth.js';
import { onRequestPost as lockResetPost } from '../../../workers/auth-gateway/src/api/lock-reset.js';
import { genKeyPair, makeAuthD1 } from '../_harness.mjs';
import { makePasswordRecord } from '../../../workers/auth-gateway/src/core/password.js';

const SPACE_KEY = 'test-space-key-12345';
const { priv: PRIV, pub: PUB } = await genKeyPair();
const RP = { SGX_RP_ID: 'styrigx.com', SGX_ORIGIN: 'https://styrigx.com' };

/*
 * 存储 = D1 替身（三个绑定同一个库）。configured = D1 里有锁屏密码 + 账号密码（lock-reset 的真路径会读到它们）。
 * 摆前提走 raw / putPassword，不进 db.calls：之后 db.calls 里只有网关自己发的语句。
 */
const PW_REC = await makePasswordRecord('some-pass-1', 'test-pepper');
function makeStore(configured) {
  const db = makeAuthD1();
  if (configured) { db.putPassword('lock', PW_REC); db.putPassword('account', PW_REC); }
  return db;
}
const CONFIGURED = true;
/** 网关发过的 D1 语句数 */
const totalCalls = (db) => db.calls.length;
/** 整库快照（root 限速 / 审计 / 开关 / 凭证），用来断言「什么都没写」 */
const snapshot = (db) => ['attempt_limit', 'audit', 'lock_reset_switch', 'password', 'passkey', 'epoch', 'challenge']
  .map((t) => { try { return t + ':' + JSON.stringify(db.raw.prepare('SELECT * FROM ' + t).all()); } catch (e) { return t + ':-'; } });

function post(path, body, cookie, ip = '203.0.113.9') {
  const headers = { 'Content-Type': 'application/json', Origin: 'https://styrigx.com', 'CF-Connecting-IP': ip };
  if (cookie) headers.Cookie = cookie;
  return new Request('https://styrigx.com' + path, { method: 'POST', headers, body: JSON.stringify(body) });
}
const env = (db) => ({ SGX_LOCK_PUBLIC: PUB, SGX_LOCK_PRIVATE: PRIV, SGX_LOCK_SPACE_KEY: SPACE_KEY, D1_LOCK_AUTH: db, SGX_PW_PEPPER: 'test-pepper', ...RP });
const sessCookie = async (by) => 'sgx-lock-session=' + (await testLockSession(PRIV, 0, by));
const pick = (res, name) => {
  for (const c of res.headers.getSetCookie()) if (c.startsWith(name + '=')) return c.slice(name.length + 1).split(';')[0];
  return '';
};

test('lock-reset：没有会话 / 锁屏密码进门 / 临时钥匙进门 → 一律真比对进站凭证（错了 401 auth，计数、写审计）', async () => {
  let n = 0;
  for (const cookie of ['', await sessCookie('password'), await sessCookie('tempkey')]) {
    const kv = makeStore(CONFIGURED);
    const ip = '198.51.100.' + (10 + n++);
    const res = await lockResetPost({ request: post('/api/lock-reset', { action: 'verify', spaceKey: 'wrong' }, cookie, ip), env: env(kv) });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { ok: false, error: 'auth' });
    const fail = kv.raw.prepare("SELECT count FROM attempt_limit WHERE realm = 'lock' AND kind = 'spacekey' AND bucket = ?").get(ip);
    assert.equal(fail && fail.count, 1, '真比对失败计入单 IP');
    const audits = kv.raw.prepare("SELECT * FROM audit WHERE realm = 'lock'").all();
    assert.equal(audits.length, 1, '写审计');
    assert.equal(audits[0].ok, 0);
  }
});

test('space-auth lock-reauth：没进门 → 401 session，不比对、不计数、不写审计、不签票', async () => {
  for (const seed of [false, CONFIGURED]) {
    const kv = makeStore(seed);
    const before = snapshot(kv);
    const res = await spaceAuthPost({ request: post('/api/space-auth', { key: SPACE_KEY, purpose: 'lock-reauth' }, ''), env: env(kv) });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { ok: false, error: 'session' });
    assert.equal(res.headers.get('Set-Cookie'), null);
    assert.deepEqual(snapshot(kv), before);
  }
});

test('space-auth lock-reauth：临时钥匙进门（任何进门方式）即可提交进站凭证；对 → 200 + LockReauthTicket(by=space)，错 → 401 auth 计数', async () => {
  for (const by of ['tempkey', 'password', 'passkey']) {
    const kv = makeStore(CONFIGURED);
    const cookie = await sessCookie(by);
    const ok = await spaceAuthPost({ request: post('/api/space-auth', { key: SPACE_KEY, purpose: 'lock-reauth' }, cookie, '198.51.100.40'), env: env(kv) });
    assert.equal(ok.status, 200, by);
    assert.ok(pick(ok, 'sgx-lock-reauth').startsWith('space.'), by + '：复验票 by=space');
    assert.equal(pick(ok, 'sgx-lock-session'), '', by + '：不签、不改锁屏会话');
    const bad = await spaceAuthPost({ request: post('/api/space-auth', { key: 'wrong', purpose: 'lock-reauth' }, cookie, '198.51.100.41'), env: env(kv) });
    assert.equal(bad.status, 401, by);
    assert.deepEqual(await bad.json(), { ok: false, error: 'auth' });
    const fail = kv.raw.prepare("SELECT count FROM attempt_limit WHERE realm = 'lock' AND kind = 'spacekey' AND bucket = '198.51.100.41'").get();
    assert.equal(fail && fail.count, 1, by);
  }
});

test('v1 的 6 段锁屏会话票按 bad-format 处理：space-auth lock-reauth 等于没进门（401 session）', async () => {
  const p6 = 'tempkey.' + 'visitor' + '.0.' + (Date.now() + 3600e3) + '.tktesttesttest01'; // v1 fixture
  const v1 = 'sgx-lock-session=' + p6 + '.' + (await ed25519Sign(PRIV, 'sgx-lock-session|' + p6)); // v1 fixture
  const kv = makeStore(CONFIGURED);
  const res = await spaceAuthPost({ request: post('/api/space-auth', { key: SPACE_KEY, purpose: 'lock-reauth' }, v1), env: env(kv) });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { ok: false, error: 'session' });
});
