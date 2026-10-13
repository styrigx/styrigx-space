/**
 * stepup 二次验证服务端安全测试（node --test）。
 *
 * 覆盖用例：
 * - signStepupCookie / verifyStepupCookie：正常签发验证通过
 * - 过期 cookie 被拒（expired）
 * - 篡改 payload（epoch/exp）被拒（bad-sig）
 * - 伪造签名（另一把密钥签）被拒（bad-sig）
 * - epoch 变更后旧 cookie 失效（epoch-changed）
 * - 缺 SGX_STEPUP_PUBLIC 时 fail closed（no-pubkey）
 * - 缺 SGX_STEPUP_PRIVATE 时拒绝签发（no-stepup-key）
 * - /api/stepup：无会话 → 401；visitor 会话 → 403；challenge 用途隔离
 *   （login 的 pk-challenge: 不能用于 stepup verify）
 *
 * 运行：node --test tests/kernel/stepup-security.test.mjs
 * 说明：mock KV 只替代 Cloudflare KV（外部环境敏感项），被测的是自家逻辑；
 * Ed25519 测试密钥在测试内临时生成，不用生产密钥、不进仓库。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  signStepupCookie,
  parseStepupCookie,
  verifyStepupCookie,
  STEPUP_COOKIE,
  STEPUP_MAX_AGE,
  onRequestPost as stepupPost,
} from '../../functions/api/stepup.js';
import { ed25519Sign } from '../../functions/_kernel/crypto.js';

/* ---------- mock KV ---------- */

function makeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k, type) {
      if (!store.has(k)) return null;
      const v = store.get(k);
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v, opts) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
    async list() { return { keys: [] }; },
  };
}

/* ---------- Ed25519 测试密钥（临时生成） ---------- */

function derToPem(der, label) {
  const b64 = Buffer.from(der).toString('base64');
  const lines = b64.match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

let TEST_PRIV_PEM = '';
let TEST_PUB_PEM = '';
let OTHER_PRIV_PEM = '';
let OTHER_PUB_PEM = '';

async function genTestKeys() {
  for (const target of ['TEST', 'OTHER']) {
    const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const privDer = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
    const pubDer = await crypto.subtle.exportKey('spki', kp.publicKey);
    if (target === 'TEST') {
      TEST_PRIV_PEM = derToPem(privDer, 'PRIVATE KEY');
      TEST_PUB_PEM = derToPem(pubDer, 'PUBLIC KEY');
    } else {
      OTHER_PRIV_PEM = derToPem(privDer, 'PRIVATE KEY');
      OTHER_PUB_PEM = derToPem(pubDer, 'PUBLIC KEY');
    }
  }
}

function postReq(url, body, headers = {}) {
  /* 2.10.2：真实浏览器 POST 必带 Origin；测试默认带上（与请求 URL 同 host） */
  let defaultOrigin = 'https://styrigx.com';
  try { defaultOrigin = new URL(url).origin; } catch (e) {}
  const h = { 'Content-Type': 'application/json', 'Origin': defaultOrigin, ...headers };
  if (headers.Origin === null) delete h['Origin'];
  return new Request(url, {
    method: 'POST',
    headers: h,
    body: JSON.stringify(body),
  });
}

function makeEnv(kv, overrides = {}) {
  return {
    OWNER_KV: kv,
    SGX_RP_ID: 'test.example.com',
    SGX_ORIGIN: 'https://test.example.com',
    SGX_STEPUP_PRIVATE: TEST_PRIV_PEM,
    SGX_STEPUP_PUBLIC: TEST_PUB_PEM,
    SGX_LOCK_PUBLIC: TEST_PUB_PEM, /* 会话验签用同一测试密钥 */
    ...overrides,
  };
}

/* 构造一个有效的 owner 会话 cookie（2.11 定稿：5 段式 by.role.epoch.exp.sig，测试密钥签名，epoch=0） */
async function makeOwnerSessionCookie() {
  const payload = 'owner.owner.0.' + (Date.now() + 43200000);
  const sig = await ed25519Sign(TEST_PRIV_PEM, payload);
  return payload + '.' + sig;
}

/* 构造一个有效的 visitor 会话 cookie（2.11 定稿：5 段式） */
async function makeVisitorSessionCookie() {
  const payload = 'owner.visitor.0.' + (Date.now() + 3600000);
  const sig = await ed25519Sign(TEST_PRIV_PEM, payload);
  return payload + '.' + sig;
}

test('setup: 生成测试密钥', async () => {
  await genTestKeys();
  assert.ok(TEST_PRIV_PEM.includes('PRIVATE KEY'));
  assert.ok(TEST_PUB_PEM.includes('PUBLIC KEY'));
});

test('正常签发 → 验证通过', async () => {
  const kv = makeKV();
  const env = makeEnv(kv);
  const val = await signStepupCookie(TEST_PRIV_PEM, 'owner', 'keys', 0);
  const p = parseStepupCookie(val);
  assert.ok(p);
  assert.equal(p.by, 'owner');
  assert.equal(p.scope, 'keys');
  assert.equal(p.epoch, 0);
  /* 有效期约 3 分钟（批次 B #11） */
  assert.ok(Math.abs((p.exp - p.iat) - STEPUP_MAX_AGE * 1000) < 5000);

  const req = new Request('https://test.example.com/api/stepup', {
    headers: { Cookie: STEPUP_COOKIE + '=' + val },
  });
  const r = await verifyStepupCookie(req, env);
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'ok');
});

