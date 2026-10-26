/**
 * 验对后清失败计数改成「先读、有才删」（_kernel/kv-clear.js，PR E 的 E7）：
 * 根凭证（/api/root-auth → root-check → clearRootFail）、锁屏 / 账号密码（password-limit clearFail）。
 *
 * 为什么和无条件删除的安全语义相同：
 * 1. 串行（没有并发）时：读到有 → 删，和以前同一个结果；读到没有 → 以前的删除是空操作。
 *    下面「随机操作序列」把新旧两种清法放进同一串输错 / 验对 / 冷却判断 / 时间流逝里逐步对比，
 *    每一步的返回值和 KV 内容都相同。
 * 2. 并发：两种清法唯一的差别在「读到没有之后、原本要删的那一刻之前」有别的请求写进失败记录：
 *    以前会把它删掉（攻击者的失败被清零），现在保留——只会更严，不会给任何人多出尝试次数。
 *    读到有、随后被并发改写：两种都删，相同。
 * 3. KV 读出错：照旧去删（尽力而为，出错吞掉），和以前相同。
 * 4. KV 最终一致：读到过期的「没有」时少删一次 = 保留了失败记录，同 2，只会更严。
 * 5. 计数的增加（recordFail / recordRootFail）、冷却 / 锁定判断都不经这里，没变。
 * 6. 时间侧信道：多出来的读只在验对之后，验对的人本来就知道结果。
 *
 * 运行：node --test tests/workers/auth-gateway/kv-clear.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteIfPresent } from '../../../workers/auth-gateway/functions/_kernel/kv-clear.js';
import { passwordLimiter } from '../../../workers/auth-gateway/functions/_kernel/password-limit.js';
import { recordRootFail, checkRootLimit, clearRootFail } from '../../../workers/auth-gateway/functions/_kernel/root-limit.js';
import { onRequestPost as rootAuth } from '../../../workers/auth-gateway/functions/api/root-auth.js';
import { onRequestPost as lockPassword } from '../../../workers/auth-gateway/functions/api/lock-password.js';
import { makePasswordRecord } from '../../../workers/auth-gateway/functions/_kernel/password.js';
import { REALM_LOCK, REALM_ROOT } from '../../../workers/auth-gateway/functions/_kernel/realms.js';
import { makeKV, genKeyPair } from '../_harness.mjs';

const { priv: PRIV, pub: PUB } = await genKeyPair();
const ROOT_KEY = 'test-root-key-kv-clear-123456';
const PEPPER = 'kv-clear-pepper';
const IP = '198.51.100.77';
const env = (kv) => ({ KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv, SGX_ROOT_KEY: ROOT_KEY, SGX_PW_PEPPER: PEPPER, SGX_LOCK_PRIVATE: PRIV, SGX_LOCK_PUBLIC: PUB });
const post = (path, body) => new Request('https://styrigx.com' + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'https://styrigx.com', 'CF-Connecting-IP': IP },
  body: JSON.stringify(body),
});
/* 锁屏未设置时 lock-reset 走真路径（无需会话） */
const rootReal = (kv, key) => rootAuth({ request: post('/api/root-auth', { key, purpose: 'lock-reset' }), env: env(kv) });
const pwVerify = (kv, password) => lockPassword({ request: post('/api/lock-password', { action: 'verify', password }), env: env(kv) });
const deletesOf = (kv, prefix) => kv._deleted.filter((k) => k.startsWith(prefix));
/** makeKV 外加记录删过哪些键 */
function kvWithDeleteLog(seed) {
  const kv = makeKV(seed);
  kv._deleted = [];
  const del = kv.delete;
  kv.delete = async (k) => { kv._deleted.push(k); return del(k); };
  return kv;
}

test('deleteIfPresent：没有不删；有就删；读出错照旧删（尽力而为）', async () => {
  const kv = kvWithDeleteLog({ a: '1' });
  assert.equal(await deleteIfPresent(kv, 'b'), false);
  assert.deepEqual(kv._deleted, []);
  assert.equal(await deleteIfPresent(kv, 'a'), true);
  assert.deepEqual(kv._deleted, ['a']);
  assert.equal(kv._map.has('a'), false);
  const bad = kvWithDeleteLog({ c: '1' });
  bad.failGet = () => true;
  assert.equal(await deleteIfPresent(bad, 'c'), true, '读不到 = 不知道 → 删');
  assert.deepEqual(bad._deleted, ['c']);
});

test('根凭证验对：之前没输错过 → 不删任何 root-fail 键；输错过 → 照旧清掉，之后从 0 计', async () => {
  const kv = kvWithDeleteLog();
  assert.equal((await rootReal(kv, ROOT_KEY)).status, 200);
  assert.deepEqual(deletesOf(kv, REALM_ROOT.kv.failPrefix), [], '没有失败记录就不花删除');
  const kv2 = kvWithDeleteLog();
  for (let i = 0; i < 3; i++) assert.equal((await rootReal(kv2, 'wrong-key')).status, 401);
  assert.equal(JSON.parse(kv2._map.get(REALM_ROOT.kv.failPrefix + IP)).count, 3);
  assert.equal((await rootReal(kv2, ROOT_KEY)).status, 200);
  assert.deepEqual(deletesOf(kv2, REALM_ROOT.kv.failPrefix), [REALM_ROOT.kv.failPrefix + IP]);
  assert.equal(kv2._map.has(REALM_ROOT.kv.failPrefix + IP), false);
  /* 清过之后还要再错满 5 次才锁（和以前一样） */
  for (let i = 0; i < 4; i++) assert.equal((await rootReal(kv2, 'wrong-key')).status, 401);
  assert.equal((await rootReal(kv2, 'wrong-key')).status, 401);
  assert.equal((await rootReal(kv2, ROOT_KEY)).status, 429, '第 5 次错之后锁定，码对也 429');
});

