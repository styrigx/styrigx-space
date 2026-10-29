/**
 * 批次 A 收尾：根凭证规范化（B2）+ passkey user handle 按类别区分（C4）。
 *
 * B2：
 * - normalizeRootKey 去掉所有空白字符（空格、制表符、换行 \r \n）
 * - root-auth：带换行、不带换行、首尾空格三种写法都通过；改一个字符失败；空串失败
 * - lockreset verify：带换行通过
 * - 只有根凭证这样处理；管理员密码、解锁密码不做任何规范化
 *
 * C4：
 * - owner、lock、应用三类 user.id 互不相同
 * - 同类再次 challenge → user.id 复用
 * - 拿 lock 的 handle 验 owner 凭据会失败（verify 用同一 getUserHandle 查期望值）
 *
 * 运行：node --test tests/kernel/batchc-RootKey-userhandle.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { testLockSession, testAccountSession } from './_tickets.mjs';
import { makeKV, genKeyPair, postReq, authD1For } from '../_harness.mjs';

let ACCT_PRIV = '', ACCT_PUB = '', LOCK_PRIV = '', LOCK_PUB = '';
async function genKeys() {
  ({ priv: LOCK_PRIV, pub: LOCK_PUB } = await genKeyPair());
  ({ priv: ACCT_PRIV, pub: ACCT_PUB } = await genKeyPair());
}

const SGX_ROOT_KEY = 'test-root-key-abc123';

function authEnv(kv, overrides = {}) {
  return {
    /* kv 只当作「上线前的 KV」（authD1For：部署前导入过）；env 里没有 KV */
    D1_LOCK_AUTH: authD1For(kv), D1_ACCOUNT_AUTH: authD1For(kv), D1_ROOT_AUTH: authD1For(kv),
    SGX_ROOT_KEY,
    SGX_LOCK_PRIVATE: LOCK_PRIV,
    SGX_LOCK_PUBLIC: LOCK_PUB,
    SGX_ACCOUNT_PRIVATE: ACCT_PRIV, /* 测试复用同一对钥匙 */
    SGX_ACCOUNT_PUBLIC: ACCT_PUB,
    SGX_RP_ID: 'styrigx.com',
    SGX_ORIGIN: 'https://styrigx.com',
    ...overrides,
  };
}

/* 测试钥匙：before 里生成（不算一条用例，单独跑某条用例时也会先执行） */
before(async () => {
  await genKeys();
  assert.ok(LOCK_PRIV && ACCT_PRIV);
});

/* ============ B2：normalizeRootKey ============ */

test('B2：normalizeRootKey 去掉所有空白字符', async () => {
  const { normalizeRootKey } = await import('../../../workers/auth-gateway/functions/_kernel/lib/crypto.js');
  assert.equal(normalizeRootKey('abc def'), 'abcdef');
  assert.equal(normalizeRootKey('abc\tdef'), 'abcdef');
  assert.equal(normalizeRootKey('abc\ndef'), 'abcdef');
  assert.equal(normalizeRootKey('abc\r\ndef'), 'abcdef');
  assert.equal(normalizeRootKey('  abc  '), 'abc');
  assert.equal(normalizeRootKey(''), '');
  assert.equal(normalizeRootKey('   \n\t '), '');
  assert.equal(normalizeRootKey(null), '');
  assert.equal(normalizeRootKey(undefined), '');
});

test('B2：root-auth 带换行通过', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/root-auth.js');
  const kv = makeKV();
  /* 引导模式：lock 未配置时无会话也能校验根凭证 */
  const req = postReq('https://styrigx.com/api/root-auth', { key: 'test-root-key-\nabc123', purpose: 'lock-reset' });
  const res = await onRequestPost({ request: req, env: authEnv(kv) });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.ok(j.ok, '带换行的根凭证应通过');
});

test('B2：root-auth 首尾空格通过', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/root-auth.js');
  const kv = makeKV();
  const req = postReq('https://styrigx.com/api/root-auth', { key: '  test-root-key-abc123  ', purpose: 'lock-reset' });
  const res = await onRequestPost({ request: req, env: authEnv(kv) });
  const j = await res.json();
  assert.ok(j.ok, '首尾空格的根凭证应通过');
});

test('B2：root-auth 不带换行通过（回归）', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/root-auth.js');
  const kv = makeKV();
  const req = postReq('https://styrigx.com/api/root-auth', { key: SGX_ROOT_KEY, purpose: 'lock-reset' });
  const res = await onRequestPost({ request: req, env: authEnv(kv) });
  const j = await res.json();
  assert.ok(j.ok, '原样根凭证应通过');
});

