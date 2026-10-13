/**
 * 批次 A 收尾：根凭证规范化（B2）+ passkey user handle 按类别区分（C4）。
 *
 * B2：
 * - normalizeRootKey 去掉所有空白字符（空格、制表符、换行 \r \n）
 * - root-auth：带换行、不带换行、首尾空格三种写法都通过；改一个字符失败；空串失败
 * - lockreset verify：带换行通过
 * - 只有根凭证这样处理；站长密码、解锁密码不做任何规范化
 *
 * C4：
 * - owner、lock、应用三类 user.id 互不相同
 * - 同类再次 challenge → user.id 复用
 * - 拿 lock 的 handle 验 owner 凭据会失败（verify 用同一 getUserHandle 查期望值）
 *
 * 运行：node --test tests/kernel/batchc-rootkey-userhandle.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

function makeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    get: async (k, fmt) => {
      const v = m.has(k) ? m.get(k) : null;
      if (v === null) return null;
      return fmt === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
    list: async (opts) => {
      const prefix = (opts && opts.prefix) || '';
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
    },
    _map: m,
  };
}

function postReq(url, body, headers = {}) {
  const h = { 'Content-Type': 'application/json', 'Origin': 'https://styrigx.com', ...headers };
  return new Request(url, {
    method: 'POST',
    headers: h,
    body: JSON.stringify(body),
  });
}

let STEPUP_PRIV = '', STEPUP_PUB = '', LOCK_PRIV = '', LOCK_PUB = '';
function derToPem(der, label) {
  const b64 = Buffer.from(der).toString('base64');
  const lines = b64.match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}
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

const SGX_ROOT_KEY = 'test-root-key-abc123';

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

/* ============ B2：normalizeRootKey ============ */

test('B2：normalizeRootKey 去掉所有空白字符', async () => {
  const { normalizeRootKey } = await import('../../functions/_kernel/crypto.js');
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
  const { onRequestPost } = await import('../../functions/api/root-auth.js');
  const kv = makeKV();
  /* 引导模式：lock 未配置时无会话也能校验根凭证 */
  const req = postReq('https://styrigx.com/api/root-auth', { key: 'test-root-key-\nabc123' });
  const res = await onRequestPost({ request: req, env: authEnv(kv) });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.ok(j.ok, '带换行的根凭证应通过');
});

test('B2：root-auth 首尾空格通过', async () => {
  const { onRequestPost } = await import('../../functions/api/root-auth.js');
  const kv = makeKV();
  const req = postReq('https://styrigx.com/api/root-auth', { key: '  test-root-key-abc123  ' });
  const res = await onRequestPost({ request: req, env: authEnv(kv) });
  const j = await res.json();
  assert.ok(j.ok, '首尾空格的根凭证应通过');
});

test('B2：root-auth 不带换行通过（回归）', async () => {
  const { onRequestPost } = await import('../../functions/api/root-auth.js');
  const kv = makeKV();
  const req = postReq('https://styrigx.com/api/root-auth', { key: SGX_ROOT_KEY });
  const res = await onRequestPost({ request: req, env: authEnv(kv) });
  const j = await res.json();
  assert.ok(j.ok, '原样根凭证应通过');
});

test('B2：root-auth 改一个字符失败', async () => {
  const { onRequestPost } = await import('../../functions/api/root-auth.js');
  const kv = makeKV();
  const req = postReq('https://styrigx.com/api/root-auth', { key: 'test-root-key-abc124' }, { 'CF-Connecting-IP': '10.0.0.1' });
  const res = await onRequestPost({ request: req, env: authEnv(kv) });
  assert.equal(res.status, 401);
  const j = await res.json();
  assert.ok(!j.ok, '改一个字符应失败');
});

test('B2：root-auth 空串失败（去空白后为空一律拒绝）', async () => {
  const { onRequestPost } = await import('../../functions/api/root-auth.js');
  const kv = makeKV();
  const req = postReq('https://styrigx.com/api/root-auth', { key: '   \n\t  ' }, { 'CF-Connecting-IP': '10.0.0.2' });
  const res = await onRequestPost({ request: req, env: authEnv(kv) });
  assert.equal(res.status, 401);
  const j = await res.json();
  assert.ok(!j.ok, '空白串应失败');
});

test('B2：lockreset verify 带换行通过', async () => {
  const { onRequestPost } = await import('../../functions/api/lockreset.js');
  const kv = makeKV();
  /* 标记 owner 层已配置：根凭证正确后走 needOwner 分支（不是 401 auth） */
  await kv.put('layer:owner', '1');
  const req = postReq('https://styrigx.com/api/lockreset', { action: 'verify', rootKey: 'test-root-key-\nabc123' }, { 'CF-Connecting-IP': '10.0.0.3' });
  const res = await onRequestPost({ request: req, env: authEnv(kv) });
  /* 根凭证正确 → 进入开关/站长凭证流程（needOwner），不是 401 auth */
  const j = await res.json();
  assert.notEqual(j.error, 'auth', '带换行的根凭证不应报 auth 失败');
  assert.equal(j.needOwner, true, '应进入站长凭证步骤');
});

/* ============ C4：user handle 按类别区分 ============ */

