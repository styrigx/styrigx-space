/**
 * 临时 LockKey（2026-10-23，取代 Turnstile「访客进入」）。
 * 运行：node --test tests/workers/auth-gateway/lock-tempkey.test.mjs
 *
 * - 临时码：12 位 Crockford Base32，规范化（大小写 / 连字符 / 空格 / O→0、I L→1）
 * - 有效期：1–24 小时、3 / 7 / 15 / 30 天，别的一律 400
 * - /api/lock-tempkey：要 admin lock 会话 + 账号会话；list / create / revoke；名字只在管理员侧
 * - /api/lock-tempkey-unlock：对 → visitor 锁屏会话（by=tempkey，票里带 tempkeyId）；错 → 403，同 IP 连错 5 次 429
 * - middleware：visitor 会话没有 tempkeyId / 钥匙被作废 → 当作没会话；访客打不开账号页
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

import * as TL from '../../../workers/auth-gateway/functions/_kernel/lock-tempkey.js';
import { onRequestPost as tempPost } from '../../../workers/auth-gateway/functions/api/lock-tempkey.js';
import { onRequestPost as unlockPost } from '../../../workers/auth-gateway/functions/api/lock-tempkey-unlock.js';
import { ed25519Sign } from '../../../workers/shared/crypto.js';
import { onRequest as mw } from '../../../workers/auth-gateway/functions/_middleware.js';
import { verifyLockSession } from '../../../workers/auth-gateway/functions/_kernel/lock-session.js';
import { API_ROUTES } from '../../../workers/auth-gateway/src/routes.js';
import { testLockSession, testAccountSession } from './_tickets.mjs';
import { makeAuthD1 } from '../_harness.mjs';

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

/* 网关全部认证状态在 D1（三个绑定同一个库）；没有任何 KV 绑定。测试里的 db 就是 makeAuthD1() 的替身 */
function env(db) {
  return {
    D1_LOCK_AUTH: db, D1_ACCOUNT_AUTH: db, D1_ROOT_AUTH: db,
    SGX_LOCK_PRIVATE: LOCK.priv,
    SGX_LOCK_PUBLIC: LOCK.pub,
    SGX_ACCOUNT_PRIVATE: ACCT.priv,
    SGX_ACCOUNT_PUBLIC: ACCT.pub,
    SGX_PW_PEPPER: PEPPER,
    SGX_ENV: 'production',
    SGX_SITE: 'space',
  };
}

async function adminCookies() {
  const lock = await testLockSession(LOCK.priv, 0, 'admin', 'password');
  const acct = await testAccountSession(ACCT.priv, 'password', 0, Date.now(), Date.now());
  return 'sgx-lock-session=' + lock + '; sgx-account-session=' + acct;
}

function post(url, body, cookie, ip) {
  const h = { 'Content-Type': 'application/json', Origin: 'https://styrigx.com' };
  if (cookie) h.Cookie = cookie;
  if (ip) h['CF-Connecting-IP'] = ip;
  return new Request(url, { method: 'POST', headers: h, body: JSON.stringify(body) });
}

const T = (body, cookie, db) => tempPost({ request: post('https://styrigx.com/api/lock-tempkey', body, cookie), env: env(db) });
const U = (code, db, ip, cookie) => unlockPost({ request: post('https://styrigx.com/api/lock-tempkey-unlock', { code }, cookie, ip), env: env(db) });

