/**
 * 密码输错限速（_kernel/password-limit.js，锁屏密码 /api/lock-password verify 与账号密码共用）：
 * - 每连错 5 次冷却一轮：30 秒起逐轮翻倍，封顶 1 小时；冷却中码对也 429；验对后轮数归零
 * - 旧格式输错记录（纯数字）照常接着计
 * - 全局只减速不封锁：本域每小时输错满阈值后每次校验先等，不返回 429
 * - IPv6 同一 /64 共用计数
 * 运行：node --test tests/workers/auth-gateway/password-limit.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost as lockPassword } from '../../../workers/auth-gateway/functions/api/lock-password.js';
import { makePasswordRecord } from '../../../workers/auth-gateway/functions/_kernel/password.js';
import { REALM_LOCK, REALM_ACCOUNT } from '../../../workers/auth-gateway/functions/_kernel/realms.js';
import {
  passwordLimiter,
  cooldownMs,
  PASSWORD_COOLDOWN_MS,
  PASSWORD_COOLDOWN_MAX_MS,
  PASSWORD_GLOBAL_SLOW_AT,
  PASSWORD_GLOBAL_DELAY_MS,
} from '../../../workers/auth-gateway/functions/_kernel/password-limit.js';

const PEPPER = 'test-pepper';

function derToPem(der, label) {
  const b64 = Buffer.from(der).toString('base64');
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
}
const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const PRIV = derToPem(await crypto.subtle.exportKey('pkcs8', kp.privateKey), 'PRIVATE KEY');
const PUB = derToPem(await crypto.subtle.exportKey('spki', kp.publicKey), 'PUBLIC KEY');

function makeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  const ttl = new Map();
  return {
    get: async (k, fmt) => {
      if (!m.has(k)) return null;
      const v = m.get(k);
      return fmt === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v, o) => { m.set(k, String(v)); ttl.set(k, o && o.expirationTtl); },
    delete: async (k) => { m.delete(k); },
    list: async () => ({ keys: [] }),
    _map: m,
    _ttl: ttl,
  };
}

const IP = '198.51.100.20';
function verify(kv, password, ip = IP) {
  return lockPassword({
    request: new Request('https://styrigx.com/api/lock-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://styrigx.com', 'CF-Connecting-IP': ip },
      body: JSON.stringify({ action: 'verify', password }),
    }),
    env: { KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv, SGX_PW_PEPPER: PEPPER, SGX_LOCK_PRIVATE: PRIV, SGX_LOCK_PUBLIC: PUB },
  });
}
const failRec = (kv, ip = IP) => JSON.parse(kv._map.get(REALM_LOCK.kv.passwordFailPrefix + ip));
const cooldownLeft = (kv, ip = IP) => Number(kv._map.get(REALM_LOCK.kv.passwordCooldownPrefix + ip)) - Date.now();
const expireCooldown = (kv, ip = IP) => kv._map.set(REALM_LOCK.kv.passwordCooldownPrefix + ip, String(Date.now() - 1));

test('冷却时长：30 秒起逐轮翻倍，封顶 1 小时', () => {
  assert.equal(cooldownMs(1), PASSWORD_COOLDOWN_MS);
  assert.equal(cooldownMs(2), 2 * PASSWORD_COOLDOWN_MS);
  assert.equal(cooldownMs(3), 4 * PASSWORD_COOLDOWN_MS);
  assert.equal(cooldownMs(7), 64 * PASSWORD_COOLDOWN_MS);
  assert.equal(cooldownMs(8), PASSWORD_COOLDOWN_MAX_MS);
  assert.equal(cooldownMs(1000), PASSWORD_COOLDOWN_MAX_MS);
});

test('锁屏密码：每 5 次错进一轮冷却，第二轮翻倍；冷却中码对也 429；验对后轮数归零', async () => {
  const kv = makeKV({ 'lock-password': JSON.stringify(await makePasswordRecord('right-pass-1', PEPPER)) });
  /* 第 1 轮 */
  for (let i = 0; i < 4; i++) assert.equal((await verify(kv, 'wrong-pass')).status, 403);
  let r = await verify(kv, 'wrong-pass');
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error, 'cooldown');
  assert.deepEqual(failRec(kv), { count: 0, strikes: 1 });
  let left = cooldownLeft(kv);
  assert.ok(left > PASSWORD_COOLDOWN_MS - 2000 && left <= PASSWORD_COOLDOWN_MS, '第 1 轮 30 秒');
  assert.equal((await verify(kv, 'right-pass-1')).status, 429, '冷却中码对也不验');
  /* 第 2 轮：翻倍 */
  expireCooldown(kv);
  for (let i = 0; i < 4; i++) assert.equal((await verify(kv, 'wrong-pass')).status, 403);
  assert.equal((await verify(kv, 'wrong-pass')).status, 429);
  assert.deepEqual(failRec(kv), { count: 0, strikes: 2 });
  left = cooldownLeft(kv);
  assert.ok(left > 2 * PASSWORD_COOLDOWN_MS - 2000 && left <= 2 * PASSWORD_COOLDOWN_MS, '第 2 轮 60 秒');
  assert.ok(kv._ttl.get(REALM_LOCK.kv.passwordCooldownPrefix + IP) >= 60, 'KV TTL 不短于冷却');
  /* 别的 IP 不受影响 */
  assert.equal((await verify(kv, 'wrong-pass', '198.51.100.21')).status, 403);
  /* 冷却过了：码对 → 解锁成功，并清掉轮数 */
  expireCooldown(kv);
  r = await verify(kv, 'right-pass-1');
  assert.equal(r.status, 200);
  assert.equal(kv._map.get(REALM_LOCK.kv.passwordFailPrefix + IP), undefined);
  assert.equal(kv._map.get(REALM_LOCK.kv.passwordCooldownPrefix + IP), undefined);
});

