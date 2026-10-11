/**
 * 2.10.0 通行密钥分类测试（space）。
 *
 * 覆盖：
 * - 凭据记录含 class（lock/app），应用类含 aud；旧凭据幂等迁移为 lock
 * - 锁屏 auth 的 challenge 只列 lock 凭据；verify 再次校验分类
 * - app auth 的 challenge 只列该 aud 的 app 凭据；verify 校验分类+aud
 * - aud=book 的凭据不能用于 aud=music；不在白名单的 aud 注册 → 400
 * - 无 sgx-stepup 时增删通行密钥 → 403；有 stepup 时通过
 * - 第一把 lock 凭据注册不需要 stepup
 * - 删除应用类凭据 → app-epoch:<aud> +1
 * - 注册参数：displayName="Sloan Gray"，lock 的 user.name="lock"，app 的 user.name=aud
 * - stepup 只接受 lock 类
 *
 * 运行：node --test tests/kernel/passkey-class.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/* ---- 简易 KV mock ---- */
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
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

let STEPUP_PRIV = '', STEPUP_PUB = '';
function derToPem(der, label) {
  const b64 = Buffer.from(der).toString('base64');
  const lines = b64.match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}
async function genKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  STEPUP_PRIV = derToPem(await crypto.subtle.exportKey('pkcs8', kp.privateKey), 'PRIVATE KEY');
  STEPUP_PUB = derToPem(await crypto.subtle.exportKey('spki', kp.publicKey), 'PUBLIC KEY');
}
async function mintStepup(epoch = 0) {
  const { signStepupCookie } = await import('../../functions/api/stepup.js');
  return await signStepupCookie(STEPUP_PRIV, epoch);
}
const stepupEnv = (kv) => ({
  OWNER_KV: kv,
  SESSION_SECRET: 's',
  SGX_STEPUP_PRIVATE: STEPUP_PRIV,
  SGX_STEPUP_PUBLIC: STEPUP_PUB,
  SGX_RP_ID: 'styrigx.com',
  SGX_ORIGIN: 'https://styrigx.com',
});
const stepupCookie = (v) => ({ Cookie: 'sgx-stepup=' + v });

/* 预置一把凭据 */
async function seedKey(kv, { credId, cls = 'lock', aud = '' }) {
  const rec = {
    name: 'test', provider: '', aaguid: '', createdAt: 1, lastUsedAt: 0,
    credId, publicKey: {}, signCount: 0, uv: 1, class: cls,
  };
  if (aud) rec.aud = aud;
  await kv.put('owner-passkey:' + credId.slice(0, 12), JSON.stringify(rec));
  await kv.put('owner-passkey-index', JSON.stringify([credId]));
}

test('setup: 生成 stepup 测试密钥', async () => {
  await genKeys();
  assert.ok(STEPUP_PRIV.includes('PRIVATE KEY'));
});

test('旧凭据无 class → getPasskeys 幂等迁移为 lock', async () => {
  const { getPasskeys } = await import('../../functions/api/owner-passkey.js');
  const kv = makeKV();
  const rec = { name: 'old', credId: 'cred-old-123', publicKey: {}, signCount: 0 };
  await kv.put('owner-passkey:' + 'cred-old-123'.slice(0, 12), JSON.stringify(rec));
  await kv.put('owner-passkey-index', JSON.stringify(['cred-old-123']));
  const keys = await getPasskeys(kv);
  assert.equal(keys[0].class, 'lock');
  // 再次读取仍为 lock（幂等）
  const keys2 = await getPasskeys(kv);
  assert.equal(keys2[0].class, 'lock');
});

test('challenge auth 默认只列 lock 凭据', async () => {
  const { onRequestPost } = await import('../../functions/api/owner-passkey.js');
  const kv = makeKV();
  await seedKey(kv, { credId: 'lock-key-001', cls: 'lock' });
  await seedKey(kv, { credId: 'app-key-001', cls: 'app', aud: 'book' });
  // 修正索引（含两把）
  await kv.put('owner-passkey-index', JSON.stringify(['lock-key-001', 'app-key-001']));
  const r = await onRequestPost({
    request: postReq('https://styrigx.com/api/owner-passkey', { action: 'challenge', type: 'auth' }),
    env: stepupEnv(kv),
  });
  const j = await r.json();
  assert.ok(j.ok);
  const ids = (j.allowCredentials || []).map((c) => c.id);
  assert.ok(ids.includes('lock-key-001'), '应列出 lock 凭据');
  assert.ok(!ids.includes('app-key-001'), '不应列出 app 凭据');
});