/** 从响应里取出 Cookie 头（只要 sgx-lock-session 带 Domain 的那条） */
function cookiesFrom(res) {
  return res.headers.getSetCookie()
    .filter((c) => c.startsWith('sgx-lock-session=') && c.includes('Domain=') && !c.startsWith('sgx-lock-session=;'))
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

test('签发：D1 只存哈希不存临时码，带到期时间；找得到、作废后找不到，行留着并记 revoked_at', async () => {
  const db = makeAuthD1();
  const e = env(db);
  const before = Date.now();
  const { key, code } = await TL.createTempkey(e, PEPPER, { name: '小明', ms: 3600e3 });
  const raw = TL.normalizeCode(code);
  const dump = JSON.stringify(db.rows('tempkey'));
  assert.ok(!dump.includes(raw), 'D1 里不能出现明文临时码');
  const rows = db.rows('tempkey');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].realm, 'lock');
  assert.equal(rows[0].id, key.id);
  assert.equal(rows[0].revoked_at, 0);
  assert.ok(rows[0].expires_at >= before + 3600e3 && rows[0].expires_at <= Date.now() + 3600e3, '行带到期时间');
  assert.equal((await TL.findByCode(e, PEPPER, raw)).id, key.id);
  assert.equal(await TL.findByCode(e, 'other-pepper', raw), null, '换 pepper 对不上');
  assert.deepEqual((await TL.listTempkeys(e)).map((k) => k.name), ['小明']);
  assert.equal(await TL.isTempkeyRevoked(e, key.id), false);
  assert.equal(await TL.revokeTempkey(e, key.id), true);
  assert.equal(await TL.findByCode(e, PEPPER, raw), null);
  assert.equal(await TL.isTempkeyRevoked(e, key.id), true);
  assert.equal(await TL.getTempkey(e, key.id), null);
  assert.deepEqual(await TL.listTempkeys(e), []);
  const after = db.rows('tempkey');
  assert.equal(after.length, 1, '作废不删行');
  assert.ok(after[0].revoked_at > 0, '作废标记 = revoked_at');
  assert.equal(await TL.revokeTempkey(e, key.id), false, '再作废一次：不存在');
});

test('上限 20 把；作废的不占上限', async () => {
  const e = env(makeAuthD1());
  const keys = [];
  for (let i = 0; i < TL.TEMPKEY_MAX; i++) keys.push((await TL.createTempkey(e, PEPPER, { name: '', ms: 3600e3 })).key);
  await assert.rejects(TL.createTempkey(e, PEPPER, { name: '', ms: 3600e3 }), /full/);
  assert.equal(await TL.revokeTempkey(e, keys[0].id), true);
  await TL.createTempkey(e, PEPPER, { name: '', ms: 3600e3 });
  await assert.rejects(TL.createTempkey(e, PEPPER, { name: '', ms: 3600e3 }), /full/);
});