test('冷却轮数一直累积到上限 1 小时（单元：limiter 直接记失败）', async () => {
  const kv = makeKV();
  const lim = passwordLimiter(kv, REALM_ACCOUNT, IP);
  let last = 0;
  for (let round = 1; round <= 10; round++) {
    for (let i = 0; i < 4; i++) assert.equal(await lim.recordFail(), false);
    assert.equal(await lim.recordFail(), true);
    last = Number(kv._map.get(REALM_ACCOUNT.kv.passwordCooldownPrefix + IP)) - Date.now();
    assert.ok(last <= cooldownMs(round) && last > cooldownMs(round) - 2000, 'round ' + round);
  }
  assert.ok(last > PASSWORD_COOLDOWN_MAX_MS - 2000 && last <= PASSWORD_COOLDOWN_MAX_MS);
  assert.ok(kv._ttl.get(REALM_ACCOUNT.kv.passwordFailPrefix + IP) >= 24 * 3600, '轮数记 24 小时');
});

test('旧格式输错记录（纯数字）接着计', async () => {
  const kv = makeKV({ [REALM_LOCK.kv.passwordFailPrefix + IP]: '4' });
  const lim = passwordLimiter(kv, REALM_LOCK, IP);
  assert.equal(await lim.recordFail(), true);
  assert.deepEqual(failRec(kv), { count: 0, strikes: 1 });
});

test('全局只减速：本域每小时输错满阈值后校验前先等，不冷却别人；未满不等；窗口过了不等', async () => {
  const kv = makeKV();
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  for (let i = 0; i < PASSWORD_GLOBAL_SLOW_AT - 1; i++) await passwordLimiter(kv, REALM_LOCK, '192.0.2.' + (i % 250)).recordFail();
  const owner = passwordLimiter(kv, REALM_LOCK, '203.0.113.50', { sleep });
  assert.equal(await owner.inCooldown(), false);
  assert.deepEqual(waits, []);
  await passwordLimiter(kv, REALM_LOCK, '192.0.2.251').recordFail();
  assert.equal(JSON.parse(kv._map.get(REALM_LOCK.kv.passwordFailGlobal)).count, PASSWORD_GLOBAL_SLOW_AT);
  assert.equal(await owner.inCooldown(), false, '不封锁');
  assert.deepEqual(waits, [PASSWORD_GLOBAL_DELAY_MS], '先等再验');
  /* 账号域各自计数 */
  waits.length = 0;
  assert.equal(await passwordLimiter(kv, REALM_ACCOUNT, '203.0.113.50', { sleep }).inCooldown(), false);
  assert.deepEqual(waits, []);
  /* 窗口过去 */
  const g = JSON.parse(kv._map.get(REALM_LOCK.kv.passwordFailGlobal));
  g.windowStart = Date.now() - 61 * 60 * 1000;
  kv._map.set(REALM_LOCK.kv.passwordFailGlobal, JSON.stringify(g));
  assert.equal(await owner.inCooldown(), false);
  assert.deepEqual(waits, []);
});

test('IPv6 同一 /64 换地址共用计数', async () => {
  const kv = makeKV();
  for (let i = 1; i <= 5; i++) await passwordLimiter(kv, REALM_LOCK, '2001:db8:1:2::' + i).recordFail();
  assert.equal(await passwordLimiter(kv, REALM_LOCK, '2001:db8:1:2:abcd::9').inCooldown(), true);
  assert.equal(await passwordLimiter(kv, REALM_LOCK, '2001:db8:1:3::1').inCooldown(), false);
});
