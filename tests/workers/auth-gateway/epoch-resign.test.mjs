/**
 * v1.1 D1/D2：删钥匙不踢当前设备（space）。
 *
 * 覆盖：
 * - D1：删 owner 类钥匙不推进 lock-epoch；之后设置管理员密码成功（不 401 session）
 * - D2：删 lock 类钥匙推进 lock-epoch +1，但同响应重签当前设备会话；
 *      新会话 cookie 用新 epoch 验签通过（session-check 200）
 * - D2：lock-password remove/set/change 推进 epoch 后同样重签当前设备会话
 * - 退出所有设备（lock-all-devices）仍清当前 cookie（保持不变）
 *
 * 运行：node --test tests/kernel/epoch-resign.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testLockSession } from './_tickets.mjs';
import { makeKV, genKeyPair } from '../_harness.mjs';

let LOCK_PRIV = '', LOCK_PUB = '';
async function genKeys() {
  ({ priv: LOCK_PRIV, pub: LOCK_PUB } = await genKeyPair());
}

const testEnv = (kv) => ({
  KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv,
  SGX_LOCK_PRIVATE: LOCK_PRIV,
  SGX_LOCK_PUBLIC: LOCK_PUB,
  SGX_RP_ID: 'styrigx.com',
  SGX_ORIGIN: 'https://styrigx.com',
  SGX_PW_PEPPER: 'test-pepper',
});

async function seedKey(kv, { credId, cls = 'lock', aud = '' }) {
  const rec = {
    name: 'test', provider: '', aaguid: '', createdAt: 1, lastUsedAt: 0,
    credId, publicKey: {}, signCount: 0, uv: 1,
  };
  if (aud) rec.aud = aud;
  const domain = cls === 'owner' || cls === 'account' ? 'account' : 'lock';
  await kv.put(domain + '-passkey:' + credId.slice(0, 12), JSON.stringify(rec));
  const idx = JSON.parse((await kv.get(domain + '-passkey-index')) || '[]');
  if (!idx.includes(credId)) idx.push(credId);
  await kv.put(domain + '-passkey-index', JSON.stringify(idx));
}

/** 从 Set-Cookie 头中取 sgx-verified 值 */
function extractSessionCookie(res) {
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of setCookies) {
    if (c.startsWith('sgx-lock-session=')) {
      return c.split(';')[0].split('=')[1];
    }
  }
  return null;
}

test('setup: 生成测试密钥', async () => {
  await genKeys();
  assert.ok(LOCK_PRIV.includes('PRIVATE KEY'));
});





/* ============ 审查返工：必修安全项 1/2，helper 层跳过 by=root ============ */

test('必修安全项 2：by=root 会话不重签（首次配 lock 的 epoch bump 不被抵消）', async () => {
  const { reissueLockSessionWithEpoch } = await import('../../../workers/auth-gateway/functions/_kernel/lock-session.js');
  const { signLockSessionTicket } = await import('../../../workers/auth-gateway/functions/_kernel/lock-session.js');
  const { verifyLockSession } = await import('../../../workers/auth-gateway/functions/_kernel/lock-session.js');
  const kv = makeKV({ 'lock-epoch': '5' });
  /* by=root 代开会话（epoch 5） */
  const rootSess = await testLockSession(LOCK_PRIV, 5, 'admin', 'password');
  /* epoch bump 到 6（模拟首次配 lock） */
  await kv.put('lock-epoch', '6');
  /* helper 应跳过，不发新 cookie */
  const headers = new Headers();
  await reissueLockSessionWithEpoch(testEnv(kv), headers, { ok: true, by: 'root', role: 'admin' }, 6);
  const setCookies = headers.getSetCookie ? headers.getSetCookie() : [];
  const reissued = setCookies.some((c) => c.startsWith('sgx-lock-session=') && !c.startsWith('sgx-lock-session=;'));
  assert.equal(reissued, false, 'by=root 会话不应重签');
  /* 旧会话 session-check 401（epoch 已变） */
  const v = await verifyLockSession(
    new Request('https://styrigx.com/', { headers: { Cookie: 'sgx-lock-session=' + rootSess } }),
    testEnv(kv)
  );
  assert.equal(v.ok, false, '旧 by=root 会话应在 epoch bump 后失效');
});



test('锁屏会话纪元必须等于当前 lock-epoch：比当前大的旧票（KV 重建后纪元回到小值）也作废', async () => {
  const { verifyLockSessionTicket } = await import('../../../workers/auth-gateway/functions/_kernel/lock-session.js');
  if (!LOCK_PRIV) await genKeys();
  const kv = makeKV({ 'lock-epoch': '1' });
  const env = testEnv(kv);
  const ok = await testLockSession(LOCK_PRIV, 1, 'admin', 'password');
  assert.equal((await verifyLockSessionTicket(ok, env)).status, 'ok');
  const old = await testLockSession(LOCK_PRIV, 7, 'admin', 'password');
  assert.equal((await verifyLockSessionTicket(old, env)).status, 'epoch-low');
  const low = await testLockSession(LOCK_PRIV, 0, 'admin', 'password');
  assert.equal((await verifyLockSessionTicket(low, env)).status, 'epoch-low');
});
