/**
 * A-2 最后一把锁屏钥匙与 AccountKey 联动（v1.5 #10）。
 *
 * - 删到 0 时 AccountKey 存在（管理员密码或管理员通行密钥任一）→ 允许，保留 lock-configured
 *   （根凭证代开继续被拒）；不存在 → 服务端 403 last-key。
 * - A-2 对 layer:lock-emptied 不读不写（该键是 B #10 的，本 PR 不引入）：
 *   删最后一把后 KV 里不出现该键；生产残留不动、不清除、不依赖。
 * - 「锁屏凭证已删光」按真实凭证数判断：无 lock 密码且无 lock 通行密钥。
 * - 删光后 lock-entry 返回 resetOnly=true（锁屏只显示访客 + 重置锁屏）。
 * - 空站（无任何凭证/标记）→ lock-entry resetOnly=false（A 启动流程保留，根凭证入口仍显示）。
 *
 * 运行：node --test tests/kernel/last-key.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testLockSession, testAccountSession } from './_tickets.mjs';

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

let ACCT_PRIV = '', ACCT_PUB = '', LOCK_PRIV = '', LOCK_PUB = '';
function derToPem(der, label) {
  const b64 = Buffer.from(der).toString('base64');
  const lines = b64.match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}
async function genKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  ACCT_PRIV = derToPem(await crypto.subtle.exportKey('pkcs8', kp.privateKey), 'PRIVATE KEY');
  ACCT_PUB = derToPem(await crypto.subtle.exportKey('spki', kp.publicKey), 'PUBLIC KEY');
  const kp2 = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  LOCK_PRIV = derToPem(await crypto.subtle.exportKey('pkcs8', kp2.privateKey), 'PRIVATE KEY');
  LOCK_PUB = derToPem(await crypto.subtle.exportKey('spki', kp2.publicKey), 'PUBLIC KEY');
}
async function mintSession(epoch = 0) {
  const { signLockSessionTicket } = await import('../../../workers/auth-gateway/functions/_kernel/lock-session.js');
  return await testLockSession(LOCK_PRIV, epoch, 'admin', 'password');
}
const envFor = (kv, extra = {}) => ({
  KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv,
  SGX_LOCK_PRIVATE: LOCK_PRIV,
  SGX_LOCK_PUBLIC: LOCK_PUB,
  SGX_RP_ID: 'styrigx.com',
  SGX_ORIGIN: 'https://styrigx.com',
  SGX_PW_PEPPER: 'test-pepper',
  ...extra,
});

async function seedKey(kv, credId, cls) {
  const rec = {
    name: 'test', provider: '', aaguid: '', createdAt: 1, lastUsedAt: 0,
    credId, publicKey: {}, signCount: 0, uv: 1,
  };
  const domain = cls === 'owner' || cls === 'account' ? 'account' : 'lock';
  await kv.put(domain + '-passkey:' + credId.slice(0, 12), JSON.stringify(rec));
  const idxRaw = await kv.get(domain + '-passkey-index', 'json');
  const idx = Array.isArray(idxRaw) ? idxRaw : [];
  idx.push(credId);
  await kv.put(domain + '-passkey-index', JSON.stringify(idx));
}
async function seedPw(kv, kind, password) {
  const { makePasswordRecord } = await import('../../../workers/auth-gateway/functions/_kernel/password.js');
  const rec = await makePasswordRecord(password, 'test-pepper');
  await kv.put(kind === 'owner' ? 'account-password' : 'lock-password', JSON.stringify(rec));
}

test('setup: 生成测试密钥', async () => {
  await genKeys();
  assert.ok(ACCT_PRIV.includes('PRIVATE KEY'));
});






test('A-2：lock-entry (b) 无真实 lock 凭证 + owner 已配置 + 无 lock-emptied → resetOnly=true', async () => {
  const { onRequestGet } = await import('../../../workers/auth-gateway/functions/api/lock-entry.js');
  const kv = makeKV({ 'account-configured': '1', 'lock-configured': '1' });
  await seedPw(kv, 'owner', 'account-password-123');
  const res = await onRequestGet({ env: { KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv } });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.resetOnly, true);
  assert.equal(j.accountConfigured, true);
  /* 标记独有兜底：passkey/password 仍为 true（不暴露根凭证入口） */
  assert.equal(j.passkey, true);
  assert.equal(j.password, true);
});

test('A-2：lock-entry (a) lock-emptied=1 残留 + 有真实 lock 凭证 → resetOnly=false（忽略该键）', async () => {
  const { onRequestGet } = await import('../../../workers/auth-gateway/functions/api/lock-entry.js');
  const kv = makeKV({ 'account-configured': '1', 'lock-configured': '1', 'layer:lock-emptied': '1' });
  await seedPw(kv, 'owner', 'account-password-123');
  await seedPw(kv, 'lock', 'lock-password-1234');
  const res = await onRequestGet({ env: { KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv } });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.resetOnly, false, '有真实 lock 凭证时 resetOnly 应为 false，残留 lock-emptied=1 被忽略');
  assert.equal(j.accountConfigured, true);
});

test('A-2：lock-entry 空站 → resetOnly=false（A 启动流程保留，根凭证入口仍显示）', async () => {
  const { onRequestGet } = await import('../../../workers/auth-gateway/functions/api/lock-entry.js');
  const kv = makeKV({});
  const res = await onRequestGet({ env: { KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv } });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.passkey, false);
  assert.equal(j.password, false);
  assert.equal(j.accountConfigured, false);
  assert.equal(j.resetOnly, false);
});


test('A-2：删光账号凭证时不动 lock-emptied 残留（留给 B 处理；账号体系走 /api/account）', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/account.js');
  const kv = makeKV({ 'account-configured': '1', 'lock-configured': '1', 'layer:lock-emptied': '1' });
  await kv.put('account-passkey-index', JSON.stringify(['acct-key-0001']));
  await kv.put('account-passkey:acct-key-000', JSON.stringify({ credId: 'acct-key-0001', publicKey: {}, signCount: 0 }));
  const sess = await mintSession();
  const acc = await testAccountSession(ACCT_PRIV, 'password', 0, Date.now());
  const { signAccountReauthTicket } = await import('../../../workers/auth-gateway/functions/_kernel/tickets.js');
  const reauth = await signAccountReauthTicket(ACCT_PRIV, 'root', 0); /* 删账号通行密钥要 AccountReauthTicket */
  const env = Object.assign({}, envFor(kv), { SGX_ACCOUNT_PRIVATE: ACCT_PRIV, SGX_ACCOUNT_PUBLIC: ACCT_PUB });
  const res = await onRequestPost({
    request: postReq('https://styrigx.com/api/account', { action: 'passkey-delete', credId: 'acct-key-0001' },
      { Cookie: 'sgx-lock-session=' + sess + '; sgx-account-session=' + acc + '; sgx-account-reauth=' + reauth }),
    env,
  });
  assert.equal(res.status, 200, await res.text());
  assert.equal(await kv.get('account-passkey:acct-key-000'), null);
  assert.equal(await kv.get('account-configured'), null, '删光账号凭证 → 清 account-configured');
  assert.equal(await kv.get('layer:lock-emptied'), '1', 'A-2 不动 lock-emptied 残留');
});
