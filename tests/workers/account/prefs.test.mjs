/**
 * 账号云同步 /api/prefs（2026-10-22）：admin lock 会话 + 账号会话；逐项新的赢。
 *
 * 2026-10-24 搬到账号 Worker styrigx-account（workers/account）；会话经网关 verifier.js（_auth.mjs），登录流程仍用网关的 /api/account。
 *
 * 2026-10-28 存储从 KV_SETTINGS_SYNC（account-prefs）搬到 D1_SETTINGS_SYNC（D1 styrigx-account 的 settings_sync）：
 * 逐项新的赢在 SQL 里原子完成（旧 t 写不进、并发写不丢）、运行时不碰任何 KV、表不存在时自愈。
 *
 * 运行：node --test tests/workers/account/prefs.test.mjs
 */
import { wrap } from './_auth.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { testLockSession, testAccountSession } from '../auth-gateway/_tickets.mjs';
import { makeKV, genKeyPair, authD1For, forbiddenKV } from '../_harness.mjs';
import { makeAccountD1 } from './_d1.mjs';

const API = '../../../workers/auth-gateway/functions/api/';
const PREFS = '../../../workers/account/src/api/prefs.js';
const KERNEL = '../../../workers/auth-gateway/functions/_kernel/';

let LOCK, ACCOUNT, OTHER;
const ROOT_KEY = 'test-root-key-account-123';
const PEPPER = 'test-pepper-acc';

/** 同一份 kv（一次测试）对应同一个账号库替身 */
const accountD1ByKv = new WeakMap();
function accountD1For(kv) {
  let d = accountD1ByKv.get(kv);
  if (!d) { d = makeAccountD1(); accountD1ByKv.set(kv, d); }
  return d;
}

function envFor(kv, overrides = {}) {
  return {
    KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv, /* 只给网关替身当认证库导入来源；账号 Worker 不读 */
    D1_SETTINGS_SYNC: accountD1For(kv),
    D1_LOCK_AUTH: authD1For(kv), D1_ACCOUNT_AUTH: authD1For(kv), D1_ROOT_AUTH: authD1For(kv), /* 网关 AuthVerifier 读纪元（D1） */
    SGX_ROOT_KEY: ROOT_KEY,
    SGX_LOCK_PRIVATE: LOCK.priv,
    SGX_LOCK_PUBLIC: LOCK.pub,
    SGX_ACCOUNT_PRIVATE: ACCOUNT.priv,
    SGX_ACCOUNT_PUBLIC: ACCOUNT.pub,
    SGX_PW_PEPPER: PEPPER,
    SGX_RP_ID: 'styrigx.com',
    SGX_ORIGIN: 'https://styrigx.com',
    ...overrides,
  };
}

function getReq(url, headers = {}) {
  return new Request(url, { method: 'GET', headers });
}

async function adminSess(epoch = 0) {
  const { signLockSessionTicket } = await import(KERNEL + 'lock-session.js');
  return await testLockSession(LOCK.priv, epoch, 'admin', 'password');
}
async function visitorSess() {
  const { signLockSessionTicket } = await import(KERNEL + 'lock-session.js');
  return await testLockSession(LOCK.priv, 0, 'visitor');
}
async function accTicket(by = 'password', authAt = Date.now(), epoch = 0, priv) {
  const { signAccountSessionTicket } = await import(KERNEL + 'account-session.js');
  return await testAccountSession(priv || ACCOUNT.priv, by, epoch, authAt);
}
function cookies(o) {
  return Object.entries(o).filter(([, v]) => v).map(([k, v]) => k + '=' + v).join('; ');
}
function setCookies(res) {
  return res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('Set-Cookie') || ''];
}
function pickCookie(res, name) {
  for (const c of setCookies(res)) {
    if (c.startsWith(name + '=')) return c.split(';')[0].slice(name.length + 1);
  }
  return null;
}

async function accountGet(kv, cookieObj, envOverrides) {
  const { onRequestGet } = await import(API + 'account.js');
  return await onRequestGet({ request: getReq('https://styrigx.com/api/account', { Cookie: cookies(cookieObj) }), env: envFor(kv, envOverrides) });
}
async function seedPassword(kv, pw) {
  const { makePasswordRecord } = await import('../../../workers/account/src/lib/password.js');
  await kv.put('account-password', JSON.stringify(await makePasswordRecord(pw, PEPPER)));
}