test('B2：root-auth 改一个字符失败', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/root-auth.js');
  const kv = makeKV();
  const req = postReq('https://styrigx.com/api/root-auth', { key: 'test-root-key-abc124', purpose: 'lock-reset' }, { 'CF-Connecting-IP': '10.0.0.1' });
  const res = await onRequestPost({ request: req, env: authEnv(kv) });
  assert.equal(res.status, 401);
  const j = await res.json();
  assert.ok(!j.ok, '改一个字符应失败');
});

test('B2：root-auth 空串失败（去空白后为空一律拒绝）', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/root-auth.js');
  const kv = makeKV();
  const req = postReq('https://styrigx.com/api/root-auth', { key: '   \n\t  ', purpose: 'lock-reset' }, { 'CF-Connecting-IP': '10.0.0.2' });
  const res = await onRequestPost({ request: req, env: authEnv(kv) });
  assert.equal(res.status, 401);
  const j = await res.json();
  assert.ok(!j.ok, '空白串应失败');
});

test('B2：lockreset verify 带换行通过', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/lock-reset.js');
  const kv = makeKV();
  /* 账号层已配置（由 D1 里的账号密码推出）：根凭证正确后走 needAccount 分支（不是 401 auth） */
  authD1For(kv).putPassword('account', { salt: 's', hash: 'h', iterations: 100000, peppered: true });
  const req = postReq('https://styrigx.com/api/lock-reset', { action: 'verify', rootKey: 'test-root-key-\nabc123' }, { 'CF-Connecting-IP': '10.0.0.3' });
  const res = await onRequestPost({ request: req, env: authEnv(kv) });
  /* 根凭证正确 → 进入开关/管理员凭证流程（needAccount），不是 401 auth */
  const j = await res.json();
  assert.notEqual(j.error, 'auth', '带换行的根凭证不应报 auth 失败');
  assert.equal(j.needAccount, true, '应进入管理员凭证步骤');
});

/* ============ C4：user handle 按类别区分（D1 user_handle 表，每个 realm 一行） ============ */

test('C4：lock / account 两个 user handle 互不相同；同域再取复用；只读取不新建；存在 D1 user_handle 的 realm 行', async () => {
  const { getUserHandle, peekUserHandle, PASSKEY_LOCK, PASSKEY_ACCOUNT } = await import('../../../workers/auth-gateway/functions/_kernel/passkey-store.js');
  const kv = makeKV();
  const env = authEnv(kv);
  assert.equal(await peekUserHandle(env, PASSKEY_LOCK), '', '没有就是空，不新建');
  assert.deepEqual(authD1For(kv).rows('user_handle'), []);
  const lock = await getUserHandle(env, PASSKEY_LOCK);
  const acct = await getUserHandle(env, PASSKEY_ACCOUNT);
  assert.match(lock, /^[A-Za-z0-9_-]{43}$/, '32 字节 base64url');
  assert.match(acct, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(lock, acct);
  assert.equal(await getUserHandle(env, PASSKEY_LOCK), lock, '同域复用');
  assert.equal(await peekUserHandle(env, PASSKEY_ACCOUNT), acct);
  const rows = Object.fromEntries(authD1For(kv).rows('user_handle').map((r) => [r.realm, r.handle]));
  assert.deepEqual(rows, { lock, account: acct });
  /* 并发第一次取：拿到同一个 */
  const kv2 = makeKV();
  const env2 = authEnv(kv2);
  const both = await Promise.all([getUserHandle(env2, PASSKEY_LOCK), getUserHandle(env2, PASSKEY_LOCK)]);
  assert.equal(both[0], both[1]);
  await assert.rejects(getUserHandle(env, 'app'), /bad domain/);
});

test('C4：上线前 KV 里的 user handle 由导入脚本搬进 D1，原样复用（已注册的通行密钥 userHandle 还对得上）；D1 出错 → null', async () => {
  const { getUserHandle, PASSKEY_LOCK, PASSKEY_ACCOUNT } = await import('../../../workers/auth-gateway/functions/_kernel/passkey-store.js');
  const kv = makeKV({ 'lock-user-id': 'legacy-lock-handle', 'account-user-id': 'legacy-acct-handle' });
  const env = authEnv(kv);
  assert.equal(await getUserHandle(env, PASSKEY_LOCK), 'legacy-lock-handle');
  assert.equal(await getUserHandle(env, PASSKEY_ACCOUNT), 'legacy-acct-handle');
  assert.equal(kv._calls.get + kv._calls.list, 0, '网关代码不读 KV');
  const broken = makeKV();
  authD1For(broken).failOn = (sql) => /user_handle/.test(sql);
  assert.equal(await getUserHandle(authEnv(broken), PASSKEY_LOCK), null, '读写失败返回 null（调用方 503）');
});
