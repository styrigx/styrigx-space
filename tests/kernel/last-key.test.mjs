/**
 * A-2 最后一把锁屏钥匙与 ownerkey 联动（v1.5 #10）。
 *
 * - 删到 0 时 ownerkey 存在（站长密码或站长通行密钥任一）→ 允许，置 layer:lock-emptied，
 *   保留 layer:lock（根凭证代开继续被拒）；不存在 → 服务端 403 last-key。
 * - 删光后 lock-config 返回 resetOnly=true（锁屏只显示访客 + 重置锁屏）。
 * - 新增 lock 凭证（设锁屏密码）→ 清除 lock-emptied；删光 owner 凭证 → 清除 lock-emptied。
 * - 空站（无任何凭证/标记）→ lock-config resetOnly=false（A 启动流程保留，根凭证入口仍显示）。
 *
 * 运行：node --test tests/kernel/last-key.test.mjs
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
    list: async (prefix) => {
      const keys = [...m.keys()].filter((k) => !prefix || !prefix.prefix || k.startsWith(prefix.prefix));
      return { keys: keys.map((name) => ({ name })) };
    },
    _map: m,
  };
}

function postReq(url, body, headers = {}) {
  const h = { 'Content-Type': 'application/json', 'Origin': 'https://styrigx.com', ...headers };
  if (headers.Origin === null) delete h['Origin'];
  return new Request(url, { method: 'POST', headers: h, body: JSON.stringify(body) });
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
async function mintStepup(by = 'owner', scope = 'keys', epoch = 0) {
  const { signStepupCookie } = await import('../../functions/api/stepup.js');
  return await signStepupCookie(STEPUP_PRIV, by, scope, epoch);
}
async function mintSession(epoch = 0) {
  const { signSessionCookie } = await import('../../functions/_kernel/session.js');
  return await signSessionCookie(LOCK_PRIV, epoch, 'owner', 'owner');
}
const envFor = (kv, extra = {}) => ({
  OWNER_KV: kv,
  SGX_LOCK_PRIVATE: LOCK_PRIV,
  SGX_LOCK_PUBLIC: LOCK_PUB,
  SGX_STEPUP_PRIVATE: STEPUP_PRIV,
  SGX_STEPUP_PUBLIC: STEPUP_PUB,
  SGX_RP_ID: 'styrigx.com',
  SGX_ORIGIN: 'https://styrigx.com',
  SGX_PW_PEPPER: 'test-pepper',
  ...extra,
});
const bothCookies = (s, t) => ({ Cookie: 'sgx-verified=' + s + '; sgx-stepup=' + t });

async function seedKey(kv, credId, cls) {
  const rec = {
    name: 'test', provider: '', aaguid: '', createdAt: 1, lastUsedAt: 0,
    credId, publicKey: {}, signCount: 0, uv: 1, class: cls,
  };
  await kv.put('owner-passkey:' + credId.slice(0, 12), JSON.stringify(rec));
  const idxRaw = await kv.get('owner-passkey-index', 'json');
  const idx = Array.isArray(idxRaw) ? idxRaw : [];
  idx.push(credId);
  await kv.put('owner-passkey-index', JSON.stringify(idx));
}
async function seedPw(kv, kind, password) {
  const { makePasswordRecord } = await import('../../functions/api/owner-password.js');
  const rec = await makePasswordRecord(password, 'test-pepper');
  await kv.put(kind === 'owner' ? 'owner-pw' : 'lock-pw', JSON.stringify(rec));
}

test('setup: 生成测试密钥', async () => {
  await genKeys();
  assert.ok(STEPUP_PRIV.includes('PRIVATE KEY'));
});

test('A-2：有站长密码时删最后一把 lock 钥匙 → 200，layer:lock 保留、lock-emptied=1', async () => {
  const { onRequestPost } = await import('../../functions/api/owner-passkey.js');
  const kv = makeKV({ 'layer:owner': '1', 'layer:lock': '1' });
  await seedKey(kv, 'lock-key-001', 'lock');
  await seedPw(kv, 'owner', 'owner-pw-123');
  const sess = await mintSession();
  const sc = await mintStepup('owner', 'keys');
  const res = await onRequestPost({
    request: postReq('https://styrigx.com/api/owner-passkey', { action: 'delete', credId: 'lock-key-001' }, bothCookies(sess, sc)),
    env: envFor(kv),
  });
  assert.equal(res.status, 200, await res.text());
  assert.equal(await kv.get('layer:lock'), '1', 'layer:lock 应保留（根凭证代开继续被拒）');
  assert.equal(await kv.get('layer:lock-emptied'), '1', '应置 lock-emptied');
});

test('A-2：无 ownerkey 时删最后一把 lock 钥匙 → 403 last-key，钥匙还在', async () => {
  const { onRequestPost } = await import('../../functions/api/owner-passkey.js');
  const kv = makeKV({ 'layer:lock': '1' });
  await seedKey(kv, 'lock-key-001', 'lock');
  const sess = await mintSession();
  const sc = await mintStepup('owner', 'keys');
  const res = await onRequestPost({
    request: postReq('https://styrigx.com/api/owner-passkey', { action: 'delete', credId: 'lock-key-001' }, bothCookies(sess, sc)),
    env: envFor(kv),
  });
  assert.equal(res.status, 403);
  const j = await res.json();
  assert.equal(j.error, 'last-key');
  const keys = await kv.get('owner-passkey-index', 'json');
  assert.deepEqual(keys, ['lock-key-001']);
});

test('A-2：有站长通行密钥时删最后一把 lock 钥匙 → 200（ownerkey 任一即可）', async () => {
  const { onRequestPost } = await import('../../functions/api/owner-passkey.js');
  const kv = makeKV({ 'layer:owner': '1', 'layer:lock': '1' });
  await seedKey(kv, 'lock-key-001', 'lock');
  await seedKey(kv, 'owner-key-001', 'owner');
  const sess = await mintSession();
  const sc = await mintStepup('owner', 'keys');
  const res = await onRequestPost({
    request: postReq('https://styrigx.com/api/owner-passkey', { action: 'delete', credId: 'lock-key-001' }, bothCookies(sess, sc)),
    env: envFor(kv),
  });
  assert.equal(res.status, 200, await res.text());
  assert.equal(await kv.get('layer:lock-emptied'), '1');
});

test('A-2：有 ownerkey 时删最后一把 lock 密码 → 200，lock-emptied=1', async () => {
  const { onRequestPost } = await import('../../functions/api/owner-password.js');
  const kv = makeKV({ 'layer:owner': '1', 'layer:lock': '1' });
  await seedPw(kv, 'owner', 'owner-pw-123');
  await seedPw(kv, 'lock', 'lock-pw-1234');
  const sess = await mintSession();
  const sc = await mintStepup('owner', 'keys');
  const res = await onRequestPost({
    request: postReq('https://styrigx.com/api/owner-password', { action: 'remove', kind: 'lock' }, bothCookies(sess, sc)),
    env: envFor(kv),
  });
  assert.equal(res.status, 200, await res.text());
  assert.equal(await kv.get('lock-pw'), null);
  assert.equal(await kv.get('layer:lock'), '1', 'layer:lock 应保留');
  assert.equal(await kv.get('layer:lock-emptied'), '1', '应置 lock-emptied');
});

test('A-2：无 ownerkey 时删最后一把 lock 密码 → 403 last-key，密码还在', async () => {
  const { onRequestPost } = await import('../../functions/api/owner-password.js');
  const kv = makeKV({ 'layer:lock': '1' });
  await seedPw(kv, 'lock', 'lock-pw-1234');
  const sess = await mintSession();
  const sc = await mintStepup('owner', 'keys');
  const res = await onRequestPost({
    request: postReq('https://styrigx.com/api/owner-password', { action: 'remove', kind: 'lock' }, bothCookies(sess, sc)),
    env: envFor(kv),
  });
  assert.equal(res.status, 403);
  const j = await res.json();
  assert.equal(j.error, 'last-key');
  const pw = await kv.get('lock-pw', 'json');
  assert.ok(pw && pw.hash, '锁屏密码应还在');
});

test('A-2：lock-config emptied 态 → resetOnly=true（锁屏只显示访客 + 重置）', async () => {
  const { onRequestGet } = await import('../../functions/api/lock-config.js');
  const kv = makeKV({ 'layer:owner': '1', 'layer:lock': '1', 'layer:lock-emptied': '1' });
  await seedPw(kv, 'owner', 'owner-pw-123');
  const res = await onRequestGet({ env: { OWNER_KV: kv } });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.resetOnly, true);
  assert.equal(j.ownerConfigured, true);
  /* 标记独有兜底：passkey/password 仍为 true（不暴露根凭证入口） */
  assert.equal(j.passkey, true);
  assert.equal(j.password, true);
});

