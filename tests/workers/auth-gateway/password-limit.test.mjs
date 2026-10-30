/**
 * 密码输错限速（workers/auth-gateway/functions/_kernel/lib/password-limit.js，锁屏密码 /api/lock-password verify 与账号密码共用）：
 * - 每连错 5 次冷却一轮：30 秒起逐轮翻倍，封顶 1 小时；冷却中码对也 429；验对后轮数归零
 * - 全局只减速不封锁：本域每小时输错满阈值后每次校验先等，不返回 429
 * - IPv6 同一 /64 共用计数
 * - 记失败是一条原子 UPSERT：并发 N 次输错正好计 N 次；过期行读时不认、下一次从头计
 * 存储：D1 attempt_limit 表，realm = 'lock'（D1_LOCK_AUTH），kind = 'password'；按域参数化（第二个域用测试对象）；
 * 单 IP 行 count / strikes / locked_until / expires_at，全局窗口 bucket = '*'（旧格式 KV 计数不导入，见 scripts/migrate-kv-to-d1.mjs）。
 * 运行：node --test tests/workers/auth-gateway/password-limit.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost as lockPassword } from '../../../workers/auth-gateway/functions/api/lock-password.js';
import { makePasswordRecord } from '../../../workers/auth-gateway/functions/_kernel/lib/password.js';
import { REALM_LOCK } from '../../../workers/auth-gateway/functions/_kernel/realms.js';
/* lib/password-limit.js 按域参数化：第二个域用测试对象核对两域互不影响（网关自己只有锁屏域） */
const REALM_ACCOUNT = Object.freeze({ id: 'account', d1Binding: 'D1_LOCK_AUTH' });
import {
  passwordLimiter,
  cooldownMs,
  PASSWORD_MAX_FAIL,
  PASSWORD_COOLDOWN_MS,
  PASSWORD_COOLDOWN_MAX_MS,
  PASSWORD_GLOBAL_SLOW_AT,
  PASSWORD_GLOBAL_DELAY_MS,
} from '../../../workers/auth-gateway/functions/_kernel/lib/password-limit.js';
import { makeAuthD1, genKeyPair } from '../_harness.mjs';

const PEPPER = 'test-pepper';

const { priv: PRIV, pub: PUB } = await genKeyPair();

const IP = '198.51.100.20';
/* 三个 D1 绑定同一个库（同正式部署）；网关不绑 KV */
const envOf = (db) => ({ D1_LOCK_AUTH: db, SGX_PW_PEPPER: PEPPER, SGX_LOCK_PRIVATE: PRIV, SGX_LOCK_PUBLIC: PUB });
function verify(db, password, ip = IP) {
  return lockPassword({
    request: new Request('https://styrigx.com/api/lock-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://styrigx.com', 'CF-Connecting-IP': ip },
      body: JSON.stringify({ action: 'verify', password }),
    }),
    env: envOf(db),
  });
}
/** attempt_limit 的一行（原样，不管过期；没有 → null） */
const row = (db, bucket = IP, realm = REALM_LOCK.id) =>
  db.raw.prepare("SELECT * FROM attempt_limit WHERE realm = ? AND kind = 'password' AND bucket = ?").get(realm, bucket) || null;
const patch = (db, cols, bucket = IP, realm = REALM_LOCK.id) => {
  const keys = Object.keys(cols);
  db.raw.prepare('UPDATE attempt_limit SET ' + keys.map((k) => k + ' = ?').join(', ') + " WHERE realm = ? AND kind = 'password' AND bucket = ?").run(...keys.map((k) => cols[k]), realm, bucket);
};
const cooldownLeft = (db, bucket = IP, realm = REALM_LOCK.id) => Number(row(db, bucket, realm).locked_until) - Date.now();
const expireCooldown = (db, bucket = IP, realm = REALM_LOCK.id) => patch(db, { locked_until: Date.now() - 1 }, bucket, realm);
async function withPassword() {
  const db = makeAuthD1();
  db.putPassword(REALM_LOCK.id, await makePasswordRecord('right-pass-1', PEPPER));
  return db;
}

test('冷却时长：30 秒起逐轮翻倍，封顶 1 小时', () => {
  assert.equal(cooldownMs(1), PASSWORD_COOLDOWN_MS);
  assert.equal(cooldownMs(2), 2 * PASSWORD_COOLDOWN_MS);
  assert.equal(cooldownMs(3), 4 * PASSWORD_COOLDOWN_MS);
  assert.equal(cooldownMs(7), 64 * PASSWORD_COOLDOWN_MS);
  assert.equal(cooldownMs(8), PASSWORD_COOLDOWN_MAX_MS);
  assert.equal(cooldownMs(1000), PASSWORD_COOLDOWN_MAX_MS);
});

