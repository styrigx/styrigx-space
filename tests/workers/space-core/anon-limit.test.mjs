/**
 * 无会话写接口的按 IP 总限流（src/core/anon-limit.js + gate.js，2026-10-28 PR2）。
 * - 无会话 POST 那五个接口：先过 ANON_LIMITER（按 CF-Connecting-IP），超了 429 cooldown + Retry-After，不进端点
 * - 有效会话（任何角色）、GET、别的接口：不过限流器
 * - 绑定缺失 = 部署配错：fail-closed 503 config + console.error（2026-11-09）；限流器抛错 / 返回怪值：放行（防刷总闸，不是安全门）
 * - wrangler.toml 的 [[ratelimits]] 和代码里的名字 / 周期一致
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { testLockSession } from './_tickets.mjs';
import { genKeyPair, makeAuthD1 } from '../_harness.mjs';
import { anonLimit, ANON_LIMITED_APIS, ANON_LIMIT_PERIOD } from '../../../workers/space-core/src/core/anon-limit.js';
import { onRequest } from '../../../workers/space-core/src/gate.js';

const { priv: PRIV, pub: PUB } = await genKeyPair();

/** 假限流器：每个 key 前 max 次 success，之后 false；记下每次的 key */
function fakeLimiter(max = 20) {
  const n = new Map();
  const keys = [];
  return {
    keys,
    async limit({ key }) { keys.push(key); n.set(key, (n.get(key) || 0) + 1); return { success: n.get(key) <= max }; },
  };
}
const post = (path, ip = '203.0.113.9', cookie = '') => new Request('https://styrigx.com' + path, {
  method: 'POST',
  headers: Object.assign({ 'Content-Type': 'application/json', Origin: 'https://styrigx.com', 'CF-Connecting-IP': ip }, cookie ? { Cookie: cookie } : {}),
  body: '{"action":"challenge","type":"auth"}',
});
const DB = makeAuthD1();
const env = (limiter) => ({ D1_SPACE: DB, SGX_SITE: 'space', SGX_ENV: 'production', SGX_SPACE_PUBLIC: PUB, SGX_SPACE_PRIVATE: PRIV, ANON_LIMITER: limiter });

test('五个无会话写接口：每个 IP 超过上限 → 429 cooldown + Retry-After，retryAfter = 周期', async () => {
  for (const path of ANON_LIMITED_APIS) {
    const lim = fakeLimiter(2);
    const e = env(lim);
    assert.equal(await anonLimit(post(path), e, false), null);
    assert.equal(await anonLimit(post(path), e, false), null);
    const r = await anonLimit(post(path), e, false);
    assert.ok(r, path + ' 第三次应被限');
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('Retry-After'), String(ANON_LIMIT_PERIOD));
    assert.match(r.headers.get('Cache-Control') || '', /no-store/);
    assert.deepEqual(await r.json(), { ok: false, error: 'cooldown', retryAfter: ANON_LIMIT_PERIOD });
    /* 换个 IP 不受影响 */
    assert.equal(await anonLimit(post(path, '198.51.100.7'), e, false), null);
    assert.deepEqual([...new Set(lim.keys)].sort(), ['198.51.100.7', '203.0.113.9']);
  }
});

test('有效会话、GET、别的接口：不碰限流器', async () => {
  const lim = fakeLimiter(0);
  const e = env(lim);
  assert.equal(await anonLimit(post('/api/lock-passkey'), e, true), null, '有会话不限');
  assert.equal(await anonLimit(new Request('https://styrigx.com/api/lock-entry'), e, false), null, 'GET 不限');
  assert.equal(await anonLimit(new Request('https://styrigx.com/api/lock-passkey'), e, false), null, 'GET 同路径也不限');
  assert.equal(await anonLimit(post('/api/lock-session-check'), e, false), null, '不在名单里的不限');
  assert.equal(await anonLimit(post('/api/lock-passkey/extra'), e, false), null, '只认精确路径');
  assert.deepEqual(lim.keys, []);
});

