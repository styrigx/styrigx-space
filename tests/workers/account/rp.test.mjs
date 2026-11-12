/**
 * WebAuthn 依赖方红线（命名 v2 一律不动；v6 P4 起旧账号会话 / reauth / reset / keys 删除，检查移到 v6 身份命令 POST /api/identity）：
 * - wrangler.toml 正式 SGX_RP_ID = "styrigx.com"、SGX_ORIGIN = "https://styrigx.com"（账号和网关两份）；rp.id 一变，所有通行密钥都失效
 * - 注册 challenge（passkey-add-challenge）的 rp.id === 'styrigx.com'、user.id = 已有钥匙的 handle（沿用，不新建第二个）；
 *   登录 / 借权 challenge（su-challenge / sudo-challenge）的 rpId === 'styrigx.com'
 * - 断言验证：rpIdHash 对不上、origin 对不上都拒（不签会话）
 *
 * 运行：node --test tests/workers/account/rp.test.mjs
 */
import './_cf-workers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeAccountD1 } from './_d1.mjs';
import { assertion, b64url, ORIGIN } from './_fixtures.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;
const SRC = REPO + 'workers/account/src/';
const { serviceFetch } = await import(SRC + 'rpc/account-service.js');
const { _resetSecretCache } = await import(SRC + 'secrets.js');
const { makePasswordRecord } = await import(SRC + 'core/password.js');

const PEPPER = 'pepper-account-test';
const PW = 'sty-pass-01';
let ipN = 0;
const freshIp = () => '198.51.100.' + (++ipN % 250);

async function setup(over = {}) {
  _resetSecretCache();
  const env = { SGX_ENV: 'production', SGX_RP_ID: 'styrigx.com', SGX_ORIGIN: ORIGIN, SGX_ACCOUNT_PASSWORD_PEPPER: PEPPER, D1_ACCOUNT: makeAccountD1(), ...over };
  const raw = env.D1_ACCOUNT.raw;
  raw.prepare("INSERT INTO account_users (uid, name, avatar, expires_at, epoch, disabled, created_at) VALUES (1000, 'styrigx', '', 0, 0, 0, 1)").run();
  for (const g of ['wheel', 'sudoers']) raw.prepare('INSERT INTO account_user_groups (uid, grp, added_at) VALUES (1000, ?, 1)').run(g);
  raw.prepare("INSERT INTO account_user_password (uid, record, pepper_id, must_change, expires_at) VALUES (1000, ?, 'account', 0, 0)").run(JSON.stringify(await makePasswordRecord(PW, PEPPER)));
  return env;
}

async function seedPasskey(env, handle, legacy = '') {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const credId = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const rec = { name: '', provider: 'samsung-pass', aaguid: '', createdAt: 1, lastUsedAt: 0, credId, publicKey: jwk, signCount: 0, uv: 1 };
  env.D1_ACCOUNT.raw.prepare('INSERT INTO account_user_passkey (credential_id, uid, user_handle, legacy_handle, record) VALUES (?, 1000, ?, ?, ?)').run(credId, handle, legacy, JSON.stringify(rec));
  return { kp, credId };
}

async function id(env, body, token) {
  const headers = { Origin: ORIGIN, 'CF-Connecting-IP': freshIp(), 'Content-Type': 'application/json' };
  if (token) headers.Cookie = 'sgx-session=' + token;
  const res = await serviceFetch(new Request(ORIGIN + '/api/identity', { method: 'POST', headers, body: JSON.stringify(body) }), env, { waitUntil() {} });
  let json = null;
  try { json = JSON.parse(await res.clone().text()); } catch (e) {}
  return { status: res.status, json, cookies: res.headers.getSetCookie() };
}
const tokenOf = (r) => { const c = r.cookies.find((x) => x.startsWith('sgx-session=')); return c ? c.split(';')[0].slice('sgx-session='.length) : ''; };
async function login(env) {
  const r = await id(env, { action: 'su', user: 'styrigx', password: PW });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return tokenOf(r);
}

