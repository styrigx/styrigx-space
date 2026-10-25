/**
 * 临时 LockKey（2026-10-23，取代 Turnstile「访客进入」）。
 * 运行：node --test tests/workers/auth-gateway/lock-tempkey.test.mjs
 *
 * - 临时码：12 位 Crockford Base32，规范化（大小写 / 连字符 / 空格 / O→0、I L→1）
 * - 有效期：1–24 小时、3 / 7 / 15 / 30 天，别的一律 400
 * - /api/lock-tempkey：要 owner lock 会话 + 账号会话；list / create / revoke；名字只在主人侧
 * - /api/lock-tempkey-unlock：对 → visitor 会话 + 钥匙票；错 → 403，同 IP 连错 5 次 429
 * - middleware：visitor 会话没有钥匙票 / 钥匙被作废 → 当作没会话；访客打不开账号页
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

import * as TL from '../../../workers/auth-gateway/functions/_kernel/lock-tempkey.js';
import { onRequestPost as tempPost } from '../../../workers/auth-gateway/functions/api/lock-tempkey.js';
import { onRequestPost as unlockPost } from '../../../workers/auth-gateway/functions/api/lock-tempkey-unlock.js';
import { signSessionCookie } from '../../../workers/auth-gateway/functions/_kernel/lock-session.js';
import { signAccountTicket } from '../../../workers/auth-gateway/functions/_kernel/account-session.js';
import { onRequest as mw, verifySessionDetailed } from '../../../workers/auth-gateway/functions/_middleware.js';
import { API_ROUTES } from '../../../workers/auth-gateway/src/routes.js';

function pair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    pub: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}
const LOCK = pair();
const ACCT = pair();
const PEPPER = 'tk-pepper';

function makeKV() {
  const store = new Map();
  return {
    store,
    async get(k, type) {
      if (!store.has(k)) return null;
      const v = store.get(k).v;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v, opts) { store.set(k, { v: String(v), opts: opts || null }); },
    async delete(k) { store.delete(k); },
    async list({ prefix }) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

/* 账号登录的 epoch / 设备记录在另一个 KV（KV_ACCOUNT_LOGIN），临时钥匙不放这里 */
const ACCT_LOGIN_KV = makeKV();

function env(kv) {
  return {
    KV_LOCK_DOOR: kv,
    KV_ACCOUNT_LOGIN: ACCT_LOGIN_KV,
    SGX_LOCK_PRIVATE: LOCK.priv,
    SGX_LOCK_PUBLIC: LOCK.pub,
    SGX_ACCOUNT_PRIVATE: ACCT.priv,
    SGX_ACCOUNT_PUBLIC: ACCT.pub,
    SGX_PW_PEPPER: PEPPER,
    SGX_ENV: 'production',
    SGX_SITE: 'space',
  };
}

async function ownerCookies() {
  const lock = await signSessionCookie(LOCK.priv, 0, 'owner', 'owner');
  const acct = await signAccountTicket(ACCT.priv, 'password', 0, Date.now(), Date.now());
  return 'sgx-verified=' + lock + '; sgx-account=' + acct;
}

function post(url, body, cookie, ip) {
  const h = { 'Content-Type': 'application/json', Origin: 'https://styrigx.com' };
  if (cookie) h.Cookie = cookie;
  if (ip) h['CF-Connecting-IP'] = ip;
  return new Request(url, { method: 'POST', headers: h, body: JSON.stringify(body) });
}

const T = (body, cookie, kv) => tempPost({ request: post('https://styrigx.com/api/lock-tempkey', body, cookie), env: env(kv) });
const U = (code, kv, ip, cookie) => unlockPost({ request: post('https://styrigx.com/api/lock-tempkey-unlock', { code }, cookie, ip), env: env(kv) });

/** 从响应里取出 Cookie 头（只要 sgx-verified 带 Domain 的那条 + sgx-tk） */
function cookiesFrom(res) {
  return res.headers.getSetCookie()
    .filter((c) => (c.startsWith('sgx-verified=') && c.includes('Domain=') && !c.startsWith('sgx-verified=;')) || c.startsWith('sgx-tk='))
    .map((c) => c.split(';')[0])
    .join('; ');
}

/* ---------------- 内核 ---------------- */