test('绑定缺失：fail-closed 503 config，打 console.error（2026-11-09）；有会话 / GET / 不在名单的接口不受影响', async () => {
  const errs = [];
  const orig = console.error;
  console.error = (...a) => { errs.push(a.join(' ')); };
  try {
    for (const lim of [undefined, {}]) {
      const r = await anonLimit(post('/api/space-auth'), env(lim), false);
      assert.ok(r, '缺绑定不放行');
      assert.equal(r.status, 503);
      assert.equal((await r.json()).error, 'config');
    }
  } finally { console.error = orig; }
  assert.equal(errs.length, 2);
  assert.match(errs[0], /no ANON_LIMITER binding, fail-closed 503 path=\/api\/space-auth/);
  assert.equal(await anonLimit(post('/api/space-auth'), env(undefined), true), null, '有会话不经总闸');
  assert.equal(await anonLimit(new Request('https://styrigx.com/api/space-auth'), env(undefined), false), null, 'GET 不经总闸');
  assert.equal(await anonLimit(post('/api/ai'), env(undefined), false), null, '不在名单的接口不经总闸');
});

test('限流器抛错 / 返回怪值：放行', async () => {
  assert.equal(await anonLimit(post('/api/space-auth'), env({ limit: async () => { throw new Error('edge down'); } }), false), null);
  assert.equal(await anonLimit(post('/api/space-auth'), env({ limit: async () => undefined }), false), null);
});

test('没有 CF-Connecting-IP：按 unknown 一个桶算（不认 X-Forwarded-For）', async () => {
  const lim = fakeLimiter(1);
  const req = () => new Request('https://styrigx.com/api/lock-password', { method: 'POST', headers: { 'X-Forwarded-For': '1.2.3.4' }, body: '{}' });
  assert.equal(await anonLimit(req(), env(lim), false), null);
  assert.equal((await anonLimit(req(), env(lim), false)).status, 429);
  assert.deepEqual(lim.keys, ['unknown', 'unknown']);
});

test('中间件：无会话超限 → 429，不进端点；带有效会话照常进端点', async () => {
  const lim = fakeLimiter(1);
  let reached = 0;
  const next = async () => { reached++; return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } }); };
  const r1 = await onRequest({ request: post('/api/lock-passkey'), env: env(lim), next });
  assert.notEqual(r1.status, 429);
  const r2 = await onRequest({ request: post('/api/lock-passkey'), env: env(lim), next });
  assert.equal(r2.status, 429);
  assert.equal((await r2.json()).error, 'cooldown');
  assert.equal(reached, 1, '被限的那次没进端点');
  const sess = 'sgx-space-session=' + (await testLockSession(PRIV, 0, 'password'));
  const r3 = await onRequest({ request: post('/api/lock-passkey', '203.0.113.9', sess), env: env(lim), next });
  assert.notEqual(r3.status, 429, '有会话不过限流器');
  assert.equal(reached, 2);
  assert.equal(lim.keys.length, 2, '有会话那次没调 limit');
});

test('wrangler.toml：[[ratelimits]] ANON_LIMITER 每 60 秒 20 次，周期和代码一致，不和 AI_LIMITER 共用 namespace；Pages 预览不绑（测试入口 preview-worker.js 给放行的桩）', () => {
  const toml = readFileSync(new URL('../../../workers/space-core/wrangler.toml', import.meta.url), 'utf8');
  const block = toml.split(/\n(?=\[\[)/).find((b) => /^\[\[ratelimits\]\]/m.test(b) && /^name = "ANON_LIMITER"$/m.test(b)) || '';
  assert.match(block, /^name = "ANON_LIMITER"$/m);
  assert.match(block, /^namespace_id = "\d+"$/m);
  assert.match(block, /^simple = \{ limit = 20, period = 60 \}$/m);
  assert.equal(ANON_LIMIT_PERIOD, 60);
  /* P4-1 起还有 AI_LIMITER（namespace 2802，见 ai-api.test.mjs），v5 S4 起还有 FIND_LIMITER（见 find-api.test.mjs）；三个绑定不共用 namespace */
  assert.equal((toml.match(/^\[\[ratelimits\]\]/gm) || []).length, 3);
  const ns = [...toml.matchAll(/^namespace_id = "(\d+)"$/gm)].map((m) => m[1]);
  assert.equal(new Set(ns).size, ns.length);
});
