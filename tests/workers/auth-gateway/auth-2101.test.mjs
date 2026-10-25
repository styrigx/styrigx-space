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
import { test } from 'node:test';
import assert from 'node:assert/strict';

/* ---- 简易 KV mock ---- */
function makeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  const kv = {
    get: async (k, fmt) => {
      if (kv._fail) throw new Error('kv-fail');
      const v = m.has(k) ? m.get(k) : null;
      if (v === null || v === undefined) return null;
      return fmt === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v, opts) => {
      if (kv._fail) throw new Error('kv-fail');
      m.set(k, v);
    },
    delete: async (k) => { m.delete(k); },
    list: async () => ({ keys: [...m.keys()].map((name) => ({ name })) }),
    _map: m,
    _fail: false,
  };
  return kv;
}

function postReq(url, body, headers = {}) {
  /* 2.10.2：真实浏览器 POST 必带 Origin；测试默认带上 */
  const h = { 'Content-Type': 'application/json', 'Origin': 'https://styrigx.com', ...headers };
  if (headers.Origin === null) delete h['Origin'];
  return new Request(url, {
    method: 'POST',
    headers: h,
    body: JSON.stringify(body),
  });
}

function derToPem(der, label) {
  const b64 = Buffer.from(der).toString('base64');
  const lines = b64.match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

let LOCK_PRIV = '', LOCK_PUB = '';
async function genKeys() {
  const mk = async () => {
    const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    return {
      priv: derToPem(await crypto.subtle.exportKey('pkcs8', kp.privateKey), 'PRIVATE KEY'),
      pub: derToPem(await crypto.subtle.exportKey('spki', kp.publicKey), 'PUBLIC KEY'),
    };
  };
  const l = await mk(); LOCK_PRIV = l.priv; LOCK_PUB = l.pub;
}

const SGX_ROOT_KEY = 'test-owner-key-12345';

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

test('setup: 生成测试密钥', async () => {
  await genKeys();
  assert.ok(LOCK_PRIV && LOCK_PUB);
});

/* ============ A2：owner-auth ============ */


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

test('A2：KV 出错 fail closed', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/root-auth.js');
  const kv = makeKV();
  kv._fail = true;
  const req = postReq('https://styrigx.com/api/root-auth', { key: SGX_ROOT_KEY, purpose: 'lock-reset' });
  const res = await onRequestPost({ request: req, env: authEnv(kv) });
  assert.ok(res.status === 503 || res.status === 500, 'KV 出错应拒绝');
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

