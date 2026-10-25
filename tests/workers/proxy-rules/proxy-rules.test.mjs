/**
 * 规则集反代 styrigx-proxy-rules（workers/proxy-rules）：白名单、上游、缓存、响应头。
 * 运行：node --test tests/workers/proxy-rules/ruleset.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { ALLOW, upstreamUrls, contentType, UPSTREAM_TIMEOUT_MS } from '../../../workers/proxy-rules/src/index.js';

const BASE = 'https://proxy-rules.styrigx.com';
const P = '/MetaCubeX/meta-rules-dat/meta/geo/';

let store, calls, upstream, waits;
beforeEach(() => {
  store = new Map(); calls = []; waits = [];
  upstream = () => new Response('RULES', { status: 200, headers: { 'set-cookie': 'x=1' } });
  globalThis.caches = { default: {
    match: async (req) => { const r = store.get(req.url); return r ? r.clone() : undefined; },
    put: async (req, res) => { store.set(req.url, res); },
  } };
  globalThis.fetch = async (req) => {
    calls.push(req.url);
    const r = upstream(req.url);
    if (r instanceof Error) throw r;
    Object.defineProperty(r, 'url', { value: req.url });
    return r;
  };
});
const ctx = () => ({ waitUntil: (p) => waits.push(p) });
const get = (path, init) => worker.fetch(new Request(BASE + path, init), {}, ctx());

test('白名单：geosite/geoip 下的 mrs、yaml、list 放行，其余拒绝', () => {
  for (const ok of ['geosite/cn.mrs', 'geosite/geolocation-!cn.mrs', 'geosite/category-ai-!cn.yaml', 'geoip/cn.list', 'geoip/private.mrs'])
    assert.ok(ALLOW.test(P + ok), ok);
  for (const bad of ['geosite/cn.dat', 'geosite/../x.mrs', 'geosite/.mrs', 'geosite/-x.mrs', 'asn/cn.mrs', 'geosite/a/b.mrs', 'geosite/cn.mrs.exe'])
    assert.ok(!ALLOW.test(P + bad), bad);
  assert.ok(!ALLOW.test('/other/repo/meta/geo/geosite/cn.mrs'));
});

test('上游：jsDelivr 在前，raw.githubusercontent 在后', () => {
  assert.deepEqual(upstreamUrls(P + 'geosite/cn.mrs'), [
    'https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/geosite/cn.mrs',
    'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/cn.mrs',
  ]);
});

test('内容类型按后缀', () => {
  assert.equal(contentType('a.mrs'), 'application/octet-stream');
  assert.equal(contentType('a.yaml'), 'text/yaml; charset=utf-8');
  assert.equal(contentType('a.list'), 'text/plain; charset=utf-8');
});

test('健康检查 / 和 /healthz', async () => {
  for (const p of ['/', '/healthz']) {
    const r = await get(p);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'styrigx-proxy-rules ok\n');
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
  assert.equal(calls.length, 0);
});

test('非 GET/HEAD 405，白名单外 404，都不打上游', async () => {
  assert.equal((await get(P + 'geosite/cn.mrs', { method: 'POST' })).status, 405);
  assert.equal((await get('/https://evil.example/x')).status, 404);
  assert.equal(calls.length, 0);
});

test('未命中：取上游，改写响应头，写缓存；再请求命中缓存不打上游', async () => {
  const r = await get(P + 'geosite/cn.mrs?v=1');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'RULES');
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.equal(r.headers.get('cache-control'), 'public, max-age=86400, stale-while-revalidate=604800');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.equal(r.headers.get('set-cookie'), null);
  assert.equal(r.headers.get('x-proxy-rules-cache'), 'MISS');
  assert.equal(r.headers.get('x-proxy-rules-upstream'), 'cdn.jsdelivr.net');
  await Promise.all(waits);
  assert.ok(store.has(BASE + P + 'geosite/cn.mrs'), '缓存键去掉了 query');

  const again = await get(P + 'geosite/cn.mrs?v=2');
  assert.equal(again.headers.get('x-proxy-rules-cache'), 'HIT');
  assert.equal(calls.length, 1);
});

test('主上游失败走备用', async () => {
  upstream = (u) => u.includes('jsdelivr') ? new Error('down') : new Response('B', { status: 200 });
  const r = await get(P + 'geoip/cn.list');
  assert.equal(await r.text(), 'B');
  assert.equal(r.headers.get('x-proxy-rules-upstream'), 'raw.githubusercontent.com');
  assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(calls.length, 2);
});

test('两个上游都 404 回 404，其他失败回 502', async () => {
  upstream = () => new Response('', { status: 404 });
  assert.equal((await get(P + 'geosite/nope.mrs')).status, 404);
  upstream = () => new Response('', { status: 500 });
  assert.equal((await get(P + 'geosite/nope.mrs')).status, 502);
  upstream = () => new Error('x');
  assert.equal((await get(P + 'geosite/nope.mrs')).status, 502);
});

test('HEAD 不读也不写缓存', async () => {
  const r = await get(P + 'geosite/cn.mrs', { method: 'HEAD' });
  assert.equal(r.status, 200);
  assert.equal(waits.length, 0);
});

test('主上游挂住（不回响应头）：等 UPSTREAM_TIMEOUT_MS 就中止，换备用', async () => {
  const realST = globalThis.setTimeout;
  const delays = [];
  /* 只把上游超时缩短到 5ms，其余 setTimeout 照常 */
  globalThis.setTimeout = (fn, ms, ...a) => { if (ms === UPSTREAM_TIMEOUT_MS) { delays.push(ms); return realST(fn, 5, ...a); } return realST(fn, ms, ...a); };
  const signals = [];
  globalThis.fetch = (req) => {
    calls.push(req.url);
    signals.push(req.signal);
    if (req.url.includes('jsdelivr')) {
      /* 永远不回，直到被中止 */
      return new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    }
    const r = new Response('BACKUP', { status: 200 });
    Object.defineProperty(r, 'url', { value: req.url });
    return Promise.resolve(r);
  };
  try {
    const r = await get(P + 'geosite/cn.mrs');
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'BACKUP');
    assert.equal(r.headers.get('x-proxy-rules-upstream'), 'raw.githubusercontent.com');
    assert.equal(calls.length, 2);
    assert.equal(delays.length, 2, '每个上游各一个计时器');
    assert.equal(signals[0].aborted, true, '主上游被中止');
    assert.equal(signals[1].aborted, false, '备用拿到响应后计时器清掉，正文转发不会被中止');
  } finally {
    globalThis.setTimeout = realST;
  }
});

