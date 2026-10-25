/**
 * 临时码输错限速（_kernel/lock-tempkey.js）：
 * - 单 IP 连错 5 次冷却 15 分钟（IPv6 按 /64 分桶，换地址绕不开）
 * - 全站只减速、不封锁：每小时错满 TEMPKEY_GLOBAL_SLOW_AT 次后每次先等 TEMPKEY_GLOBAL_DELAY_MS，
 *   以前的「全站错 30 次暂停 1 小时」已去掉（别人刷错就能让所有访客进不来），KV 里残留的 pausedUntil 不再生效
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

function makeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    m,
    get: async (k, fmt) => {
      const v = m.has(k) ? m.get(k) : null;
      if (v === null) return null;
      return fmt === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v) => { m.set(k, String(v)); },
    delete: async (k) => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter((n) => n.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
  };
}
const GLOBAL = 'lock-tempkey-fail-global';
const waits = [];
const fakeSleep = async (ms) => { waits.push(ms); };

test('全站错满阈值后只减速：本 IP 不冷却 → 先等 TEMPKEY_GLOBAL_DELAY_MS 再返回 false', async () => {
  const kv = makeKV({ [GLOBAL]: JSON.stringify({ count: TEMPKEY_GLOBAL_SLOW_AT, windowStart: Date.now() }) });
  waits.length = 0;
  assert.equal(await isTempkeyLimited(kv, '203.0.113.1', { sleep: fakeSleep }), false);
  assert.deepEqual(waits, [TEMPKEY_GLOBAL_DELAY_MS]);
});

test('全站没到阈值、或窗口已过：不等', async () => {
  waits.length = 0;
  let kv = makeKV({ [GLOBAL]: JSON.stringify({ count: TEMPKEY_GLOBAL_SLOW_AT - 1, windowStart: Date.now() }) });
  assert.equal(await isTempkeyLimited(kv, '203.0.113.1', { sleep: fakeSleep }), false);
  kv = makeKV({ [GLOBAL]: JSON.stringify({ count: 999, windowStart: Date.now() - 2 * 3600e3 }) });
  assert.equal(await isTempkeyLimited(kv, '203.0.113.1', { sleep: fakeSleep }), false);
  assert.deepEqual(waits, []);
});

test('KV 里残留旧格式 pausedUntil：不再封锁全站', async () => {
  const kv = makeKV({ [GLOBAL]: JSON.stringify({ count: 0, windowStart: Date.now(), pausedUntil: Date.now() + 3600e3 }) });
  assert.equal(await isTempkeyLimited(kv, '203.0.113.2', { sleep: fakeSleep }), false);
});

test('recordTempkeyFail：全站计数一直涨也不会写 pausedUntil；单 IP 第 5 次进入冷却', async () => {
  const kv = makeKV();
  for (let i = 0; i < 40; i++) await recordTempkeyFail(kv, '198.51.100.' + (i % 30));
  const g = JSON.parse(kv.m.get(GLOBAL));
  assert.equal(g.count, 40);
  assert.equal('pausedUntil' in g, false);
  assert.equal(await isTempkeyLimited(kv, '203.0.113.9', { sleep: fakeSleep }), false, '别的 IP 不受影响');
  const ip = '192.0.2.77';
  const res = [];
  for (let i = 0; i < 5; i++) res.push(await recordTempkeyFail(kv, ip));
  assert.deepEqual(res, [false, false, false, false, true]);
  assert.equal(await isTempkeyLimited(kv, ip, { sleep: fakeSleep }), true);
  await clearTempkeyFail(kv, ip);
  assert.equal(await isTempkeyLimited(kv, ip, { sleep: fakeSleep }), false, '清掉后不再冷却');
});

test('IPv6 按 /64 分桶：同一 /64 里换地址共用一个计数', async () => {
  const kv = makeKV();
  for (let i = 1; i <= 5; i++) await recordTempkeyFail(kv, '2001:db8:1:2::' + i.toString(16));
  assert.equal(await isTempkeyLimited(kv, '2001:db8:1:2:ffff:ffff:ffff:ffff', { sleep: fakeSleep }), true);
  assert.equal(await isTempkeyLimited(kv, '2001:db8:1:3::1', { sleep: fakeSleep }), false, '别的 /64 不受影响');
});

test('接口：全站已错满（含旧 pausedUntil），对的临时码照样进门', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const kv = makeKV();
  const env = {
    KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: makeKV(),
    SGX_LOCK_PRIVATE: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    SGX_LOCK_PUBLIC: publicKey.export({ type: 'spki', format: 'pem' }),
    SGX_PW_PEPPER: 'tk-pepper',
  };
  const made = await createTempkey(kv, 'tk-pepper', { name: 'guest', ms: 2 * 3600e3 });
  assert.ok(made && made.code, JSON.stringify(made));
  /* 全站减速期间也不是 429；这里把窗口设成刚好过期，免得测试真的等 2 秒 */
  kv.m.set(GLOBAL, JSON.stringify({ count: 500, windowStart: Date.now() - 3600e3 - 1, pausedUntil: Date.now() + 3600e3 }));
  const req = new Request('https://styrigx.com/api/lock-tempkey-unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://styrigx.com', 'CF-Connecting-IP': '203.0.113.50' },
    body: JSON.stringify({ code: made.code }),
  });
  const res = await unlockPost({ request: req, env });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, role: 'visitor' });
});