test('A-2：lock-config 空站 → resetOnly=false（A 启动流程保留，根凭证入口仍显示）', async () => {
  const { onRequestGet } = await import('../../functions/api/lock-config.js');
  const kv = makeKV({});
  const res = await onRequestGet({ env: { OWNER_KV: kv } });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.passkey, false);
  assert.equal(j.password, false);
  assert.equal(j.ownerConfigured, false);
  assert.equal(j.resetOnly, false);
});

test('A-2：新增 lock 密码后清除 lock-emptied（锁屏恢复正常解锁入口）', async () => {
  const { onRequestPost } = await import('../../functions/api/owner-password.js');
  const kv = makeKV({ 'layer:owner': '1', 'layer:lock': '1', 'layer:lock-emptied': '1' });
  await seedPw(kv, 'owner', 'owner-pw-123');
  const sess = await mintSession();
  const sc = await mintStepup('owner', 'keys');
  const res = await onRequestPost({
    request: postReq('https://styrigx.com/api/owner-password', { action: 'set', kind: 'lock', password: 'new-lock-pw' }, bothCookies(sess, sc)),
    env: envFor(kv),
  });
  assert.equal(res.status, 200, await res.text());
  assert.equal(await kv.get('layer:lock-emptied'), null, '新增 lock 密码应清除 lock-emptied');
});

test('A-2：删光 owner 凭证时清除 lock-emptied', async () => {
  const { onRequestPost } = await import('../../functions/api/owner-password.js');
  const kv = makeKV({ 'layer:owner': '1', 'layer:lock': '1', 'layer:lock-emptied': '1' });
  await seedPw(kv, 'owner', 'owner-pw-123');
  const sess = await mintSession();
  /* owner 密码删除需入口 1（by=root, scope=root） */
  const sc = await mintStepup('root', 'root');
  const res = await onRequestPost({
    request: postReq('https://styrigx.com/api/owner-password', { action: 'remove', kind: 'owner' }, bothCookies(sess, sc)),
    env: envFor(kv),
  });
  assert.equal(res.status, 200, await res.text());
  assert.equal(await kv.get('owner-pw'), null);
  assert.equal(await kv.get('layer:lock-emptied'), null, '删光 owner 凭证应清除 lock-emptied');
});
