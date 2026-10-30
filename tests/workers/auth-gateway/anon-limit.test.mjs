/**
 * 无会话写接口的按 IP 总限流（_kernel/anon-limit.js + _middleware.js，2026-10-28 PR2）。
 * - 无会话 POST 那五个接口：先过 ANON_LIMITER（按 CF-Connecting-IP），超了 429 cooldown + Retry-After，不进端点
 * - 有效会话（任何角色）、GET、别的接口：不过限流器
 * - 绑定缺失 / 限流器抛错：放行（防刷总闸，不是安全门）
 * - wrangler.toml 的 [[ratelimits]] 和代码里的名字 / 周期一致
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { testLockSession } from './_tickets.mjs';
import { genKeyPair, makeAuthD1 } from '../_harness.mjs';
import { anonLimit, ANON_LIMITED_APIS, ANON_LIMIT_PERIOD } from '../../../workers/auth-gateway/functions/_kernel/anon-limit.js';
import { onRequest } from '../../../workers/auth-gateway/functions/_middleware.js';

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
const env = (limiter) => ({ D1_LOCK_AUTH: DB, SGX_SITE: 'space', SGX_ENV: 'production', SGX_LOCK_PUBLIC: PUB, SGX_LOCK_PRIVATE: PRIV, ANON_LIMITER: limiter });

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

test('绑定缺失 / 限流器抛错 / 返回怪值：放行', async () => {
  assert.equal(await anonLimit(post('/api/root-auth'), env(undefined), false), null);
  assert.equal(await anonLimit(post('/api/root-auth'), env({}), false), null);
  assert.equal(await anonLimit(post('/api/root-auth'), env({ limit: async () => { throw new Error('edge down'); } }), false), null);
  assert.equal(await anonLimit(post('/api/root-auth'), env({ limit: async () => undefined }), false), null);
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
  const sess = 'sgx-lock-session=' + (await testLockSession(PRIV, 0, 'admin'));
  const r3 = await onRequest({ request: post('/api/lock-passkey', '203.0.113.9', sess), env: env(lim), next });
  assert.notEqual(r3.status, 429, '有会话不过限流器');
  assert.equal(reached, 2);
  assert.equal(lim.keys.length, 2, '有会话那次没调 limit');
});

test('wrangler.toml：[[ratelimits]] ANON_LIMITER 每 60 秒 20 次，周期和代码一致；Pages 预览不绑（缺绑定放行）', () => {
  const toml = readFileSync(new URL('../../../workers/auth-gateway/wrangler.toml', import.meta.url), 'utf8');
  const block = toml.split(/\n(?=\[\[)/).find((b) => /^\[\[ratelimits\]\]/m.test(b)) || '';
  assert.match(block, /^name = "ANON_LIMITER"$/m);
  assert.match(block, /^namespace_id = "\d+"$/m);
  assert.match(block, /^simple = \{ limit = 20, period = 60 \}$/m);
  assert.equal(ANON_LIMIT_PERIOD, 60);
  assert.equal((toml.match(/^\[\[ratelimits\]\]/gm) || []).length, 1);
});