test('临时码：12 位 Crockford Base32，显示 XXXX-XXXX-XXXX，规范化容错', () => {
  for (let i = 0; i < 50; i++) {
    const c = TL.newCode();
    assert.match(c, /^[0-9A-HJKMNP-TV-Z]{12}$/);
    assert.equal(TL.normalizeCode(TL.formatCode(c)), c);
    assert.equal(TL.normalizeCode(' ' + TL.formatCode(c).toLowerCase() + ' '), c);
  }
  assert.equal(TL.normalizeCode('o1il-ABCD-EFGH'), '0111ABCDEFGH');
  assert.equal(TL.normalizeCode('ABCD-EFGH-JKM'), '', '11 位');
  assert.equal(TL.normalizeCode('ABCD-EFGH-JKMU'), '', 'U 不在字母表');
  assert.equal(TL.normalizeCode(''), '');
});

test('有效期：1–24 小时 / 3 / 7 / 15 / 30 天，其它一律 0', () => {
  assert.equal(TL.durationMs({ hours: 1 }), 3600e3);
  assert.equal(TL.durationMs({ hours: 24 }), 24 * 3600e3);
  for (const d of [3, 7, 15, 30]) assert.equal(TL.durationMs({ days: d }), d * 24 * 3600e3);
  for (const bad of [{ hours: 0 }, { hours: 25 }, { hours: 1.5 }, { hours: '3' }, { days: 1 }, { days: 14 }, { days: 31 }, {}, { hours: 2, days: 3 }]) {
    assert.equal(TL.durationMs(bad), 0, JSON.stringify(bad));
  }
});

test('名字：去控制字符、去首尾空格、最多 24 字，可空', () => {
  assert.equal(TL.cleanName('  小明\u0007 '), '小明');
  assert.equal(TL.cleanName(undefined), '');
  assert.equal(TL.cleanName('一'.repeat(24)), '一'.repeat(24));
  assert.equal(TL.cleanName('一'.repeat(25)), null);
});

test('签发：KV 只存哈希不存临时码，带到期时间；找得到、作废后找不到并留作废标记', async () => {
  const kv = makeKV();
  const { key, code } = await TL.createTempkey(kv, PEPPER, { name: '小明', ms: 3600e3 });
  const raw = TL.normalizeCode(code);
  const dump = JSON.stringify([...kv.store.entries()]);
  assert.ok(!dump.includes(raw), 'KV 里不能出现明文临时码');
  for (const [, v] of kv.store) assert.ok(v.opts && v.opts.expiration > Date.now() / 1000, '每个键都带过期时间');
  assert.equal((await TL.findByCode(kv, PEPPER, raw)).id, key.id);
  assert.equal(await TL.findByCode(kv, 'other-pepper', raw), null, '换 pepper 对不上');
  assert.deepEqual((await TL.listTempkeys(kv)).map((k) => k.name), ['小明']);
  assert.equal(await TL.isTempkeyRevoked(kv, key.id), false);
  assert.equal(await TL.revokeTempkey(kv, key.id), true);
  assert.equal(await TL.findByCode(kv, PEPPER, raw), null);
  assert.equal(await TL.isTempkeyRevoked(kv, key.id), true);
  assert.deepEqual(await TL.listTempkeys(kv), []);
  assert.equal(await TL.revokeTempkey(kv, key.id), false, '再作废一次：不存在');
});

test('上限 20 把', async () => {
  const kv = makeKV();
  for (let i = 0; i < TL.TEMPKEY_MAX; i++) await TL.createTempkey(kv, PEPPER, { name: '', ms: 3600e3 });
  await assert.rejects(TL.createTempkey(kv, PEPPER, { name: '', ms: 3600e3 }), /full/);
});

/* ---------------- /api/lock-tempkey（管理） ---------------- */

test('管理接口：要同源 + owner lock 会话 + 账号会话', async () => {
  const kv = makeKV();
  const noOrigin = new Request('https://styrigx.com/api/lock-tempkey', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: await ownerCookies() }, body: '{"action":"list"}' });
  assert.equal((await tempPost({ request: noOrigin, env: env(kv) })).status, 403);
  assert.equal((await T({ action: 'list' }, '', kv)).status, 401);
  const lockOnly = 'sgx-verified=' + (await signSessionCookie(LOCK.priv, 0, 'owner', 'owner'));
  const r = await T({ action: 'list' }, lockOnly, kv);
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'account');
  const visitor = 'sgx-verified=' + (await signSessionCookie(LOCK.priv, 0, 'visitor', 'owner')) + '; sgx-tk=' + (await TL.signTk(env(kv), 'tktesttesttest01', Date.now() + 3600e3));
  assert.equal((await T({ action: 'list' }, visitor, kv)).status, 401, '访客不是主人');
});

