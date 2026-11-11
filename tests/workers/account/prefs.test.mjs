/**
 * 账号云同步 /api/prefs（2026-10-22）：进站会话 + 账号会话 + 作用域 prefs.sync（P2-2 起不看 role）；逐项新的赢。
 *
 * 2026-10-24 搬到账号 Worker styrigx-account（workers/account）；锁屏身份经网关这一跳写成身份头、账号会话由账号 Worker 自己验（_auth.mjs）。
 *
 * 2026-10-28 存储从 KV 搬到 D1（styrigx-account 的 settings_sync；命名 v2 起绑定只叫 D1_ACCOUNT）：
 * 逐项新的赢在 SQL 里原子完成（旧 t 写不进、并发写不丢）、运行时不碰任何 KV、表不存在时自愈。
 *
 * 运行：node --test tests/workers/account/prefs.test.mjs
 */
import { wrap, testAccountSession } from './_auth.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { testLockSession } from '../space-core/_tickets.mjs';
import { makeKV, genKeyPair, authD1For, forbiddenKV } from '../_harness.mjs';
import { makeAccountD1, splitD1 } from './_d1.mjs';

const PREFS = '../../../workers/account/src/api/prefs.js';
const KERNEL = '../../../workers/space-core/src/core/';

let LOCK, ACCOUNT, OTHER;
const PEPPER = 'test-pepper-acc';

/** 同一份 kv（一次测试）对应同一个账号库替身 */
const accountD1ByKv = new WeakMap();
function accountD1For(kv) {
  let d = accountD1ByKv.get(kv);
  if (!d) { d = makeAccountD1({ migrations: 'pre-uid' }); accountD1ByKv.set(kv, d); } /* 迁移前（0006）的表：本文件测无 uid 列的写法；有 uid 列见 v6-identity-api.test.mjs */
  return d;
}

function envFor(kv, overrides = {}) {
  return {
    KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv, /* 只给网关替身当认证库导入来源；账号 Worker 不读 */
    D1_ACCOUNT: accountD1For(kv), /* 账号 Worker：session、授权、settings_sync 同一个库 */
    D1_SPACE: authD1For(kv), /* 网关这一跳验进站会话 */
    SGX_SPACE_PRIVATE: LOCK.priv,
    SGX_SPACE_PUBLIC: LOCK.pub,
    SGX_ACCOUNT_PRIVATE: ACCOUNT.priv,
    SGX_ACCOUNT_PUBLIC: ACCOUNT.pub,
    SGX_ACCOUNT_PASSWORD_PEPPER: PEPPER,
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
  return await testLockSession(LOCK.priv, epoch, 'password');
}
async function visitorSess() {
  const { signLockSessionTicket } = await import(KERNEL + 'lock-session.js');
  return await testLockSession(LOCK.priv, 0, 'link');
}
async function accTicket(by = 'password', authAt = Date.now(), epoch = 0, priv) {
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
  return { 'sgx-space-session': await adminSess(), 'sgx-account-session': await accTicket() };
}

/* 测试钥匙：before 里生成（不算一条用例，单独跑某条用例时也会先执行） */
before(async () => {
  LOCK = await genKeyPair(); ACCOUNT = await genKeyPair(); OTHER = await genKeyPair();
});

test('进站会话 + 账号会话 + prefs.sync：没有进站会话 401 session、没账号 401 account；分享链接进站会话 + 账号会话也放行（P2-2 起账号 Worker 不看 role）', async () => {
  const kv = makeKV();
  const none = await prefsCall(kv, 'GET', null, {});
  assert.equal(none.status, 401);
  assert.equal((await none.json()).error, 'session');
  /* 有账号会话、没有进站会话 → 仍是 401 session */
  const noLock = await prefsCall(kv, 'GET', null, { 'sgx-account-session': await accTicket() });
  assert.equal(noLock.status, 401);
  assert.equal((await noLock.json()).error, 'session');
  const sess = await adminSess();
  const r = await prefsCall(kv, 'GET', null, { 'sgx-space-session': sess });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'account');
  /* 账号票签名不对 → 401 account */
  const bad = await prefsCall(kv, 'GET', null, { 'sgx-space-session': sess, 'sgx-account-session': await accTicket('password', Date.now(), 0, OTHER.priv) });
  assert.equal(bad.status, 401);
  assert.equal((await bad.json()).error, 'account');
  /* 过渡期：分享链接进站会话（原临时钥匙）（网关 role 门 P2-3 前还会挡 /api/prefs）在账号 Worker 这一层只看进站会话 + 账号会话 */
  const vis = await visitorSess();
  assert.equal((await prefsCall(kv, 'GET', null, { 'sgx-space-session': vis, 'sgx-account-session': await accTicket() })).status, 200);
  const ok = await prefsCall(kv, 'GET', null, { 'sgx-space-session': sess, 'sgx-account-session': await accTicket() });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).items, {});
  /* POST 同一道门 */
  const pNo = await prefsCall(kv, 'POST', { changes: { 'sgx-theme': { v: 'dark', t: Date.now() - 1000 } } }, { 'sgx-space-session': sess });
  assert.equal(pNo.status, 401);
  assert.equal((await pNo.json()).error, 'account');
});

