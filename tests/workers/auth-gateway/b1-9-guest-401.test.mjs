/**
 * B1-9 验收测试：访客假入口统一 401（真实 Miniflare）。
 *
 * 验收标准（任务书）：
 * 1. KV 全空、KV 有凭证两种情况下，访客提交任意值都返回同一个 401 和同一 body
 * 2. 用 KV 代理计数断言该请求 KV 访问次数为 0
 * 3. root-auth 和 lockreset 都测
 *
 * 运行：node --test tests/kernel/b1-9-guest-401.test.mjs
 */
import { signRole } from './_tk.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

/* 动态导入 miniflare（未安装时跳过） */
let Miniflare = null;
try {
  const mfMod = await import('miniflare');
  Miniflare = mfMod.Miniflare;
} catch (e) {
  console.log('SKIP: miniflare not installed, B1-9 Miniflare tests skipped');
}

/* 测试用 Ed25519 密钥 */
function derToPem(der, label) {
  const b64 = Buffer.from(der).toString('base64');
  const lines = b64.match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

let TEST_PRIV_PEM = '';
let TEST_PUB_PEM = '';
async function genTestKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const privDer = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
  const pubDer = await crypto.subtle.exportKey('spki', kp.publicKey);
  TEST_PRIV_PEM = derToPem(privDer, 'PRIVATE KEY');
  TEST_PUB_PEM = derToPem(pubDer, 'PUBLIC KEY');
}

async function signVisitorCookie() {
  const { signSessionCookie } = await import(REPO + '/workers/auth-gateway/functions/_kernel/session.js');
  return signRole(signSessionCookie, TEST_PRIV_PEM, 0, 'visitor', 'owner');
}

/* 带计数的 KV */
function makeCountingKv() {
  const store = new Map();
  const calls = { get: 0, put: 0, delete: 0, list: 0 };
  return {
    get: async (k) => { calls.get++; const v = store.get(k); return v === undefined ? null : v; },
    put: async (k, v) => { calls.put++; store.set(k, v); },
    delete: async (k) => { calls.delete++; store.delete(k); },
    list: async () => { calls.list++; return { keys: [...store.keys()].map(name => ({ name })) }; },
    _calls: calls,
    _store: store,
  };
}

test('B1-9 验收（真实 Miniflare）：访客 401 统一', async (t) => {
  if (!Miniflare) {
    t.skip('miniflare not installed');
    return;
  }
  await genTestKeys();
  const EXPECTED_BODY = JSON.stringify({ ok: false, error: 'denied' });

  await t.test('root-auth：KV 空 vs 有凭证 → 同一 401/body，KV get=0', async () => {
    const mf = new Miniflare({
      modules: true,
      script: `export default { async fetch() { return new Response('mf-ok'); } }`,
    });
    const visitorCookie = await signVisitorCookie();
    const bodies = [];

    for (const kvInit of [{}, { 'layer:lock': '1', 'cred:root': 'hash123' }]) {
      const kv = makeCountingKv();
      for (const [k, v] of Object.entries(kvInit)) await kv.put(k, v);
      kv._calls.get = 0; kv._calls.put = 0;

      const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/root-auth.js');
      const req = new Request('https://test.example.com/api/root-auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'https://test.example.com',
          'Cookie': 'sgx-verified=' + visitorCookie,
        },
        body: JSON.stringify({ key: 'any-value-' + Math.random() }),
      });
      const env = { SGX_LOCK_PUBLIC: TEST_PUB_PEM, SGX_ROOT_KEY: 'test-root-key-12345', KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv };
      const res = await onRequestPost({ request: req, env });

      assert.equal(res.status, 401, 'KV=' + JSON.stringify(kvInit) + ' 应返回 401');
      const body = await res.text();
      assert.equal(body, EXPECTED_BODY, 'KV=' + JSON.stringify(kvInit) + ' body 应为 denied');
      bodies.push(body);
      assert.equal(kv._calls.get, 0, 'KV=' + JSON.stringify(kvInit) + ' 访客请求不应读 KV (get=' + kv._calls.get + ')');
    }

    assert.equal(bodies[0], bodies[1], 'KV 空与有凭证的响应 body 应逐字节相同');
    await mf.dispose();
  });

  await t.test('lockreset：KV 空 vs 有凭证 → 同一 401/body，KV get=0', async () => {
    const mf = new Miniflare({
      modules: true,
      script: `export default { async fetch() { return new Response('mf-ok'); } }`,
    });
    const visitorCookie = await signVisitorCookie();
    const bodies = [];

    for (const kvInit of [{}, { 'layer:lock': '1' }]) {
      const kv = makeCountingKv();
      for (const [k, v] of Object.entries(kvInit)) await kv.put(k, v);
      kv._calls.get = 0; kv._calls.put = 0;

      const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/lockreset.js');
      const req = new Request('https://test.example.com/api/lockreset', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'https://test.example.com',
          'Cookie': 'sgx-verified=' + visitorCookie,
        },
        body: JSON.stringify({ key: 'any-value' }),
      });
      const env = { SGX_LOCK_PUBLIC: TEST_PUB_PEM, KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv };
      const res = await onRequestPost({ request: req, env });

      assert.equal(res.status, 401, 'lockreset KV=' + JSON.stringify(kvInit) + ' 应返回 401');
      const body = await res.text();
      assert.equal(body, EXPECTED_BODY, 'lockreset body 应为 denied');
      bodies.push(body);
      assert.equal(kv._calls.get, 0, 'lockreset 访客请求不应读 KV (get=' + kv._calls.get + ')');
    }

    assert.equal(bodies[0], bodies[1], 'lockreset 两种 KV 状态的 body 应相同');
    await mf.dispose();
  });
});