test('管理接口：create → 只这一次返回临时码；list 有名字和到期；revoke', async () => {
  const kv = makeKV();
  const c = await ownerCookies();
  let r = await T({ action: 'create', name: ' 小红 ', days: 7 }, c, kv);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.match(j.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal(j.key.name, '小红');
  assert.ok(Math.abs(j.key.expiresAt - Date.now() - 7 * 24 * 3600e3) < 5000);
  r = await T({ action: 'list' }, c, kv);
  const list = (await r.json()).keys;
  assert.equal(list.length, 1);
  assert.equal(list[0].name, '小红');
  assert.ok(!('h' in list[0]) && !('code' in list[0]), 'list 不给哈希也不给码');
  assert.equal((await T({ action: 'create', hours: 25 }, c, kv)).status, 400);
  assert.equal((await T({ action: 'create', days: 14 }, c, kv)).status, 400);
  assert.equal((await T({ action: 'create', hours: 2, name: 'x'.repeat(25) }, c, kv)).status, 400);
  assert.equal((await T({ action: 'revoke', id: 'bad' }, c, kv)).status, 400);
  assert.equal((await T({ action: 'revoke', id: j.key.id }, c, kv)).status, 200);
  assert.equal((await T({ action: 'revoke', id: j.key.id }, c, kv)).status, 404);
});

/* ---------------- /api/lock-tempkey-unlock（进门） ---------------- */

test('进门：码对 → visitor 会话 + 钥匙票，Max-Age 不超过钥匙剩余时间', async () => {
  const kv = makeKV();
  const { code } = await TL.createTempkey(kv, PEPPER, { name: '', ms: 2 * 3600e3 });
  const r = await U(code.toLowerCase().replace(/-/g, ' '), kv, '1.1.1.1');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, role: 'visitor' });
  const sc = r.headers.getSetCookie();
  const v = sc.find((c) => c.startsWith('sgx-verified=') && c.includes('Domain='));
  const tk = sc.find((c) => c.startsWith('sgx-tk='));
  const age = (s) => parseInt(/Max-Age=(\d+)/.exec(s)[1], 10);
  assert.ok(age(v) <= 7200 && age(v) > 7100);
  assert.equal(age(tk), age(v));
  const sess = await verifySessionDetailed(new Request('https://styrigx.com/', { headers: { Cookie: cookiesFrom(r) } }), env(kv));
  assert.deepEqual([sess.ok, sess.role], [true, 'visitor']);
});

test('进门：30 天的钥匙，一次会话最长 12 小时', async () => {
  const kv = makeKV();
  const { code } = await TL.createTempkey(kv, PEPPER, { name: '', ms: 30 * 24 * 3600e3 });
  const r = await U(code, kv, '1.1.1.2');
  assert.ok(r.headers.getSetCookie().find((c) => c.startsWith('sgx-tk=')).includes('Max-Age=43200'));
});

test('进门：码错 403 wrong；同 IP 连错 5 次 429 locked，锁定后码对也进不去', async () => {
  const kv = makeKV();
  const { code } = await TL.createTempkey(kv, PEPPER, { name: '', ms: 3600e3 });
  for (let i = 0; i < 4; i++) {
    const r = await U('AAAA-BBBB-CCCC', kv, '9.9.9.9');
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, 'wrong');
    assert.equal(r.headers.get('Set-Cookie'), null);
  }
  const fifth = await U('short', kv, '9.9.9.9');
  assert.equal(fifth.status, 429, '格式不对也算一次');
  assert.equal((await U(code, kv, '9.9.9.9')).status, 429);
  assert.equal((await U(code, kv, '8.8.8.8')).status, 200, '别的 IP 不受影响');
});

test('进门：已经是主人 → ok，不降级成访客、不下发 cookie', async () => {
  const kv = makeKV();
  const owner = 'sgx-verified=' + (await signSessionCookie(LOCK.priv, 0, 'owner', 'owner'));
  const r = await U('AAAA-BBBB-CCCC', kv, '1.2.3.4', owner);
  assert.deepEqual(await r.json(), { ok: true, role: 'owner' });
  assert.equal(r.headers.get('Set-Cookie'), null);
});

