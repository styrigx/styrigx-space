/**
 * GET /api/find（网关，src/api/find.js + core/find-limit.js；v5 S4 关键词搜索）：
 * - 公开：访客（没有进站会话）经整条网关也能调；只有 GET（POST / 多一段 /x 都不是 public → 401）
 * - 转给 styrigx-ai 的 GET /find：只带 q / lang，不转 cookie、不写账号结论头（伪造的结论头在 app.js 第一步被剥）
 * - 每 IP 第 11 次 429 cooldown + Retry-After + 终端能显示的 message；FIND_LIMITER 单独计数（不碰 AI_LIMITER）
 * - 绑定缺失 / 出错：放行
 * - styrigx-ai 没绑 / 抛错 / 非 2xx → 200 degraded（不 5xx）；q 为空 / 太长 400 bad_request（不进限流、不调 styrigx-ai）
 * - wrangler.toml：FIND_LIMITER 自己的 namespace，每 60 秒 10 次
 * 运行：node --test tests/workers/space-core/find-api.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as findApi from '../../../workers/space-core/src/api/find.js';
import * as L from '../../../workers/space-core/src/core/find-limit.js';
import { API_ROUTES } from '../../../workers/space-core/src/router.js';
import { withAuthD1 } from '../_harness.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;
const worker = (await import(REPO + 'workers/space-core/src/app.js')).default;
const CTX = { waitUntil() {} };

const RESULTS = [{ title: 'Muse tips', url: 'https://styrigx.com/blog/post/muse/', site: 'blog', snippet: 'Blog' }];

/** styrigx-ai 替身：记下转进来的请求 */
function aiSvc(log, fn) {
  return {
    async fetch(r) {
      log.push({ url: r.url, method: r.method, headers: Object.fromEntries(r.headers) });
      if (fn) return fn(r);
      const q = new URL(r.url).searchParams.get('q');
      return new Response(JSON.stringify({ ok: true, q, results: RESULTS }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    },
  };
}
/** Rate Limiting 替身：每个 key 计数，超过 limit 回 success:false */
function limiter(limit) {
  const m = new Map();
  return { calls: m, async limit({ key }) { const n = (m.get(key) || 0) + 1; m.set(key, n); return { success: n <= limit }; } };
}
function env(over = {}) {
  const log = [];
  const e = withAuthD1({
    SGX_ENV: 'production', SGX_SITE: 'space',
    AI_LIMITER: limiter(1000), FIND_LIMITER: limiter(10),
    AI_SERVICE: aiSvc(log), ...over,
  });
  e.log = log;
  return e;
}
function get(qs, { cookie = '', ip = '203.0.113.9', method = 'GET', path = '/api/find', extra = {} } = {}) {
  const headers = { 'CF-Connecting-IP': ip, Origin: 'https://styrigx.com', ...extra };
  if (cookie) headers.Cookie = cookie;
  return new Request('https://styrigx.com' + path + qs, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : '{}' });
}
const viaGateway = (r, e) => worker.fetch(r, e, CTX);

test('路由：/api/find 在 API_ROUTES，指向 api/find.js；只有 GET', () => {
  assert.equal(API_ROUTES.get('/api/find'), findApi);
  assert.deepEqual(Object.keys(findApi).filter((k) => k.startsWith('onRequest')), ['onRequestGet']);
});

test('访客经整条网关：GET /api/find 200 结果（公开）；POST / 多一段 401；HEAD 不是 public', async () => {
  const e = env();
  const r = await viaGateway(get('?q=muse&lang=en'), e);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('Cache-Control') || '', /no-store/);
  assert.deepEqual(await r.json(), { ok: true, q: 'muse', results: RESULTS });
  assert.equal(e.log.length, 1);
  for (const [m, p] of [['POST', '/api/find'], ['GET', '/api/find/x'], ['HEAD', '/api/find']]) {
    const e2 = env();
    const r2 = await viaGateway(get('?q=muse', { method: m, path: p }), e2);
    assert.equal(r2.status, 401, m + ' ' + p);
    assert.equal(e2.log.length, 0, m + ' ' + p + ' 没转 styrigx-ai');
  }
  /* 已登录也能用（接口公开，不看身份） */
  const e3 = env();
  assert.equal((await viaGateway(get('?q=muse', { cookie: 'sgx-session=styrigx' }), e3)).status, 200);
});

