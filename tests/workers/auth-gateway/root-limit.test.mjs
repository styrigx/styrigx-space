/**
 * 根凭证限速（_kernel/root-limit.js + /api/root-auth）：
 * - 无会话假入口只计单 IP，不推全局计数（刷假入口锁不住主人）
 * - 全局只减速不封锁：全局计数满 ROOT_GLOBAL_SLOW_AT 后比对前先等 ROOT_GLOBAL_DELAY_MS，正确的 RootKey 照样通过
 *   （包括 KV 里残留旧格式的 pausedUntil）
 * - 单 IP 连错 5 次锁 15 分钟：锁定中码对也 429，过期后恢复；IPv6 同一 /64 共用计数
 * - KV 出错 → 503（fail closed）
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

function makeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  const kv = {
    get: async (k, fmt) => {
      if (kv._fail) throw new Error('kv-fail');
      if (!m.has(k)) return null;
      const v = m.get(k);
      return fmt === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v) => {
      if (kv._fail) throw new Error('kv-fail');
      m.set(k, String(v));
    },
    delete: async (k) => { m.delete(k); },
    list: async () => ({ keys: [...m.keys()].map((name) => ({ name })) }),
    _map: m,
    _fail: false,
  };
  return kv;
}

function derToPem(der, label) {
  const b64 = Buffer.from(der).toString('base64');
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
}
const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const PRIV = derToPem(await crypto.subtle.exportKey('pkcs8', kp.privateKey), 'PRIVATE KEY');
const PUB = derToPem(await crypto.subtle.exportKey('spki', kp.publicKey), 'PUBLIC KEY');
const ROOT_KEY = 'test-root-key-abcdef-123456';

const env = (kv) => ({ KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv, SGX_ROOT_KEY: ROOT_KEY, SGX_LOCK_PRIVATE: PRIV, SGX_LOCK_PUBLIC: PUB });
function post(body, ip) {
  return new Request('https://styrigx.com/api/root-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://styrigx.com', 'CF-Connecting-IP': ip },
    body: JSON.stringify(body),
  });
}
/* 锁屏未设置（空 KV）时 lock-reset 走真路径（无需会话）；lock-reauth 无会话走假入口 */
const real = (kv, key, ip) => rootAuth({ request: post({ key, purpose: 'lock-reset' }, ip), env: env(kv) });
const decoy = (kv, key, ip) => rootAuth({ request: post({ key, purpose: 'lock-reauth' }, ip), env: env(kv) });

test('假入口：多个 IP 刷错只计单 IP，不推全局计数；主人随后用正确 RootKey 不受影响、不减速', async () => {
  const kv = makeKV();
  const n = ROOT_GLOBAL_SLOW_AT + 5;
  const rs = await Promise.all(Array.from({ length: n }, (_, i) => decoy(kv, 'wrong', '198.51.100.' + i)));
  for (const r of rs) assert.equal(r.status, 401);
  assert.equal(kv._map.get('root-fail-global'), undefined, '假入口不写全局计数');
  assert.equal(JSON.parse(kv._map.get('root-fail:198.51.100.0')).count, 1, '单 IP 照样计数');
  const t0 = Date.now();
  const ok = await real(kv, ROOT_KEY, '203.0.113.7');
  assert.equal(ok.status, 200);
  assert.ok(Date.now() - t0 < ROOT_GLOBAL_DELAY_MS, '没有触发全局减速');
});

test('假入口：同一 IP 刷满 5 次照样被单 IP 锁（与真路径一致）', async () => {
  const kv = makeKV();
  for (let i = 0; i < 5; i++) assert.equal((await decoy(kv, 'wrong', '198.51.100.9')).status, 401);
  assert.equal((await decoy(kv, 'wrong', '198.51.100.9')).status, 429);
});