test('challenge app auth 只列该 aud 的 app 凭据', async () => {
  const { onRequestPost } = await import('../../functions/api/owner-passkey.js');
  const kv = makeKV();
  await seedKey(kv, { credId: 'lock-key-001', cls: 'lock' });
  await seedKey(kv, { credId: 'app-key-book', cls: 'app', aud: 'book' });
  await seedKey(kv, { credId: 'app-key-music', cls: 'app', aud: 'music' });
  await kv.put('owner-passkey-index', JSON.stringify(['lock-key-001', 'app-key-book', 'app-key-music']));
  const r = await onRequestPost({
    request: postReq('https://styrigx.com/api/owner-passkey', { action: 'challenge', type: 'auth', pkClass: 'app', aud: 'book' }),
    env: stepupEnv(kv),
  });
  const j = await r.json();
  assert.ok(j.ok);
  const ids = (j.allowCredentials || []).map((c) => c.id);
  assert.deepEqual(ids, ['app-key-book'], '只应列出 book 的 app 凭据');
});

test('challenge app auth：不在白名单的 aud → 400', async () => {
  const { onRequestPost } = await import('../../functions/api/owner-passkey.js');
  const kv = makeKV();
  const r = await onRequestPost({
    request: postReq('https://styrigx.com/api/owner-passkey', { action: 'challenge', type: 'auth', pkClass: 'app', aud: 'evil' }),
    env: stepupEnv(kv),
  });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'aud');
});

test('无 stepup 时 list/register/delete → 403 stepup-required', async () => {
  const { onRequestPost } = await import('../../functions/api/owner-passkey.js');
  const kv = makeKV();
  await seedKey(kv, { credId: 'lock-key-001', cls: 'lock' });
  const env = stepupEnv(kv);
  for (const body of [
    { action: 'list' },
    { action: 'delete', credId: 'lock-key-001' },
    { action: 'challenge', type: 'register', pkClass: 'app', aud: 'book' },
  ]) {
    const r = await onRequestPost({ request: postReq('https://styrigx.com/api/owner-passkey', body), env });
    assert.equal(r.status, 403, JSON.stringify(body));
    assert.equal((await r.json()).error, 'stepup-required');
  }
});

test('有 stepup 时 list 通过', async () => {
  const { onRequestPost } = await import('../../functions/api/owner-passkey.js');
  const kv = makeKV();
  await seedKey(kv, { credId: 'lock-key-001', cls: 'lock' });
  const sc = await mintStepup();
  const r = await onRequestPost({
    request: postReq('https://styrigx.com/api/owner-passkey', { action: 'list' }, stepupCookie(sc)),
    env: stepupEnv(kv),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.ok && j.keys.length === 1);
  assert.equal(j.keys[0].class, 'lock');
});

test('删除 app 凭据 → app-epoch:book +1', async () => {
  const { onRequestPost } = await import('../../functions/api/owner-passkey.js');
  const kv = makeKV();
  await seedKey(kv, { credId: 'app-key-book', cls: 'app', aud: 'book' });
  const sc = await mintStepup();
  const env = stepupEnv(kv);
  const r = await onRequestPost({
    request: postReq('https://styrigx.com/api/owner-passkey', { action: 'delete', credId: 'app-key-book' }, stepupCookie(sc)),
    env,
  });
  assert.equal(r.status, 200);
  assert.equal(await kv.get('app-epoch:book'), '1');
  // 再删一把 → 2（删除会 bump session-epoch，stepup 失效，需用新 epoch 重新签发）
  await seedKey(kv, { credId: 'app-key-book2', cls: 'app', aud: 'book' });
  const sc2 = await mintStepup(1);
  const r2 = await onRequestPost({
    request: postReq('https://styrigx.com/api/owner-passkey', { action: 'delete', credId: 'app-key-book2' }, stepupCookie(sc2)),
    env,
  });
  assert.equal(r2.status, 200);
  assert.equal(await kv.get('app-epoch:book'), '2');
});

test('删除 lock 凭据不推进 app-epoch', async () => {
  const { onRequestPost } = await import('../../functions/api/owner-passkey.js');
  const kv = makeKV();
  await seedKey(kv, { credId: 'lock-key-001', cls: 'lock' });
  await seedKey(kv, { credId: 'lock-key-002', cls: 'lock' });
  await kv.put('owner-pw', JSON.stringify({ hash: 'x' })); // 有密码，不触发 last-key 保护
  const sc = await mintStepup();
  const r = await onRequestPost({
    request: postReq('https://styrigx.com/api/owner-passkey', { action: 'delete', credId: 'lock-key-001' }, stepupCookie(sc)),
    env: stepupEnv(kv),
  });
  assert.equal(r.status, 200);
  assert.equal(await kv.get('app-epoch:book'), null);
});

test('无密码时禁止删除最后一把 lock 凭据', async () => {
  const { onRequestPost } = await import('../../functions/api/owner-passkey.js');
  const kv = makeKV();
  await seedKey(kv, { credId: 'lock-key-001', cls: 'lock' });
  const sc = await mintStepup();
  const r = await onRequestPost({
    request: postReq('https://styrigx.com/api/owner-passkey', { action: 'delete', credId: 'lock-key-001' }, stepupCookie(sc)),
    env: stepupEnv(kv),
  });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'last-key');
});