async function prefsCall(kv, method, body, cookieObj, origin, envOverrides) {
  const mod = await import(PREFS);
  const m = { onRequestGet: wrap(mod.onRequestGet), onRequestPost: wrap(mod.onRequestPost) };
  const headers = { Cookie: cookies(cookieObj) };
  const env = envFor(kv, envOverrides);
  if (method === 'GET') return await m.onRequestGet({ request: new Request('https://styrigx.com/api/prefs', { headers }), env });
  const req = new Request('https://styrigx.com/api/prefs', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Origin: origin || 'https://styrigx.com' }, body: JSON.stringify(body) });
  return await m.onRequestPost({ request: req, env });
}
async function adminCo() {
  return { 'sgx-lock-session': await adminSess(), 'sgx-account-session': await accTicket() };
}

/* 测试钥匙：before 里生成（不算一条用例，单独跑某条用例时也会先执行） */
before(async () => {
  LOCK = await genKeyPair(); ACCOUNT = await genKeyPair(); OTHER = await genKeyPair();
});

test('要 admin lock 会话 + 账号会话：缺一个都 401', async () => {
  const kv = makeKV();
  assert.equal((await prefsCall(kv, 'GET', null, {})).status, 401);
  const sess = await adminSess();
  const r = await prefsCall(kv, 'GET', null, { 'sgx-lock-session': sess });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'account');
  const vis = await visitorSess();
  assert.equal((await prefsCall(kv, 'GET', null, { 'sgx-lock-session': vis, 'sgx-account-session': await accTicket() })).status, 401);
  const ok = await prefsCall(kv, 'GET', null, { 'sgx-lock-session': sess, 'sgx-account-session': await accTicket() });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).items, {});
});

test('POST 合并：逐项新的赢；旧的不覆盖；非 sgx- key / 未来时间 / 超长值丢掉', async () => {
  const kv = makeKV();
  const co = { 'sgx-lock-session': await adminSess(), 'sgx-account-session': await accTicket() };
  const now = Date.now();
  let r = await prefsCall(kv, 'POST', { changes: {
    'sgx-theme-mode': { v: 'dark', t: now - 1000 },
    'sgx-palette': { v: 'mint', t: now - 1000 },
    'evil': { v: 'x', t: now },
    'sgx-future': { v: 'x', t: now + 3600e3 },
    'sgx-long': { v: 'x'.repeat(601), t: now },
    'sgx-num': { v: 5, t: now },
  } }, co);
  assert.equal(r.status, 200);
  let j = await r.json();
  assert.deepEqual(Object.keys(j.items).sort(), ['sgx-palette', 'sgx-theme-mode']);
  r = await prefsCall(kv, 'POST', { changes: { 'sgx-theme-mode': { v: 'light', t: now - 5000 }, 'sgx-palette': { v: null, t: now } } }, co);
  j = await r.json();
  assert.equal(j.items['sgx-theme-mode'].v, 'dark', '旧的不覆盖');
  assert.equal(j.items['sgx-palette'].v, null, '恢复默认也同步');
  const g = await (await prefsCall(kv, 'GET', null, co)).json();
  assert.deepEqual(g.items, j.items);
});

test('POST 跨源 → 拒绝', async () => {
  const kv = makeKV();
  const co = { 'sgx-lock-session': await adminSess(), 'sgx-account-session': await accTicket() };
  const r = await prefsCall(kv, 'POST', { changes: {} }, co, 'https://evil.example');
  assert.equal(r.status, 403);
});

test('被单独退出的设备（revoked）不能同步', async () => {
  const kv = makeKV();
  const { signAccountSessionTicket } = await import(KERNEL + 'account-session.js');
  const t = await testAccountSession(ACCOUNT.priv, 'password', 0, Date.now(), undefined, 'AAAAAAAAAAAAAAAA');
  await kv.put('account-device-revoked:AAAAAAAAAAAAAAAA', '1');
  const r = await prefsCall(kv, 'GET', null, { 'sgx-lock-session': await adminSess(), 'sgx-account-session': t });
  assert.equal(r.status, 401);
});

/* ---------- D1（2026-10-28）---------- */

