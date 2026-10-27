/**
 * 根凭证限速（_kernel/root-limit.js + /api/root-auth）：
 * - 无会话假入口只计单 IP，不推全局计数（刷假入口锁不住主人）
 * - 全局只减速不封锁：全局计数满 ROOT_GLOBAL_SLOW_AT 后比对前先等 ROOT_GLOBAL_DELAY_MS，正确的 RootKey 照样通过
 * - 单 IP 连错 5 次锁 15 分钟：锁定中码对也 429，过期后恢复；IPv6 同一 /64 共用计数
 * - 记失败是原子 UPSERT：并发 N 次失败正好计 N 次；过期行读时不认、下一次失败从 1 重新计
 * - D1 出错 → 503（fail closed）
 * 存储：D1_ROOT_AUTH，attempt_limit 表 realm='root'、kind='rootkey'（bucket = IP 分桶；全局窗口 bucket='*'）。
 * 运行：node --test tests/workers/auth-gateway/root-limit.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost as rootAuth } from '../../../workers/auth-gateway/functions/api/root-auth.js';
import {
  checkRootLimit,
  recordRootFail,
  ROOT_GLOBAL_SLOW_AT,
  ROOT_GLOBAL_DELAY_MS,
} from '../../../workers/auth-gateway/functions/_kernel/root-limit.js';
import { makeAuthD1, genKeyPair } from '../_harness.mjs';

const { priv: PRIV, pub: PUB } = await genKeyPair();
const ROOT_KEY = 'test-root-key-abcdef-123456';

/* 三个 D1 绑定同一个库（同正式部署）；网关不绑 KV */
const env = (db) => ({ D1_LOCK_AUTH: db, D1_ACCOUNT_AUTH: db, D1_ROOT_AUTH: db, SGX_ROOT_KEY: ROOT_KEY, SGX_LOCK_PRIVATE: PRIV, SGX_LOCK_PUBLIC: PUB });
/** attempt_limit 里根凭证的一行（不管过没过期，原样返回；没有 → null） */
const row = (db, bucket) => db.raw.prepare("SELECT * FROM attempt_limit WHERE realm = 'root' AND kind = 'rootkey' AND bucket = ?").get(bucket) || null;
/** 直接改一行（摆前提：把窗口 / 锁定挪到过去） */
const patch = (db, bucket, cols) => {
  const keys = Object.keys(cols);
  db.raw.prepare('UPDATE attempt_limit SET ' + keys.map((k) => k + ' = ?').join(', ') + " WHERE realm = 'root' AND kind = 'rootkey' AND bucket = ?").run(...keys.map((k) => cols[k]), bucket);
};
function post(body, ip) {
  return new Request('https://styrigx.com/api/root-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://styrigx.com', 'CF-Connecting-IP': ip },
    body: JSON.stringify(body),
  });
}
/* 锁屏未设置（空库）时 lock-reset 走真路径（无需会话）；lock-reauth 无会话走假入口 */
const real = (db, key, ip) => rootAuth({ request: post({ key, purpose: 'lock-reset' }, ip), env: env(db) });
const decoy = (db, key, ip) => rootAuth({ request: post({ key, purpose: 'lock-reauth' }, ip), env: env(db) });

test('假入口：多个 IP 刷错只计单 IP，不推全局计数；主人随后用正确 RootKey 不受影响、不减速', async () => {
  const db = makeAuthD1();
  const n = ROOT_GLOBAL_SLOW_AT + 5;
  const rs = await Promise.all(Array.from({ length: n }, (_, i) => decoy(db, 'wrong', '198.51.100.' + i)));
  for (const r of rs) assert.equal(r.status, 401);
  assert.equal(row(db, '*'), null, '假入口不写全局计数');
  assert.equal(row(db, '198.51.100.0').count, 1, '单 IP 照样计数');
  const t0 = Date.now();
  const ok = await real(db, ROOT_KEY, '203.0.113.7');
  assert.equal(ok.status, 200);
  assert.ok(Date.now() - t0 < ROOT_GLOBAL_DELAY_MS, '没有触发全局减速');
});

test('假入口：同一 IP 刷满 5 次照样被单 IP 锁（与真路径一致）', async () => {
  const db = makeAuthD1();
  for (let i = 0; i < 5; i++) assert.equal((await decoy(db, 'wrong', '198.51.100.9')).status, 401);
  assert.equal((await decoy(db, 'wrong', '198.51.100.9')).status, 429);
});