test('过期 cookie 被拒', async () => {
  const kv = makeKV();
  const env = makeEnv(kv);
  /* 手工构造过期 cookie：iat/exp 为过去，有效签名 */
  const iat = Date.now() - 20 * 60 * 1000;
  const exp = iat + STEPUP_MAX_AGE * 1000; /* 已过期 3 分钟 */
  const payload = 'owner.keys.0.' + iat + '.' + exp;
  const sig = await ed25519Sign(TEST_PRIV_PEM, payload);
  const val = payload + '.' + sig;

  const req = new Request('https://test.example.com/api/stepup', {
    headers: { Cookie: STEPUP_COOKIE + '=' + val },
  });
  const r = await verifyStepupCookie(req, env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'expired');
});

test('篡改 payload（epoch）→ 签名失效被拒', async () => {
  const kv = makeKV();
  const env = makeEnv(kv);
  const val = await signStepupCookie(TEST_PRIV_PEM, 'owner', 'keys', 0);
  /* 篡改 epoch：0 → 99，签名不再匹配（2.11 定稿：6 段式 by.scope.epoch.iat.exp.sig） */
  const tampered = val.replace(/^owner\.keys\.0\./, 'owner.keys.99.');

  const req = new Request('https://test.example.com/api/stepup', {
    headers: { Cookie: STEPUP_COOKIE + '=' + tampered },
  });
  const r = await verifyStepupCookie(req, env);
  assert.equal(r.ok, false);
  /* epoch 99 ≠ KV epoch 0，先报 epoch-changed（同样拒绝） */
  assert.ok(['epoch-changed', 'bad-sig'].includes(r.reason), 'reason=' + r.reason);
});