test('存在 D1 settings_sync：一项一行；updatedAt = 最后一次真正写入的服务器时间；没改动不动 updatedAt', async () => {
  const kv = makeKV();
  const co = await adminCo();
  const now = Date.now();
  let j = await (await prefsCall(kv, 'POST', { changes: { 'sgx-theme-mode': { v: 'dark', t: now - 1000 }, 'sgx-palette': { v: null, t: now - 1000 } } }, co)).json();
  const rows = accountD1For(kv).rows('settings_sync');
  assert.deepEqual(rows.map((r) => [r.k, r.v, r.t]), [['sgx-palette', null, now - 1000], ['sgx-theme-mode', 'dark', now - 1000]]);
  assert.ok(j.updatedAt >= now && j.updatedAt === rows[0].updated_at);
  const first = j.updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  j = await (await prefsCall(kv, 'POST', { changes: { 'sgx-theme-mode': { v: 'light', t: now - 2000 } } }, co)).json();
  assert.equal(j.updatedAt, first, '旧值被拒 → 没写入 → updatedAt 不变');
  assert.equal(j.items['sgx-theme-mode'].v, 'dark');
  const g = await (await prefsCall(kv, 'GET', null, co)).json();
  assert.deepEqual(g, { ok: true, items: j.items, updatedAt: first });
});

test('原子新的赢：旧 t 被拒、相等 t 不动、更新的 t 覆盖（直接打 SQL，没有先读后写）', async () => {
  const { UPSERT_SQL, MAX_TOTAL } = await import(PREFS);
  const db = makeAccountD1();
  const up = (k, v, t) => db.prepare(UPSERT_SQL).bind(k, v, t, 1, MAX_TOTAL).run();
  assert.equal((await up('sgx-a', 'new', 200)).meta.changes, 1);
  assert.equal((await up('sgx-a', 'stale', 100)).meta.changes, 0, '旧设备的旧值写不进');
  assert.equal((await up('sgx-a', 'same', 200)).meta.changes, 0, '相等不动');
  assert.equal(db.rows('settings_sync')[0].v, 'new');
  assert.equal((await up('sgx-a', null, 300)).meta.changes, 1);
  assert.deepEqual(db.rows('settings_sync').map((r) => [r.k, r.v, r.t]), [['sgx-a', null, 300]]);
});

test('并发写：两台设备同时 POST，不论谁先落地，每一项都是 t 更大的那份；互不相干的项都保留', async () => {
  const co = await adminCo();
  const now = Date.now();
  for (const order of [0, 1]) {
    const kv = makeKV();
    const newer = { changes: { 'sgx-theme-mode': { v: 'dark', t: now - 100 }, 'sgx-a': { v: 'A', t: now - 100 } } };
    const stale = { changes: { 'sgx-theme-mode': { v: 'light', t: now - 5000 }, 'sgx-b': { v: 'B', t: now - 5000 } } };
    const bodies = order ? [stale, newer] : [newer, stale];
    const rs = await Promise.all(bodies.map((b) => prefsCall(kv, 'POST', b, co)));
    for (const r of rs) assert.equal(r.status, 200);
    const g = await (await prefsCall(kv, 'GET', null, co)).json();
    assert.deepEqual(g.items, {
      'sgx-a': { v: 'A', t: now - 100 },
      'sgx-b': { v: 'B', t: now - 5000 },
      'sgx-theme-mode': { v: 'dark', t: now - 100 },
    }, 'order ' + order);
  }
  /* 很多个请求同时写同一项：最后留下 t 最大的 */
  const kv = makeKV();
  const ts = [7, 3, 9, 1, 5, 8, 2].map((d) => now - d * 1000);
  await Promise.all(ts.map((t) => prefsCall(kv, 'POST', { changes: { 'sgx-x': { v: String(t), t } } }, co)));
  const g = await (await prefsCall(kv, 'GET', null, co)).json();
  assert.deepEqual(g.items['sgx-x'], { v: String(Math.max(...ts)), t: Math.max(...ts) });
});

