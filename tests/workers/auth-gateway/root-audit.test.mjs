/**
 * 根凭证审计（_kernel/root-audit.js + GET /api/root-audit）：
 * - 存储：D1_ROOT_AUTH 的 audit 表，realm = 'root'；只追加（INSERT，不 UPDATE / REPLACE），保留 7 天（expires_at），过期行读时不认
 * - GET 返回最新的 50 条（gateway 审计 #8）：一条 ORDER BY ts DESC LIMIT 50；新的在前
 * - 只给时间、IP 前缀、结果三项；只要 admin 锁屏会话
 *
 * 运行：node --test tests/workers/auth-gateway/root-audit.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { onRequestGet, AUDIT_SHOW } from '../../../workers/auth-gateway/functions/api/root-audit.js';
import { writeRootAudit, listRootAudit, ipPrefix } from '../../../workers/auth-gateway/functions/_kernel/root-audit.js';
import { testLockSessionCookie, testTicketCookie } from './_tickets.mjs';
import { LOCK_REAUTH_TICKET } from '../../../workers/auth-gateway/functions/_kernel/realms.js';
import { genKeyPair, makeAuthD1 } from '../_harness.mjs';

const { priv: PRIV, pub: PUB } = await genKeyPair();
const DAY = 86400e3;

/* 三个 D1 绑定同一个库（同正式部署）；纪元在 D1，空库 → 0 */
const envOf = (db) => ({ SGX_LOCK_PUBLIC: PUB, D1_LOCK_AUTH: db, D1_ACCOUNT_AUTH: db, D1_ROOT_AUTH: db });

/** 直接摆一行审计（不走网关代码） */
function putAudit(db, row) {
  const r = { realm: 'root', decoy: 0, via: '', path: '', ...row };
  if (r.expires_at === undefined) r.expires_at = r.ts + 7 * DAY;
  db.raw.prepare('INSERT INTO audit (realm, id, ts, ip_prefix, ok, decoy, via, path, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(r.realm, r.id, r.ts, r.ip_prefix, r.ok ? 1 : 0, r.decoy ? 1 : 0, r.via, r.path, r.expires_at);
}
const audits = (db) => db.raw.prepare('SELECT * FROM audit ORDER BY ts, rowid').all().map((r) => Object.assign({}, r));

async function req() {
  const cookie = (await testLockSessionCookie(PRIV, 0, 'admin')) + '; ' + (await testTicketCookie(PRIV, LOCK_REAUTH_TICKET, 'root', 0));
  return new Request('https://styrigx.com/api/root-audit', { headers: { Cookie: cookie } });
}

test('root-audit：130 条里返回最新的 50 条（新的在前），一条查询拿到', async () => {
  const db = makeAuthD1();
  const t0 = Date.now() - 6 * DAY;
  /* 乱序插入：结果不能依赖插入顺序 / 主键顺序 */
  const order = Array.from({ length: 130 }, (_, i) => i).sort((a, b) => ((a * 37) % 130) - ((b * 37) % 130));
  for (const i of order) putAudit(db, { id: 'r' + String(i).padStart(3, '0'), ts: t0 + i * 60000, ip_prefix: '10.0.' + i + '.x', ok: i % 2 === 0 });
  db.calls.length = 0;
  const res = await onRequestGet({ request: await req(), env: envOf(db) });
  assert.equal(res.status, 200);
  const { ok, items } = await res.json();
  assert.equal(ok, true);
  assert.equal(items.length, AUDIT_SHOW);
  assert.equal(items[0].ts, t0 + 129 * 60000, '第一条是最新的');
  assert.equal(items[49].ts, t0 + 80 * 60000, '最后一条是倒数第 50 条');
  for (let i = 1; i < items.length; i++) assert.ok(items[i - 1].ts > items[i].ts, '按时间倒序');
  assert.equal(db.calls.filter((s) => /FROM audit/.test(s)).length, 1, '审计只查一次（不翻页）');
  assert.equal(db.calls.filter((s) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(s) && /\baudit\b/.test(s)).length, 0, 'GET 不写审计表');
});

test('root-audit：不到 50 条时全返回；没有记录时返回空列表', async () => {
  let db = makeAuthD1();
  const now = Date.now();
  for (let i = 0; i < 7; i++) putAudit(db, { id: 'x' + i, ts: now - 1000 + i, ip_prefix: 'p', ok: true });
  let res = await onRequestGet({ request: await req(), env: envOf(db) });
  assert.equal((await res.json()).items.length, 7);
  db = makeAuthD1();
  res = await onRequestGet({ request: await req(), env: envOf(db) });
  assert.deepEqual(await res.json(), { ok: true, items: [] });
});

test('root-audit：过期（超过 7 天）的行不返回；别的 realm 的行不返回', async () => {
  const db = makeAuthD1();
  const now = Date.now();
  putAudit(db, { id: 'old', ts: now - 8 * DAY, ip_prefix: 'old', ok: true });
  putAudit(db, { id: 'edge', ts: now - DAY, ip_prefix: 'edge', ok: true, expires_at: now - 1 });
  putAudit(db, { id: 'other', realm: 'lock', ts: now - 1000, ip_prefix: 'other', ok: true });
  putAudit(db, { id: 'new', ts: now - 2000, ip_prefix: 'new', ok: false });
  const res = await onRequestGet({ request: await req(), env: envOf(db) });
  const { items } = await res.json();
  assert.deepEqual(items.map((x) => x.ipPrefix), ['new']);
});

test('root-audit：D1 查询出错 → 503 server；没绑 D1_ROOT_AUTH → 500 config', async () => {
  const db = makeAuthD1();
  db.failOn = (sql) => /FROM audit/.test(sql);
  const res = await onRequestGet({ request: await req(), env: envOf(db) });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false, error: 'server' });
  const env = envOf(makeAuthD1());
  delete env.D1_ROOT_AUTH;
  const res2 = await onRequestGet({ request: await req(), env });
  assert.equal(res2.status, 500);
  assert.deepEqual(await res2.json(), { ok: false, error: 'config' });
});

