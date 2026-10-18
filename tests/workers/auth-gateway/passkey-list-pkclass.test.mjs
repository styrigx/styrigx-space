/**
 * 批次 A 验收修复 P0：list 类别由页面决定（tests/kernel）。
 *
 * 覆盖：
 * - list 必须显式传 pkClass；缺失/非法 → 400 params
 * - keys 票 + pkClass=lock → 只返回 lock 类
 * - keys 票 + pkClass=app（无 aud）→ 返回全部 app 类；带 aud=book → 只返回 book 的
 * - keys 票 + pkClass=app + aud=evil（不在白名单）→ 400 aud
 * - keys 票 + pkClass=owner → 403 scope
 * - root 代管票（by=root, scope=root）+ owner 未配置 → list lock 成功；
 *   代管中途站长层被配置 → 403 scope + reason=owner-configured
 * - keys 代管票（by=root, scope=keys）+ owner 已配置 → 403 scope + reason=owner-configured
 * - lockreset 票 + pkClass=lock → 成功；+ pkClass=app → 403 scope
 *
 * 运行：node --test tests/kernel/passkey-list-pkclass.test.mjs
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
    list: async () => ({ keys: [...m.keys()].map((name) => ({ name })) }),
    _map: m,
  };
}

function postReq(url, body, headers = {}) {
  const h = { 'Content-Type': 'application/json', Origin: 'https://styrigx.com', ...headers };
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
async function mintStepup(by, scope, epoch = 0) {
  const { signStepupCookie } = await import('../../../workers/auth-gateway/functions/api/stepup.js');
  return await signStepupCookie(STEPUP_PRIV, by, scope, epoch);
}
async function mintSession(by = 'owner', epoch = 0) {
  const { signSessionCookie } = await import('../../../workers/auth-gateway/functions/_kernel/session.js');
  return await signSessionCookie(LOCK_PRIV, epoch, 'owner', by);
}
const envFor = (kv) => ({
  OWNER_KV: kv,
  SGX_LOCK_PRIVATE: LOCK_PRIV,
  SGX_LOCK_PUBLIC: LOCK_PUB,
  SGX_STEPUP_PRIVATE: STEPUP_PRIV,
  SGX_STEPUP_PUBLIC: STEPUP_PUB,
  SGX_RP_ID: 'styrigx.com',
  SGX_ORIGIN: 'https://styrigx.com',
});
const bothCookies = (s, t) => ({ Cookie: 'sgx-verified=' + s + '; sgx-stepup=' + t });

async function seedKey(kv, { credId, cls = 'lock', aud = '' }) {
  const rec = {
    name: 'test', provider: '', aaguid: '', createdAt: 1, lastUsedAt: 0,
    credId, publicKey: {}, signCount: 0, uv: 1, class: cls,
  };
  if (aud) rec.aud = aud;
  await kv.put('owner-passkey:' + credId.slice(0, 12), JSON.stringify(rec));
}
async function seedAll(kv) {
  await seedKey(kv, { credId: 'lock-key-001', cls: 'lock' });
  await seedKey(kv, { credId: 'owner-key-01', cls: 'owner' });
  await seedKey(kv, { credId: 'app-key-book', cls: 'app', aud: 'book' });
  await kv.put('owner-passkey-index', JSON.stringify(['lock-key-001', 'owner-key-01', 'app-key-book']));
}
async function listAs(kv, body, sessBy, stepupBy, stepupScope) {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/owner-passkey.js');
  const sess = await mintSession(sessBy);
  const sc = await mintStepup(stepupBy, stepupScope);
  const r = await onRequestPost({
    request: postReq('https://styrigx.com/api/owner-passkey', body, bothCookies(sess, sc)),
    env: envFor(kv),
  });
  return { status: r.status, json: await r.json() };
}

test('setup: 生成测试密钥', async () => {
  await genKeys();
  assert.ok(STEPUP_PRIV.includes('PRIVATE KEY'));
});

test('list 缺 pkClass / 非法 pkClass → 400 params', async () => {
  const kv = makeKV();
  await seedAll(kv);
  for (const body of [{ action: 'list' }, { action: 'list', pkClass: 'bogus' }]) {
    const { status, json } = await listAs(kv, body, 'owner', 'owner', 'keys');
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(json.error, 'params');
  }
});

test('keys 票 + pkClass=lock → 只返回 lock 类', async () => {
  const kv = makeKV();
  await seedAll(kv);
  const { status, json } = await listAs(kv, { action: 'list', pkClass: 'lock' }, 'owner', 'owner', 'keys');
  assert.equal(status, 200);
  assert.ok(json.ok);
  assert.deepEqual(json.keys.map((k) => k.credId), ['lock-key-001']);
});

test('keys 票 + pkClass=app：无 aud 返回全部 app 类；aud=book 只返回 book', async () => {
  const kv = makeKV();
  await seedAll(kv);
  const all = await listAs(kv, { action: 'list', pkClass: 'app' }, 'owner', 'owner', 'keys');
  assert.equal(all.status, 200);
  assert.deepEqual(all.json.keys.map((k) => k.credId), ['app-key-book']);
  const book = await listAs(kv, { action: 'list', pkClass: 'app', aud: 'book' }, 'owner', 'owner', 'keys');
  assert.equal(book.status, 200);
  assert.deepEqual(book.json.keys.map((k) => k.credId), ['app-key-book']);
});

test('keys 票 + pkClass=app + aud=evil → 400 aud', async () => {
  const kv = makeKV();
  await seedAll(kv);
  const { status, json } = await listAs(kv, { action: 'list', pkClass: 'app', aud: 'evil' }, 'owner', 'owner', 'keys');
  assert.equal(status, 400);
  assert.equal(json.error, 'aud');
});

test('keys 票 + pkClass=owner → 403 scope（不附 owner-configured）', async () => {
  const kv = makeKV();
  await seedAll(kv);
  const { status, json } = await listAs(kv, { action: 'list', pkClass: 'owner' }, 'owner', 'owner', 'keys');
  assert.equal(status, 403);
  assert.equal(json.error, 'scope');
  assert.equal(json.reason, undefined);
});

test('root 代管票 + owner 未配置 → list lock 成功；站长层被配置后 → 403 scope + reason=owner-configured', async () => {
  const kv = makeKV();
  await seedAll(kv);
  const env = envFor(kv);
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/owner-passkey.js');
  const { setLayerConfigured, LAYER_OWNER } = await import('../../../workers/auth-gateway/functions/_kernel/layers.js');
  const sess = await mintSession('owner');
  const sc = await mintStepup('root', 'root');
  const call = async () => {
    const r = await onRequestPost({
      request: postReq('https://styrigx.com/api/owner-passkey', { action: 'list', pkClass: 'lock' }, bothCookies(sess, sc)),
      env,
    });
    return { status: r.status, json: await r.json() };
  };
  const before = await call();
  assert.equal(before.status, 200, '代管中 list lock 应成功');
  assert.deepEqual(before.json.keys.map((k) => k.credId), ['lock-key-001']);
  /* 代管中途站长层被配置（另一设备配了站长凭证） */
  await setLayerConfigured(kv, LAYER_OWNER);
  const after = await call();
  assert.equal(after.status, 403);
  assert.equal(after.json.error, 'scope');
  assert.equal(after.json.reason, 'owner-configured');
});