test('全局计数：只有真比对失败才加；满阈值后 checkRootLimit 给出减速，不封锁', async () => {
  const db = makeAuthD1();
  const e = env(db);
  for (let i = 0; i < ROOT_GLOBAL_SLOW_AT - 1; i++) await recordRootFail(e, '192.0.2.' + i);
  assert.deepEqual(await checkRootLimit(e, '203.0.113.1'), { limited: false, delayMs: 0 });
  await recordRootFail(e, '192.0.2.250');
  assert.equal(row(db, '*').count, ROOT_GLOBAL_SLOW_AT);
  assert.deepEqual(await checkRootLimit(e, '203.0.113.1'), { limited: false, delayMs: ROOT_GLOBAL_DELAY_MS });
  /* global:false（假入口）不加全局 */
  await recordRootFail(e, '192.0.2.251', { global: false });
  assert.equal(row(db, '*').count, ROOT_GLOBAL_SLOW_AT);
  /* 窗口过了：不再减速，下一次失败从 1 重新计 */
  patch(db, '*', { window_start: Date.now() - 61 * 60 * 1000 });
  assert.deepEqual(await checkRootLimit(e, '203.0.113.1'), { limited: false, delayMs: 0 });
  await recordRootFail(e, '192.0.2.252');
  assert.equal(row(db, '*').count, 1);
});

test('全局暂停不存在：全局计数爆表时正确的 RootKey 仍然通过，只是先等几秒', async () => {
  const db = makeAuthD1();
  const now = Date.now();
  db.raw.prepare("INSERT INTO attempt_limit (realm, kind, bucket, count, window_start, expires_at) VALUES ('root', 'rootkey', '*', 100000, ?, ?)").run(now, now + 3600 * 1000);
  const t0 = Date.now();
  const ok = await real(db, ROOT_KEY, '203.0.113.8');
  assert.equal(ok.status, 200, '不是 429');
  assert.ok(Date.now() - t0 >= ROOT_GLOBAL_DELAY_MS - 50, '全局减速：比对前先等');
  /* 假入口同样等（时间上和真路径分不出来） */
  const t1 = Date.now();
  assert.equal((await decoy(db, 'wrong', '203.0.113.9')).status, 401);
  assert.ok(Date.now() - t1 >= ROOT_GLOBAL_DELAY_MS - 50);
});

test('单 IP 锁定：锁定中正确 RootKey 也 429；过期后恢复', async () => {
  const db = makeAuthD1();
  for (let i = 0; i < 5; i++) assert.equal((await real(db, 'wrong', '192.0.2.77')).status, 401);
  assert.equal((await real(db, ROOT_KEY, '192.0.2.77')).status, 429);
  const rec = row(db, '192.0.2.77');
  assert.ok(rec.locked_until > Date.now());
  assert.ok(rec.locked_until <= Date.now() + 15 * 60 * 1000, '锁 15 分钟');
  patch(db, '192.0.2.77', { locked_until: Date.now() - 1 });
  assert.equal((await real(db, ROOT_KEY, '192.0.2.77')).status, 200);
  assert.equal(row(db, '192.0.2.77'), null, '验对后清掉本 IP 的行');
});

test('单 IP 锁定：IPv6 同一 /64 换地址也共用计数', async () => {
  const db = makeAuthD1();
  const e = env(db);
  for (let i = 1; i <= 5; i++) await recordRootFail(e, '2001:db8:aa:bb::' + i.toString(16));
  assert.ok(row(db, '2001:db8:aa:bb::/64').locked_until > Date.now());
  assert.equal((await checkRootLimit(e, '2001:db8:aa:bb:ffff::1')).limited, true);
  assert.equal((await checkRootLimit(e, '2001:db8:aa:bc::1')).limited, false, '别的 /64 不受影响');
});

