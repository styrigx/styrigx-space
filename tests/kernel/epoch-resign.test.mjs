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

let STEPUP_PRIV = '', STEPUP_PUB = '', LOCK_PRIV = '', LOCK_PUB = '';
function derToPem(der, label) {
  const b64 = Buffer.from(der).toString('base64');
  const lines = b64.match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}
async function genKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  STEPUP_PRIV = derToPem(await crypto.subtle.exportKey('pkcs8', kp.privateKey), 'PRIVATE KEY');
  STEPUP_PUB = derToPem(await crypto.subtle.exportKey('spki', kp.publicKey), 'PUBLIC KEY');
  const kp2 = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  LOCK_PRIV = derToPem(await crypto.subtle.exportKey('pkcs8', kp2.privateKey), 'PRIVATE KEY');
  LOCK_PUB = derToPem(await crypto.subtle.exportKey('spki', kp2.publicKey), 'PUBLIC KEY');
}

const testEnv = (kv) => ({
  OWNER_KV: kv,
  SGX_LOCK_PRIVATE: LOCK_PRIV,
  SGX_LOCK_PUBLIC: LOCK_PUB,
  SGX_STEPUP_PRIVATE: STEPUP_PRIV,
  SGX_STEPUP_PUBLIC: STEPUP_PUB,
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
  assert.ok(STEPUP_PRIV.includes('PRIVATE KEY'));
});

test('D1：删 owner 类钥匙不推进 session-epoch', async () => {
  const { onRequestPost } = await import('../../functions/api/owner-passkey.js');
  const { signStepupCookie } = await import('../../functions/api/stepup.js');
  const { signSessionCookie } = await import('../../functions/_kernel/session.js');
  const kv = makeKV({ 'session-epoch': '5' });
  await seedKey(kv, { credId: 'owner-key-001', cls: 'owner' });
  /* owner 层已配置标记（避免删光后清标记影响） */
  await kv.put('layer:owner', '1');
  /* 站长密码也存在（删光钥匙后仍有密码，层标记不被清） */
  await kv.put('owner-pw', JSON.stringify({ hash: 'x', salt: 'y', iterations: 100000 }));

  const sess = await signSessionCookie(LOCK_PRIV, 5, 'owner', 'owner');
  const stepup = await signStepupCookie(STEPUP_PRIV, 'root', 'root', 5);
  const r = await onRequestPost({
    request: postReq('https://styrigx.com/api/owner-passkey',
      { action: 'delete', credId: 'owner-key-001' },
      { Cookie: 'sgx-verified=' + sess + '; sgx-stepup=' + stepup }),
    env: testEnv(kv),
  });
  assert.equal(r.status, 200, '删 ownerkey 应成功');
  const j = await r.json();
  assert.equal(j.ok, true);
  /* D1：epoch 不变 */
  assert.equal(await kv.get('session-epoch'), '5', '删 ownerkey 不应推进 session-epoch');
  /* D1：无新会话 cookie（无需重签） */
  assert.equal(extractSessionCookie(r), null, '删 ownerkey 不应重签会话');
});

test('D1+D4：删光 ownerkey 后设置站长密码成功（不 401 session）', async () => {
  const { onRequestPost: pkPost } = await import('../../functions/api/owner-passkey.js');
  const { onRequestPost: pwPost } = await import('../../functions/api/owner-password.js');
  const { signStepupCookie } = await import('../../functions/api/stepup.js');
  const { signSessionCookie } = await import('../../functions/_kernel/session.js');
  const kv = makeKV({ 'session-epoch': '5' });
  await seedKey(kv, { credId: 'owner-key-001', cls: 'owner' });
  await kv.put('layer:owner', '1');

  const sess = await signSessionCookie(LOCK_PRIV, 5, 'owner', 'owner');
  const stepup = await signStepupCookie(STEPUP_PRIV, 'root', 'root', 5);
  /* 删掉唯一 ownerkey（无 owner 密码 → 层标记被清，但 epoch 不变） */
  const rDel = await pkPost({
    request: postReq('https://styrigx.com/api/owner-passkey',
      { action: 'delete', credId: 'owner-key-001' },
      { Cookie: 'sgx-verified=' + sess + '; sgx-stepup=' + stepup }),
    env: testEnv(kv),
  });
  assert.equal((await rDel.json()).ok, true);
  assert.equal(await kv.get('session-epoch'), '5');

  /* 同一次进门：设置站长密码（stepup 仍有效，会话仍有效） */
  const rSet = await pwPost({
    request: postReq('https://styrigx.com/api/owner-password',
      { action: 'set', kind: 'owner', password: 'new-owner-pw-123' },
      { Cookie: 'sgx-verified=' + sess + '; sgx-stepup=' + stepup }),
    env: testEnv(kv),
  });
  const jSet = await rSet.json();
  assert.equal(rSet.status, 200, '设置站长密码不应 401 session，实际：' + JSON.stringify(jSet));
  assert.equal(jSet.ok, true);
});

