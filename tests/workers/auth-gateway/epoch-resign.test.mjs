/**
 * v1.1 D1/D2：删钥匙不踢当前设备（space）。
 *
 * 覆盖：
 * - D1：删 owner 类钥匙不推进 session-epoch；之后设置站长密码成功（不 401 session）
 * - D2：删 lock 类钥匙推进 session-epoch +1，但同响应重签当前设备会话；
 *      新会话 cookie 用新 epoch 验签通过（session-check 200）
 * - D2：owner-password remove/set/change 推进 epoch 后同样重签当前设备会话
 * - 退出所有设备（lock-all-devices）仍清当前 cookie（保持不变）
 *
 * 运行：node --test tests/kernel/epoch-resign.test.mjs
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

let LOCK_PRIV = '', LOCK_PUB = '';
function derToPem(der, label) {
  const b64 = Buffer.from(der).toString('base64');
  const lines = b64.match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}
async function genKeys() {
  const kp2 = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  LOCK_PRIV = derToPem(await crypto.subtle.exportKey('pkcs8', kp2.privateKey), 'PRIVATE KEY');
  LOCK_PUB = derToPem(await crypto.subtle.exportKey('spki', kp2.publicKey), 'PUBLIC KEY');
}

const testEnv = (kv) => ({
  KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv,
  SGX_LOCK_PRIVATE: LOCK_PRIV,
  SGX_LOCK_PUBLIC: LOCK_PUB,
  SGX_RP_ID: 'styrigx.com',
  SGX_ORIGIN: 'https://styrigx.com',
  SGX_PW_PEPPER: 'test-pepper',
});

async function seedKey(kv, { credId, cls = 'lock', aud = '' }) {
  const rec = {
    name: 'test', provider: '', aaguid: '', createdAt: 1, lastUsedAt: 0,
    credId, publicKey: {}, signCount: 0, uv: 1, class: cls,
  };
  if (aud) rec.aud = aud;
  await kv.put('owner-passkey:' + credId.slice(0, 12), JSON.stringify(rec));
  const idx = JSON.parse((await kv.get('owner-passkey-index')) || '[]');
  if (!idx.includes(credId)) idx.push(credId);
  await kv.put('owner-passkey-index', JSON.stringify(idx));
}

/** 从 Set-Cookie 头中取 sgx-verified 值 */
function extractSessionCookie(res) {
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of setCookies) {
    if (c.startsWith('sgx-verified=')) {
      return c.split(';')[0].split('=')[1];
    }
  }
  return null;
}

test('setup: 生成测试密钥', async () => {
  await genKeys();
  assert.ok(LOCK_PRIV.includes('PRIVATE KEY'));
});





/* ============ 审查返工：必修安全项 1/2，helper 层跳过 by=root ============ */

test('必修安全项 2：by=root 会话不重签（首次配 lock 的 epoch bump 不被抵消）', async () => {
  const { reissueSessionWithEpoch } = await import('../../../workers/auth-gateway/functions/_kernel/session.js');
  const { signSessionCookie } = await import('../../../workers/auth-gateway/functions/_kernel/session.js');
  const { verifySessionDetailed } = await import('../../../workers/auth-gateway/functions/_middleware.js');
  const kv = makeKV({ 'session-epoch': '5' });
  /* by=root 代开会话（epoch 5） */
  const rootSess = await signSessionCookie(LOCK_PRIV, 5, 'owner', 'root');
  /* epoch bump 到 6（模拟首次配 lock） */
  await kv.put('session-epoch', '6');
  /* helper 应跳过，不发新 cookie */
  const headers = new Headers();
  await reissueSessionWithEpoch(testEnv(kv), headers, { ok: true, by: 'root', role: 'owner' }, 6);
  const setCookies = headers.getSetCookie ? headers.getSetCookie() : [];
  const reissued = setCookies.some((c) => c.startsWith('sgx-verified=') && !c.startsWith('sgx-verified=;'));
  assert.equal(reissued, false, 'by=root 会话不应重签');
  /* 旧会话 session-check 401（epoch 已变） */
  const v = await verifySessionDetailed(
    new Request('https://styrigx.com/', { headers: { Cookie: 'sgx-verified=' + rootSess } }),
    testEnv(kv)
  );
  assert.equal(v.ok, false, '旧 by=root 会话应在 epoch bump 后失效');
});