test('wrangler.toml：账号和网关的 SGX_RP_ID / SGX_ORIGIN 钉死 styrigx.com', () => {
  for (const f of ['workers/account/wrangler.toml', 'workers/space-core/wrangler.toml']) {
    const toml = readFileSync(REPO + f, 'utf8');
    assert.match(toml, /^SGX_RP_ID = "styrigx\.com"$/m, f);
    assert.match(toml, /^SGX_ORIGIN = "https:\/\/styrigx\.com"$/m, f);
  }
});

test('注册 challenge（passkey-add-challenge）：rp.id === styrigx.com；user.id = 已有钥匙的 handle 并沿用；handle 一个字节都不动', async () => {
  const env = await setup();
  const a = await seedPasskey(env, 'HANDLE-original-bytes', 'LEGACY-original-bytes');
  const tok = await login(env);
  const j = (await id(env, { action: 'passkey-add-challenge', as: 1000 }, tok)).json;
  assert.equal(j.rp.id, 'styrigx.com');
  assert.equal(j.rpId, 'styrigx.com');
  assert.deepEqual([j.user.id, j.user.name, j.rp.name], ['HANDLE-original-bytes', 'styrigx', 'Styrigx']);
  assert.deepEqual(j.excludeCredentials.map((c) => c.id), [a.credId]);
  assert.deepEqual({ ...env.D1_ACCOUNT.raw.prepare('SELECT user_handle, legacy_handle FROM account_user_passkey').get() },
    { user_handle: 'HANDLE-original-bytes', legacy_handle: 'LEGACY-original-bytes' }, 'handle 一个字节都没动');
});

test('登录 / 借权 challenge（su-challenge / sudo-challenge）：rpId === styrigx.com', async () => {
  const env = await setup();
  await seedPasskey(env, 'h-sty');
  assert.equal((await id(env, { action: 'su-challenge' })).json.rpId, 'styrigx.com');
  const tok = await login(env);
  assert.equal((await id(env, { action: 'sudo-challenge' }, tok)).json.rpId, 'styrigx.com');
});

test('断言：rpIdHash 不对（别的 RP 签的）/ origin 不对 → 拒，不签会话', async () => {
  const env = await setup({ SGX_RP_ID: 'example.com' });
  const { kp, credId } = await seedPasskey(env, 'h-sty');
  const ch = (await id(env, { action: 'su-challenge' })).json;
  assert.equal(ch.rpId, 'example.com');
  const r = await id(env, { action: 'su', user: 'styrigx', cid: ch.cid, credential: await assertion(kp, credId, ch.challenge, 'h-sty') }); /* 断言按 styrigx.com 的 rpIdHash 签 */
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'auth');
  assert.equal(tokenOf(r), '', '不签会话');
  const env2 = await setup({ SGX_ORIGIN: 'https://other.example' });
  const k2 = await seedPasskey(env2, 'h-sty');
  const ch2 = (await id(env2, { action: 'su-challenge' })).json;
  const r2 = await id(env2, { action: 'su', user: 'styrigx', cid: ch2.cid, credential: await assertion(k2.kp, k2.credId, ch2.challenge, 'h-sty') });
  assert.equal(r2.status, 401);
  assert.equal(tokenOf(r2), '');
  /* 对照：同样的钥匙在对的 RP / origin 下能登（说明上面是被 rpIdHash / origin 拒的） */
  const env3 = await setup();
  const k3 = await seedPasskey(env3, 'h-sty');
  const ch3 = (await id(env3, { action: 'su-challenge' })).json;
  const r3 = await id(env3, { action: 'su', user: 'styrigx', cid: ch3.cid, credential: await assertion(k3.kp, k3.credId, ch3.challenge, 'h-sty') });
  assert.equal(r3.status, 200, JSON.stringify(r3.json));
});