test('D2：删 lock 类钥匙推进 epoch 并重签当前设备会话', async () => {
  const { onRequestPost } = await import('../../functions/api/owner-passkey.js');
  const { signStepupCookie } = await import('../../functions/api/stepup.js');
  const { signSessionCookie, parseSessionCookie } = await import('../../functions/_kernel/session.js');
  const { verifySessionDetailed } = await import('../../functions/_middleware.js');
  const kv = makeKV({ 'session-epoch': '5' });
  await seedKey(kv, { credId: 'lock-key-001', cls: 'lock' });
  await seedKey(kv, { credId: 'lock-key-002', cls: 'lock' });
  await kv.put('layer:lock', '1');
  await kv.put('lock-pw', JSON.stringify({ hash: 'x', salt: 'y', iterations: 100000 }));

  const sess = await signSessionCookie(LOCK_PRIV, 5, 'owner', 'owner');
  const stepup = await signStepupCookie(STEPUP_PRIV, 'owner', 'keys', 5);
  const r = await onRequestPost({
    request: postReq('https://styrigx.com/api/owner-passkey',
      { action: 'delete', credId: 'lock-key-001' },
      { Cookie: 'sgx-verified=' + sess + '; sgx-stepup=' + stepup }),
    env: testEnv(kv),
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  /* D2：epoch +1（踢掉其他设备） */
  assert.equal(await kv.get('session-epoch'), '6');
  /* D2：同响应重签当前设备会话，新 cookie 用新 epoch */
  const newSess = extractSessionCookie(r);
  assert.ok(newSess, '删 lockkey 应重签当前设备会话');
  const parsed = parseSessionCookie(newSess);
  assert.equal(parsed.epoch, 6, '新会话 cookie 应为新 epoch');
  assert.equal(parsed.by, 'owner');
  assert.equal(parsed.role, 'owner');
  /* 新会话验签通过 */
  const v = await verifySessionDetailed(
    new Request('https://styrigx.com/', { headers: { Cookie: 'sgx-verified=' + newSess } }),
    testEnv(kv)
  );
  assert.equal(v.ok, true, '新会话应验签通过');
});

test('D2：owner-password remove 推进 epoch 后重签当前设备会话', async () => {
  const { onRequestPost } = await import('../../functions/api/owner-password.js');
  const { signStepupCookie } = await import('../../functions/api/stepup.js');
  const { signSessionCookie, parseSessionCookie } = await import('../../functions/_kernel/session.js');
  const kv = makeKV({ 'session-epoch': '5' });
  await kv.put('layer:owner', '1');
  await kv.put('owner-pw', JSON.stringify({ hash: 'x', salt: 'y', iterations: 100000 }));
  await seedKey(kv, { credId: 'owner-key-001', cls: 'owner' });

  const sess = await signSessionCookie(LOCK_PRIV, 5, 'owner', 'owner');
  const stepup = await signStepupCookie(STEPUP_PRIV, 'root', 'root', 5);
  const r = await onRequestPost({
    request: postReq('https://styrigx.com/api/owner-password',
      { action: 'remove', kind: 'owner' },
      { Cookie: 'sgx-verified=' + sess + '; sgx-stepup=' + stepup }),
    env: testEnv(kv),
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  assert.equal(await kv.get('session-epoch'), '6');
  const newSess = extractSessionCookie(r);
  assert.ok(newSess, '删 owner 密码应重签当前设备会话');
  assert.equal(parseSessionCookie(newSess).epoch, 6);
});

test('退出所有设备仍清当前 cookie（保持不变）', async () => {
  const { onRequestPost } = await import('../../functions/api/lock-all-devices.js');
  const { signStepupCookie } = await import('../../functions/api/stepup.js');
  const { signSessionCookie } = await import('../../functions/_kernel/session.js');
  const kv = makeKV({ 'session-epoch': '5' });
  await kv.put('layer:owner', '1');
  await kv.put('layer:lock', '1');

  const sess = await signSessionCookie(LOCK_PRIV, 5, 'owner', 'owner');
  const stepup = await signStepupCookie(STEPUP_PRIV, 'owner', 'keys', 5);
  const r = await onRequestPost({
    request: postReq('https://styrigx.com/api/lock-all-devices', {},
      { Cookie: 'sgx-verified=' + sess + '; sgx-stepup=' + stepup }),
    env: testEnv(kv),
  });
  assert.equal(r.status, 200);
  assert.equal(await kv.get('session-epoch'), '6');
  /* 清 cookie：Set-Cookie 为空值 + Max-Age=0 */
  const setCookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  const cleared = setCookies.some((c) => c.startsWith('sgx-verified=;') && c.includes('Max-Age=0'));
  assert.equal(cleared, true, '退出所有设备应清当前 cookie');
});
