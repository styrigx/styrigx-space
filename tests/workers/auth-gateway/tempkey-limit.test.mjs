/**
 * 临时码输错限速（_kernel/lock-tempkey.js）：
 * - 单 IP 连错 5 次冷却 15 分钟（IPv6 按 /64 分桶，换地址绕不开）
 * - 全站只减速、不封锁：每小时错满 TEMPKEY_GLOBAL_SLOW_AT 次后每次先等 TEMPKEY_GLOBAL_DELAY_MS，
 *   以前的「全站错 30 次暂停 1 小时」已去掉（别人刷错就能让所有访客进不来），全站那一行（D1 attempt_limit bucket='*'）的 locked_until 不再生效
 * - 接口层：全站减速时对的临时码照样能进门
 *
 * 运行：node --test tests/workers/auth-gateway/tempkey-limit.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  isTempkeyLimited, recordTempkeyFail, clearTempkeyFail, createTempkey,
  TEMPKEY_GLOBAL_SLOW_AT, TEMPKEY_GLOBAL_DELAY_MS,
} from '../../../workers/auth-gateway/functions/_kernel/lock-tempkey.js';
import { onRequestPost as unlockPost } from '../../../workers/auth-gateway/functions/api/lock-tempkey-unlock.js';
import { makeAuthD1 } from '../_harness.mjs';

/* 输错计数在 D1 attempt_limit 表：realm='lock'、kind='tempkey'；全站一行 bucket='*' */
const REALM = 'lock';
const KIND = 'tempkey';
const GLOBAL = '*';

/** env：三个 D1 绑定同一个库，没有 KV */
function envOf(db, extra) {
  return { D1_LOCK_AUTH: db, D1_ACCOUNT_AUTH: db, D1_ROOT_AUTH: db, ...(extra || {}) };
}

/** 直接摆一行全站计数（不走被测代码） */
function setGlobal(db, count, windowStart, lockedUntil) {
  db.raw.prepare(
    'INSERT OR REPLACE INTO attempt_limit (realm, kind, bucket, count, strikes, locked_until, window_start, expires_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)'
  ).run(REALM, KIND, GLOBAL, count, lockedUntil || 0, windowStart, windowStart + 3600e3);
}

/** @param {any} db @param {string} bucket */
function row(db, bucket) {
  return db.rows('attempt_limit').find((r) => r.realm === REALM && r.kind === KIND && r.bucket === bucket) || null;
}
const waits = [];
const fakeSleep = async (ms) => { waits.push(ms); };

test('全站错满阈值后只减速：本 IP 不冷却 → 先等 TEMPKEY_GLOBAL_DELAY_MS 再返回 false', async () => {
  const db = makeAuthD1();
  setGlobal(db, TEMPKEY_GLOBAL_SLOW_AT, Date.now());
  waits.length = 0;
  assert.equal(await isTempkeyLimited(envOf(db), '203.0.113.1', { sleep: fakeSleep }), false);
  assert.deepEqual(waits, [TEMPKEY_GLOBAL_DELAY_MS]);
});

test('全站没到阈值、或窗口已过：不等', async () => {
  waits.length = 0;
  let db = makeAuthD1();
  setGlobal(db, TEMPKEY_GLOBAL_SLOW_AT - 1, Date.now());
  assert.equal(await isTempkeyLimited(envOf(db), '203.0.113.1', { sleep: fakeSleep }), false);
  db = makeAuthD1();
  setGlobal(db, 999, Date.now() - 2 * 3600e3);
  assert.equal(await isTempkeyLimited(envOf(db), '203.0.113.1', { sleep: fakeSleep }), false);
  assert.deepEqual(waits, []);
});

test('全站那一行带着 locked_until（旧「全站暂停」的残留）：不再封锁全站', async () => {
  const db = makeAuthD1();
  setGlobal(db, 0, Date.now(), Date.now() + 3600e3);
  assert.equal(await isTempkeyLimited(envOf(db), '203.0.113.2', { sleep: fakeSleep }), false);
});

test('recordTempkeyFail：全站计数一直涨也不会给全站上锁；单 IP 第 5 次进入冷却', async () => {
  const db = makeAuthD1();
  const env = envOf(db);
  for (let i = 0; i < 40; i++) await recordTempkeyFail(env, '198.51.100.' + (i % 30));
  const g = row(db, GLOBAL);
  assert.equal(g.count, 40);
  assert.equal(g.locked_until, 0, '全站一行从不写 locked_until');
  assert.equal(await isTempkeyLimited(env, '203.0.113.9', { sleep: fakeSleep }), false, '别的 IP 不受影响');
  const ip = '192.0.2.77';
  const res = [];
  for (let i = 0; i < 5; i++) res.push(await recordTempkeyFail(env, ip));
  assert.deepEqual(res, [false, false, false, false, true]);
  assert.ok(row(db, ip).locked_until > Date.now(), 'D1 里本 IP 的行进入冷却');
  assert.equal(await isTempkeyLimited(env, ip, { sleep: fakeSleep }), true);
  await clearTempkeyFail(env, ip);
  assert.equal(row(db, ip), null, '清掉后行没了');
  assert.equal(await isTempkeyLimited(env, ip, { sleep: fakeSleep }), false, '清掉后不再冷却');
});

test('IPv6 按 /64 分桶：同一 /64 里换地址共用一个计数', async () => {
  const env = envOf(makeAuthD1());
  for (let i = 1; i <= 5; i++) await recordTempkeyFail(env, '2001:db8:1:2::' + i.toString(16));
  assert.equal(await isTempkeyLimited(env, '2001:db8:1:2:ffff:ffff:ffff:ffff', { sleep: fakeSleep }), true);
  assert.equal(await isTempkeyLimited(env, '2001:db8:1:3::1', { sleep: fakeSleep }), false, '别的 /64 不受影响');
});

test('接口：全站已错满（含残留 locked_until），对的临时码照样进门', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const db = makeAuthD1();
  const env = envOf(db, {
    SGX_LOCK_PRIVATE: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    SGX_LOCK_PUBLIC: publicKey.export({ type: 'spki', format: 'pem' }),
    SGX_PW_PEPPER: 'tk-pepper',
  });
  const made = await createTempkey(env, 'tk-pepper', { name: 'guest', ms: 2 * 3600e3 });
  assert.ok(made && made.code, JSON.stringify(made));
  /* 全站减速期间也不是 429；这里把窗口设成刚好过期，免得测试真的等 2 秒 */
  setGlobal(db, 500, Date.now() - 3600e3 - 1, Date.now() + 3600e3);
  const req = new Request('https://styrigx.com/api/lock-tempkey-unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://styrigx.com', 'CF-Connecting-IP': '203.0.113.50' },
    body: JSON.stringify({ code: made.code }),
  });
  const res = await unlockPost({ request: req, env });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, role: 'visitor' });
});