test('进门：缺 pepper 503，KV 坏了 503，都不签会话', async () => {
  const kv = makeKV();
  const e = env(kv);
  delete e.SGX_PW_PEPPER;
  let r = await unlockPost({ request: post('https://styrigx.com/api/lock-tempkey-unlock', { code: 'AAAA-BBBB-CCCC' }), env: e });
  assert.equal(r.status, 503);
  const bad = { get: async () => { throw new Error('kv'); }, put: async () => { throw new Error('kv'); }, delete: async () => {}, list: async () => ({ keys: [] }) };
  r = await unlockPost({ request: post('https://styrigx.com/api/lock-tempkey-unlock', { code: 'AAAA-BBBB-CCCC' }), env: env(bad) });
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('Set-Cookie'), null);
});

/* ---------------- middleware ---------------- */

async function visitorFor(kv) {
  const { key, code } = await TL.createTempkey(kv, PEPPER, { name: '', ms: 3600e3 });
  const r = await U(code, kv, '5.5.5.5');
  return { key, cookie: cookiesFrom(r) };
}

const page = (path, cookie) => new Request('https://styrigx.com' + path, { headers: cookie ? { Cookie: cookie } : {} });
const next = async () => new Response('<html><body>PAGE</body></html>', { headers: { 'Content-Type': 'text/html' } });

test('middleware：访客会话没有钥匙票 → 无效（以前 Turnstile 签的访客会话不再认）', async () => {
  const kv = makeKV();
  const bare = 'sgx-verified=' + (await signSessionCookie(LOCK.priv, 0, 'visitor', 'owner'));
  const s = await verifySessionDetailed(page('/', bare), env(kv));
  assert.equal(s.ok, false);
  assert.equal(s.reason, 'no-tk');
  const res = await mw({ request: page('/blog/', bare), env: env(kv), next });
  assert.equal(res.status, 302);
});

test('middleware：钥匙票签名不对 / 和别的 lock 私钥签的 → 无效', async () => {
  const kv = makeKV();
  const { cookie } = await visitorFor(kv);
  const other = pair();
  const forged = cookie.replace(/sgx-tk=[^;]+/, 'sgx-tk=' + (await TL.signTk({ SGX_LOCK_PRIVATE: other.priv }, 'tktesttesttest01', Date.now() + 3600e3)));
  assert.equal((await verifySessionDetailed(page('/', forged), env(kv))).reason, 'bad-tk');
});

test('middleware：作废钥匙 → 拿它进来的访客下一个请求就进不来；主人不受影响', async () => {
  const kv = makeKV();
  const { key, cookie } = await visitorFor(kv);
  assert.equal((await mw({ request: page('/blog/', cookie), env: env(kv), next })).status, 200);
  await TL.revokeTempkey(kv, key.id);
  const s = await verifySessionDetailed(page('/', cookie), env(kv));
  assert.equal(s.reason, 'tk-revoked');
  assert.equal((await mw({ request: page('/blog/', cookie), env: env(kv), next })).status, 302);
  const owner = 'sgx-verified=' + (await signSessionCookie(LOCK.priv, 0, 'owner', 'owner'));
  assert.equal((await mw({ request: page('/blog/', owner), env: env(kv), next })).status, 200);
});

test('middleware：访客打不开账号页（302 回首页），也调不了临时钥匙管理接口', async () => {
  const kv = makeKV();
  const { cookie } = await visitorFor(kv);
  for (const p of ['/account/', '/account/tempkeys/', '/en/account/devices/']) {
    const res = await mw({ request: page(p, cookie), env: env(kv), next });
    assert.equal(res.status, 302, p);
    assert.equal(res.headers.get('Location'), 'https://styrigx.com' + (p.startsWith('/en/') ? '/en/' : '/'));
  }
  const api = await mw({ request: post('https://styrigx.com/api/lock-tempkey', { action: 'list' }, cookie), env: env(kv), next });
  assert.equal(api.status, 403);
});

test('middleware：/api/lock-tempkey-unlock 无会话可达（白名单），/api/verify 已删除', async () => {
  const kv = makeKV();
  let hit = false;
  const res = await mw({ request: post('https://styrigx.com/api/lock-tempkey-unlock', { code: 'x' }), env: env(kv), next: async () => { hit = true; return Response.json({ ok: false }); } });
  assert.equal(hit, true);
  assert.notEqual(res.status, 401);
  assert.equal(API_ROUTES.has('/api/verify'), false);
  assert.equal(API_ROUTES.has('/api/lock-tempkey'), true);
  assert.equal(API_ROUTES.has('/api/lock-tempkey-unlock'), true);
});