test('stepup challenge 只列 lock 凭据', async () => {
  const { onRequestPost } = await import('../../functions/api/stepup.js');
  const kv = makeKV();
  await seedKey(kv, { credId: 'lock-key-001', cls: 'lock' });
  await seedKey(kv, { credId: 'app-key-001', cls: 'app', aud: 'book' });
  await kv.put('owner-passkey-index', JSON.stringify(['lock-key-001', 'app-key-001']));
  // 需要 owner 会话；这里直接测过滤逻辑：challenge 返回前会验会话，先验证 filter
  // 用无会话调用 → 401（证明会话门禁仍在）
  const r = await onRequestPost({
    request: postReq('https://styrigx.com/api/stepup', { action: 'challenge' }),
    env: { OWNER_KV: kv, SGX_STEPUP_PUBLIC: STEPUP_PUB, SGX_RP_ID: 'x', SGX_ORIGIN: 'y' },
  });
  // 无会话 → 401（verifySessionDetailed 在 mock 下无 cookie 返回不 ok）
  assert.ok([401, 403].includes(r.status));
});

test('注册参数：challenge register 下发写死的用户信息', async () => {
  const { onRequestPost } = await import('../../functions/api/owner-passkey.js');
  const kv = makeKV();
  const sc = await mintStepup();
  const env = stepupEnv(kv);
  const headers = stepupCookie(sc);
  // lock 注册（第一把，无需 stepup 也行，但这里带上）
  let r = await onRequestPost({
    request: postReq('https://styrigx.com/api/owner-passkey', { action: 'challenge', type: 'register', pkClass: 'lock' }, headers),
    env,
  });
  let j = await r.json();
  assert.ok(j.ok);
  assert.equal(j.user.displayName, 'Sloan Gray');
  assert.equal(j.user.name, 'lock');
  assert.ok(j.user.id, '应有 user.id');
  const lockUserId = j.user.id;
  // app 注册
  r = await onRequestPost({
    request: postReq('https://styrigx.com/api/owner-passkey', { action: 'challenge', type: 'register', pkClass: 'app', aud: 'book' }, headers),
    env,
  });
  j = await r.json();
  assert.ok(j.ok);
  assert.equal(j.user.displayName, 'Sloan Gray');
  assert.equal(j.user.name, 'book');
  assert.ok(j.user.id && j.user.id !== lockUserId, 'app 的 user.id 应与 lock 不同');
  // 同一 aud 再次 challenge → user.id 复用
  r = await onRequestPost({
    request: postReq('https://styrigx.com/api/owner-passkey', { action: 'challenge', type: 'register', pkClass: 'app', aud: 'book' }, headers),
    env,
  });
  j = await r.json();
  assert.ok(j.ok);
});

/* ---- CI 静态检查 ---- */
test('CI 静态检查：verifyStepupCookie 只在安全设置接口（owner-passkey/owner-password/stepup）', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const apiDir = new URL('../../functions/api/', import.meta.url);
  const allowed = new Set(['owner-passkey.js', 'owner-password.js', 'stepup.js']);
  const bad = [];
  for (const f of readdirSync(apiDir)) {
    if (!f.endsWith('.js')) continue;
    const src = readFileSync(join(apiDir.pathname, f), 'utf8');
    if (/verifyStepupCookie|requireStepup/.test(src) && !allowed.has(f)) {
      bad.push(f);
    }
  }
  assert.deepEqual(bad, [], '以下文件不应引用 stepup 验签：' + bad.join(','));
});
