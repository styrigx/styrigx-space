/**
 * 2026-11-09 fix/silent-writeback-logs：锁屏密码是旧记录（没 pepper）时验对了会重哈希写回；写回失败不挡进站，但打 console.error（以前静默吞掉）。
 * 运行：node --test tests/workers/space-core/lock-password-rehash.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lockPassword from '../../../workers/space-core/src/api/lock-password.js';
import { makePasswordRecord, savePassword } from '../../../workers/space-core/src/core/password.js';
import { REALM_LOCK } from '../../../workers/space-core/src/core/realms.js';
import { genKeyPair, makeKV, authD1For, postReq } from '../_harness.mjs';

const { priv: PRIV, pub: PUB } = await genKeyPair();
const ORIGIN = 'https://styrigx.com';
const PEPPER = 'test-pepper';

async function setup() {
  const db = authD1For(makeKV());
  db.setEpoch('lock', 0);
  const env = { D1_SPACE: db, SGX_SPACE_PRIVATE: PRIV, SGX_SPACE_PUBLIC: PUB, SGX_SPACE_PASSWORD_PEPPER: PEPPER, SGX_SPACE_TEMPKEY_PEPPER: PEPPER, SGX_RP_ID: 'styrigx.com', SGX_ORIGIN: ORIGIN };
  /* 旧记录：无 pepper 哈希、没有 peppered 标记 */
  const legacy = await makePasswordRecord('old-lock-pass-1', '');
  delete legacy.peppered;
  await savePassword(env, REALM_LOCK, legacy);
  return { db, env };
}
const verify = (env) => lockPassword.onRequestPost({ request: postReq(ORIGIN + '/api/lock-password', { action: 'verify', password: 'old-lock-pass-1' }), env });

test('旧记录验对：重哈希写回成功 → 记录带 peppered', async () => {
  const { db, env } = await setup();
  const res = await verify(env);
  assert.equal(res.status, 200);
  assert.equal(db.password('lock').peppered, true);
});

test('重哈希写回失败：照样进站（200 + 会话 cookie），console.error 记一行 [lock-password] rehash writeback failed', async () => {
  const { db, env } = await setup();
  db.failOn = (sql) => /^\s*(INSERT|UPDATE|REPLACE)\b[\s\S]*\bpassword\b/i.test(sql) && !/attempt|limit|fail/i.test(sql);
  const errs = [];
  const orig = console.error;
  console.error = (...a) => { errs.push(a.map(String).join(' ')); };
  let res;
  try { res = await verify(env); } finally { console.error = orig; db.failOn = () => false; }
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  assert.match(res.headers.get('Set-Cookie') || '', /sgx-space-session=/);
  assert.ok(errs.some((l) => /\[lock-password\] rehash writeback failed, unlock allowed/.test(l)), errs.join('\n'));
  assert.ok(!db.password('lock').peppered, '没写进去，还是旧记录（下次再试）');
});
