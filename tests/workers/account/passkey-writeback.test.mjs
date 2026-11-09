/**
 * 2026-11-09 fix/silent-writeback-logs：账号通行密钥验签通过后回写 signCount / lastUsedAt 失败——不挡登录，但打 console.error（以前静默吞掉）。
 * 运行：node --test tests/workers/account/passkey-writeback.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { keys, makeEnv, seedPasskey, setHandles, passkeyLogin } from './_fixtures.mjs';

before(keys);

test('signCount 回写失败：登录照常 200，console.error 记一行 [account-passkey] signCount writeback failed', async () => {
  const env = makeEnv();
  const { kp, credId } = await seedPasskey(env);
  setHandles(env, 'HANDLE', 'LEGACY');
  const db = env.D1_ACCOUNT;
  env.D1_ACCOUNT = new Proxy(db, {
    get(t, k) {
      if (k === 'prepare') return (sql) => { if (/^\s*UPDATE account_passkey\b/i.test(sql)) throw new Error('d1 write down'); return t.prepare(sql); };
      const v = Reflect.get(t, k);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  const errs = [];
  const orig = console.error;
  console.error = (...a) => { errs.push(a.map(String).join(' ')); };
  let res;
  try { res = await passkeyLogin(env, kp, credId, 'HANDLE'); } finally { console.error = orig; }
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  assert.ok(errs.some((l) => /\[account-passkey\] signCount writeback failed, sign-in allowed: d1 write down/.test(l)), errs.join('\n'));
});