test('keys 代管票（by=root）+ owner 已配置 → 403 scope + reason=owner-configured', async () => {
  const kv = makeKV();
  await seedAll(kv);
  const { setLayerConfigured, LAYER_OWNER } = await import('../../../workers/auth-gateway/functions/_kernel/layers.js');
  await setLayerConfigured(kv, LAYER_OWNER);
  const { status, json } = await listAs(kv, { action: 'list', pkClass: 'lock' }, 'owner', 'root', 'keys');
  assert.equal(status, 403);
  assert.equal(json.error, 'scope');
  assert.equal(json.reason, 'owner-configured');
});

test('lockreset 票 + pkClass=lock → 成功；+ pkClass=app → 403 scope', async () => {
  const kv = makeKV();
  await seedAll(kv);
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/owner-passkey.js');
  /* lockreset 票无会话：checkPasskeyMgmt 直接放行 lock list */
  const sc = await mintStepup('owner+root', 'lockreset');
  for (const [body, want] of [
    [{ action: 'list', pkClass: 'lock' }, 200],
    [{ action: 'list', pkClass: 'app' }, 403],
  ]) {
    const r = await onRequestPost({
      request: postReq('https://styrigx.com/api/owner-passkey', body, { Cookie: 'sgx-stepup=' + sc }),
      env: envFor(kv),
    });
    assert.equal(r.status, want, JSON.stringify(body));
    if (want === 200) {
      assert.deepEqual((await r.json()).keys.map((k) => k.credId), ['lock-key-001']);
    }
  }
});

test('root 票 + pkClass=owner → 只返回 owner 类', async () => {
  const kv = makeKV();
  await seedAll(kv);
  const { status, json } = await listAs(kv, { action: 'list', pkClass: 'owner' }, 'owner', 'root', 'root');
  assert.equal(status, 200);
  assert.deepEqual(json.keys.map((k) => k.credId), ['owner-key-01']);
});
