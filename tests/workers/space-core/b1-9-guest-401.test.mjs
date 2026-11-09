/**
 * B1-9 的会话假入口（v1：凭会话等级写死 401）随 P2-3 进门二值删除（方案 3.3、定案第 6 条）。这里验收删除之后的行为：
 * 1. /api/lock-reset 不看进站会话：没有会话、锁屏密码进门、临时钥匙进门 → 一律真比对进站凭证（错了 401 auth，计数、写审计）
 * 2. 进站 v3 L1：恢复钥匙不签 reauth 票。/api/space-auth purpose=lock-reauth 已删，任何会话下（没进门 / 临时钥匙 /
 *    密码 / 通行密钥进门）都 → 400 purpose，不比对、不计数、不写审计、不签票；reauth 只认解锁密码 / 通行密钥
 * 3. v1 的 6 段票按 bad-format 处理，等于没有会话（verifyLockSession）
 *
 * 运行：node --test tests/workers/space-core/b1-9-guest-401.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testLockSession } from './_tickets.mjs';
import { ed25519Sign } from '../../../workers/space-core/src/lib/crypto.js';
import { onRequestPost as spaceAuthPost } from '../../../workers/space-core/src/api/space-auth.js';
import { onRequestPost as lockResetPost } from '../../../workers/space-core/src/api/lock-reset.js';
import { genKeyPair, makeAuthD1 } from '../_harness.mjs';
import { makePasswordRecord } from '../../../workers/space-core/src/core/password.js';

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
const env = (db) => ({ SGX_SPACE_PUBLIC: PUB, SGX_SPACE_PRIVATE: PRIV, SGX_SPACE_RECOVERY_KEY: SPACE_KEY, D1_SPACE: db, SGX_SPACE_PASSWORD_PEPPER: 'test-pepper', SGX_SPACE_TEMPKEY_PEPPER: 'test-pepper', ...RP });
const sessCookie = async (by) => 'sgx-space-session=' + (await testLockSession(PRIV, 0, by));
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

test('space-auth lock-reauth（v3 L1 已删）：没进门 / 任何进门方式 → 400 purpose，不比对、不计数、不写审计、不签票', async () => {
  for (const seed of [false, CONFIGURED]) {
    for (const by of ['', 'tempkey', 'password', 'passkey']) {
      const kv = makeStore(seed);
      const cookie = by ? await sessCookie(by) : '';
      const before = snapshot(kv);
      const res = await spaceAuthPost({ request: post('/api/space-auth', { key: SPACE_KEY, purpose: 'lock-reauth' }, cookie), env: env(kv) });
      assert.equal(res.status, 400, by || 'none');
      assert.deepEqual(await res.json(), { ok: false, error: 'purpose' });
      assert.equal(res.headers.get('Set-Cookie'), null, (by || 'none') + '：不签票');
      assert.deepEqual(snapshot(kv), before, (by || 'none') + '：不写存储');
    }
  }
});

test('v1 的 6 段进站会话票按 bad-format 处理：verifyLockSession 等于没进门', async () => {
  const { verifyLockSession } = await import('../../../workers/space-core/src/core/lock-session.js');
  const p6 = 'tempkey.' + 'visitor' + '.0.' + (Date.now() + 3600e3) + '.tktesttesttest01'; // v1 fixture
  const v1 = 'sgx-space-session=' + p6 + '.' + (await ed25519Sign(PRIV, 'sgx-space-session|' + p6)); // v1 fixture
  const kv = makeStore(CONFIGURED);
  const r = await verifyLockSession(post('/api/space-auth', {}, v1), env(kv));
  assert.equal(r.ok, false);
  const good = await verifyLockSession(post('/api/space-auth', {}, await sessCookie('tempkey')), env(kv));
  assert.equal(good.ok, true, '对照：现行票有效');
});