test('没作用域 prefs.sync → 403 scope（gate.scopeDenial，带 scope 字段）', async () => {
  const { scopeDenial } = await import('../../../workers/account/src/gate.js');
  const lockOk = { ok: true, by: 'password', reason: 'ok' };
  const auth = (a) => ({ gateway: async () => lockOk, authorize: async () => a });
  const d = await scopeDenial(auth({ ok: true, reason: 'ok', deviceId: 'x', scopes: ['curio.write'], reauth: false }), 'prefs.sync');
  assert.equal(d.status, 403);
  const j = await d.json();
  assert.equal(j.error, 'scope');
  assert.equal(j.scope, 'prefs.sync');
  assert.equal(await scopeDenial(auth({ ok: true, reason: 'ok', deviceId: 'x', scopes: ['prefs.sync'], reauth: false }), 'prefs.sync'), null);
  const nl = await scopeDenial({ gateway: async () => ({ ok: false, by: '', reason: 'no-identity' }), authorize: async () => { throw new Error('不该问账号'); } }, 'prefs.sync');
  assert.equal(nl.status, 401);
  assert.equal((await nl.json()).error, 'session');
  const na = await scopeDenial(auth({ ok: false, reason: 'missing', deviceId: '', scopes: [], reauth: false }), 'prefs.sync');
  assert.equal(na.status, 401);
  const nj = await na.json();
  assert.equal(nj.error, 'account');
  assert.equal(nj.reason, 'missing');
});

test('POST 合并：逐项新的赢；旧的不覆盖；非 sgx- key / 未来时间 / 超长值丢掉', async () => {
  const kv = makeKV();
  const co = { 'sgx-space-session': await adminSess(), 'sgx-account-session': await accTicket() };
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
  const co = { 'sgx-space-session': await adminSess(), 'sgx-account-session': await accTicket() };
  const r = await prefsCall(kv, 'POST', { changes: {} }, co, 'https://evil.example');
  assert.equal(r.status, 403);
});

test('被单独退出的设备（revoked）不能同步', async () => {
  const kv = makeKV();
  const t = await testAccountSession(ACCOUNT.priv, 'password', 0, Date.now(), undefined, 'AAAAAAAAAAAAAAAA');
  accountD1For(kv).raw.prepare("INSERT INTO account_device (device_id, record, last_seen, revoked_at, expires_at) VALUES ('AAAAAAAAAAAAAAAA', '{}', 0, 1, ?)").run(Date.now() + 86400000);
  const r = await prefsCall(kv, 'GET', null, { 'sgx-space-session': await adminSess(), 'sgx-account-session': t });
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
  const db = makeAccountD1({ migrations: 'pre-uid' });
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
  /* 也没有 KV 回落：prefs.js 没有 D1_ACCOUNT 就 500 config，从不读 KV（缺绑定时 session 先验不过，这里直接测处理函数的取库） */
  const { onRequestGet } = await import(PREFS);
  const ok = { gateway: async () => ({ ok: true }), authorize: async () => ({ ok: true, reason: 'ok', deviceId: 'd', scopes: ['prefs.sync'], reauth: false }) };
  r = await onRequestGet({ request: new Request('https://styrigx.com/api/prefs'), env: { KV_SETTINGS_SYNC: forbiddenKV('KV_SETTINGS_SYNC', touched) }, auth: ok });
  assert.equal(r.status, 500);
  assert.equal((await r.json()).error, 'config');
  assert.deepEqual(touched, []);
});

test('表不存在（还没跑 migration）：自己补建一次，GET 返回空、POST 写得进', async () => {
  const kv = makeKV();
  const co = await adminCo();
  const db = makeAccountD1({ migrations: false });
  const over = { D1_ACCOUNT: splitD1(accountD1For(kv), db, /settings_sync/) };
  let r = await prefsCall(kv, 'GET', null, co, undefined, over);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, items: {}, updatedAt: 0 });
  const db2 = makeAccountD1({ migrations: false });
  r = await prefsCall(kv, 'POST', { changes: { 'sgx-palette': { v: 'mint', t: Date.now() } } }, co, undefined, { D1_ACCOUNT: splitD1(accountD1For(kv), db2, /settings_sync/) });
  assert.equal(r.status, 200);
  assert.equal(db2.rows('settings_sync').length, 1);
});

test('D1 出错（不是缺表）→ 503，不自愈也不回落', async () => {
  const kv = makeKV();
  const co = await adminCo();
  const broken = { prepare() { return { bind() { return this; }, async all() { throw new Error('D1_ERROR: network'); }, async run() { throw new Error('should not create'); } }; }, async batch() { throw new Error('D1_ERROR'); } };
  const r = await prefsCall(kv, 'GET', null, co, undefined, { D1_ACCOUNT: splitD1(accountD1For(kv), broken, /settings_sync/) });
  assert.equal(r.status, 503);
  const p = await prefsCall(kv, 'POST', { changes: { 'sgx-a': { v: '1', t: Date.now() } } }, co, undefined, { D1_ACCOUNT: splitD1(accountD1For(kv), broken, /settings_sync/) });
  assert.equal(p.status, 503);
});

test('迁移文件 0002_settings_sync.sql 和代码里的 SCHEMA 是同一张表', async () => {
  const { SCHEMA } = await import(PREFS);
  const { readFileSync } = await import('node:fs');
  const sql = readFileSync(new URL('../../../workers/account/migrations/0002_settings_sync.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS settings_sync/);
  const a = makeAccountD1({ migrations: false });
  a.raw.exec(SCHEMA);
  const b = makeAccountD1({ migrations: 'pre-uid' }); /* SCHEMA = 兜底建表，迁移前（0007 之前）的结构 */
  const cols = (d) => d.raw.prepare('PRAGMA table_info(settings_sync)').all().map((c) => [c.name, c.type, c.notnull, c.pk]);
  assert.deepEqual(cols(a), cols(b));
});
