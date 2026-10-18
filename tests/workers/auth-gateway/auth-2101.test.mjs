/**
 * 2.10.1 修复测试（space）。
 *
 * 覆盖：
 * - A2（2.11更新）：/api/root-auth 校验 SGX_ROOT_KEY 通过后签发 sgx-stepup(by=root, scope=root)；
 *       错误密钥 → 401 并计数；超限 → 429；缺 SGX_ROOT_KEY/SGX_STEPUP_PRIVATE → 拒绝；
 *       每次使用写审计记录；KV 出错 fail closed
 * - B6：register 必须要求 owner 会话；第一把 lock 也要求 stepup
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

let LOCK_PRIV = '', LOCK_PUB = '', STEPUP_PRIV = '', STEPUP_PUB = '';
async function genKeys() {
  const mk = async () => {
    const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    return {
      priv: derToPem(await crypto.subtle.exportKey('pkcs8', kp.privateKey), 'PRIVATE KEY'),
      pub: derToPem(await crypto.subtle.exportKey('spki', kp.publicKey), 'PUBLIC KEY'),
    };
  };
  const l = await mk(); LOCK_PRIV = l.priv; LOCK_PUB = l.pub;
  const s = await mk(); STEPUP_PRIV = s.priv; STEPUP_PUB = s.pub;
}

const SGX_ROOT_KEY = 'test-owner-key-12345';

function authEnv(kv, overrides = {}) {
  return {
    OWNER_KV: kv,
    SGX_ROOT_KEY,
    SGX_LOCK_PRIVATE: LOCK_PRIV,
    SGX_LOCK_PUBLIC: LOCK_PUB,
    SGX_STEPUP_PRIVATE: STEPUP_PRIV,
    SGX_STEPUP_PUBLIC: STEPUP_PUB,
    SGX_RP_ID: 'styrigx.com',
    SGX_ORIGIN: 'https://styrigx.com',
    ...overrides,
  };
}

test('setup: 生成测试密钥', async () => {
  await genKeys();
  assert.ok(LOCK_PRIV && STEPUP_PRIV);
});

/* ============ A2：owner-auth ============ */

test('A2：正确根密钥 → 签发 sgx-stepup(by=root, scope=root)', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/root-auth.js');
  const kv = makeKV();
  const req = postReq('https://styrigx.com/api/root-auth', { key: SGX_ROOT_KEY });
  const res = await onRequestPost({ request: req, env: authEnv(kv) });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.ok(j.ok, '应返回 ok:true');
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('Set-Cookie')];
  const all = cookies.join(';');
  /* 2.11：root-auth 只签发 sgx-stepup(by=root, scope=root)，不签发会话 */
  assert.ok(!all.includes('sgx-verified='), '2.11：不应签发 sgx-verified 会话 cookie');
  assert.ok(all.includes('sgx-stepup='), '应签发 sgx-stepup cookie');
});

test('A2：错误根密钥 → 401 并计数', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/root-auth.js');
  const kv = makeKV();
  const env = authEnv(kv);
  for (let i = 0; i < 3; i++) {
    const req = postReq('https://styrigx.com/api/root-auth', { key: 'wrong' }, { 'CF-Connecting-IP': '1.2.3.4' });
    const res = await onRequestPost({ request: req, env });
    assert.equal(res.status, 401);
  }
  const rec = await kv.get('root-auth-fail:1.2.3.4', 'json');
  assert.ok(rec && rec.count === 3, '失败应计数');
});

test('A2：超限 → 429', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/root-auth.js');
  const kv = makeKV();
  const env = authEnv(kv);
  for (let i = 0; i < 6; i++) {
    const req = postReq('https://styrigx.com/api/root-auth', { key: 'wrong' }, { 'CF-Connecting-IP': '5.6.7.8' });
    await onRequestPost({ request: req, env });
  }
  const req = postReq('https://styrigx.com/api/root-auth', { key: 'wrong' }, { 'CF-Connecting-IP': '5.6.7.8' });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 429, '5 次失败后应锁定返回 429');
});