test('全局计数：只有真比对失败才加；满阈值后 checkRootLimit 给出减速，不封锁', async () => {
  const kv = makeKV();
  for (let i = 0; i < ROOT_GLOBAL_SLOW_AT - 1; i++) await recordRootFail(kv, '192.0.2.' + i);
  assert.deepEqual(await checkRootLimit(kv, '203.0.113.1'), { limited: false, delayMs: 0 });
  await recordRootFail(kv, '192.0.2.250');
  assert.equal(JSON.parse(kv._map.get('root-fail-global')).count, ROOT_GLOBAL_SLOW_AT);
  assert.deepEqual(await checkRootLimit(kv, '203.0.113.1'), { limited: false, delayMs: ROOT_GLOBAL_DELAY_MS });
  /* global:false（假入口）不加全局 */
  await recordRootFail(kv, '192.0.2.251', { global: false });
  assert.equal(JSON.parse(kv._map.get('root-fail-global')).count, ROOT_GLOBAL_SLOW_AT);
  /* 窗口过了：不再减速，下一次失败从 1 重新计 */
  const g = JSON.parse(kv._map.get('root-fail-global'));
  g.windowStart = Date.now() - 61 * 60 * 1000;
  kv._map.set('root-fail-global', JSON.stringify(g));
  assert.deepEqual(await checkRootLimit(kv, '203.0.113.1'), { limited: false, delayMs: 0 });
  await recordRootFail(kv, '192.0.2.252');
  assert.equal(JSON.parse(kv._map.get('root-fail-global')).count, 1);
});

test('全局暂停不存在：全局计数爆表（含旧格式 pausedUntil）时正确的 RootKey 仍然通过，只是先等几秒', async () => {
  const now = Date.now();
  const kv = makeKV({ 'root-fail-global': JSON.stringify({ count: 100000, windowStart: now, pausedUntil: now + 3600 * 1000 }) });
  const t0 = Date.now();
  const ok = await real(kv, ROOT_KEY, '203.0.113.8');
  assert.equal(ok.status, 200, '不是 429');
  assert.ok(Date.now() - t0 >= ROOT_GLOBAL_DELAY_MS - 50, '全局减速：比对前先等');
  /* 假入口同样等（时间上和真路径分不出来） */
  const t1 = Date.now();
  assert.equal((await decoy(kv, 'wrong', '203.0.113.9')).status, 401);
  assert.ok(Date.now() - t1 >= ROOT_GLOBAL_DELAY_MS - 50);
});

test('单 IP 锁定：锁定中正确 RootKey 也 429；过期后恢复', async () => {
  const kv = makeKV();
  for (let i = 0; i < 5; i++) assert.equal((await real(kv, 'wrong', '192.0.2.77')).status, 401);
  assert.equal((await real(kv, ROOT_KEY, '192.0.2.77')).status, 429);
  const rec = JSON.parse(kv._map.get('root-fail:192.0.2.77'));
  assert.ok(rec.lockedUntil > Date.now());
  rec.lockedUntil = Date.now() - 1;
  kv._map.set('root-fail:192.0.2.77', JSON.stringify(rec));
  assert.equal((await real(kv, ROOT_KEY, '192.0.2.77')).status, 200);
});

test('单 IP 锁定：IPv6 同一 /64 换地址也共用计数', async () => {
  const kv = makeKV();
  for (let i = 1; i <= 5; i++) await recordRootFail(kv, '2001:db8:aa:bb::' + i.toString(16));
  assert.ok(JSON.parse(kv._map.get('root-fail:2001:db8:aa:bb::/64')).lockedUntil > Date.now());
  assert.equal((await checkRootLimit(kv, '2001:db8:aa:bb:ffff::1')).limited, true);
  assert.equal((await checkRootLimit(kv, '2001:db8:aa:bc::1')).limited, false, '别的 /64 不受影响');
});

test('KV 出错 → 503（真路径和假入口都 fail closed）', async () => {
  const kv = makeKV();
  kv._fail = true;
  assert.equal((await decoy(kv, 'wrong', '192.0.2.88')).status, 503);
  const kv2 = makeKV();
  const get = kv2.get;
  kv2.get = async (k, f) => { if (String(k).startsWith('root-fail')) throw new Error('kv-fail'); return get(k, f); };
  assert.equal((await real(kv2, ROOT_KEY, '192.0.2.89')).status, 503);
});
