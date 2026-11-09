/**
 * 规则集反代 styrigx-proxy-rules：自有仓 styrigx/mihomo-rules release 分支（core/sources/own-repo.js）。
 * 白名单（只认 geosite / geoip 下 [a-z0-9-] 名字的 .mrs / .yaml）、上游顺序（raw 在前）、缓存 1 小时，
 * 以及两个来源互不串（MetaCubeX 仍 24 小时）。
 * 运行：node --test tests/workers/proxy-rules/*.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../../workers/proxy-rules/src/app.js';
import { ALLOW, upstreamUrls, CACHE_TTL } from '../../../workers/proxy-rules/src/core/sources/own-repo.js';
import * as metacubex from '../../../workers/proxy-rules/src/core/sources/metacubex.js';
import { matchSource, SOURCES } from '../../../workers/proxy-rules/src/core/sources.js';

const BASE = 'https://proxy-rules.styrigx.com';
const P = '/styrigx/mihomo-rules/release/';

/* mihomo-rules README 里的 13 个规则集（release 分支每个各一份 .mrs + .yaml） */
const GEOSITE = ['overseas', 'cn', 'ai', 'google', 'samsung', 'galaxy-store', 'nintendo', 'private', 'ntp', 'ads'];
const GEOIP = ['cn', 'google', 'private'];
const DIST = [...GEOSITE.map((n) => `geosite/${n}`), ...GEOIP.map((n) => `geoip/${n}`)];

let store, calls, cfOpts, upstream, waits;
beforeEach(() => {
  store = new Map(); calls = []; cfOpts = []; waits = [];
  upstream = () => new Response('RULES', { status: 200, headers: { 'set-cookie': 'x=1', 'content-type': 'text/plain; charset=utf-8' } });
  globalThis.caches = { default: {
    match: async (req) => { const r = store.get(req.url); return r ? r.clone() : undefined; },
    put: async (req, res) => { store.set(req.url, res); },
  } };
  globalThis.fetch = async (req, init) => {
    calls.push(req.url);
    cfOpts.push(init && init.cf);
    const r = upstream(req.url);
    if (r instanceof Error) throw r;
    Object.defineProperty(r, 'url', { value: req.url });
    return r;
  };
});
const ctx = () => ({ waitUntil: (p) => waits.push(p) });
const get = (path, init) => worker.fetch(new Request(BASE + path, init), {}, ctx());
/* 和 Worker 里一样经 URL 解析后的 pathname（`..`、`%2e%2e` 已折叠） */
const parsed = (path) => new URL(BASE + path).pathname;

test('白名单：release 里 13 个规则集的 .mrs 和 .yaml 全部放行', () => {
  assert.equal(DIST.length, 13);
  for (const f of DIST) for (const ext of ['mrs', 'yaml']) {
    const p = `${P}${f}.${ext}`;
    assert.ok(ALLOW.test(p), p);
    assert.equal(matchSource(p)?.source.id, 'own-repo', p);
  }
});

test('白名单：manifest、别的后缀、大写、未知目录、子目录、怪字符一律拒绝', () => {
  for (const bad of [
    'manifest.json', 'geosite/manifest.json',
    'geosite/cn.list', 'geosite/cn.json', 'geosite/cn.txt', 'geosite/cn.mrs.exe', 'geosite/cn.MRS', 'geosite/cn',
    'geosite/CN.mrs', 'geosite/Samsung.yaml', 'GEOSITE/cn.mrs',
    'asn/cn.mrs', 'geo/geosite/cn.mrs', 'rules/cn.mrs', 'cn.mrs',
    'geosite/a/b.mrs', 'geosite//cn.mrs',
    'geosite/.mrs', 'geosite/-cn.mrs', 'geosite/cn-.mrs', 'geosite/geolocation-!cn.mrs', 'geosite/cn_x.mrs', 'geosite/cn.x.mrs',
    'geosite/c%6e.mrs', 'geosite/..%2fx.mrs', 'geosite/%2e%2e/x.mrs', 'geosite/' + 'a'.repeat(65) + '.mrs',
  ]) {
    assert.ok(!ALLOW.test(P + bad), bad);
    assert.equal(matchSource(parsed(P + bad)), null, bad);
  }
  /* 别的分支、别的仓、大小写不同的仓名 */
  for (const bad of ['/styrigx/mihomo-rules/main/geosite/cn.mrs', '/styrigx/other/release/geosite/cn.mrs', '/Styrigx/mihomo-rules/release/geosite/cn.mrs', '/styrigx/mihomo-rules/dist/geosite/cn.mrs', '/styrigx/mihomo-rules/release/../release/geosite/x/../../../../MetaCubeX/x.mrs'])
    assert.equal(matchSource(parsed(bad)), null, bad);
});

test('路径穿越：URL 解析把 .. 折叠后不会落到白名单外的上游文件', async () => {
  for (const bad of [
    P + 'geosite/../manifest.json',
    P + 'geosite/%2e%2e/manifest.json',
    P + 'geosite/..%2fmanifest.json',
    P + 'geosite/%2e%2e%2f%2e%2e%2fmain/README.md',
    P + '../main/src/sources.yaml',
    P + 'geosite/..\\..\\x.mrs',
  ]) {
    const r = await get(bad);
    assert.equal(r.status, 404, bad);
  }
  /* 折叠后恰好落在白名单内的，转发的也是折叠后的规范路径 */
  const r = await get(P + 'geoip/../geosite/samsung.mrs');
  assert.equal(r.status, 200);
  assert.deepEqual(calls, ['https://raw.githubusercontent.com/styrigx/mihomo-rules/release/geosite/samsung.mrs']);
});