test('A2：缺 SGX_ROOT_KEY → 拒绝', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/root-auth.js');
  const kv = makeKV();
  const req = postReq('https://styrigx.com/api/root-auth', { key: 'anything' });
  const res = await onRequestPost({ request: req, env: authEnv(kv, { SGX_ROOT_KEY: '' }) });
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'config');
});

test('A2：缺 SGX_STEPUP_PRIVATE → 拒绝', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/root-auth.js');
  const kv = makeKV();
  const req = postReq('https://styrigx.com/api/root-auth', { key: SGX_ROOT_KEY });
  const res = await onRequestPost({ request: req, env: authEnv(kv, { SGX_STEPUP_PRIVATE: '' }) });
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'no-stepup-key');
});

test('A2：每次使用写审计记录', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/root-auth.js');
  const kv = makeKV();
  const env = authEnv(kv);
  await onRequestPost({ request: postReq('https://styrigx.com/api/root-auth', { key: SGX_ROOT_KEY }, { 'CF-Connecting-IP': '9.9.9.9' }), env });
  await onRequestPost({ request: postReq('https://styrigx.com/api/root-auth', { key: 'bad' }, { 'CF-Connecting-IP': '9.9.9.9' }), env });
  const keys = [...kv._map.keys()].filter((k) => k.startsWith('root-auth-audit:'));
  assert.ok(keys.length >= 2, '成功和失败都应写审计记录');
  const rec = JSON.parse(kv._map.get(keys[0]));
  assert.ok(rec.ts && rec.ipPrefix && ('ok' in rec), '审计记录应含时间、IP 前缀、结果');
  assert.ok(!rec.ipPrefix.includes('9.9.9.9') || rec.ipPrefix.includes('9.9.9.x'), 'IP 应只存前缀');
});

test('A2：KV 出错 fail closed', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/root-auth.js');
  const kv = makeKV();
  kv._fail = true;
  const req = postReq('https://styrigx.com/api/root-auth', { key: SGX_ROOT_KEY });
  const res = await onRequestPost({ request: req, env: authEnv(kv) });
  assert.ok(res.status === 503 || res.status === 500, 'KV 出错应拒绝');
});

/* ============ B6：register 要求 owner 会话 ============ */

test('B6：无会话时 register challenge → 401', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/owner-passkey.js');
  const kv = makeKV();
  const env = authEnv(kv);
  const req = postReq('https://styrigx.com/api/owner-passkey', { action: 'challenge', type: 'register', pkClass: 'lock' });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401, '无 owner 会话时 register 应被拒');
});

/* ============ B9/B10：删除应用类密钥 ============ */

test('B9：bumpAppEpoch KV 失败 → 删除被拒绝（fail closed）', async () => {
  // 直接验证 bumpAppEpoch 的 fail-closed 语义通过 delete 路径
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/owner-passkey.js');
  const { signStepupCookie } = await import('../../../workers/auth-gateway/functions/api/stepup.js');
  const kv = makeKV();
  // 预置一把 app 凭据（credId 12 字符）
  const credId = 'appcred1234';
  const rec = {
    name: 't', provider: '', aaguid: '', createdAt: 1, lastUsedAt: 0,
    credId, publicKey: {}, signCount: 0, uv: 1, class: 'app', aud: 'book',
  };
  await kv.put('owner-passkey:' + credId, JSON.stringify(rec));
  await kv.put('owner-passkey-index', JSON.stringify([credId]));
  const env = authEnv(kv);
  // 先做一个能用的 stepup
  const stepupVal = await signStepupCookie(STEPUP_PRIV, 'owner', 'keys', 0);
  // 让 bumpAppEpoch 的 put 失败：用一个会抛错的 KV 包装
  const failKv = {
    ...kv,
    put: async (k, v, opts) => {
      if (String(k).startsWith('app-epoch:')) throw new Error('kv-fail');
      return kv.put(k, v, opts);
    },
  };
  const failEnv = authEnv(failKv);
  /* 2.10.2：delete 需 owner 会话 + stepup */
  const { signSessionCookie } = await import('../../../workers/auth-gateway/functions/_kernel/session.js');
  const sessVal = await signSessionCookie(LOCK_PRIV, 0, 'owner', 'owner');
  const req = postReq('https://styrigx.com/api/owner-passkey',
    { action: 'delete', credId },
    { Cookie: 'sgx-verified=' + sessVal + '; sgx-stepup=' + stepupVal });
  const res = await onRequestPost({ request: req, env: failEnv });
  assert.equal(res.status, 503, 'bumpAppEpoch 失败时删除应被拒绝');
  assert.equal((await res.json()).error, 'epoch');
});