test('D1 行（第 5 层）：tempkey 表 realm=lock、code_hash 唯一；码哈希域串 lock-tempkey|；不碰 KV', async () => {
  const db = makeAuthD1();
  const e = env(db);
  const { key, code } = await TL.createTempkey(e, PEPPER, { name: '', ms: 3600e3 });
  const raw = TL.normalizeCode(code);
  const h = await TL.hashCode(PEPPER, raw);
  const { createHash } = await import('node:crypto');
  assert.equal(h, createHash('sha256').update('lock-tempkey|' + PEPPER + '|' + raw).digest('hex'));
  const row = db.rows('tempkey').find((r) => r.id === key.id);
  assert.ok(row);
  assert.deepEqual([row.realm, row.code_hash, row.link], ['lock', h, 0]);
  assert.throws(() => db.raw.prepare('INSERT INTO tempkey (realm, id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run('lock', 'dupdupdupdupdup1', h, 1, Date.now() + 1e6), /UNIQUE/i, 'code_hash 唯一');
  await TL.revokeTempkey(e, key.id);
  assert.ok(db.rows('tempkey').find((r) => r.id === key.id).revoked_at > 0);
  /* env 里放一个碰一下就抛错的 KV：内核不读也不写 KV */
  const trap = new Proxy({}, { get() { throw new Error('KV touched'); } });
  const e2 = { ...env(makeAuthD1()), KV_LOCK_DOOR: trap, KV_ACCOUNT_LOGIN: trap };
  const k2 = await TL.createTempkey(e2, PEPPER, { name: 'x', ms: 3600e3 });
  await TL.findByCode(e2, PEPPER, TL.normalizeCode(k2.code));
  await TL.listTempkeys(e2);
  await TL.isTempkeyRevoked(e2, k2.key.id);
  await TL.revokeTempkey(e2, k2.key.id);
});

test('作废立即生效：revoke 后紧接着的下一次校验（isTempkeyRevoked / findByCode / 访客会话）就不认', async () => {
  const db = makeAuthD1();
  const e = env(db);
  const { key, code } = await TL.createTempkey(e, PEPPER, { name: '', ms: 3600e3 });
  const r = await U(code, db, '6.6.6.6');
  assert.equal(r.status, 200);
  const cookie = cookiesFrom(r);
  const req = () => new Request('https://styrigx.com/', { headers: { Cookie: cookie } });
  assert.equal((await verifyLockSession(req(), e)).ok, true);
  assert.equal(await TL.revokeTempkey(e, key.id), true);
  /* 紧接着的下一次读，不等任何传播 */
  const s = await verifyLockSession(req(), e);
  assert.equal(s.ok, false);
  assert.equal(s.reason, 'tempkey-revoked');
  assert.equal(await TL.isTempkeyRevoked(e, key.id), true);
  assert.equal(await TL.findByCode(e, PEPPER, TL.normalizeCode(code)), null);
  const again = await U(code, db, '6.6.6.7');
  assert.equal(again.status, 403, '作废后临时码进不来');
  assert.equal(again.headers.get('Set-Cookie'), null);
});

test('过期立即不认：行还没被清掉（expires_at 已过、revoked_at = 0）也进不来、不在列表、不占上限', async () => {
  const db = makeAuthD1();
  const e = env(db);
  const { key, code } = await TL.createTempkey(e, PEPPER, { name: '过期', ms: 3600e3 });
  const raw = TL.normalizeCode(code);
  /* 直接把到期时间改到过去，不走任何清理 */
  db.raw.prepare('UPDATE tempkey SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, key.id);
  assert.equal(db.rows('tempkey').length, 1, '行还在');
  assert.equal(await TL.findByCode(e, PEPPER, raw), null);
  assert.equal(await TL.getTempkey(e, key.id), null);
  assert.deepEqual(await TL.listTempkeys(e), []);
  assert.equal(await TL.revokeTempkey(e, key.id), false);
  const r = await U(code, db, '7.7.7.7');
  assert.equal(r.status, 403);
  assert.equal(r.headers.get('Set-Cookie'), null);
  for (let i = 0; i < TL.TEMPKEY_MAX; i++) await TL.createTempkey(e, PEPPER, { name: '', ms: 3600e3 });
  assert.ok(!db.rows('tempkey').some((x) => x.id === key.id), '签发新钥匙时顺手清掉过期行');
});

/* ---------------- /api/lock-tempkey（管理） ---------------- */

test('管理接口：要同源 + admin lock 会话 + 账号会话', async () => {
  const db = makeAuthD1();
  const noOrigin = new Request('https://styrigx.com/api/lock-tempkey', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: await adminCookies() }, body: '{"action":"list"}' });
  assert.equal((await tempPost({ request: noOrigin, env: env(db) })).status, 403);
  assert.equal((await T({ action: 'list' }, '', db)).status, 401);
  const lockOnly = 'sgx-lock-session=' + (await testLockSession(LOCK.priv, 0, 'admin', 'password'));
  const r = await T({ action: 'list' }, lockOnly, db);
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'account');
  const visitor = 'sgx-lock-session=' + (await testLockSession(LOCK.priv, 0, 'visitor'));
  assert.equal((await T({ action: 'list' }, visitor, db)).status, 401, '访客不是管理员');
});

