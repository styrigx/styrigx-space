/**
 * 规则集反代 styrigx-proxy-rules（workers/proxy-rules）：白名单、上游、缓存、响应头。
 * 运行：node --test tests/workers/proxy-rules/ruleset.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { ALLOW, upstreamUrls, contentType } from '../../../workers/proxy-rules/src/index.js';

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