/* ===== 写入：只追加 ===== */

test('writeRootAudit：每次写一行（realm=root，只存 IP 前缀），不覆盖已有行；读出新的在前', async () => {
  const db = makeAuthD1();
  const env = envOf(db);
  assert.equal(await writeRootAudit(env, '203.0.113.45', false, { path: 'lock-reset', decoy: true, via: 'switch' }), true);
  assert.equal(await writeRootAudit(env, '2001:db8:1:2:3:4:5:6', true, { path: 'root-auth' }), true);
  /* 同一毫秒、同一 IP 的多次写入也各自一行（并发） */
  const rs = await Promise.all(Array.from({ length: 5 }, () => writeRootAudit(env, '203.0.113.45', false, { path: 'lock-reset' })));
  assert.deepEqual(rs, [true, true, true, true, true]);
  const rows = audits(db);
  assert.equal(rows.length, 7);
  assert.equal(new Set(rows.map((r) => r.id)).size, 7, 'id 不重复');
  for (const r of rows) {
    assert.equal(r.realm, 'root');
    assert.ok(r.expires_at > r.ts + 7 * DAY - 1000 && r.expires_at <= r.ts + 7 * DAY, '保留 7 天');
    assert.ok(!r.ip_prefix.includes('45') && !r.ip_prefix.includes(':5:6'), '不存完整 IP');
  }
  assert.equal(rows[0].ip_prefix, ipPrefix('203.0.113.45'));
  assert.equal(rows[0].decoy, 1);
  assert.equal(rows[0].via, 'switch');
  const list = await listRootAudit(env, 50);
  assert.equal(list.length, 7);
  for (const it of list) assert.deepEqual(Object.keys(it).sort(), ['ipPrefix', 'ok', 'ts']);
});