test('C4：owner、lock、应用三类 user.id 互不相同', async () => {
  const { onRequestPost } = await import('../../functions/api/owner-passkey.js');
  const { signStepupCookie } = await import('../../functions/api/stepup.js');
  const { signSessionCookie } = await import('../../functions/_kernel/session.js');
  const kv = makeKV();
  const env = authEnv(kv);

  /* 构造有效 owner 会话；owner 类用入口 1（by=root, scope=root），lock/app 用入口 2（by=owner, scope=keys） */
  const sess = await signSessionCookie(LOCK_PRIV, 0, 'owner', 'owner');
  const stepOwner = await signStepupCookie(STEPUP_PRIV, 'root', 'root', 0);
  const stepKeys = await signStepupCookie(STEPUP_PRIV, 'owner', 'keys', 0);
  const headersFor = (pkClass) => ({
    'Cookie': 'sgx-verified=' + sess + '; sgx-stepup=' + (pkClass === 'owner' ? stepOwner : stepKeys),
  });

  const challenge = async (pkClass, aud) => {
    const body = { action: 'challenge', type: 'register', pkClass };
    if (aud) body.aud = aud;
    const req = postReq('https://styrigx.com/api/owner-passkey', body, headersFor(pkClass));
    const res = await onRequestPost({ request: req, env });
    const j = await res.json();
    assert.ok(j.ok, pkClass + ' challenge 应成功：' + JSON.stringify(j));
    return j.user.id;
  };

  const ownerId = await challenge('owner');
  const lockId = await challenge('lock');
  const appId = await challenge('app', 'book');
  assert.ok(ownerId && lockId && appId, '三类都应有 user.id');
  assert.notEqual(ownerId, lockId, 'owner 与 lock 的 user.id 应不同');
  assert.notEqual(ownerId, appId, 'owner 与 app 的 user.id 应不同');
  assert.notEqual(lockId, appId, 'lock 与 app 的 user.id 应不同');
});

test('C4：同类再次 challenge → user.id 复用', async () => {
  const { onRequestPost } = await import('../../functions/api/owner-passkey.js');
  const { signStepupCookie } = await import('../../functions/api/stepup.js');
  const { signSessionCookie } = await import('../../functions/_kernel/session.js');
  const kv = makeKV();
  const env = authEnv(kv);
  const sess = await signSessionCookie(LOCK_PRIV, 0, 'owner', 'owner');
  const stepOwner = await signStepupCookie(STEPUP_PRIV, 'root', 'root', 0);
  const stepKeys = await signStepupCookie(STEPUP_PRIV, 'owner', 'keys', 0);
  const headersFor = (pkClass) => ({
    'Cookie': 'sgx-verified=' + sess + '; sgx-stepup=' + (pkClass === 'owner' ? stepOwner : stepKeys),
  });

  const challenge = async (pkClass) => {
    const req = postReq('https://styrigx.com/api/owner-passkey', { action: 'challenge', type: 'register', pkClass }, headersFor(pkClass));
    const res = await onRequestPost({ request: req, env });
    const j = await res.json();
    assert.ok(j.ok);
    return j.user.id;
  };

  const first = await challenge('owner');
  const second = await challenge('owner');
  assert.equal(first, second, '同类 user.id 应复用（存 KV）');
});

test('C4：lock 的 handle 验 owner 凭据会失败（verify 用同一 getUserHandle 查期望值）', async () => {
  /* 机制验证：verify 时期望的 userHandle 按 pkClass 取；owner 与 lock 的期望值不同，
     所以用 lock handle 注册的凭据提交到 owner verify 时，gotUh !== expectUh → 抛 userHandle。
     这里直接验证两类的期望值不同（verify 内部用同一函数，无需构造完整 WebAuthn 断言）。 */
  const { onRequestPost } = await import('../../functions/api/owner-passkey.js');
  const { signStepupCookie } = await import('../../functions/api/stepup.js');
  const { signSessionCookie } = await import('../../functions/_kernel/session.js');
  const kv = makeKV();
  const env = authEnv(kv);
  const sess = await signSessionCookie(LOCK_PRIV, 0, 'owner', 'owner');
  const stepOwner = await signStepupCookie(STEPUP_PRIV, 'root', 'root', 0);
  const stepKeys = await signStepupCookie(STEPUP_PRIV, 'owner', 'keys', 0);
  const headersFor = (pkClass) => ({
    'Cookie': 'sgx-verified=' + sess + '; sgx-stepup=' + (pkClass === 'owner' ? stepOwner : stepKeys),
  });

  const challenge = async (pkClass) => {
    const req = postReq('https://styrigx.com/api/owner-passkey', { action: 'challenge', type: 'register', pkClass }, headersFor(pkClass));
    const res = await onRequestPost({ request: req, env });
    const j = await res.json();
    assert.ok(j.ok);
    return j.user.id;
  };

  const ownerUh = await challenge('owner');
  const lockUh = await challenge('lock');
  /* 若凭据用 lockUh 注册，提交到 owner verify 时期望 ownerUh → 不匹配 → 失败 */
  assert.notEqual(lockUh, ownerUh, 'lock handle 与 owner 期望值不同，跨类验证必失败');
  /* KV 里两类 handle 分开存 */
  assert.equal(await kv.get('owner-user-id'), lockUh, 'lock 类用旧 key');
  assert.equal(await kv.get('owner-user-id:owner'), ownerUh, 'owner 类用新 key');
});