test('管理接口：create → 只这一次返回临时码；list 有名字和到期；revoke', async () => {
  const db = makeAuthD1();
  const c = await adminCookies();
  let r = await T({ action: 'create', name: ' 小红 ', days: 7 }, c, db);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.match(j.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal(j.key.name, '小红');
  assert.ok(Math.abs(j.key.expiresAt - Date.now() - 7 * 24 * 3600e3) < 5000);
  r = await T({ action: 'list' }, c, db);
  const list = (await r.json()).keys;
  assert.equal(list.length, 1);
  assert.equal(list[0].name, '小红');
  assert.ok(!('h' in list[0]) && !('code' in list[0]), 'list 不给哈希也不给码');
  assert.equal((await T({ action: 'create', hours: 25 }, c, db)).status, 400);
  assert.equal((await T({ action: 'create', days: 14 }, c, db)).status, 400);
  assert.equal((await T({ action: 'create', hours: 2, name: 'x'.repeat(25) }, c, db)).status, 400);
  assert.equal((await T({ action: 'revoke', id: 'bad' }, c, db)).status, 400);
  assert.equal((await T({ action: 'revoke', id: j.key.id }, c, db)).status, 200);
  assert.equal((await T({ action: 'revoke', id: j.key.id }, c, db)).status, 404);
});

/* ---------------- /api/lock-tempkey-unlock（进门） ---------------- */

test('进门：码对 → visitor 会话（by=tempkey、带 tempkeyId），Max-Age 不超过钥匙剩余时间', async () => {
  const db = makeAuthD1();
  const { key, code } = await TL.createTempkey(env(db), PEPPER, { name: '', ms: 2 * 3600e3 });
  const r = await U(code.toLowerCase().replace(/-/g, ' '), db, '1.1.1.1');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, role: 'visitor' });
  const sc = r.headers.getSetCookie();
  const v = sc.find((c) => c.startsWith('sgx-lock-session=') && c.includes('Domain='));
  const age = (s) => parseInt(/Max-Age=(\d+)/.exec(s)[1], 10);
  assert.ok(age(v) <= 7200 && age(v) > 7100);
  assert.equal(sc.find((c) => c.startsWith('sgx-tk=')), undefined, '不再有单独的钥匙票');
  const val = v.split(';')[0].slice('sgx-lock-session='.length).split('.');
  assert.deepEqual([val[0], val[1], val[4]], ['tempkey', 'visitor', key.id]);
  const sess = await verifyLockSession(new Request('https://styrigx.com/', { headers: { Cookie: cookiesFrom(r) } }), env(db));
  assert.deepEqual([sess.ok, sess.role, sess.by, sess.tempkeyId], [true, 'visitor', 'tempkey', key.id]);
});

test('进门：30 天的钥匙，一次会话最长 12 小时', async () => {
  const db = makeAuthD1();
  const { code } = await TL.createTempkey(env(db), PEPPER, { name: '', ms: 30 * 24 * 3600e3 });
  const r = await U(code, db, '1.1.1.2');
  assert.ok(r.headers.getSetCookie().find((c) => c.startsWith('sgx-lock-session=') && c.includes('Domain=')).includes('Max-Age=43200'));
});

test('进门：码错 403 wrong；同 IP 连错 5 次 429 locked，锁定后码对也进不去', async () => {
  const db = makeAuthD1();
  const { code } = await TL.createTempkey(env(db), PEPPER, { name: '', ms: 3600e3 });
  for (let i = 0; i < 4; i++) {
    const r = await U('AAAA-BBBB-CCCC', db, '9.9.9.9');
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, 'wrong');
    assert.equal(r.headers.get('Set-Cookie'), null);
  }
  const fifth = await U('short', db, '9.9.9.9');
  assert.equal(fifth.status, 429, '格式不对也算一次');
  assert.equal((await U(code, db, '9.9.9.9')).status, 429);
  assert.equal((await U(code, db, '8.8.8.8')).status, 200, '别的 IP 不受影响');
});

test('进门：已经是管理员 → ok，不降级成访客、不下发 cookie', async () => {
  const db = makeAuthD1();
  const admin = 'sgx-lock-session=' + (await testLockSession(LOCK.priv, 0, 'admin', 'password'));
  const r = await U('AAAA-BBBB-CCCC', db, '1.2.3.4', admin);
  assert.deepEqual(await r.json(), { ok: true, role: 'admin' });
  assert.equal(r.headers.get('Set-Cookie'), null);
});

test('进门：缺 pepper 503，D1 坏了 503、没绑 500，都不签会话', async () => {
  const db = makeAuthD1();
  const e = env(db);
  delete e.SGX_PW_PEPPER;
  let r = await unlockPost({ request: post('https://styrigx.com/api/lock-tempkey-unlock', { code: 'AAAA-BBBB-CCCC' }), env: e });
  assert.equal(r.status, 503);
  const bad = makeAuthD1();
  bad.failOn = () => true;
  r = await unlockPost({ request: post('https://styrigx.com/api/lock-tempkey-unlock', { code: 'AAAA-BBBB-CCCC' }), env: env(bad) });
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('Set-Cookie'), null);
  const unbound = env(db);
  delete unbound.D1_LOCK_AUTH;
  r = await unlockPost({ request: post('https://styrigx.com/api/lock-tempkey-unlock', { code: 'AAAA-BBBB-CCCC' }), env: unbound });
  assert.equal(r.status, 500, 'D1_LOCK_AUTH 没绑：配置错误');
  assert.equal((await r.clone().json()).error, 'config');
  assert.equal(r.headers.get('Set-Cookie'), null);
});