test('writeRootAudit：只追加：源码里没有 UPDATE / REPLACE / UPSERT audit；写入只发 INSERT（外加清过期行）', async () => {
  const src = fs.readFileSync(new URL('../../../workers/auth-gateway/functions/_kernel/lib/root-audit.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /UPDATE\s+audit/i);
  assert.doesNotMatch(src, /(INSERT\s+OR\s+REPLACE|REPLACE\s+INTO)\s+audit/i);
  assert.doesNotMatch(src, /ON\s+CONFLICT/i);
  const db = makeAuthD1();
  putAudit(db, { id: 'keep', ts: Date.now() - 1000, ip_prefix: 'keep', ok: true });
  db.calls.length = 0;
  await writeRootAudit(envOf(db), '192.0.2.1', false, { path: 'root-auth' });
  const writes = db.calls.filter((s) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(s));
  assert.ok(writes.some((s) => /^\s*INSERT INTO audit/i.test(s)));
  for (const s of writes) {
    assert.ok(/^\s*INSERT INTO audit/i.test(s) || /^\s*DELETE FROM audit WHERE realm = \? AND expires_at <= \?/i.test(s), '只有插入和清过期：' + s);
  }
  assert.ok(audits(db).some((r) => r.id === 'keep'), '没过期的旧行不动');
});

test('writeRootAudit：D1 出错或没绑 → false（调用方据此 fail closed）', async () => {
  const db = makeAuthD1();
  db.failOn = (sql) => /^\s*INSERT INTO audit/i.test(sql);
  assert.equal(await writeRootAudit(envOf(db), '192.0.2.1', true, { path: 'root-auth' }), false);
  assert.equal(audits(db).length, 0);
  assert.equal(await writeRootAudit({}, '192.0.2.1', true, { path: 'root-auth' }), false);
});

/* ===== 账号 → 服务状态页的折叠区：只要 admin 锁屏会话，不要 LockReauthTicket ===== */

/** @param {string} cookie */
function reqWith(cookie) {
  return new Request('https://styrigx.com/api/root-audit', cookie ? { headers: { Cookie: cookie } } : {});
}
const T1 = Date.now() - 2 * DAY;
const T2 = T1 + 60000;
function seeded() {
  const db = makeAuthD1();
  putAudit(db, { id: T1 + ':a', ts: T1, ip_prefix: '203.0.113.x', ok: false, decoy: 1, via: 'switch', path: 'lock-reset' });
  putAudit(db, { id: T2 + ':b', ts: T2, ip_prefix: '2001:db8:1:2::x', ok: true, path: 'lock-reauth' });
  return db;
}

test('root-audit：只有 admin 锁屏会话（没有 sgx-lock-reauth）→ 200 列表', async () => {
  const db = seeded();
  const res = await onRequestGet({ request: reqWith(await testLockSessionCookie(PRIV, 0, 'admin')), env: envOf(db) });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.deepEqual(j.items.map((x) => x.ts), [T2, T1]);
});

test('root-audit：访客会话 / 没有会话 / 坏会话 → 401 session，不读审计', async () => {
  for (const cookie of [await testLockSessionCookie(PRIV, 0, 'visitor', 'tempkey'), '', 'sgx-lock-session=1.2.3']) {
    const db = seeded();
    db.failOn = (sql) => { if (/FROM audit/.test(sql)) throw new Error('不该读审计'); return false; };
    const res = await onRequestGet({ request: reqWith(cookie), env: envOf(db) });
    assert.equal(res.status, 401, cookie || '(无 cookie)');
    assert.deepEqual(await res.json(), { ok: false, error: 'session' });
    assert.equal(db.calls.filter((s) => /FROM audit/.test(s)).length, 0);
  }
});

test('root-audit：只给时间、IP 前缀、结果三项，decoy / via / path 不出接口', async () => {
  const db = seeded();
  const res = await onRequestGet({ request: reqWith(await testLockSessionCookie(PRIV, 0, 'admin')), env: envOf(db) });
  const { items } = await res.json();
  for (const it of items) assert.deepEqual(Object.keys(it).sort(), ['ipPrefix', 'ok', 'ts']);
  assert.deepEqual(items[1], { ts: T1, ipPrefix: '203.0.113.x', ok: false });
});

test('root-audit：响应不缓存（Cache-Control no-store）', async () => {
  const db = seeded();
  const res = await onRequestGet({ request: reqWith(await testLockSessionCookie(PRIV, 0, 'admin')), env: envOf(db) });
  assert.match(res.headers.get('Cache-Control') || '', /no-store/);
});