test('总项数上限 160：超过整单 413、什么都不写；已有的项照常更新', async () => {
  const kv = makeKV();
  const co = await adminCo();
  const now = Date.now() - 10000;
  const batch = (from, n, t) => Object.fromEntries(Array.from({ length: n }, (_, i) => ['sgx-k' + (from + i), { v: 'x', t }]));
  assert.equal((await prefsCall(kv, 'POST', { changes: batch(0, 80, now) }, co)).status, 200);
  assert.equal((await prefsCall(kv, 'POST', { changes: batch(80, 80, now) }, co)).status, 200);
  const r = await prefsCall(kv, 'POST', { changes: { ...batch(0, 1, now + 1), 'sgx-extra': { v: 'x', t: now } } }, co);
  assert.equal(r.status, 413);
  assert.equal(accountD1For(kv).rows('settings_sync').length, 160);
  assert.equal(accountD1For(kv).rows('settings_sync').find((x) => x.k === 'sgx-k0').t, now, '整单拒，已有的那项也没改');
  const ok = await prefsCall(kv, 'POST', { changes: batch(0, 1, now + 1) }, co);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).items['sgx-k0'].t, now + 1);
  /* SQL 条件兜底：绕过预检直接插第 161 项也插不进 */
  const { UPSERT_SQL, MAX_TOTAL } = await import(PREFS);
  const res = await accountD1For(kv).prepare(UPSERT_SQL).bind('sgx-race', 'x', now, now, MAX_TOTAL).run();
  assert.equal(res.meta.changes, 0);
});

test('不碰 KV：KV_SETTINGS_SYNC / KV_PROFILE 换成一碰就抛错的替身，GET / POST 照常，一次都没碰', async () => {
  const kv = makeKV();
  const co = await adminCo();
  const touched = [];
  const over = { KV_SETTINGS_SYNC: forbiddenKV('KV_SETTINGS_SYNC', touched), KV_PROFILE: forbiddenKV('KV_PROFILE', touched) };
  const now = Date.now();
  let r = await prefsCall(kv, 'POST', { changes: { 'sgx-theme-mode': { v: 'dark', t: now } } }, co, undefined, over);
  assert.equal(r.status, 200);
  r = await prefsCall(kv, 'GET', null, co, undefined, over);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).items['sgx-theme-mode'].v, 'dark');
  assert.deepEqual(touched, []);
  /* 也没有 KV 回落：没绑 D1、只有 KV（哪怕里面有旧 account-prefs）→ 500 config，不读 KV */
  const legacy = forbiddenKV('KV_SETTINGS_SYNC', touched);
  r = await prefsCall(kv, 'GET', null, co, undefined, { D1_SETTINGS_SYNC: undefined, KV_SETTINGS_SYNC: legacy });
  assert.equal(r.status, 500);
  assert.equal((await r.json()).error, 'config');
  assert.deepEqual(touched, []);
});

test('表不存在（还没跑 migration）：自己补建一次，GET 返回空、POST 写得进', async () => {
  const kv = makeKV();
  const co = await adminCo();
  const db = makeAccountD1({ migrations: false });
  const over = { D1_SETTINGS_SYNC: db };
  let r = await prefsCall(kv, 'GET', null, co, undefined, over);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, items: {}, updatedAt: 0 });
  const db2 = makeAccountD1({ migrations: false });
  r = await prefsCall(kv, 'POST', { changes: { 'sgx-palette': { v: 'mint', t: Date.now() } } }, co, undefined, { D1_SETTINGS_SYNC: db2 });
  assert.equal(r.status, 200);
  assert.equal(db2.rows('settings_sync').length, 1);
});

test('D1 出错（不是缺表）→ 503，不自愈也不回落', async () => {
  const kv = makeKV();
  const co = await adminCo();
  const broken = { prepare() { return { bind() { return this; }, async all() { throw new Error('D1_ERROR: network'); }, async run() { throw new Error('should not create'); } }; }, async batch() { throw new Error('D1_ERROR'); } };
  const r = await prefsCall(kv, 'GET', null, co, undefined, { D1_SETTINGS_SYNC: broken });
  assert.equal(r.status, 503);
  const p = await prefsCall(kv, 'POST', { changes: { 'sgx-a': { v: '1', t: Date.now() } } }, co, undefined, { D1_SETTINGS_SYNC: broken });
  assert.equal(p.status, 503);
});

test('迁移文件 0002_settings_sync.sql 和代码里的 SCHEMA 是同一张表', async () => {
  const { SCHEMA } = await import(PREFS);
  const { readFileSync } = await import('node:fs');
  const sql = readFileSync(new URL('../../../workers/account/migrations/0002_settings_sync.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS settings_sync/);
  const a = makeAccountD1({ migrations: false });
  a.raw.exec(SCHEMA);
  const b = makeAccountD1();
  const cols = (d) => d.raw.prepare('PRAGMA table_info(settings_sync)').all().map((c) => [c.name, c.type, c.notnull, c.pk]);
  assert.deepEqual(cols(a), cols(b));
});
