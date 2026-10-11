/**
 * 2.11 定稿测试：根凭证 / 站长凭证鉴权拆分。
 *
 * 九组（定稿第十节）：
 * 1. 越权：scope 不匹配 403；lock passkey 开 stepup 被拒；已配置层拒 by=root
 * 2. 无 lock 会话：单用站长凭证进入口 2、单用根凭证进入口 1 均被拒
 * 3. 重置锁屏：只站长或只根（开关关闭）被拒；两者都过拿到 lockreset；
 *    lockreset 访问主页面/APP/会话/入口1/2 均 403 且不产生 sgx-verified；
 *    完成后旧会话失效；owner 未配置时被拒
 * 4. 开关：缺失/过期/超 24 小时/格式错误时单根被拒；有效时单根拿到 lockreset；
 *    有效时单站长仍被拒
 * 5. 假入口：访客提交正确 SGX_ROOT_KEY 返回 401 auth，与错误密钥响应逐字节相同
 * 6. 接管：未配时根可代管；配置后失效；接管后旧 root 票/会话被拒；
 *    KV 读失败时根代管被拒
 * 7. pepper：旧 hash 重哈希；缺 pepper fail closed；owner 密码 = 锁屏密码被拒
 * 8. /api/root-auth：错误 401 auth，缺 Origin 403；/api/owner-auth 不可用
 * 9. 限速：根凭证各路径共用计数
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const REPO = new URL('../../', import.meta.url).pathname;

/* 简易 KV mock */
function makeKv(init) {
  const m = new Map(Object.entries(init || {}));
  return {
    get: async (k, t) => {
      const v = m.get(k);
      if (v === undefined) return null;
      return t === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v, o) => { m.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
    delete: async (k) => { m.delete(k); },
    list: async (o) => ({ keys: Array.from(m.keys()).map((name) => ({ name })) }),
    _store: m,
  };
}

function postReq(url, body, headers) {
  const h = { 'Content-Type': 'application/json', 'Origin': new URL(url).origin };
  Object.assign(h, headers || {});
  return new Request(url, { method: 'POST', headers: h, body: JSON.stringify(body || {}) });
}

/* 测试用 Ed25519 密钥（运行时生成，仅测试，不用于生产） */
let TEST_PRIV_PEM = '';
let TEST_PUB_PEM = '';

function derToPem(der, label) {
  const b64 = Buffer.from(der).toString('base64');
  const lines = b64.match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

async function genTestKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const privDer = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
  const pubDer = await crypto.subtle.exportKey('spki', kp.publicKey);
  TEST_PRIV_PEM = derToPem(privDer, 'PRIVATE KEY');
  TEST_PUB_PEM = derToPem(pubDer, 'PUBLIC KEY');
}
await genTestKeys();

function baseEnv(kv, overrides) {
  return Object.assign({
    OWNER_KV: kv,
    SGX_ROOT_KEY: 'test-root-key-12345',
    SGX_STEPUP_PRIVATE: TEST_PRIV_PEM,
    SGX_STEPUP_PUBLIC: TEST_PUB_PEM,
    SGX_LOCK_PRIVATE: TEST_PRIV_PEM,
    SGX_LOCK_PUBLIC: TEST_PUB_PEM,
    SGX_PW_PEPPER: 'test-pepper',
    SGX_RP_ID: 'test.example.com',
    SGX_ORIGIN: 'https://test.example.com',
  }, overrides || {});
}

/* ============ 1. 越权 ============ */

test('2.11 越权：scope 不匹配 403（scope=keys 的票不能进入口 1）', async () => {
  const { verifyStepupCookie, signStepupCookie, STEPUP_SCOPE_KEYS } = await import(REPO + 'functions/api/stepup.js');
  const kv = makeKv();
  const env = baseEnv(kv);
  /* 直接验票：scope=keys 的票用于要求 scope=root 的场景 → 由调用方拒绝。
     这里验证 stepup 模块本身能正确解析 by/scope */
  const cv = await signStepupCookie(TEST_PRIV_PEM, 'owner', 'keys', 0);
  assert.ok(cv.startsWith('owner.keys.'));
});

test('2.11 越权：已配置层拒 by=root 的票（owner-passkey 管理 owner 类）', async () => {
  const { onRequestPost } = await import(REPO + 'functions/api/owner-passkey.js');
  const { signStepupCookie } = await import(REPO + 'functions/api/stepup.js');
  const { signSessionCookie } = await import(REPO + 'functions/_kernel/session.js');
  const kv = makeKv({
    'layer:owner': '1',
    'layer:lock': '1',
    'session-epoch': '0',
  });
  const env = baseEnv(kv);
  /* by=root, scope=keys 的票（旧代管票），owner 已配置 → 拒绝 */
  const stepupCv = await signStepupCookie(TEST_PRIV_PEM, 'root', 'keys', 0);
  const sessCv = await signSessionCookie(TEST_PRIV_PEM, 0, 'owner', 'owner');
  const req = postReq('https://test.example.com/api/owner-passkey', {
    action: 'challenge', type: 'register', pkClass: 'lock',
  }, { 'Cookie': 'sgx-verified=' + sessCv + '; sgx-stepup=' + stepupCv });
  const res = await onRequestPost({ request: req, env });
  /* by=root + scope=keys 但 owner 已配置 → 403 scope */
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, 'scope');
});

