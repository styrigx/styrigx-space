/**
 * A-2 最后一把锁屏钥匙与 accountkey 联动（v1.5 #10）。
 *
 * - 删到 0 时 accountkey 存在（站长密码或站长通行密钥任一）→ 允许，保留 layer:lock
 *   （根凭证代开继续被拒）；不存在 → 服务端 403 last-key。
 * - A-2 对 layer:lock-emptied 不读不写（该键是 B #10 的，本 PR 不引入）：
 *   删最后一把后 KV 里不出现该键；生产残留不动、不清除、不依赖。
 * - 「锁屏凭证已删光」按真实凭证数判断：无 lock 密码且无 lock 通行密钥。
 * - 删光后 lock-config 返回 resetOnly=true（锁屏只显示访客 + 重置锁屏）。
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
async function mintStepup(by = 'account', scope = 'keys', epoch = 0) {
  const { signStepupCookie } = await import('../../../workers/auth-gateway/functions/api/stepup.js');
  return await signStepupCookie(STEPUP_PRIV, by, scope, epoch);
}
async function mintSession(epoch = 0) {
  const { signSessionCookie } = await import('../../../workers/auth-gateway/functions/_kernel/session.js');
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
  const { makePasswordRecord } = await import('../../../workers/auth-gateway/functions/api/owner-password.js');
  const rec = await makePasswordRecord(password, 'test-pepper');
  await kv.put(kind === 'owner' ? 'owner-pw' : 'lock-pw', JSON.stringify(rec));
}

test('setup: 生成测试密钥', async () => {
  await genKeys();
  assert.ok(STEPUP_PRIV.includes('PRIVATE KEY'));
});

test('A-2：有站长密码时删最后一把 lock 钥匙 → 200，layer:lock 保留、KV 不出现 layer:lock-emptied', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/owner-passkey.js');
  const kv = makeKV({ 'layer:owner': '1', 'layer:lock': '1' });
  await seedKey(kv, 'lock-key-001', 'lock');
  await seedPw(kv, 'owner', 'owner-pw-123');
  const sess = await mintSession();
  const sc = await mintStepup('account', 'keys');
  const res = await onRequestPost({
    request: postReq('https://styrigx.com/api/owner-passkey', { action: 'delete', credId: 'lock-key-001' }, bothCookies(sess, sc)),
    env: envFor(kv),
  });
  assert.equal(res.status, 200, await res.text());
  assert.equal(await kv.get('layer:lock'), '1', 'layer:lock 应保留（根凭证代开继续被拒）');
  assert.equal(await kv.get('layer:lock-emptied'), null, 'A-2 不写 layer:lock-emptied，该键不应出现');
});

test('A-2：无 accountkey 时删最后一把 lock 钥匙 → 403 last-key，钥匙还在', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/owner-passkey.js');
  const kv = makeKV({ 'layer:lock': '1' });
  await seedKey(kv, 'lock-key-001', 'lock');
  const sess = await mintSession();
  const sc = await mintStepup('account', 'keys');
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

test('A-2：有站长通行密钥时删最后一把 lock 钥匙 → 200（accountkey 任一即可）', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/owner-passkey.js');
  const kv = makeKV({ 'layer:owner': '1', 'layer:lock': '1' });
  await seedKey(kv, 'lock-key-001', 'lock');
  await seedKey(kv, 'owner-key-001', 'owner');
  const sess = await mintSession();
  const sc = await mintStepup('account', 'keys');
  const res = await onRequestPost({
    request: postReq('https://styrigx.com/api/owner-passkey', { action: 'delete', credId: 'lock-key-001' }, bothCookies(sess, sc)),
    env: envFor(kv),
  });
  assert.equal(res.status, 200, await res.text());
  assert.equal(await kv.get('layer:lock-emptied'), null, 'A-2 不写 layer:lock-emptied，该键不应出现');
});

test('A-2：有 accountkey 时删最后一把 lock 密码 → 200，KV 不出现 layer:lock-emptied', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/owner-password.js');
  const kv = makeKV({ 'layer:owner': '1', 'layer:lock': '1' });
  await seedPw(kv, 'owner', 'owner-pw-123');
  await seedPw(kv, 'lock', 'lock-pw-1234');
  const sess = await mintSession();
  const sc = await mintStepup('account', 'keys');
  const res = await onRequestPost({
    request: postReq('https://styrigx.com/api/owner-password', { action: 'remove', kind: 'lock' }, bothCookies(sess, sc)),
    env: envFor(kv),
  });
  assert.equal(res.status, 200, await res.text());
  assert.equal(await kv.get('lock-pw'), null);
  assert.equal(await kv.get('layer:lock'), '1', 'layer:lock 应保留');
  assert.equal(await kv.get('layer:lock-emptied'), null, 'A-2 不写 layer:lock-emptied，该键不应出现');
});

test('A-2：无 accountkey 时删最后一把 lock 密码 → 403 last-key，密码还在', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/owner-password.js');
  const kv = makeKV({ 'layer:lock': '1' });
  await seedPw(kv, 'lock', 'lock-pw-1234');
  const sess = await mintSession();
  const sc = await mintStepup('account', 'keys');
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

test('A-2：lock-config (b) 无真实 lock 凭证 + owner 已配置 + 无 lock-emptied → resetOnly=true', async () => {
  const { onRequestGet } = await import('../../../workers/auth-gateway/functions/api/lock-config.js');
  const kv = makeKV({ 'layer:owner': '1', 'layer:lock': '1' });
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

test('A-2：lock-config (a) lock-emptied=1 残留 + 有真实 lock 凭证 → resetOnly=false（忽略该键）', async () => {
  const { onRequestGet } = await import('../../../workers/auth-gateway/functions/api/lock-config.js');
  const kv = makeKV({ 'layer:owner': '1', 'layer:lock': '1', 'layer:lock-emptied': '1' });
  await seedPw(kv, 'owner', 'owner-pw-123');
  await seedPw(kv, 'lock', 'lock-pw-1234');
  const res = await onRequestGet({ env: { OWNER_KV: kv } });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.resetOnly, false, '有真实 lock 凭证时 resetOnly 应为 false，残留 lock-emptied=1 被忽略');
  assert.equal(j.ownerConfigured, true);
});

test('A-2：lock-config 空站 → resetOnly=false（A 启动流程保留，根凭证入口仍显示）', async () => {
  const { onRequestGet } = await import('../../../workers/auth-gateway/functions/api/lock-config.js');
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

test('A-2：新增 lock 密码后不动 lock-emptied 残留（留给 B 处理）', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/owner-password.js');
  const kv = makeKV({ 'layer:owner': '1', 'layer:lock': '1', 'layer:lock-emptied': '1' });
  await seedPw(kv, 'owner', 'owner-pw-123');
  const sess = await mintSession();
  const sc = await mintStepup('account', 'keys');
  const res = await onRequestPost({
    request: postReq('https://styrigx.com/api/owner-password', { action: 'set', kind: 'lock', password: 'new-lock-pw' }, bothCookies(sess, sc)),
    env: envFor(kv),
  });
  assert.equal(res.status, 200, await res.text());
  assert.equal(await kv.get('layer:lock-emptied'), '1', 'A-2 不动 lock-emptied 残留');
});

test('A-2：删光账号凭证时不动 lock-emptied 残留（留给 B 处理；账号体系走 /api/account）', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/account.js');
  const { signAccountTicket } = await import('../../../workers/auth-gateway/functions/_kernel/account-session.js');
  const kv = makeKV({ 'layer:owner': '1', 'layer:lock': '1', 'layer:lock-emptied': '1' });
  await kv.put('owner-passkey-index', JSON.stringify(['acct-key-0001']));
  await kv.put('owner-passkey:acct-key-000', JSON.stringify({ credId: 'acct-key-0001', class: 'owner', publicKey: {}, signCount: 0 }));
  const sess = await mintSession();
  const acc = await signAccountTicket(STEPUP_PRIV, 'root', 0, Date.now());
  const { signDoorTicket } = await import('../../../workers/auth-gateway/functions/_kernel/door.js');
  const door = await signDoorTicket(STEPUP_PRIV, 'account', 'root', 0); /* 删账号通行密钥要账号门票 */
  const env = Object.assign({}, envFor(kv), { SGX_ACCOUNT_PRIVATE: STEPUP_PRIV, SGX_ACCOUNT_PUBLIC: STEPUP_PUB });
  const res = await onRequestPost({
    request: postReq('https://styrigx.com/api/account', { action: 'delete', credId: 'acct-key-0001' },
      { Cookie: 'sgx-verified=' + sess + '; sgx-account=' + acc + '; sgx-door=' + door }),
    env,
  });
  assert.equal(res.status, 200, await res.text());
  assert.equal(await kv.get('owner-passkey:acct-key-000'), null);
  assert.equal(await kv.get('layer:owner'), null, '删光账号凭证 → 清 layer:owner');
  assert.equal(await kv.get('layer:lock-emptied'), '1', 'A-2 不动 lock-emptied 残留');
});