/* ---------------- middleware ---------------- */

async function visitorFor(db) {
  const { key, code } = await TL.createTempkey(env(db), PEPPER, { name: '', ms: 3600e3 });
  const r = await U(code, db, '5.5.5.5');
  return { key, cookie: cookiesFrom(r) };
}

const page = (path, cookie) => new Request('https://styrigx.com' + path, { headers: cookie ? { Cookie: cookie } : {} });
const next = async () => new Response('<html><body>PAGE</body></html>', { headers: { 'Content-Type': 'text/html' } });

test('middleware：visitor 会话没有 tempkeyId（以前 Turnstile 签的访客会话 / 旧格式）→ 无效', async () => {
  const db = makeAuthD1();
  const payload = 'tempkey.visitor.0.' + (Date.now() + 3600e3) + '.';
  const sig = await ed25519Sign(LOCK.priv, 'sgx-lock-session|' + payload);
  const bare = 'sgx-lock-session=' + payload + '.' + sig;
  const s = await verifyLockSession(page('/', bare), env(db));
  assert.equal(s.ok, false);
  assert.equal(s.reason, 'bad-format');
  const res = await mw({ request: page('/blog/', bare), env: env(db), next });
  assert.equal(res.status, 302);
});

test('middleware：visitor 会话签名不对 / 别的 lock 私钥签的 / 改了 tempkeyId → 无效', async () => {
  const db = makeAuthD1();
  const { cookie } = await visitorFor(db);
  const other = pair();
  const forged = 'sgx-lock-session=' + (await testLockSession(other.priv, 0, 'visitor'));
  assert.equal((await verifyLockSession(page('/', forged), env(db))).reason, 'bad-sig');
  const p = cookie.slice('sgx-lock-session='.length).split('.');
  p[4] = 'tktesttesttest99';
  assert.equal((await verifyLockSession(page('/', 'sgx-lock-session=' + p.join('.')), env(db))).reason, 'bad-sig');
});

test('middleware：作废钥匙 → 拿它进来的访客下一个请求就进不来；管理员不受影响', async () => {
  const db = makeAuthD1();
  const { key, cookie } = await visitorFor(db);
  assert.equal((await mw({ request: page('/blog/', cookie), env: env(db), next })).status, 200);
  await TL.revokeTempkey(env(db), key.id);
  const s = await verifyLockSession(page('/', cookie), env(db));
  assert.equal(s.reason, 'tempkey-revoked');
  assert.equal((await mw({ request: page('/blog/', cookie), env: env(db), next })).status, 302);
  const admin = 'sgx-lock-session=' + (await testLockSession(LOCK.priv, 0, 'admin', 'password'));
  assert.equal((await mw({ request: page('/blog/', admin), env: env(db), next })).status, 200);
});

test('middleware：访客打不开账号页（302 回首页），也调不了临时钥匙管理接口', async () => {
  const db = makeAuthD1();
  const { cookie } = await visitorFor(db);
  for (const p of ['/account/', '/account/tempkeys/', '/en/account/devices/']) {
    const res = await mw({ request: page(p, cookie), env: env(db), next });
    assert.equal(res.status, 302, p);
    assert.equal(res.headers.get('Location'), 'https://styrigx.com' + (p.startsWith('/en/') ? '/en/' : '/'));
  }
  const api = await mw({ request: post('https://styrigx.com/api/lock-tempkey', { action: 'list' }, cookie), env: env(db), next });
  assert.equal(api.status, 403);
});

test('middleware：/api/lock-tempkey-unlock 无会话可达（白名单），/api/verify 已删除', async () => {
  const db = makeAuthD1();
  let hit = false;
  const res = await mw({ request: post('https://styrigx.com/api/lock-tempkey-unlock', { code: 'x' }), env: env(db), next: async () => { hit = true; return Response.json({ ok: false }); } });
  assert.equal(hit, true);
  assert.notEqual(res.status, 401);
  assert.equal(API_ROUTES.has('/api/verify'), false);
  assert.equal(API_ROUTES.has('/api/lock-tempkey'), true);
  assert.equal(API_ROUTES.has('/api/lock-tempkey-unlock'), true);
});
