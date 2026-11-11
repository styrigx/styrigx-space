/**
 * 2026-11-09 fix/silent-writeback-logs：通行密钥验签通过后回写 signCount / lastUsedAt 失败——不挡登录，但打 console.error（不静默吞掉）。
 * v6 P4 起旧账号会话的通行密钥登录删除，同一条行为在 v6 身份命令上测（su 用通行密钥，core/identity-passkey.js），接口行为不变。
 * 运行：node --test tests/workers/account/passkey-writeback.test.mjs
 */
import './_cf-workers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAccountD1 } from './_d1.mjs';
import { assertion, b64url, ORIGIN } from './_fixtures.mjs';

const SRC = new URL('../../../workers/account/src/', import.meta.url).pathname;
const { serviceFetch } = await import(SRC + 'rpc/account-service.js');
const { _resetSecretCache } = await import(SRC + 'secrets.js');

async function setup() {
  _resetSecretCache();
  const env = { SGX_ENV: 'production', SGX_RP_ID: 'styrigx.com', SGX_ORIGIN: ORIGIN, SGX_ACCOUNT_PASSWORD_PEPPER: 'pepper-account-test', D1_ACCOUNT: makeAccountD1() };
  const raw = env.D1_ACCOUNT.raw;
  raw.prepare("INSERT INTO account_users (uid, name, avatar, expires_at, epoch, disabled, created_at) VALUES (1000, 'styrigx', '', 0, 0, 0, 1)").run();
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const credId = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const rec = { name: '', provider: 'samsung-pass', aaguid: '', createdAt: 1, lastUsedAt: 0, credId, publicKey: jwk, signCount: 0, uv: 1 };
  raw.prepare("INSERT INTO account_user_passkey (credential_id, uid, user_handle, legacy_handle, record) VALUES (?, 1000, 'HANDLE', 'LEGACY', ?)").run(credId, JSON.stringify(rec));
  return { env, kp, credId };
}
async function id(env, body) {
  const res = await serviceFetch(new Request(ORIGIN + '/api/identity', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.9' }, body: JSON.stringify(body) }), env, { waitUntil() {} });
  return { status: res.status, json: await res.json() };
}

test('signCount 回写失败：su（通行密钥）照常 200，console.error 记一行 [account-v6-passkey] signCount writeback failed', async () => {
  const { env, kp, credId } = await setup();
  const db = env.D1_ACCOUNT;
  env.D1_ACCOUNT = new Proxy(db, {
    get(t, k) {
      if (k === 'prepare') return (sql) => { if (/^\s*UPDATE account_user_passkey\b/i.test(sql)) throw new Error('d1 write down'); return t.prepare(sql); };
      const v = Reflect.get(t, k);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  const ch = await id(env, { action: 'su-challenge' });
  assert.equal(ch.status, 200);
  const errs = [];
  const orig = console.error;
  console.error = (...a) => { errs.push(a.map(String).join(' ')); };
  let r;
  try { r = await id(env, { action: 'su', user: 'styrigx', cid: ch.json.cid, credential: await assertion(kp, credId, ch.json.challenge, 'HANDLE') }); } finally { console.error = orig; }
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.user.name, 'styrigx');
  assert.ok(errs.some((l) => /\[account-v6-passkey\] signCount writeback failed/.test(l)), errs.join('\n'));
});