test('锁屏密码：每 5 次错进一轮冷却，第二轮翻倍；冷却中码对也 429；验对后轮数归零', async () => {
  const db = await withPassword();
  /* 第 1 轮 */
  for (let i = 0; i < 4; i++) assert.equal((await verify(db, 'wrong-pass')).status, 403);
  assert.equal(row(db).count, 4);
  let r = await verify(db, 'wrong-pass');
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error, 'cooldown');
  assert.equal(row(db).count, 0);
  assert.equal(row(db).strikes, 1);
  let left = cooldownLeft(db);
  assert.ok(left > PASSWORD_COOLDOWN_MS - 2000 && left <= PASSWORD_COOLDOWN_MS, '第 1 轮 30 秒');
  assert.equal((await verify(db, 'right-pass-1')).status, 429, '冷却中码对也不验');
  /* 第 2 轮：翻倍 */
  expireCooldown(db);
  for (let i = 0; i < 4; i++) assert.equal((await verify(db, 'wrong-pass')).status, 403);
  assert.equal((await verify(db, 'wrong-pass')).status, 429);
  assert.equal(row(db).count, 0);
  assert.equal(row(db).strikes, 2);
  left = cooldownLeft(db);
  assert.ok(left > 2 * PASSWORD_COOLDOWN_MS - 2000 && left <= 2 * PASSWORD_COOLDOWN_MS, '第 2 轮 60 秒');
  assert.ok(row(db).expires_at >= row(db).locked_until, '行的有效期不短于冷却');
  /* 别的 IP 不受影响 */
  assert.equal((await verify(db, 'wrong-pass', '198.51.100.21')).status, 403);
  /* 冷却过了：码对 → 解锁成功，并清掉本 IP 的行（计数、轮数、冷却一起） */
  expireCooldown(db);
  r = await verify(db, 'right-pass-1');
  assert.equal(r.status, 200);
  assert.equal(row(db), null);
  assert.equal(row(db, '198.51.100.21').count, 1, '只清本 IP');
});

test('冷却轮数一直累积到上限 1 小时（单元：limiter 直接记失败）', async () => {
  const db = makeAuthD1();
  const lim = passwordLimiter(envOf(db), REALM_ACCOUNT, IP);
  let last = 0;
  for (let round = 1; round <= 10; round++) {
    for (let i = 0; i < 4; i++) assert.equal(await lim.recordFail(), false);
    assert.equal(await lim.recordFail(), true);
    last = cooldownLeft(db, IP, REALM_ACCOUNT.id);
    assert.ok(last <= cooldownMs(round) && last > cooldownMs(round) - 2000, 'round ' + round);
    assert.equal(row(db, IP, REALM_ACCOUNT.id).strikes, round);
  }
  assert.ok(last > PASSWORD_COOLDOWN_MAX_MS - 2000 && last <= PASSWORD_COOLDOWN_MAX_MS);
  assert.ok(row(db, IP, REALM_ACCOUNT.id).expires_at - Date.now() > 24 * 3600 * 1000 - 5000, '轮数记 24 小时');
  assert.equal(row(db, IP, REALM_LOCK.id), null, '账号域不写锁屏域的行');
});

test('全局只减速：本域每小时输错满阈值后校验前先等，不冷却别人；未满不等；窗口过了不等', async () => {
  const db = makeAuthD1();
  const env = envOf(db);
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  for (let i = 0; i < PASSWORD_GLOBAL_SLOW_AT - 1; i++) await passwordLimiter(env, REALM_LOCK, '192.0.2.' + (i % 250)).recordFail();
  const lock = passwordLimiter(env, REALM_LOCK, '203.0.113.50', { sleep });
  assert.equal(await lock.inCooldown(), false);
  assert.deepEqual(waits, []);
  await passwordLimiter(env, REALM_LOCK, '192.0.2.251').recordFail();
  assert.equal(row(db, '*').count, PASSWORD_GLOBAL_SLOW_AT);
  assert.equal(await lock.inCooldown(), false, '不封锁');
  assert.deepEqual(waits, [PASSWORD_GLOBAL_DELAY_MS], '先等再验');
  /* 账号域各自计数 */
  waits.length = 0;
  assert.equal(await passwordLimiter(env, REALM_ACCOUNT, '203.0.113.50', { sleep }).inCooldown(), false);
  assert.deepEqual(waits, []);
  assert.equal(row(db, '*', REALM_ACCOUNT.id), null);
  /* 窗口过去 */
  patch(db, { window_start: Date.now() - 61 * 60 * 1000 }, '*');
  assert.equal(await lock.inCooldown(), false);
  assert.deepEqual(waits, []);
  /* 窗口过去后的下一次输错：全局从 1 重新计 */
  await passwordLimiter(env, REALM_LOCK, '192.0.2.252').recordFail();
  assert.equal(row(db, '*').count, 1);
});