test('锁屏密码验对：之前没输错过 → 不删 lock-password-fail / -cooldown；输错过 → 照旧清掉', async () => {
  const seed = { 'lock-password': JSON.stringify(await makePasswordRecord('right-pass-1', PEPPER)) };
  const kv = kvWithDeleteLog(seed);
  assert.equal((await pwVerify(kv, 'right-pass-1')).status, 200);
  assert.deepEqual(deletesOf(kv, 'lock-password-'), []);
  const kv2 = kvWithDeleteLog(seed);
  for (let i = 0; i < 2; i++) assert.equal((await pwVerify(kv2, 'wrong-pass')).status, 403);
  assert.equal((await pwVerify(kv2, 'right-pass-1')).status, 200);
  assert.deepEqual(deletesOf(kv2, 'lock-password-'), [REALM_LOCK.kv.passwordFailPrefix + IP]);
  assert.equal(kv2._map.has(REALM_LOCK.kv.passwordFailPrefix + IP), false);
});

test('并发：读到没有之后别的请求写进失败记录 → 保留（以前会被删掉）；读到有之后被改写 → 两种都删', async () => {
  const key = REALM_LOCK.kv.passwordFailPrefix + IP;
  /* 读完、删之前插进一次并发输错 */
  const kv = makeKV();
  const get = kv.get;
  kv.get = async (k, t) => {
    const v = await get(k, t);
    if (k === key) await kv.put(key, JSON.stringify({ count: 1, strikes: 0 }));
    return v;
  };
  await passwordLimiter(kv, REALM_LOCK, IP).clearFail();
  assert.deepEqual(JSON.parse(kv._map.get(key)), { count: 1, strikes: 0 }, '并发写进来的失败没被清零（只会更严）');
  const kv2 = makeKV({ [key]: JSON.stringify({ count: 2, strikes: 1 }) });
  const get2 = kv2.get;
  kv2.get = async (k, t) => {
    const v = await get2(k, t);
    if (k === key) await kv2.put(key, JSON.stringify({ count: 3, strikes: 1 }));
    return v;
  };
  await passwordLimiter(kv2, REALM_LOCK, IP).clearFail();
  assert.equal(kv2._map.has(key), false, '有记录时照旧删');
});

/* ---- 串行等价：新旧两种清法放进同一串操作，每一步返回值与 KV 内容逐一相同 ---- */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
/** 以前的清法（无条件删） */
function oldPasswordClear(kv) {
  return async () => {
    try {
      await kv.delete(REALM_LOCK.kv.passwordFailPrefix + IP);
      await kv.delete(REALM_LOCK.kv.passwordCooldownPrefix + IP);
    } catch (e) {}
  };
}
async function oldRootClear(kv, ip) {
  try { await kv.delete(REALM_ROOT.kv.failPrefix + ip); } catch (e) {}
}
const snapshot = (kv) => JSON.stringify([...kv._map.entries()].sort());

test('串行等价（密码）：400 串随机操作（输错 / 验对清计数 / 冷却判断 / 时间流逝），新旧两种清法每一步都相同', async () => {
  const realNow = Date.now;
  const sleep = async () => {};
  try {
    for (let run = 0; run < 400; run++) {
      const r = rng(run + 1);
      let now = 1_800_000_000_000;
      Date.now = () => now;
      const a = makeKV();
      const b = makeKV();
      const la = passwordLimiter(a, REALM_LOCK, IP, { sleep });
      const lb = passwordLimiter(b, REALM_LOCK, IP, { sleep });
      const oldClear = oldPasswordClear(b);
      for (let step = 0; step < 40; step++) {
        const x = r();
        if (x < 0.45) assert.equal(await la.recordFail(), await lb.recordFail());
        else if (x < 0.6) { await la.clearFail(); await oldClear(); }
        else if (x < 0.85) assert.equal(await la.inCooldown(), await lb.inCooldown());
        else now += Math.floor(r() * 120_000);
        assert.equal(snapshot(a), snapshot(b), `run ${run} step ${step}`);
      }
    }
  } finally {
    Date.now = realNow;
  }
});

test('串行等价（根凭证）：400 串随机操作（真比对失败 / 验对清计数 / 限速判断 / 时间流逝），新旧每一步都相同', async () => {
  const realNow = Date.now;
  try {
    for (let run = 0; run < 400; run++) {
      const r = rng(10_000 + run);
      let now = 1_800_000_000_000;
      Date.now = () => now;
      const a = makeKV();
      const b = makeKV();
      for (let step = 0; step < 40; step++) {
        const x = r();
        if (x < 0.45) { await recordRootFail(a, IP); await recordRootFail(b, IP); }
        else if (x < 0.6) { await clearRootFail(a, IP); await oldRootClear(b, IP); }
        else if (x < 0.85) assert.deepEqual(await checkRootLimit(a, IP), await checkRootLimit(b, IP));
        else now += Math.floor(r() * 600_000);
        assert.equal(snapshot(a), snapshot(b), `run ${run} step ${step}`);
      }
    }
  } finally {
    Date.now = realNow;
  }
});
