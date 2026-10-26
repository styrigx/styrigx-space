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
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testLockSession, testAccountSession } from './_tickets.mjs';
import { makeKV, genKeyPair, postReq } from '../_harness.mjs';

let ACCT_PRIV = '', ACCT_PUB = '', LOCK_PRIV = '', LOCK_PUB = '';
async function genKeys() {
  ({ priv: LOCK_PRIV, pub: LOCK_PUB } = await genKeyPair());
  ({ priv: ACCT_PRIV, pub: ACCT_PUB } = await genKeyPair());
}

const SGX_ROOT_KEY = 'test-root-key-abc123';

function authEnv(kv, overrides = {}) {
  return {
    KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv,
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

test('setup: 生成测试密钥', async () => {
  await genKeys();
  assert.ok(LOCK_PRIV && ACCT_PRIV);
});

/* ============ B2：normalizeRootKey ============ */

test('B2：normalizeRootKey 去掉所有空白字符', async () => {
  const { normalizeRootKey } = await import('../../../workers/auth-gateway/functions/_kernel/crypto.js');
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
  /* 标记 owner 层已配置：根凭证正确后走 needAccount 分支（不是 401 auth） */
  await kv.put('account-configured', '1');
  const req = postReq('https://styrigx.com/api/lock-reset', { action: 'verify', rootKey: 'test-root-key-\nabc123' }, { 'CF-Connecting-IP': '10.0.0.3' });
  const res = await onRequestPost({ request: req, env: authEnv(kv) });
  /* 根凭证正确 → 进入开关/管理员凭证流程（needAccount），不是 401 auth */
  const j = await res.json();
  assert.notEqual(j.error, 'auth', '带换行的根凭证不应报 auth 失败');
  assert.equal(j.needAccount, true, '应进入管理员凭证步骤');
});

/* ============ C4：user handle 按类别区分 ============ */




/* ============ 批次 A 收尾返工：owner 验证接受旧 handle ============ */