test('IPv6 同一 /64 换地址共用计数', async () => {
  const db = makeAuthD1();
  const env = envOf(db);
  for (let i = 1; i <= 5; i++) await passwordLimiter(env, REALM_LOCK, '2001:db8:1:2::' + i).recordFail();
  assert.equal(await passwordLimiter(env, REALM_LOCK, '2001:db8:1:2:abcd::9').inCooldown(), true);
  assert.equal(await passwordLimiter(env, REALM_LOCK, '2001:db8:1:3::1').inCooldown(), false);
});

test('并发：N 次输错同时记（Promise.all）正好计 N 次，没有丢更新', async () => {
  const db = makeAuthD1();
  const env = envOf(db);
  const n = PASSWORD_MAX_FAIL - 1; /* 不触发冷却清零：count 应正好是 n */
  const res = await Promise.all(Array.from({ length: n }, () => passwordLimiter(env, REALM_LOCK, IP).recordFail()));
  assert.deepEqual(res, new Array(n).fill(false));
  assert.equal(row(db).count, n);
  assert.equal(row(db, '*').count, n, '全局窗口同样不丢');
  /* 同一 IP 并发正好一轮：只有一次报「刚进入冷却」，strikes 正好 +1 */
  const db2 = makeAuthD1();
  const env2 = envOf(db2);
  const res2 = await Promise.all(Array.from({ length: PASSWORD_MAX_FAIL }, () => passwordLimiter(env2, REALM_LOCK, IP).recordFail()));
  assert.equal(res2.filter(Boolean).length, 1);
  assert.equal(row(db2).count, 0);
  assert.equal(row(db2).strikes, 1);
  assert.equal(await passwordLimiter(env2, REALM_LOCK, IP).inCooldown(), true);
  /* 走 HTTP verify 并发：每次错都计上 */
  const db3 = await withPassword();
  const rs = await Promise.all(Array.from({ length: 3 }, () => verify(db3, 'wrong-pass')));
  for (const r of rs) assert.equal(r.status, 403);
  assert.equal(row(db3).count, 3);
});

test('过期窗口重置：行过期（24 小时没输错）后读时不认，下一次输错从 1 计、轮数归零', async () => {
  const db = makeAuthD1();
  const env = envOf(db);
  const lim = passwordLimiter(env, REALM_LOCK, IP);
  for (let i = 0; i < PASSWORD_MAX_FAIL; i++) await lim.recordFail();
  assert.equal(await lim.inCooldown(), true);
  /* 冷却还没到期，但整行过期：不认 */
  patch(db, { expires_at: Date.now() - 1 });
  assert.equal(await lim.inCooldown(), false);
  for (let i = 0; i < 3; i++) await lim.recordFail();
  const r = row(db);
  assert.equal(r.count, 3, '过期行当新行：从 1 起计');
  assert.equal(r.strikes, 0, '轮数归零');
  assert.equal(r.locked_until, 0);
  /* 下一轮冷却按第 1 轮算（30 秒），不是接着翻倍 */
  await lim.recordFail();
  assert.equal(await lim.recordFail(), true);
  const left = cooldownLeft(db);
  assert.ok(left > PASSWORD_COOLDOWN_MS - 2000 && left <= PASSWORD_COOLDOWN_MS);
});

test('冷却生效：冷却中 verify 一律 429，不验密码、不再计数；到期后才放行', async () => {
  const db = await withPassword();
  for (let i = 0; i < PASSWORD_MAX_FAIL; i++) await verify(db, 'wrong-pass');
  const before = row(db);
  for (const pw of ['right-pass-1', 'wrong-pass', 'right-pass-1']) {
    const r = await verify(db, pw);
    assert.equal(r.status, 429);
    assert.equal((await r.json()).error, 'cooldown');
    assert.equal(r.headers.get('Set-Cookie'), null, '冷却中不签票');
  }
  assert.deepEqual(row(db), before, '冷却中不改计数行');
  expireCooldown(db);
  assert.equal((await verify(db, 'right-pass-1')).status, 200);
});

test('D1 出错：inCooldown / recordFail 抛错（调用方 fail closed）；verify 返回 503', async () => {
  const db = await withPassword();
  db.failOn = (sql) => /attempt_limit/.test(sql);
  const lim = passwordLimiter(envOf(db), REALM_LOCK, IP);
  await assert.rejects(() => lim.inCooldown(), /d1-error/);
  await assert.rejects(() => lim.recordFail(), /d1-error/);
  const r = await verify(db, 'right-pass-1');
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('Set-Cookie'), null);
});