test('B10：删应用类密钥只加 app-epoch，不推进会话纪元', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/owner-passkey.js');
  const { signStepupCookie } = await import('../../../workers/auth-gateway/functions/api/stepup.js');
  const kv = makeKV({ 'session-epoch': '10', 'app-epoch:book': '2' });
  const credId = 'appcred1234'; // 12 字符，与 key 后缀一致
  const rec = {
    name: 't', provider: '', aaguid: '', createdAt: 1, lastUsedAt: 0,
    credId, publicKey: {}, signCount: 0, uv: 1, class: 'app', aud: 'book',
  };
  await kv.put('owner-passkey:' + credId, JSON.stringify(rec));
  await kv.put('owner-passkey-index', JSON.stringify([credId]));
  const env = authEnv(kv);
  const stepupVal = await signStepupCookie(STEPUP_PRIV, 'owner', 'keys', 10);
  /* 2.10.2：delete 需 owner 会话 + stepup */
  const { signSessionCookie } = await import('../../../workers/auth-gateway/functions/_kernel/session.js');
  const sessVal = await signSessionCookie(LOCK_PRIV, 10, 'owner', 'owner');
  const req = postReq('https://styrigx.com/api/owner-passkey',
    { action: 'delete', credId },
    { Cookie: 'sgx-verified=' + sessVal + '; sgx-stepup=' + stepupVal });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 200);
  assert.equal(await kv.get('app-epoch:book'), '3', 'app-epoch:book 应 +1');
  assert.equal(await kv.get('session-epoch'), '10', '会话纪元不应推进');
});

/* ============ B8：userHandle 按 pkClass/aud 取 ============ */

test('B8：getUserHandle 按 aud 分键', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/owner-passkey.js');
  // 通过 challenge register 流程间接验证：不同 aud 的 user.id 不同
  // 这里直接验证 KV 键名隔离
  const kv = makeKV();
  const env = authEnv(kv);
  // 制造一个合法会话 + stepup
  const { signSessionCookie } = await import('../../../workers/auth-gateway/functions/_kernel/session.js');
  const { signStepupCookie } = await import('../../../workers/auth-gateway/functions/api/stepup.js');
  const sessVal = await signSessionCookie(LOCK_PRIV, 0, 'owner', 'owner');
  const stepupVal = await signStepupCookie(STEPUP_PRIV, 'owner', 'keys', 0);
  const cookie = `sgx-verified=${sessVal}; sgx-stepup=${stepupVal}`;
  const req = postReq('https://styrigx.com/api/owner-passkey',
    { action: 'challenge', type: 'register', pkClass: 'app', aud: 'book' },
    { Cookie: cookie });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.ok(j.ok && j.user && j.user.id, '应下发 user.id');
  const uhBook = await kv.get('owner-user-id:app:book');
  assert.ok(uhBook, 'app 类应使用 owner-user-id:app:book');
  const uhLock = await kv.get('owner-user-id');
  assert.equal(uhLock, null, '不应污染锁屏的 owner-user-id');
});