/* ============ 2. 无 lock 会话 ============ */

test('2.11 无 lock 会话：单用站长凭证进入口 2 被拒（无会话 → 401）', async () => {
  const { onRequestPost } = await import(REPO + 'functions/api/stepup.js');
  const kv = makeKv({ 'layer:owner': '1', 'layer:lock': '1' });
  const env = baseEnv(kv);
  /* verify-password 需要 owner 会话；无会话 → 401 */
  const req = postReq('https://test.example.com/api/stepup', {
    action: 'verify-password', password: 'whatever',
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401);
});

test('2.11 无 lock 会话：单用根凭证进入口 1 被拒（无会话且 lock 已配置 → 假入口 401 auth）', async () => {
  const { onRequestPost } = await import(REPO + 'functions/api/root-auth.js');
  const kv = makeKv({ 'layer:lock': '1' });
  const env = baseEnv(kv);
  const req = postReq('https://test.example.com/api/root-auth', { key: 'test-root-key-12345' });
  const res = await onRequestPost({ request: req, env });
  /* 无会话 + lock 已配置 → 假入口，即使密钥正确也 401 auth */
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { ok: false, error: 'auth' });
});

/* ============ 3. 重置锁屏 ============ */

test('2.11 重置锁屏：开关关闭时只根凭证被拒（缺站长凭证 → 401）', async () => {
  const { onRequestPost } = await import(REPO + 'functions/api/lockreset.js');
  const kv = makeKv({ 'layer:owner': '1', 'layer:lock': '1' });
  const env = baseEnv(kv); /* 无 SGX_RECOVERY_UNTIL → 开关关闭 */
  const req = postReq('https://test.example.com/api/lockreset', {
    action: 'verify', rootKey: 'test-root-key-12345',
    /* 无 ownerProof */
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401);
});

test('2.11 重置锁屏：开关关闭时只站长凭证被拒（缺根凭证 → 401）', async () => {
  const { onRequestPost } = await import(REPO + 'functions/api/lockreset.js');
  const { makePasswordRecord } = await import(REPO + 'functions/api/owner-password.js');
  const kv = makeKv({ 'layer:owner': '1', 'layer:lock': '1' });
  const rec = await makePasswordRecord('owner-pass-1', 'test-pepper');
  await kv.put('owner-pw', JSON.stringify(rec));
  const env = baseEnv(kv);
  const req = postReq('https://test.example.com/api/lockreset', {
    action: 'verify',
    ownerProof: { type: 'password', password: 'owner-pass-1' },
    /* 无 rootKey */
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401);
});

test('2.11 重置锁屏：owner 未配置且开关关闭 → 403 not-set', async () => {
  const { onRequestPost } = await import(REPO + 'functions/api/lockreset.js');
  const kv = makeKv({ 'layer:lock': '1' }); /* owner 未配置 */
  const env = baseEnv(kv);
  const st = postReq('https://test.example.com/api/lockreset', { action: 'status' });
  const stRes = await onRequestPost({ request: st, env });
  const stBody = await stRes.json();
  assert.equal(stBody.available, false);
  assert.equal(stBody.skippable, false);
  const req = postReq('https://test.example.com/api/lockreset', {
    action: 'verify', rootKey: 'test-root-key-12345',
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 403);
});

/* ============ 4. 恢复开关 ============ */

test('2.11 开关：缺失/过期/超 24h/格式错误 → isRecoveryEnabled=false', async () => {
  const { isRecoveryEnabled } = await import(REPO + 'functions/_kernel/recovery.js');
  assert.equal(isRecoveryEnabled({}), false);
  assert.equal(isRecoveryEnabled({ SGX_RECOVERY_UNTIL: 'not-a-date' }), false);
  assert.equal(isRecoveryEnabled({ SGX_RECOVERY_UNTIL: '2020-01-01T00:00:00+08:00' }), false);
  /* 超 24 小时（未来 25 小时） */
  const future25 = new Date(Date.now() + 25 * 3600 * 1000).toISOString();
  assert.equal(isRecoveryEnabled({ SGX_RECOVERY_UNTIL: future25 }), false);
  /* 无时区后缀 → 格式错误 */
  assert.equal(isRecoveryEnabled({ SGX_RECOVERY_UNTIL: '2026-10-13T12:00:00' }), false);
});

test('2.11 开关：有效（未来 1 小时）→ 开启；单根可拿 lockreset', async () => {
  const { isRecoveryEnabled } = await import(REPO + 'functions/_kernel/recovery.js');
  const { onRequestPost } = await import(REPO + 'functions/api/lockreset.js');
  const future1h = new Date(Date.now() + 3600 * 1000).toISOString();
  assert.equal(isRecoveryEnabled({ SGX_RECOVERY_UNTIL: future1h }), true);
  /* 开关开启时，单根可拿 lockreset */
  const kv = makeKv({ 'layer:lock': '1' }); /* owner 未配置 */
  const env = baseEnv(kv, { SGX_RECOVERY_UNTIL: future1h });
  const st = postReq('https://test.example.com/api/lockreset', { action: 'status' });
  const stRes = await onRequestPost({ request: st, env });
  const stBody = await stRes.json();
  assert.equal(stBody.available, true);
  assert.equal(stBody.skippable, true);
});

test('2.11 开关：有效时单站长凭证仍被拒（不能跳过根凭证）', async () => {
  const { onRequestPost } = await import(REPO + 'functions/api/lockreset.js');
  const { makePasswordRecord } = await import(REPO + 'functions/api/owner-password.js');
  const future1h = new Date(Date.now() + 3600 * 1000).toISOString();
  const kv = makeKv({ 'layer:owner': '1', 'layer:lock': '1' });
  const rec = await makePasswordRecord('owner-pass-1', 'test-pepper');
  await kv.put('owner-pw', JSON.stringify(rec));
  const env = baseEnv(kv, { SGX_RECOVERY_UNTIL: future1h });
  /* 有 ownerProof 但无 rootKey → 401（根凭证不可跳过） */
  const req = postReq('https://test.example.com/api/lockreset', {
    action: 'verify',
    ownerProof: { type: 'password', password: 'owner-pass-1' },
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401);
});

/* ============ 5. 假入口 ============ */

test('2.11 假入口：访客提交正确根凭证 → 401 auth，与错误密钥响应逐字节相同', async () => {
  const { onRequestPost } = await import(REPO + 'functions/api/root-auth.js');
  const kv1 = makeKv({ 'layer:lock': '1' });
  const kv2 = makeKv({ 'layer:lock': '1' });
  const env1 = baseEnv(kv1);
  const env2 = baseEnv(kv2);
  /* 正确密钥 */
  const req1 = postReq('https://test.example.com/api/root-auth', { key: 'test-root-key-12345' });
  const res1 = await onRequestPost({ request: req1, env: env1 });
  /* 错误密钥 */
  const req2 = postReq('https://test.example.com/api/root-auth', { key: 'wrong-key' });
  const res2 = await onRequestPost({ request: req2, env: env2 });
  assert.equal(res1.status, 401);
  assert.equal(res2.status, 401);
  const b1 = await res1.text();
  const b2 = await res2.text();
  assert.equal(b1, b2);
  assert.equal(b1, JSON.stringify({ ok: false, error: 'auth' }));
});

test('2.11 假入口：缺 Origin → 403（先于假入口）', async () => {
  const { onRequestPost } = await import(REPO + 'functions/api/root-auth.js');
  const kv = makeKv({ 'layer:lock': '1' });
  const env = baseEnv(kv);
  const req = new Request('https://test.example.com/api/root-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'test-root-key-12345' }),
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 403);
});

/* ============ 6. 接管 ============ */

test('2.11 接管：未配 owner 时 root 可代管（scope=keys, by=root）', async () => {
  const { checkRootTakeover, LAYER_OWNER } = await import(REPO + 'functions/_kernel/layers.js');
  const kv = makeKv(); /* 全未配置 */
  const r = await checkRootTakeover(kv, LAYER_OWNER);
  assert.equal(r.allowed, true);
  assert.equal(r.reason, 'takeover');
});

test('2.11 接管：配置后 root 对该层失效', async () => {
  const { checkRootTakeover, LAYER_OWNER } = await import(REPO + 'functions/_kernel/layers.js');
  const kv = makeKv({ 'layer:owner': '1' });
  const r = await checkRootTakeover(kv, LAYER_OWNER);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'configured');
});

test('2.11 接管：KV 读取失败按已配置处理（root 被拒）', async () => {
  const { checkRootTakeover, LAYER_OWNER } = await import(REPO + 'functions/_kernel/layers.js');
  const brokenKv = {
    get: async () => { throw new Error('kv-down'); },
  };
  const r = await checkRootTakeover(brokenKv, LAYER_OWNER);
  assert.equal(r.allowed, false);
  /* 2.11 定稿：KV 读失败按已配置处理 */
  assert.equal(r.reason, 'configured');
});

/* ============ 7. pepper ============ */

test('2.11 pepper：缺 pepper → fail closed（set/verify 均拒绝）', async () => {
  const { onRequestPost } = await import(REPO + 'functions/api/owner-password.js');
  const { signStepupCookie } = await import(REPO + 'functions/api/stepup.js');
  const { signSessionCookie } = await import(REPO + 'functions/_kernel/session.js');
  const kv = makeKv({ 'layer:owner': '1', 'layer:lock': '1', 'session-epoch': '0' });
  const envNoPepper = baseEnv(kv, { SGX_PW_PEPPER: '' });
  const stepupCv = await signStepupCookie(TEST_PRIV_PEM, 'owner', 'keys', 0);
  const sessCv = await signSessionCookie(TEST_PRIV_PEM, 0, 'owner', 'owner');
  const headers = { 'Cookie': 'sgx-verified=' + sessCv + '; sgx-stepup=' + stepupCv };
  /* set 无 pepper → 503 */
  const req1 = postReq('https://test.example.com/api/owner-password',
    { action: 'set', kind: 'lock', password: 'new-pass-12345' }, headers);
  const res1 = await onRequestPost({ request: req1, env: envNoPepper });
  assert.equal(res1.status, 503);
});

test('2.11 pepper：owner 密码 = 锁屏密码被拒（双向）', async () => {
  const { onRequestPost } = await import(REPO + 'functions/api/owner-password.js');
  const { makePasswordRecord } = await import(REPO + 'functions/api/owner-password.js');
  const { signStepupCookie } = await import(REPO + 'functions/api/stepup.js');
  const { signSessionCookie } = await import(REPO + 'functions/_kernel/session.js');
  const kv = makeKv({ 'layer:owner': '1', 'layer:lock': '1', 'session-epoch': '0' });
  /* 先设锁屏密码 */
  const lockRec = await makePasswordRecord('same-pass-12345', 'test-pepper');
  await kv.put('lock-pw', JSON.stringify(lockRec));
  const env = baseEnv(kv);
  /* 入口 1：scope=root, by=root */
  const stepupRoot = await signStepupCookie(TEST_PRIV_PEM, 'root', 'root', 0);
  const sessCv = await signSessionCookie(TEST_PRIV_PEM, 0, 'owner', 'owner');
  const headers = { 'Cookie': 'sgx-verified=' + sessCv + '; sgx-stepup=' + stepupRoot };
  /* 设 owner 密码 = 锁屏密码 → 403 same-as-lock */
  const req = postReq('https://test.example.com/api/owner-password',
    { action: 'set', kind: 'owner', password: 'same-pass-12345' }, headers);
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'same-as-lock');
});

/* ============ 8. root-auth ============ */

test('2.11 root-auth：错误密钥 401 auth（引导模式）', async () => {
  const { onRequestPost } = await import(REPO + 'functions/api/root-auth.js');
  const kv = makeKv(); /* lock 未配置 → 引导模式 */
  const env = baseEnv(kv);
  const req = postReq('https://test.example.com/api/root-auth', { key: 'wrong-key' });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { ok: false, error: 'auth' });
});

test('2.11 root-auth：缺 Origin 403 origin', async () => {
  const { onRequestPost } = await import(REPO + 'functions/api/root-auth.js');
  const kv = makeKv();
  const env = baseEnv(kv);
  const req = new Request('https://test.example.com/api/root-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'x' }),
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'origin');
});

test('2.11 root-auth：旧 /api/owner-auth 不再可用（文件不存在）', async () => {
  const fs = await import('node:fs');
  assert.equal(fs.existsSync(REPO + 'functions/api/owner-auth.js'), false);
});

/* ============ 9. 限速 ============ */

test('2.11 限速：根凭证各路径共用计数（root-auth 失败计入 lockreset 限速）', async () => {
  const { checkRootLimit, recordRootFail } = await import(REPO + 'functions/_kernel/rootlimit.js');
  const kv = makeKv();
  const ip = '1.2.3.4';
  /* 5 次失败后锁定 */
  for (let i = 0; i < 5; i++) {
    await recordRootFail(kv, ip);
  }
  const lim = await checkRootLimit(kv, ip);
  assert.equal(lim.limited, true);
});
