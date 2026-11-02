/**
 * /api/lock-password 的 set：读现有密码失败 → 503 server，不当成「不存在」去写（fail closed，同 remove 的守卫）。
 * - 读失败：503 server，整个请求没有任何写入（密码、纪元、计数都不动，不发 Set-Cookie）
 * - 读得到、确实没有：照常 set（200，写入密码，纪元 +1）
 * - 已存在：照原逻辑 403 exists，不覆盖
 * 运行：node --test tests/workers/auth-gateway/lock-password-set.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lockPassword from '../../../workers/auth-gateway/src/api/lock-password.js';
import { makePasswordRecord } from '../../../workers/auth-gateway/src/core/password.js';
import { testLockSession, testTicket } from './_tickets.mjs';
import { genKeyPair, makeKV, authD1For, postReq } from '../_harness.mjs';

const { priv: PRIV, pub: PUB } = await genKeyPair();
const ORIGIN = 'https://styrigx.com';
const PEPPER = 'test-pepper';
const WRITE_RE = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i;

function setup() {
  const db = authD1For(makeKV());
  db.setEpoch('lock', 0); /* 纪元行先摆好：读纪元时的懒建行（INSERT OR IGNORE）不混进「写入」的观测 */
  const env = { D1_LOCK_AUTH: db, SGX_LOCK_PRIVATE: PRIV, SGX_LOCK_PUBLIC: PUB, SGX_PW_PEPPER: PEPPER, SGX_RP_ID: 'styrigx.com', SGX_ORIGIN: ORIGIN };
  return { db, env };
}

async function manageCookie() {
  const sess = await testLockSession(PRIV, 0, 'admin', 'password');
  const reauth = await testTicket(PRIV, 'LockReauthTicket', 'password', 0);
  return 'sgx-lock-session=' + sess + '; sgx-lock-reauth=' + reauth;
}

async function setReq(env, password) {
  return lockPassword.onRequestPost({
    request: postReq(ORIGIN + '/api/lock-password', { action: 'set', password }, { Cookie: await manageCookie() }),
    env,
  });
}

test('set：读现有密码失败 → 503 server，没有任何写入', async () => {
  const { db, env } = setup();
  db.failOn = (sql) => /SELECT record FROM password/i.test(sql);
  const before = db.calls.length;
  const res = await setReq(env, 'new-lock-pass-1');
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'server');
  const writes = db.calls.slice(before).filter((s) => WRITE_RE.test(s));
  assert.deepEqual(writes, [], '读失败后不许有任何写语句');
  db.failOn = () => false;
  assert.equal(db.password('lock'), null, '没有写密码');
  assert.equal(db.epoch('lock'), 0, '纪元没推进');
  assert.equal(res.headers.get('Set-Cookie'), null, '没有重签票 / 会话');
});

test('set：读得到、确实没有 → 照常 set（200，写入密码，纪元 +1）', async () => {
  const { db, env } = setup();
  const res = await setReq(env, 'new-lock-pass-1');
  assert.equal(res.status, 200);
  const rec = db.password('lock');
  assert.ok(rec && rec.hash, '写入了密码');
  assert.equal(db.epoch('lock'), 1);
});

test('set：已存在 → 403 exists（原逻辑），不覆盖', async () => {
  const { db, env } = setup();
  const old = await makePasswordRecord('old-lock-pass-1', PEPPER);
  db.putPassword('lock', old);
  const before = db.calls.length;
  const res = await setReq(env, 'new-lock-pass-2');
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'exists');
  assert.deepEqual(db.calls.slice(before).filter((s) => /INTO password|UPDATE password|epoch/i.test(s) && WRITE_RE.test(s)), []);
  assert.deepEqual(db.password('lock'), old, '原密码不变');
});