test('上游：raw.githubusercontent 在前，jsDelivr 在后（jsDelivr 的分支缓存会滞后）', () => {
  assert.deepEqual(upstreamUrls(P + 'geosite/samsung.mrs'), [
    'https://raw.githubusercontent.com/styrigx/mihomo-rules/release/geosite/samsung.mrs',
    'https://cdn.jsdelivr.net/gh/styrigx/mihomo-rules@release/geosite/samsung.mrs',
  ]);
  assert.deepEqual(upstreamUrls(P + 'geoip/cn.yaml'), [
    'https://raw.githubusercontent.com/styrigx/mihomo-rules/release/geoip/cn.yaml',
    'https://cdn.jsdelivr.net/gh/styrigx/mihomo-rules@release/geoip/cn.yaml',
  ]);
});

test('缓存时长：自有仓 1 小时，MetaCubeX 仍 24 小时', () => {
  assert.equal(CACHE_TTL, 3600);
  assert.equal(metacubex.CACHE_TTL, 86400);
  assert.deepEqual(SOURCES.map((s) => [s.id, s.cacheTtl]), [['metacubex', 86400], ['own-repo', 3600]]);
});

test('未命中：取 raw，内容类型按后缀，1 小时缓存头，cf.cacheTtl 也是 1 小时，不透传 Set-Cookie；再请求命中缓存', async () => {
  const r = await get(P + 'geosite/samsung.mrs?v=1');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'RULES');
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.equal(r.headers.get('cache-control'), 'public, max-age=3600, stale-while-revalidate=86400');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.equal(r.headers.get('set-cookie'), null);
  assert.equal(r.headers.get('x-proxy-rules-cache'), 'MISS');
  assert.equal(r.headers.get('x-proxy-rules-upstream'), 'raw.githubusercontent.com');
  assert.deepEqual(cfOpts, [{ cacheTtl: 3600, cacheEverything: true }]);
  await Promise.all(waits);
  assert.ok(store.has(BASE + P + 'geosite/samsung.mrs'), '缓存键去掉了 query');

  const again = await get(P + 'geosite/samsung.mrs?v=2');
  assert.equal(again.headers.get('x-proxy-rules-cache'), 'HIT');
  assert.equal(again.headers.get('cache-control'), 'public, max-age=3600, stale-while-revalidate=86400');
  assert.equal(calls.length, 1);

  const y = await get(P + 'geoip/cn.yaml');
  assert.equal(y.headers.get('content-type'), 'text/yaml; charset=utf-8');
});

test('MetaCubeX 路径的缓存头和 cf.cacheTtl 不受自有仓影响（仍 24 小时）', async () => {
  const r = await get('/MetaCubeX/meta-rules-dat/meta/geo/geosite/cn.mrs');
  assert.equal(r.headers.get('cache-control'), 'public, max-age=86400, stale-while-revalidate=604800');
  assert.deepEqual(cfOpts, [{ cacheTtl: 86400, cacheEverything: true }]);
  assert.deepEqual(calls, ['https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/geosite/cn.mrs']);
});

test('主上游 raw 失败走 jsDelivr；两个都 404 回 404，其他失败回 502', async () => {
  upstream = (u) => u.includes('raw.githubusercontent') ? new Response('', { status: 503 }) : new Response('B', { status: 200 });
  const r = await get(P + 'geoip/cn.mrs');
  assert.equal(await r.text(), 'B');
  assert.equal(r.headers.get('x-proxy-rules-upstream'), 'cdn.jsdelivr.net');
  assert.equal(calls.length, 2);

  upstream = () => new Response('', { status: 404 });
  assert.equal((await get(P + 'geosite/nope.mrs')).status, 404);
  upstream = () => new Error('down');
  assert.equal((await get(P + 'geosite/nope.mrs')).status, 502);
});

test('非 GET/HEAD 405；白名单外 404；都不打上游。HEAD 不写缓存', async () => {
  assert.equal((await get(P + 'geosite/cn.mrs', { method: 'POST' })).status, 405);
  assert.equal((await get(P + 'manifest.json')).status, 404);
  assert.equal((await get(P + 'geosite/CN.mrs')).status, 404);
  assert.equal(calls.length, 0);
  const h = await get(P + 'geosite/cn.mrs', { method: 'HEAD' });
  assert.equal(h.status, 200);
  assert.equal(waits.length, 0);
});

test('响应头只有白名单里的几个（和 MetaCubeX 同一套）', async () => {
  upstream = () => new Response('R', { status: 200, headers: {
    etag: '"e"', 'last-modified': 'Mon, 09 Nov 2026 00:00:00 GMT', 'set-cookie': 'a=1',
    'content-security-policy': "default-src 'none'", 'strict-transport-security': 'max-age=1', 'x-github-request-id': 'X',
  } });
  const r = await get(P + 'geosite/ai.yaml');
  assert.deepEqual([...r.headers.keys()].sort(), ['access-control-allow-origin', 'cache-control', 'content-type', 'etag', 'last-modified', 'x-content-type-options', 'x-proxy-rules-cache', 'x-proxy-rules-upstream']);
});