test('转发：GET https://styrigx-ai/find?q=&lang=；不转 cookie、不写账号结论头（伪造的也被剥）', async () => {
  const e = env();
  await viaGateway(get('?q=%20%20Galaxy%20Buds%20&lang=zh', {
    cookie: 'sgx-session=styrigx; sgx-account-session=ok',
    extra: { 'X-Styrigx-Account-Session': '1', 'X-Styrigx-Account-Scopes': 'curio.write' },
  }), e);
  assert.equal(e.log.length, 1);
  const u = new URL(e.log[0].url);
  assert.equal(u.origin + u.pathname, 'https://styrigx-ai/find');
  assert.equal(u.searchParams.get('q'), 'Galaxy Buds');
  assert.equal(u.searchParams.get('lang'), 'zh');
  assert.equal(e.log[0].method, 'GET');
  for (const h of Object.keys(e.log[0].headers)) assert.ok(!/^(cookie|x-styrigx-)/i.test(h), h);
  /* lang 不认识就不带 */
  const e2 = env();
  await viaGateway(get('?q=x&lang=fr'), e2);
  assert.equal(new URL(e2.log[0].url).searchParams.has('lang'), false);
});

test('限流：每 IP 第 11 次 429 cooldown + Retry-After 60 + message；别的 IP 不受影响；只用 FIND_LIMITER', async () => {
  const e = env();
  for (let i = 0; i < 10; i++) assert.equal((await viaGateway(get('?q=muse'), e)).status, 200, '第 ' + (i + 1) + ' 次');
  const r = await viaGateway(get('?q=muse'), e);
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('Retry-After'), '60');
  const j = await r.json();
  assert.deepEqual(j, { ok: false, error: 'cooldown', retryAfter: L.FIND_PERIOD, message: L.FIND_LIMITED_MESSAGE });
  assert.equal(e.log.length, 10, '超了不调 styrigx-ai');
  assert.equal((await viaGateway(get('?q=muse', { ip: '198.51.100.1' }), e)).status, 200);
  assert.equal(e.AI_LIMITER.calls.size, 0, '不占 AI 配额');
});

test('FIND_LIMITER 没绑 / 调用出错：放行', async () => {
  assert.equal((await viaGateway(get('?q=muse'), env({ FIND_LIMITER: undefined }))).status, 200);
  assert.equal((await viaGateway(get('?q=muse'), env({ FIND_LIMITER: { async limit() { throw new Error('x'); } } }))).status, 200);
});

test('styrigx-ai 没绑 / 抛错 / 非 2xx → 200 degraded（空结果），不 5xx', async () => {
  const cases = [
    env({ AI_SERVICE: undefined }),
    env({ AI_SERVICE: aiSvc([], () => { throw new Error('down'); }) }),
    env({ AI_SERVICE: aiSvc([], () => new Response('{"ok":false,"error":"internal"}', { status: 500 })) }),
  ];
  for (const e of cases) {
    const r = await viaGateway(get('?q=muse'), e);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, q: 'muse', results: [], degraded: true });
  }
  /* styrigx-ai 自己降级（KV 读不了）也原样回 */
  const deg = env({ AI_SERVICE: aiSvc([], () => Response.json({ ok: true, q: 'muse', results: [], degraded: true })) });
  assert.deepEqual(await (await viaGateway(get('?q=muse'), deg)).json(), { ok: true, q: 'muse', results: [], degraded: true });
});

test('q 为空 / 超过 FIND_Q_MAX → 400 bad_request；不进限流、不调 styrigx-ai', async () => {
  for (const qs of ['', '?q=', '?q=%20', '?q=' + 'a'.repeat(findApi.FIND_Q_MAX + 1)]) {
    const e = env();
    const r = await viaGateway(get(qs), e);
    assert.equal(r.status, 400, qs);
    assert.equal((await r.json()).error, 'bad_request');
    assert.equal(e.log.length, 0);
    assert.equal(e.FIND_LIMITER.calls.size, 0);
  }
});

test('wrangler.toml：[[ratelimits]] FIND_LIMITER 每 60 秒 10 次，周期和代码一致，namespace 不和别的限流器共用', () => {
  const toml = readFileSync(new URL('../../../workers/space-core/wrangler.toml', import.meta.url), 'utf8');
  const block = toml.split(/\n(?=\[\[)/).find((b) => /^\[\[ratelimits\]\]/m.test(b) && /^name = "FIND_LIMITER"$/m.test(b)) || '';
  assert.match(block, /^namespace_id = "2804"$/m);
  assert.match(block, /^simple = \{ limit = 10, period = 60 \}$/m);
  assert.equal(L.FIND_PERIOD, 60);
  const ns = [...toml.matchAll(/^namespace_id = "(\d+)"$/gm)].map((m) => m[1]);
  assert.equal(new Set(ns).size, ns.length);
});
