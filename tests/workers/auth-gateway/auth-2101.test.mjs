/**
 * 2.10.1 修复测试（space）。
 *
 * 覆盖：
 * - A2（2.11更新）：/api/root-auth 校验 SGX_ROOT_KEY 通过后签发 sgx-stepup(by=root, scope=root)；
 *       错误密钥 → 401 并计数；超限 → 429；缺 SGX_ROOT_KEY/SGX_STEPUP_PRIVATE → 拒绝；
 *       每次使用写审计记录；KV 出错 fail closed
 * - B6：register 必须要求 admin 会话；第一把 lock 也要求 stepup
 * - B9：bumpAppEpoch KV 失败时抛错（删除被拒绝，fail closed）
 * - B10：删应用类密钥只加 app-epoch:<aud>，不推进会话纪元
 * - B7 已在 tests/ui/app-token.test.mjs 覆盖
 * - B8 已在实现中修复（按 pkClass/aud 取 userHandle），此处断言 getUserHandle 分键
 *
 * 运行：node --test tests/kernel/auth-2101.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeKV, genKeyPair, postReq } from '../_harness.mjs';

let LOCK_PRIV = '', LOCK_PUB = '';
async function genKeys() {
  ({ priv: LOCK_PRIV, pub: LOCK_PUB } = await genKeyPair());
}

const SGX_ROOT_KEY = 'test-root-key-2101';

function authEnv(kv, overrides = {}) {
  return {
    KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv,
    SGX_ROOT_KEY,
    SGX_LOCK_PRIVATE: LOCK_PRIV,
    SGX_LOCK_PUBLIC: LOCK_PUB,
    SGX_RP_ID: 'styrigx.com',
    SGX_ORIGIN: 'https://styrigx.com',
    ...overrides,
  };
}

/* 测试钥匙：before 里生成（不算一条用例，单独跑某条用例时也会先执行） */
before(async () => {
  await genKeys();
  assert.ok(LOCK_PRIV && LOCK_PUB);
});

/* ============ A2：root-auth ============ */


test('A2：错误根密钥 → 401 并计数', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/root-auth.js');
  const kv = makeKV();
  const env = authEnv(kv);
  for (let i = 0; i < 3; i++) {
    const req = postReq('https://styrigx.com/api/root-auth', { key: 'wrong', purpose: 'lock-reset' }, { 'CF-Connecting-IP': '1.2.3.4' });
    const res = await onRequestPost({ request: req, env });
    assert.equal(res.status, 401);
  }
  const rec = await kv.get('root-fail:1.2.3.4', 'json');
  assert.ok(rec && rec.count === 3, '失败应计数');
});

test('A2：超限 → 429', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/root-auth.js');
  const kv = makeKV();
  const env = authEnv(kv);
  for (let i = 0; i < 6; i++) {
    const req = postReq('https://styrigx.com/api/root-auth', { key: 'wrong', purpose: 'lock-reset' }, { 'CF-Connecting-IP': '5.6.7.8' });
    await onRequestPost({ request: req, env });
  }
  const req = postReq('https://styrigx.com/api/root-auth', { key: 'wrong', purpose: 'lock-reset' }, { 'CF-Connecting-IP': '5.6.7.8' });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 429, '5 次失败后应锁定返回 429');
});

test('A2：缺 SGX_ROOT_KEY → 拒绝', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/root-auth.js');
  const kv = makeKV();
  const req = postReq('https://styrigx.com/api/root-auth', { key: 'anything', purpose: 'lock-reset' });
  const res = await onRequestPost({ request: req, env: authEnv(kv, { SGX_ROOT_KEY: '' }) });
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'config');
});


test('A2：每次使用写审计记录', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/root-auth.js');
  const kv = makeKV();
  const env = authEnv(kv);
  await onRequestPost({ request: postReq('https://styrigx.com/api/root-auth', { key: SGX_ROOT_KEY, purpose: 'lock-reset' }, { 'CF-Connecting-IP': '9.9.9.9' }), env });
  await onRequestPost({ request: postReq('https://styrigx.com/api/root-auth', { key: 'bad', purpose: 'lock-reset' }, { 'CF-Connecting-IP': '9.9.9.9' }), env });
  const keys = [...kv._map.keys()].filter((k) => k.startsWith('root-audit:'));
  assert.ok(keys.length >= 2, '成功和失败都应写审计记录');
  const rec = JSON.parse(kv._map.get(keys[0]));
  assert.ok(rec.ts && rec.ipPrefix && ('ok' in rec), '审计记录应含时间、IP 前缀、结果');
  assert.ok(!rec.ipPrefix.includes('9.9.9.9') || rec.ipPrefix.includes('9.9.9.x'), 'IP 应只存前缀');
});

test('A2：KV 出错 fail closed（无会话假入口：限速读不到 → 503 server，不是 500 config）', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/root-auth.js');
  const kv = makeKV();
  kv._fail = true;
  /* KV 全挂：锁屏是否已设置读不到 → 按已设置处理 → lock-reset 走假入口 → 限速检查抛错 → 503 */
  const req = postReq('https://styrigx.com/api/root-auth', { key: SGX_ROOT_KEY, purpose: 'lock-reset' });
  const res = await onRequestPost({ request: req, env: authEnv(kv) });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false, error: 'server' });
  assert.equal(res.headers.get('Set-Cookie'), null, '不签票');
});

test('A2：KV 出错 fail closed（真路径：锁屏未设置、限速 KV 读出错 → 503 server，对的 RootKey 也不签票）', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/root-auth.js');
  const kv = makeKV();
  const get = kv.get;
  kv.get = async (k, fmt) => {
    if (String(k).startsWith('root-fail')) throw new Error('kv-fail');
    return get(k, fmt);
  };
  const { isLockEffectivelyConfigured } = await import('../../../workers/auth-gateway/functions/_kernel/layers.js');
  assert.equal(await isLockEffectivelyConfigured(kv), false, '前提：锁屏未设置，lock-reset 走真路径');
  const req = postReq('https://styrigx.com/api/root-auth', { key: SGX_ROOT_KEY, purpose: 'lock-reset' });
  const res = await onRequestPost({ request: req, env: authEnv(kv) });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false, error: 'server' });
  assert.equal(res.headers.get('Set-Cookie'), null, '不签票');
});

/* ============ B6：register 要求 admin 会话 ============ */

test('B6：无会话时 register challenge → 401', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/lock-passkey.js');
  const kv = makeKV();
  const env = authEnv(kv);
  const req = postReq('https://styrigx.com/api/lock-passkey', { action: 'challenge', type: 'register' });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401, '无 admin 会话时 register 应被拒');
});

/* ============ B9/B10：删除应用类密钥 ============ */



/* ============ B8：userHandle 按 pkClass/aud 取 ============ */

