/**
 * 发通行密钥 challenge 的限速（报告修复 PR 10）：
 * - 单 IP 每 60 秒 20 个（su / sudo / self / passkey-add 四个入口共用），第 21 个 429 cooldown + Retry-After；
 *   别的 IP 不受影响；IPv6 同一个 /64 算一个桶；窗口过了重新数
 * - 全表未过期 challenge 上限（CHALLENGE_OUTSTANDING_MAX）：满了 429，过期的不算
 * - 计数出错 fail closed（503 server），不发 challenge
 * - bumpWindow 原子：并发的两次计数不会互相覆盖
 *
 * 运行：node --test tests/workers/account/challenge-limit.test.mjs
 */
import './_cf-workers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAccountD1 } from './_d1.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;
const SRC = REPO + 'workers/account/src/';
const { serviceFetch } = await import(SRC + 'rpc/account-service.js');
const { _resetSecretCache } = await import(SRC + 'secrets.js');
const { makePasswordRecord } = await import(SRC + 'core/password.js');
const { CHALLENGE_IP_LIMIT, CHALLENGE_OUTSTANDING_MAX } = await import(SRC + 'core/config.js');
const { bumpWindow } = await import(SRC + 'lib/attempt-limit.js');

const ORIGIN = 'https://styrigx.com';
const PEP = 'pepper-account-test';

async function setup() {
  _resetSecretCache();
  const env = {
    SGX_ENV: 'production', SGX_RP_ID: 'styrigx.com', SGX_ORIGIN: ORIGIN,
    SGX_ACCOUNT_PASSWORD_PEPPER: PEP,
    D1_ACCOUNT: makeAccountD1(),
    ASSETS: { fetch: async () => new Response('DEFAULT', { status: 200 }) },
  };
  const raw = env.D1_ACCOUNT.raw;
  raw.prepare('INSERT INTO account_users (uid, name, avatar, expires_at, epoch, disabled, created_at) VALUES (1000, \'styrigx\', \'\', 0, 0, 0, 1)').run();
  for (const g of ['wheel', 'sudoers']) raw.prepare('INSERT INTO account_user_groups (uid, grp, added_at) VALUES (1000, ?, 1)').run(g);
  const rec = await makePasswordRecord('sty-pass-01', PEP);
  raw.prepare('INSERT INTO account_user_password (uid, record, pepper_id, must_change, expires_at) VALUES (1000, ?, \'account\', 0, 0)').run(JSON.stringify(rec));
  return env;
}