test('两个上游都挂住：都超时后回 502', async () => {
  const realST = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => realST(fn, ms === UPSTREAM_TIMEOUT_MS ? 5 : ms, ...a);
  globalThis.fetch = (req) => { calls.push(req.url); return new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))); };
  try {
    assert.equal((await get(P + 'geosite/cn.mrs')).status, 502);
    assert.equal(calls.length, 2);
  } finally {
    globalThis.setTimeout = realST;
  }
});

test('响应头白名单（workers #33）：上游的 CSP / HSTS / x-github-* / Set-Cookie 不透传，只留 ETag / Last-Modified + 自己的头；缓存命中（含部署前的旧条目）也洗一遍', async () => {
  const UP = {
    'content-security-policy': "default-src 'none'; sandbox",
    'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
    'x-github-request-id': 'AAAA:BBBB',
    'x-frame-options': 'deny',
    'x-jsd-version': '1.2.3',
    'set-cookie': 'tracker=1',
    'access-control-allow-origin': 'https://evil.example',
    etag: 'W/"abc"',
    'last-modified': 'Sat, 24 Oct 2026 00:00:00 GMT',
    'content-type': 'text/html',
  };
  upstream = () => new Response('RULES', { status: 200, headers: UP });
  const r = await get(P + 'geosite/cn.list');
  assert.equal(r.status, 200);
  const names = [...r.headers.keys()].sort();
  assert.deepEqual(names, ['access-control-allow-origin', 'cache-control', 'content-type', 'etag', 'last-modified', 'x-content-type-options', 'x-proxy-rules-cache', 'x-proxy-rules-upstream']);
  assert.equal(r.headers.get('etag'), 'W/"abc"');
  assert.equal(r.headers.get('last-modified'), 'Sat, 24 Oct 2026 00:00:00 GMT');
  assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await r.text(), 'RULES');
  await Promise.all(waits);
  const hit = await get(P + 'geosite/cn.list');
  assert.equal(hit.headers.get('x-proxy-rules-cache'), 'HIT');
  assert.equal(hit.headers.get('x-proxy-rules-upstream'), 'cdn.jsdelivr.net');
  assert.equal(hit.headers.get('etag'), 'W/"abc"');
  assert.equal(hit.headers.get('content-security-policy'), null);
  /* 部署前写进 Cache API 的旧条目：头是上游原样的，命中时也只留白名单 */
  store.set(BASE + P + 'geoip/cn.mrs', new Response('OLD', { status: 200, headers: { ...UP, 'x-proxy-rules-upstream': 'raw.githubusercontent.com' } }));
  const old = await get(P + 'geoip/cn.mrs');
  assert.equal(await old.text(), 'OLD');
  assert.equal(old.headers.get('strict-transport-security'), null);
  assert.equal(old.headers.get('x-github-request-id'), null);
  assert.equal(old.headers.get('set-cookie'), null);
  assert.equal(old.headers.get('content-type'), 'application/octet-stream');
  assert.equal(old.headers.get('x-proxy-rules-upstream'), 'raw.githubusercontent.com');
  assert.equal(old.headers.get('x-proxy-rules-cache'), 'HIT');
});
