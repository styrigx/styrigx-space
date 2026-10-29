/**
 * A-2 最后一把锁屏钥匙与 AccountKey 联动（v1.5 #10）。
 *
 * - 删到 0 时 AccountKey 存在（管理员密码或管理员通行密钥任一）→ 允许，锁屏仍算已配置（由凭证推出：账号已配置 ⇒ 锁屏已配置，
 *   根凭证代开继续被拒）；不存在 → 服务端 403 last-key。
 * - A-2 对 layer:lock-emptied 不读不写（该键是 B #10 的，本 PR 不引入）：网关运行时不碰 KV；生产残留不动、不清除、不依赖。
 * - 「锁屏凭证已删光」按真实凭证数判断：无 lock 密码且无 lock 通行密钥。
 * - 删光后 lock-entry 返回 resetOnly=true（锁屏只显示访客 + 重置锁屏）。
 * - 空站（无任何凭证/标记）→ lock-entry resetOnly=false（A 启动流程保留，根凭证入口仍显示）。
 *
 * 运行：node --test tests/kernel/last-key.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { testLockSession, testAccountSession } from './_tickets.mjs';
import { makeKV, genKeyPair, postReq, authD1For } from '../_harness.mjs';

let ACCT_PRIV = '', ACCT_PUB = '', LOCK_PRIV = '', LOCK_PUB = '';
async function genKeys() {
  ({ priv: ACCT_PRIV, pub: ACCT_PUB } = await genKeyPair());
  ({ priv: LOCK_PRIV, pub: LOCK_PUB } = await genKeyPair());
}
async function mintSession(epoch = 0) {
  const { signLockSessionTicket } = await import('../../../workers/auth-gateway/functions/_kernel/lock-session.js');
  return await testLockSession(LOCK_PRIV, epoch, 'admin', 'password');
}
const envFor = (kv, extra = {}) => ({
  ...d1Env(kv),
  SGX_LOCK_PRIVATE: LOCK_PRIV,
  SGX_LOCK_PUBLIC: LOCK_PUB,
  SGX_RP_ID: 'styrigx.com',
  SGX_ORIGIN: 'https://styrigx.com',
  SGX_PW_PEPPER: 'test-pepper',
  ...extra,
});

/** 直接写 D1（锁屏 / 账号凭证都在 D1；kv 只当作这份 D1 替身的钥匙，网关不读 KV） */
async function seedKey(kv, credId, cls) {
  authD1For(kv).putPasskey(cls === 'account' ? 'account' : 'lock', {
    name: 'test', provider: '', aaguid: '', createdAt: 1, lastUsedAt: 0,
    credId, publicKey: {}, signCount: 0, uv: 1,
  });
}
async function seedPw(kv, kind, password) {
  const { makePasswordRecord } = await import('../../../workers/shared/password.js');
  authD1For(kv).putPassword(kind === 'account' ? 'account' : 'lock', await makePasswordRecord(password, 'test-pepper'));
}
/** 网关 env：三个 D1 绑定，没有 KV */
const d1Env = (kv) => ({ D1_LOCK_AUTH: authD1For(kv), D1_ACCOUNT_AUTH: authD1For(kv), D1_ROOT_AUTH: authD1For(kv) });

/* 测试钥匙：before 里生成（不算一条用例，单独跑某条用例时也会先执行） */
before(async () => {
  await genKeys();
  assert.ok(ACCT_PRIV.includes('PRIVATE KEY'));
});






test('A-2：lock-entry (b) 无真实 lock 凭证 + owner 已配置 + 无 lock-emptied → resetOnly=true', async () => {
  const { onRequestGet } = await import('../../../workers/auth-gateway/functions/api/lock-entry.js');
  const kv = makeKV();
  await seedPw(kv, 'account', 'account-password-123');
  const res = await onRequestGet({ env: d1Env(kv) });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.resetOnly, true);
  assert.equal(j.accountConfigured, true);
  /* 标记独有兜底：passkey/password 仍为 true（不暴露根凭证入口） */
  assert.equal(j.passkey, true);
  assert.equal(j.password, true);
});

test('A-2：lock-entry (a) lock-emptied=1 残留 + 有真实 lock 凭证 → resetOnly=false（忽略该键）', async () => {
  const { onRequestGet } = await import('../../../workers/auth-gateway/functions/api/lock-entry.js');
  const kv = makeKV({ 'layer:lock-emptied': '1' }) /* 生产 KV 里的残留：网关运行时不读 KV */;
  await seedPw(kv, 'account', 'account-password-123');
  await seedPw(kv, 'lock', 'lock-password-1234');
  const res = await onRequestGet({ env: d1Env(kv) });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.resetOnly, false, '有真实 lock 凭证时 resetOnly 应为 false，残留 lock-emptied=1 被忽略');
  assert.equal(j.accountConfigured, true);
});

test('A-2：lock-entry 空站 → resetOnly=false（A 启动流程保留，根凭证入口仍显示）', async () => {
  const { onRequestGet } = await import('../../../workers/auth-gateway/functions/api/lock-entry.js');
  const kv = makeKV({});
  const res = await onRequestGet({ env: d1Env(kv) });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.passkey, false);
  assert.equal(j.password, false);
  assert.equal(j.accountConfigured, false);
  assert.equal(j.resetOnly, false);
});


test('A-2：删光账号凭证时不动 lock-emptied 残留（留给 B 处理；账号体系走 /api/account）', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/account.js');
  const kv = makeKV({ 'layer:lock-emptied': '1' }) /* 生产 KV 里的残留：网关运行时不读 KV */;
  await seedKey(kv, 'acct-key-0001', 'account');
  const sess = await mintSession();
  const acc = await testAccountSession(ACCT_PRIV, 'password', 0, Date.now());
  const { signAccountReauthTicket } = await import('../../../workers/auth-gateway/functions/_kernel/tickets.js');
  const reauth = await signAccountReauthTicket(ACCT_PRIV, 'root', 0); /* 删账号通行密钥要 AccountReauthTicket */
  const env = Object.assign({}, envFor(kv), { SGX_ACCOUNT_PRIVATE: ACCT_PRIV, SGX_ACCOUNT_PUBLIC: ACCT_PUB });
  const res = await onRequestPost({
    request: postReq('https://styrigx.com/api/account', { action: 'passkey-delete', credId: 'acct-key-0001' },
      { Cookie: 'sgx-lock-session=' + sess + '; sgx-account-session=' + acc + '; sgx-account-reauth=' + reauth }),
    env,
  });
  assert.equal(res.status, 200, await res.text());
  assert.equal(authD1For(kv).passkey('account', 'acct-key-0001'), null, '从 D1 删掉');
  const { isAccountEffectivelyConfigured } = await import('../../../workers/auth-gateway/functions/_kernel/layers.js');
  assert.equal(await isAccountEffectivelyConfigured(env), false, '删光账号凭证 → 账号未配置（由凭证推出，不存标记）');
  assert.equal(kv.store.get('layer:lock-emptied'), '1', 'A-2 不动 lock-emptied 残留');
  assert.deepEqual(kv._calls, { get: 0, put: 0, delete: 0, list: 0 }, '网关运行时一次都没碰 KV');
});