test('并发：N 个失败同时记（Promise.all）正好计 N 次，没有丢更新', async () => {
  const db = makeAuthD1();
  const e = env(db);
  const n = 4; /* < 5：不触发锁定清零，计数应正好是 n */
  await Promise.all(Array.from({ length: n }, () => recordRootFail(e, '192.0.2.150')));
  assert.equal(row(db, '192.0.2.150').count, n);
  assert.equal(row(db, '*').count, n, '全局窗口同样不丢');
  /* 再并发一批不同 IP：全局正好累加 */
  const m = ROOT_GLOBAL_SLOW_AT;
  await Promise.all(Array.from({ length: m }, (_, i) => recordRootFail(e, '198.51.100.' + i)));
  assert.equal(row(db, '*').count, n + m);
  /* 同一 IP 并发 5 次：正好进入锁定（第 5 次清零并锁定） */
  await Promise.all(Array.from({ length: 5 }, () => recordRootFail(e, '192.0.2.151')));
  assert.equal(row(db, '192.0.2.151').count, 0);
  assert.equal((await checkRootLimit(e, '192.0.2.151')).limited, true);
  /* 走 HTTP 的真路径并发：每个失败都计上 */
  const db2 = makeAuthD1();
  const rs = await Promise.all(Array.from({ length: 3 }, () => real(db2, 'wrong', '192.0.2.152')));
  for (const r of rs) assert.equal(r.status, 401);
  assert.equal(row(db2, '192.0.2.152').count, 3);
  assert.equal(row(db2, '*').count, 3);
});

test('过期窗口重置：单 IP 行过期后读时不认（锁定失效），下一次失败从 1 重新计', async () => {
  const db = makeAuthD1();
  const e = env(db);
  for (let i = 0; i < 5; i++) await recordRootFail(e, '192.0.2.160');
  assert.equal((await checkRootLimit(e, '192.0.2.160')).limited, true);
  /* 锁定还没到期，但整行 expires_at 过了：不认 */
  patch(db, '192.0.2.160', { expires_at: Date.now() - 1 });
  assert.equal((await checkRootLimit(e, '192.0.2.160')).limited, false);
  /* 计数中途过期：下一次失败当新行，count = 1，锁定清掉 */
  for (let i = 0; i < 3; i++) await recordRootFail(e, '192.0.2.161');
  patch(db, '192.0.2.161', { expires_at: Date.now() - 1 });
  await recordRootFail(e, '192.0.2.161');
  assert.equal(row(db, '192.0.2.161').count, 1);
  assert.equal(row(db, '192.0.2.161').locked_until, 0);
  /* 过期的锁定行被下一次失败当新行：不会从旧 locked_until 接着锁 */
  patch(db, '192.0.2.160', { expires_at: Date.now() - 1 });
  await recordRootFail(e, '192.0.2.160');
  assert.equal(row(db, '192.0.2.160').count, 1);
  assert.equal((await checkRootLimit(e, '192.0.2.160')).limited, false);
});

test('冷却生效：锁定期间正确的 RootKey 和错误的都 429，不比对、不再计数；锁定到期才放行', async () => {
  const db = makeAuthD1();
  for (let i = 0; i < 5; i++) await real(db, 'wrong', '192.0.2.170');
  const before = row(db, '192.0.2.170');
  const globalBefore = row(db, '*').count;
  for (const key of [ROOT_KEY, 'wrong', ROOT_KEY]) {
    const r = await real(db, key, '192.0.2.170');
    assert.equal(r.status, 429);
    assert.deepEqual(await r.json(), { ok: false, error: 'cooldown' });
  }
  assert.deepEqual(row(db, '192.0.2.170'), before, '冷却中不改计数行');
  assert.equal(row(db, '*').count, globalBefore, '冷却中不算真比对，不推全局');
  /* 别的 IP 不受影响 */
  assert.equal((await real(db, ROOT_KEY, '192.0.2.171')).status, 200);
  patch(db, '192.0.2.170', { locked_until: Date.now() - 1 });
  assert.equal((await real(db, ROOT_KEY, '192.0.2.170')).status, 200);
});

test('D1 出错 → 503（真路径和假入口都 fail closed）', async () => {
  const db = makeAuthD1();
  db.failOn = () => true;
  assert.equal((await decoy(db, 'wrong', '192.0.2.88')).status, 503);
  const db2 = makeAuthD1();
  db2.failOn = (sql) => /attempt_limit/.test(sql);
  const r = await real(db2, ROOT_KEY, '192.0.2.89');
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('Set-Cookie'), null, '不签票');
  /* 没绑 D1_ROOT_AUTH：同样拒绝 */
  const e = env(makeAuthD1());
  delete e.D1_ROOT_AUTH;
  const r3 = await rootAuth({ request: post({ key: ROOT_KEY, purpose: 'lock-reset' }, '192.0.2.90'), env: e });
  assert.ok(r3.status >= 500, '没绑定不放行');
  assert.equal(r3.headers.get('Set-Cookie'), null);
});