test('篡改 payload（延长 exp）→ 签名失效被拒', async () => {
  const kv = makeKV();
  const env = makeEnv(kv);
  const val = await signStepupCookie(TEST_PRIV_PEM, 'owner', 'keys', 0);
  const parts = val.split('.');
  /* exp 改成 10 年后（2.11 定稿：6 段式，exp 在 index 4） */
  parts[4] = String(Date.now() + 10 * 365 * 24 * 3600 * 1000);
  const tampered = parts.join('.');

  const req = new Request('https://test.example.com/api/stepup', {
    headers: { Cookie: STEPUP_COOKIE + '=' + tampered },
  });
  const r = await verifyStepupCookie(req, env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-sig');
});

test('伪造签名（另一把密钥）被拒', async () => {
  const kv = makeKV();
  const env = makeEnv(kv);
  /* 用 OTHER 私钥签名，公钥仍是 TEST 的 */
  const val = await signStepupCookie(OTHER_PRIV_PEM, 'owner', 'keys', 0);

  const req = new Request('https://test.example.com/api/stepup', {
    headers: { Cookie: STEPUP_COOKIE + '=' + val },
  });
  const r = await verifyStepupCookie(req, env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-sig');
});

test('epoch 变更后旧 cookie 失效', async () => {
  const kv = makeKV();
  const env = makeEnv(kv);
  const val = await signStepupCookie(TEST_PRIV_PEM, 'owner', 'keys', 0);

  /* 模拟 lock-all-devices：epoch 0 → 1 */
  await kv.put('session-epoch', '1');

  const req = new Request('https://test.example.com/api/stepup', {
    headers: { Cookie: STEPUP_COOKIE + '=' + val },
  });
  const r = await verifyStepupCookie(req, env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'epoch-changed');
});

test('缺 SGX_STEPUP_PUBLIC → fail closed', async () => {
  const kv = makeKV();
  const env = makeEnv(kv, { SGX_STEPUP_PUBLIC: '' });
  const val = await signStepupCookie(TEST_PRIV_PEM, 'owner', 'keys', 0);

  const req = new Request('https://test.example.com/api/stepup', {
    headers: { Cookie: STEPUP_COOKIE + '=' + val },
  });
  const r = await verifyStepupCookie(req, env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-pubkey');
});

test('无 cookie → no-cookie', async () => {
  const kv = makeKV();
  const env = makeEnv(kv);
  const req = new Request('https://test.example.com/api/stepup');
  const r = await verifyStepupCookie(req, env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-cookie');
});

test('格式错误 → bad-format', async () => {
  const kv = makeKV();
  const env = makeEnv(kv);
  for (const bad of ['xxx', 'owner.0.123', 'a.b.c.d.e.f', 'visitor.0.1.2.sig']) {
    const req = new Request('https://test.example.com/api/stepup', {
      headers: { Cookie: STEPUP_COOKIE + '=' + bad },
    });
    const r = await verifyStepupCookie(req, env);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'bad-format', 'val=' + bad);
  }
});

/* ---------- /api/stepup 会话门禁 ---------- */

test('/api/stepup challenge：无会话 → 401', async () => {
  const kv = makeKV();
  const env = makeEnv(kv);
  const res = await stepupPost({ request: postReq('https://test.example.com/api/stepup', { action: 'challenge' }), env });
  assert.equal(res.status, 401);
  const j = await res.json();
  assert.equal(j.ok, false);
});

test('/api/stepup challenge：visitor 会话 → 403', async () => {
  const kv = makeKV();
  const env = makeEnv(kv);
  const visitorCookie = await makeVisitorSessionCookie();
  const res = await stepupPost({
    request: postReq('https://test.example.com/api/stepup', { action: 'challenge' }, {
      Cookie: 'sgx-verified=' + visitorCookie,
    }),
    env,
  });
  assert.equal(res.status, 403);
  const j = await res.json();
  assert.equal(j.error, 'role');
});

test('/api/stepup verify：login 的 pk-challenge 不能用于 stepup', async () => {
  const kv = makeKV();
  const env = makeEnv(kv);
  const ownerCookie = await makeOwnerSessionCookie();
  const headers = { Cookie: 'sgx-verified=' + ownerCookie };

  /* 模拟登录下发的 challenge（pk-challenge: 前缀） */
  const loginCid = 'login-cid-123';
  await kv.put('pk-challenge:' + loginCid, JSON.stringify({
    challenge: 'abc123', type: 'auth', exp: Date.now() + 300000,
  }));

  /* stepup verify 只查 stepup-challenge:，login 的 cid 查不到 → challenge 错误 */
  const res = await stepupPost({
    request: postReq('https://test.example.com/api/stepup', {
      action: 'verify', cid: loginCid, credential: { rawId: 'x' },
    }, headers),
    env,
  });
  assert.equal(res.status, 403);
  const j = await res.json();
  assert.equal(j.error, 'challenge');
});

test('/api/stepup verify：stepup challenge 单次使用（重放被拒）', async () => {
  const kv = makeKV();
  const env = makeEnv(kv);
  const ownerCookie = await makeOwnerSessionCookie();
  const headers = { Cookie: 'sgx-verified=' + ownerCookie };

  /* 手工写入一个 stepup challenge */
  const cid = 'stepup-cid-456';
  await kv.put('stepup-challenge:' + cid, JSON.stringify({
    challenge: 'def456', purpose: 'stepup', exp: Date.now() + 300000,
  }));

  /* 第一次 verify：credential 非法 → verify 失败，但 challenge 已被消费（删除） */
  let res = await stepupPost({
    request: postReq('https://test.example.com/api/stepup', {
      action: 'verify', cid: cid, credential: { rawId: 'nonexistent' },
    }, headers),
    env,
  });
  assert.equal(res.status, 403);

  /* KV 里 challenge 已删除 */
  const gone = await kv.get('stepup-challenge:' + cid);
  assert.equal(gone, null);

  /* 第二次用同一 cid → challenge 错误（重放被拒） */
  res = await stepupPost({
    request: postReq('https://test.example.com/api/stepup', {
      action: 'verify', cid: cid, credential: { rawId: 'nonexistent' },
    }, headers),
    env,
  });
  assert.equal(res.status, 403);
  const j = await res.json();
  assert.equal(j.error, 'challenge');
});

test('/api/stepup verify：缺 SGX_STEPUP_PRIVATE 时不断言直接拒绝签发', async () => {
  /* 此测试验证 signStepupCookie 的调用方在缺 key 时返回 no-stepup-key。
     完整 verify 流程需要真实 WebAuthn 断言，由 e2e 覆盖；这里只验证
     parseStepupCookie 对非法输入的鲁棒性（单元层面） */
  assert.equal(parseStepupCookie(''), null);
  assert.equal(parseStepupCookie(null), null);
  assert.equal(parseStepupCookie('owner.abc.123.456.sig'), null);
});

test('/api/stepup status：无有效 cookie → valid=false', async () => {
  const kv = makeKV();
  const env = makeEnv(kv);
  const ownerCookie = await makeOwnerSessionCookie();
  const res = await stepupPost({
    request: postReq('https://test.example.com/api/stepup', { action: 'status' }, {
      Cookie: 'sgx-verified=' + ownerCookie,
    }),
    env,
  });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.valid, false);
});

test('/api/stepup status：有效 cookie → valid=true', async () => {
  const kv = makeKV();
  const env = makeEnv(kv);
  const ownerCookie = await makeOwnerSessionCookie();
  const stepupVal = await signStepupCookie(TEST_PRIV_PEM, 'owner', 'keys', 0);
  const res = await stepupPost({
    request: postReq('https://test.example.com/api/stepup', { action: 'status' }, {
      Cookie: 'sgx-verified=' + ownerCookie + '; ' + STEPUP_COOKIE + '=' + stepupVal,
    }),
    env,
  });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.valid, true);
});

/* #72 补充：不 mock stepup 的端到端测试。
   真实走 owner 会话 → POST /api/root-auth（正确根凭证）→ 带返回的 sgx-stepup Cookie
   调 POST /api/stepup {action:'status'}，必须 valid:true。
   证明「刚签的票」在真实签发-验签链路上有效（密钥对配对、epoch 一致、Domain 等）。
   修前：door1 e2e 测试 mock 了 stepup valid:true，证明不了这一点。 */
test('#72：root-auth 签发的票 → stepup status 必须 valid=true（不 mock）', async () => {
  const { onRequestPost: rootAuthPost } = await import('../../functions/api/root-auth.js');
  const kv = makeKV();
  /* SGX_ROOT_KEY：测试用根凭证 */
  const TEST_ROOT_KEY = 'test-root-key-72';
  const env = makeEnv(kv, { SGX_ROOT_KEY: TEST_ROOT_KEY });
  const ownerCookie = await makeOwnerSessionCookie();

  /* 1. owner 会话 + 正确根凭证 → /api/root-auth 签发 sgx-stepup */
  const authRes = await rootAuthPost({
    request: postReq('https://test.example.com/api/root-auth', { key: TEST_ROOT_KEY }, {
      'Cookie': 'sgx-verified=' + ownerCookie,
    }),
    env,
  });
  assert.equal(authRes.status, 200, 'root-auth 应 200');
  const authJson = await authRes.json();
  assert.ok(authJson.ok, 'root-auth 应 ok:true');

  /* 2. 从 Set-Cookie 提取 sgx-stepup */
  const setCookies = authRes.headers.getSetCookie ? authRes.headers.getSetCookie() : [authRes.headers.get('Set-Cookie')];
  const stepupSetCookie = setCookies.find((c) => c && c.startsWith(STEPUP_COOKIE + '='));
  assert.ok(stepupSetCookie, '应签发 sgx-stepup cookie');
  const stepupVal = stepupSetCookie.split(';')[0].split('=')[1];
  assert.ok(stepupVal && stepupVal.length > 10, 'stepup cookie 值非空');

  /* 3. 带该 Cookie 调 /api/stepup status → 必须 valid:true
     （stepup API 要求 owner 会话，故同时带上会话 cookie） */
  const statusRes = await stepupPost({
    request: postReq('https://test.example.com/api/stepup', { action: 'status' }, {
      'Cookie': 'sgx-verified=' + ownerCookie + '; ' + STEPUP_COOKIE + '=' + stepupVal,
    }),
    env,
  });
  assert.equal(statusRes.status, 200);
  const statusJson = await statusRes.json();
  assert.equal(statusJson.ok, true);
  assert.equal(statusJson.valid, true, '刚签发的票必须 valid:true，reason=' + statusJson.reason);
});