async function id(env, body, ip, cookie) {
  const headers = { Origin: ORIGIN, 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = 'sgx-session=' + cookie;
  const res = await serviceFetch(new Request(ORIGIN + '/api/identity', { method: 'POST', headers, body: JSON.stringify(body) }), env, { waitUntil() {} });
  let json = null;
  try { json = JSON.parse(await res.clone().text()); } catch (e) {}
  return { res, status: res.status, json };
}
const challenges = (env) => env.D1_ACCOUNT.raw.prepare('SELECT COUNT(*) AS n FROM account_challenge').get().n;

test('单 IP 每窗口 20 个 challenge：第 21 个 429 cooldown + Retry-After；不多存；别的 IP 照发', async () => {
  const env = await setup();
  const ip = '198.51.100.10';
  assert.equal(CHALLENGE_IP_LIMIT.max, 20);
  for (let i = 0; i < CHALLENGE_IP_LIMIT.max; i++) {
    const r = await id(env, { action: 'su-challenge' }, ip);
    assert.equal(r.status, 200, 'first ' + (i + 1) + ': ' + JSON.stringify(r.json));
    assert.ok(r.json.cid && r.json.challenge);
  }
  const over = await id(env, { action: 'su-challenge' }, ip);
  assert.equal(over.status, 429);
  assert.equal(over.json.error, 'cooldown');
  const ra = Number(over.res.headers.get('Retry-After'));
  assert.ok(ra >= 1 && ra <= 60, 'Retry-After ' + ra);
  assert.equal(challenges(env), CHALLENGE_IP_LIMIT.max, '被挡的不存');
  const other = await id(env, { action: 'su-challenge' }, '198.51.100.11');
  assert.equal(other.status, 200, '别的 IP 不受影响');
});

test('IPv6 同一个 /64 共用一个桶', async () => {
  const env = await setup();
  for (let i = 0; i < CHALLENGE_IP_LIMIT.max; i++) {
    const r = await id(env, { action: 'su-challenge' }, '2001:db8:1:2::' + (i + 1).toString(16));
    assert.equal(r.status, 200);
  }
  assert.equal((await id(env, { action: 'su-challenge' }, '2001:db8:1:2:ffff::1')).status, 429, '同 /64 换后缀没用');
  assert.equal((await id(env, { action: 'su-challenge' }, '2001:db8:1:3::1')).status, 200, '别的 /64 照发');
});

test('sudo / self / passkey-add 的 challenge 也计数（和 su 共用一个桶）', async () => {
  const env = await setup();
  const ip = '198.51.100.20';
  const login = await id(env, { action: 'su', user: 'styrigx', password: 'sty-pass-01' }, '198.51.100.21');
  assert.equal(login.status, 200, JSON.stringify(login.json));
  const tok = login.res.headers.getSetCookie().find((c) => c.startsWith('sgx-session=')).split(';')[0].slice('sgx-session='.length);
  for (let i = 0; i < CHALLENGE_IP_LIMIT.max - 3; i++) assert.equal((await id(env, { action: 'su-challenge' }, ip)).status, 200);
  assert.equal((await id(env, { action: 'sudo-challenge' }, ip, tok)).status, 200);
  assert.equal((await id(env, { action: 'self-challenge' }, ip, tok)).status, 200);
  const add = await id(env, { action: 'passkey-add-challenge', as: 1000 }, ip, tok);
  assert.equal(add.status, 200, '第 20 个（add）照发');
  const add2 = await id(env, { action: 'passkey-add-challenge', as: 1000 }, ip, tok);
  assert.equal(add2.status, 429);
  assert.equal(add2.json.error, 'cooldown');
});

test('窗口过了重新数', async () => {
  const env = await setup();
  const ip = '198.51.100.30';
  for (let i = 0; i < CHALLENGE_IP_LIMIT.max; i++) await id(env, { action: 'su-challenge' }, ip);
  assert.equal((await id(env, { action: 'su-challenge' }, ip)).status, 429);
  env.D1_ACCOUNT.raw.prepare('UPDATE account_attempt_limit SET expires_at = ? WHERE kind = ?').run(Date.now() - 1, CHALLENGE_IP_LIMIT.kind);
  assert.equal((await id(env, { action: 'su-challenge' }, ip)).status, 200, '新窗口从 1 数');
  const row = env.D1_ACCOUNT.raw.prepare('SELECT count FROM account_attempt_limit WHERE kind = ?').get(CHALLENGE_IP_LIMIT.kind);
  assert.equal(row.count, 1);
});

test('全表未过期 challenge 满了 → 429；过期的不算', async () => {
  const env = await setup();
  const raw = env.D1_ACCOUNT.raw;
  const fut = Date.now() + 300000;
  const ins = raw.prepare('INSERT INTO account_challenge (id, purpose, challenge, expires_at) VALUES (?, \'v6-su\', \'x\', ?)');
  for (let i = 0; i < CHALLENGE_OUTSTANDING_MAX; i++) ins.run('c' + i, fut);
  const full = await id(env, { action: 'su-challenge' }, '198.51.100.40');
  assert.equal(full.status, 429);
  assert.equal(full.json.error, 'cooldown');
  assert.equal(challenges(env), CHALLENGE_OUTSTANDING_MAX, '满了不再存');
  raw.prepare('UPDATE account_challenge SET expires_at = ? WHERE id = \'c0\'').run(Date.now() - 1);
  const r = await id(env, { action: 'su-challenge' }, '198.51.100.41');
  assert.equal(r.status, 200, '过期的被清掉、腾出位置');
  assert.equal(challenges(env), CHALLENGE_OUTSTANDING_MAX);
});

test('计数出错 fail closed：503 server，不发 challenge', async () => {
  const env = await setup();
  env.D1_ACCOUNT.raw.exec('DROP TABLE account_attempt_limit');
  const r = await id(env, { action: 'su-challenge' }, '198.51.100.50');
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'server');
  assert.equal(challenges(env), 0);
});

test('bumpWindow 原子：并发计数不丢', async () => {
  const env = await setup();
  const o = { max: 100, windowMs: 60000 };
  const rs = await Promise.all(Array.from({ length: 30 }, () => bumpWindow(env, 'test-kind', 'b', o)));
  assert.deepEqual(rs.map((r) => r.count).sort((a, b) => a - b), Array.from({ length: 30 }, (_, i) => i + 1));
  assert.ok(rs.every((r) => r.allowed));
});
