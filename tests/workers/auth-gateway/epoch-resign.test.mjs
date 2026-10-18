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
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/owner-passkey.js');
  const { signStepupCookie } = await import('../../../workers/auth-gateway/functions/api/stepup.js');
  const { signSessionCookie } = await import('../../../workers/auth-gateway/functions/_kernel/session.js');
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
  const { onRequestPost: pkPost } = await import('../../../workers/auth-gateway/functions/api/owner-passkey.js');
  const { onRequestPost: pwPost } = await import('../../../workers/auth-gateway/functions/api/owner-password.js');
  const { signStepupCookie } = await import('../../../workers/auth-gateway/functions/api/stepup.js');
  const { signSessionCookie } = await import('../../../workers/auth-gateway/functions/_kernel/session.js');
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
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/owner-passkey.js');
  const { signStepupCookie } = await import('../../../workers/auth-gateway/functions/api/stepup.js');
  const { signSessionCookie, parseSessionCookie } = await import('../../../workers/auth-gateway/functions/_kernel/session.js');
  const { verifySessionDetailed } = await import('../../../workers/auth-gateway/functions/_middleware.js');
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
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/owner-password.js');
  const { signStepupCookie } = await import('../../../workers/auth-gateway/functions/api/stepup.js');
  const { signSessionCookie, parseSessionCookie } = await import('../../../workers/auth-gateway/functions/_kernel/session.js');
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
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/lock-all-devices.js');
  const { signStepupCookie } = await import('../../../workers/auth-gateway/functions/api/stepup.js');
  const { signSessionCookie } = await import('../../../workers/auth-gateway/functions/_kernel/session.js');
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

test('必修安全项 1：by=root, scope=keys 票不重签（首次配 owner 的 epoch bump 不被抵消）', async () => {
  const { reissueStepupWithEpoch, signStepupCookie, verifyStepupCookie } = await import('../../../workers/auth-gateway/functions/api/stepup.js');
  const kv = makeKV({ 'session-epoch': '5' });
  /* by=root, scope=keys 票（epoch 5） */
  const ticket = await signStepupCookie(STEPUP_PRIV, 'root', 'keys', 5);
  /* epoch bump 到 6（模拟首次配 owner） */
  await kv.put('session-epoch', '6');
  /* helper 应跳过，不发新 cookie */
  const headers = new Headers();
  await reissueStepupWithEpoch(testEnv(kv), headers, { ok: true, by: 'root', scope: 'keys' }, 6);
  const setCookies = headers.getSetCookie ? headers.getSetCookie() : [];
  const reissued = setCookies.some((c) => c.startsWith('sgx-stepup=') && !c.startsWith('sgx-stepup=;'));
  assert.equal(reissued, false, 'by=root, scope=keys 票不应重签');
  /* 旧票验签失败（epoch 已变） */
  const v = await verifyStepupCookie(
    new Request('https://styrigx.com/', { headers: { Cookie: 'sgx-stepup=' + ticket } }),
    testEnv(kv)
  );
  assert.equal(v.ok, false, '旧 by=root, scope=keys 票应在 epoch bump 后失效');
});

test('D2 保持：by=owner 会话 + 删 lockkey / 改密码 → 当前设备仍 200', async () => {
  const { reissueSessionWithEpoch } = await import('../../../workers/auth-gateway/functions/_kernel/session.js');
  const { reissueStepupWithEpoch } = await import('../../../workers/auth-gateway/functions/api/stepup.js');
  const { signSessionCookie, parseSessionCookie } = await import('../../../workers/auth-gateway/functions/_kernel/session.js');
  const { verifySessionDetailed } = await import('../../../workers/auth-gateway/functions/_middleware.js');
  const kv = makeKV({ 'session-epoch': '5' });
  /* by=owner 正常会话 */
  const ownerSess = await signSessionCookie(LOCK_PRIV, 5, 'owner', 'owner');
  /* epoch bump 到 6（模拟删 lockkey / 改密码） */
  await kv.put('session-epoch', '6');
  /* helper 应重签 */
  const headers = new Headers();
  await reissueSessionWithEpoch(testEnv(kv), headers, { ok: true, by: 'owner', role: 'owner' }, 6);
  const setCookies = headers.getSetCookie ? headers.getSetCookie() : [];
  const newSess = extractSessionCookie({ headers: { getSetCookie: () => setCookies } });
  assert.ok(newSess, 'by=owner 会话应重签');
  assert.equal(parseSessionCookie(newSess).epoch, 6, '新会话应为新 epoch');
  assert.equal(parseSessionCookie(newSess).by, 'owner');
  /* 新会话 session-check 200 */
  const v = await verifySessionDetailed(
    new Request('https://styrigx.com/', { headers: { Cookie: 'sgx-verified=' + newSess } }),
    testEnv(kv)
  );
  assert.equal(v.ok, true, '重签后的 by=owner 会话应验签通过');
  /* by=owner, scope=keys 票也应重签（D2 保持门内连续操作） */
  const headers2 = new Headers();
  await reissueStepupWithEpoch(testEnv(kv), headers2, { ok: true, by: 'owner', scope: 'keys' }, 6);
  const setCookies2 = headers2.getSetCookie ? headers2.getSetCookie() : [];
  const reissued2 = setCookies2.some((c) => c.startsWith('sgx-stepup=') && !c.startsWith('sgx-stepup=;'));
  assert.equal(reissued2, true, 'by=owner, scope=keys 票应重签');
  /* 旧 by=owner 会话失效（epoch 已变），但新会话有效 */
  const vOld = await verifySessionDetailed(
    new Request('https://styrigx.com/', { headers: { Cookie: 'sgx-verified=' + ownerSess } }),
    testEnv(kv)
  );
  assert.equal(vOld.ok, false, '旧 by=owner 会话应在 epoch bump 后失效（新会话接替）');
});
