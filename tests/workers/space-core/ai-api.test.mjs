/**
 * /api/ai（网关，src/api/ai.js + core/ai-limit.js；P4-1，方案 5.3 / 5.6）：
 * 同源、进门（不分进门方式）、不要账号会话、每 IP 第 7 次 429 cooldown、全站第 61 次 429 busy（跨请求共享计数、超闸不写行）、
 * D1 出错 429 busy（fail closed）、账号结论头只在有账号会话时写、转发只带 Content-Type 和结论头（不转 cookie）、
 * 浏览器伪造的 X-Styrigx-Account-* 被剥（整条 app.js 链路）、SSE 原样流回、没绑定 503 / 抛错 502、wrangler.toml 绑定。
 * 运行：node --test tests/workers/space-core/ai-api.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as aiApi from '../../../workers/space-core/src/api/ai.js';
import * as L from '../../../workers/space-core/src/core/ai-limit.js';
import { API_ROUTES } from '../../../workers/space-core/src/router.js';
import { testLockSession } from './_tickets.mjs';
import { genKeyPair, withAuthD1, makeAuthD1 } from '../_harness.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;
const worker = (await import(REPO + 'workers/space-core/src/app.js')).default;
const CTX = { waitUntil() {} };

const { priv: PRIV, pub: PUB } = await genKeyPair();
const PW_SESS = await testLockSession(PRIV, 0, 'password');
const LINK_SESS = await testLockSession(PRIV, 0, 'link');

function kv() {
  const m = new Map();
  return { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); }, async list() { return { keys: [] }; } };
}

/** styrigx-ai 替身：记下转进来的请求，回一段 SSE */
function aiSvc(log, fn) {
  return {
    async fetch(r) {
      log.push({ url: r.url, method: r.method, headers: Object.fromEntries(r.headers), body: await r.clone().text(), signal: r.signal });
      if (fn) return fn(r);
      return new Response('event: delta\ndata: {"text":"ok"}\n\nevent: done\ndata: {}\n\n', {
        status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Styrigx-AI-Scope': r.headers.get('X-Styrigx-Account-Session') === '1' ? 'private' : 'public' },
      });
    },
  };
}
const ACCOUNT_VERIFIER = {
  async authorize(cookie) {
    if (/sgx-account-session=boom/.test(cookie)) throw new Error('rpc');
    if (/sgx-account-session=ok/.test(cookie)) return { ok: true, reason: 'ok', deviceId: 'devtestdevtest01', scopes: ['curio.write'], reauth: false };
    return { ok: false, reason: 'missing' };
  },
};
/** Rate Limiting 替身：每个 key 计数，超过 limit 回 success:false */
function limiter(limit) {
  const m = new Map();
  return { calls: m, async limit({ key }) { const n = (m.get(key) || 0) + 1; m.set(key, n); return { success: n <= limit }; } };
}

function env(over = {}) {
  const log = [];
  const e = withAuthD1({ SGX_ENV: 'production', SGX_SITE: 'space', SGX_SPACE_PUBLIC: PUB, KV_LOCK_DOOR: kv(), ACCOUNT_VERIFIER, AI_SERVICE: aiSvc(log), ...over });
  e.log = log;
  return e;
}
function req({ cookie = PW_SESS, acc, origin = 'https://styrigx.com', ip = '203.0.113.7', body = { q: '主题' }, extra = {} } = {}) {
  const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...extra };
  const c = [];
  if (cookie) c.push('sgx-space-session=' + cookie);
  if (acc) c.push('sgx-account-session=' + acc);
  if (c.length) headers.Cookie = c.join('; ');
  if (origin) headers.Origin = origin;
  return new Request('https://styrigx.com/api/ai', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
}
const call = (r, e) => aiApi.onRequestPost({ request: r, env: e, data: {} });
const errOf = async (res) => (await res.json()).error;
const rows = (e) => e.D1_SPACE.raw
  ? e.D1_SPACE.raw.prepare("SELECT realm, kind, bucket, count FROM attempt_limit WHERE realm = 'ai'").all()
  : null;

test('路由：/api/ai 在 API_ROUTES，指向 api/ai.js；POST 问、GET 取模型列表（P4-2）', () => {
  assert.equal(API_ROUTES.get('/api/ai'), aiApi);
  assert.deepEqual(Object.keys(aiApi).filter((k) => k.startsWith('onRequest')).sort(), ['onRequestGet', 'onRequestPost']);
});

test('GET /api/ai（P4-2）：进门才转 GET /models；写账号结论头、不转 cookie；不计 AI 限流；绑定缺失 503 / 抛错 502', async () => {
  const get = ({ cookie = PW_SESS, acc } = {}) => {
    const c = [];
    if (cookie) c.push('sgx-space-session=' + cookie);
    if (acc) c.push('sgx-account-session=' + acc);
    return new Request('https://styrigx.com/api/ai', { headers: c.length ? { Cookie: c.join('; '), 'CF-Connecting-IP': '203.0.113.7' } : {} });
  };
  const models = (r) => new Response(JSON.stringify({ ok: true, default: 'm', models: [], canChoose: r.headers.get('X-Styrigx-Account-Session') === '1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const lim = limiter(0);
  let log = [];
  let e = env({ AI_SERVICE: aiSvc(log, models), AI_LIMITER: lim });
  let r = await aiApi.onRequestGet({ request: get({ cookie: null }), env: e, data: {} });
  assert.equal(r.status, 401);
  assert.equal(log.length, 0);
  r = await aiApi.onRequestGet({ request: get(), env: e, data: {} });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).canChoose, false);
  assert.deepEqual([log[0].url, log[0].method], ['https://styrigx-ai/models', 'GET']);
  assert.equal(log[0].headers.cookie, undefined);
  r = await aiApi.onRequestGet({ request: get({ acc: 'ok' }), env: e, data: {} });
  assert.equal((await r.json()).canChoose, true);
  assert.match(r.headers.get('Cache-Control'), /no-store/);
  assert.equal(lim.calls.size, 0, '不计限流');
  assert.deepEqual(rows(e) || [], [], '不计全站总闸');
  r = await aiApi.onRequestGet({ request: get(), env: env({ AI_SERVICE: undefined }), data: {} });
  assert.equal(r.status, 503);
  r = await aiApi.onRequestGet({ request: get(), env: env({ AI_SERVICE: { fetch() { throw new Error('x'); } } }), data: {} });
  assert.equal(r.status, 502);
});

test('门：跨源 403 origin；没进门 401 unauthorized；都不转发、不计数', async () => {
  const e = env({ AI_LIMITER: limiter(6) });
  let r = await call(req({ origin: 'https://evil.example' }), e);
  assert.equal(r.status, 403);
  assert.equal(await errOf(r), 'origin');
  r = await call(req({ origin: null }), e);
  assert.equal(r.status, 403);
  r = await call(req({ cookie: null }), e);
  assert.equal(r.status, 401);
  assert.equal(await errOf(r), 'unauthorized');
  r = await call(req({ cookie: 'garbage.1.2.3.sig' }), e);
  assert.equal(r.status, 401);
  assert.equal(e.log.length, 0);
  assert.equal(e.AI_LIMITER.calls.size, 0);
  assert.deepEqual(rows(e) || [], []);
});

test('进门就行、不要账号会话：锁屏密码 / 分享链接进门都转发；没账号会话不写结论头（只召回公开）', async () => {
  for (const cookie of [PW_SESS, LINK_SESS]) {
    const e = env();
    const r = await call(req({ cookie }), e);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('Content-Type'), 'text/event-stream; charset=utf-8');
    assert.equal(r.headers.get('X-Styrigx-AI-Scope'), 'public');
    assert.match(r.headers.get('Cache-Control'), /no-store/);
    assert.match(await r.text(), /^event: delta\n/);
    const f = e.log[0];
    assert.equal(f.url, 'https://styrigx-ai/ask');
    assert.equal(f.method, 'POST');
    assert.equal(f.body, JSON.stringify({ q: '主题' }));
    assert.equal(f.headers['x-styrigx-account-session'], undefined);
    assert.equal(f.headers.cookie, undefined, '不转 cookie');
  }
});

test('有账号会话 → 写账号结论头；RPC 出错 → 不写（当没有账号会话）', async () => {
  let e = env();
  let r = await call(req({ acc: 'ok' }), e);
  assert.equal(r.headers.get('X-Styrigx-AI-Scope'), 'private');
  assert.equal(e.log[0].headers['x-styrigx-account-session'], '1');
  assert.deepEqual(Object.keys(e.log[0].headers).filter((k) => !k.startsWith('x-styrigx-account-')).sort(), ['content-type']);
  e = env();
  r = await call(req({ acc: 'boom' }), e);
  assert.equal(r.status, 200);
  assert.equal(e.log[0].headers['x-styrigx-account-session'], undefined);
});

test('整条链路：浏览器伪造的 X-Styrigx-Account-* / x-sgx-* 被剥，到不了 styrigx-ai', async () => {
  const e = env();
  const r = await worker.fetch(req({ extra: { 'X-Styrigx-Account-Session': '1', 'X-Styrigx-Account-Scopes': 'curio.write', 'X-Sgx-Anything': '1' } }), e, CTX);
  assert.equal(r.status, 200);
  assert.equal(e.log.length, 1);
  const h = e.log[0].headers;
  assert.equal(h['x-styrigx-account-session'], undefined);
  assert.equal(h['x-styrigx-account-scopes'], undefined);
  assert.equal(h['x-sgx-anything'], undefined);
  /* 没会话：网关的门先 401 */
  const e2 = env();
  const r2 = await worker.fetch(req({ cookie: null }), e2, CTX);
  assert.equal(r2.status, 401);
  assert.equal(e2.log.length, 0);
});

test('第一档：同一 IP 一分钟第 7 次 429 cooldown + Retry-After: 60；别的 IP 不受影响；绑定缺失 / 出错放行', async () => {
  const e = env({ AI_LIMITER: limiter(6) });
  for (let i = 1; i <= 6; i++) assert.equal((await call(req(), e)).status, 200, '第 ' + i + ' 次');
  const r = await call(req(), e);
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('Retry-After'), '60');
  assert.deepEqual(await r.json(), { ok: false, error: 'cooldown', retryAfter: 60 });
  assert.equal(e.log.length, 6);
  assert.equal((await call(req({ ip: '198.51.100.9' }), e)).status, 200);
  assert.equal((await call(req(), env({}))).status, 200, '没绑 AI_LIMITER 放行');
  assert.equal((await call(req(), env({ AI_LIMITER: { async limit() { throw new Error('x'); } } }))).status, 200, '出错放行');
});

test('第二档：全站第 61 次 429 busy（跨请求、跨 IP 共享计数），超闸不写行；下一分钟重新计', async () => {
  const d1 = makeAuthD1();
  const e = { D1_SPACE: d1 };
  const t0 = Date.UTC(2026, 10, 4, 8, 0, 10);
  for (let i = 1; i <= 60; i++) assert.equal(await L.aiGlobalGate(e, t0 + i), null, '第 ' + i + ' 次');
  const r = await L.aiGlobalGate(e, t0 + 61);
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error, 'busy');
  assert.equal(r.headers.get('Retry-After'), '50');
  const row = await d1.prepare("SELECT count, window_start, expires_at FROM attempt_limit WHERE realm = 'ai' AND kind = 'global' AND bucket = ?").bind(String(Math.floor(t0 / 60000))).first();
  assert.equal(row.count, 60, '超闸的请求不写行');
  assert.equal(row.window_start, Math.floor(t0 / 60000) * 60000);
  assert.equal(row.expires_at, Math.floor(t0 / 60000) * 60000 + 60000 + 120000);
  /* 下一分钟：新行，从 1 开始（第 61 次那一刻满了的窗口不影响下一分钟） */
  const m0 = Math.floor(t0 / 60000);
  assert.equal(await L.aiGlobalGate(e, t0 + 60000), null);
  let left = await d1.prepare("SELECT bucket, count FROM attempt_limit WHERE realm = 'ai' ORDER BY bucket").all();
  assert.deepEqual(left.results.map((x) => [x.bucket, x.count]), [[String(m0), 60], [String(m0 + 1), 1]]);
  /* 过期行（窗口结束 + 2 分钟）在某分钟第一次放行时清掉 */
  assert.equal(await L.aiGlobalGate(e, t0 + 4 * 60000), null);
  left = await d1.prepare("SELECT bucket FROM attempt_limit WHERE realm = 'ai'").all();
  assert.deepEqual(left.results.map((x) => x.bucket), [String(m0 + 4)]);
});

test('第二档经 /api/ai：这一分钟已满 60 次 → 429 busy，不转发', async () => {
  const e = env();
  const now = Date.now();
  const minute = Math.floor(now / 60000);
  await e.D1_SPACE.prepare("INSERT INTO attempt_limit (realm, kind, bucket, count, strikes, locked_until, window_start, expires_at) VALUES ('ai', 'global', ?, 60, 0, 0, ?, ?)")
    .bind(String(minute), minute * 60000, minute * 60000 + 180000).run();
  const before = e.log.length;
  const r = await call(req({ ip: '192.0.2.1' }), e);
  if (Math.floor(Date.now() / 60000) !== minute) return; /* 正好跨分钟：这次不判 */
  assert.equal(r.status, 429);
  assert.equal(await errOf(r), 'busy');
  assert.equal(e.log.length, before);
});

test('D1 出错 → fail closed 429 busy，不转发', async () => {
  const broken = { prepare() { throw new Error('d1 down'); } };
  const e = env();
  e.D1_SPACE = broken;
  /* 门还要读锁屏纪元：用 data.lockSession 直接给进门结论 */
  const r = await aiApi.onRequestPost({ request: req(), env: e, data: { lockSession: { ok: true, by: 'password' } } });
  assert.equal(r.status, 429);
  assert.equal(await errOf(r), 'busy');
  assert.ok(Number(r.headers.get('Retry-After')) >= 1);
  assert.equal(e.log.length, 0);
  const r2 = await L.aiGlobalGate({}, Date.now());
  assert.equal(r2.status, 429, '没绑 D1 也 fail closed');
});

test('请求体超 16 KB → 413 too-large，不转发、不计全站数', async () => {
  const e = env();
  const r = await call(req({ body: JSON.stringify({ q: 'a', pad: 'x'.repeat(aiApi.BODY_MAX) }) }), e);
  assert.equal(r.status, 413);
  assert.equal(await errOf(r), 'too-large');
  assert.equal(e.log.length, 0);
});

test('没绑 AI_SERVICE 503 upstream；绑定抛错 502 upstream；styrigx-ai 的错误状态原样回', async () => {
  let e = env({ AI_SERVICE: undefined });
  let r = await call(req(), e);
  assert.equal(r.status, 503);
  assert.equal(await errOf(r), 'upstream');
  e = env({ AI_SERVICE: { async fetch() { throw new Error('x'); } } });
  r = await call(req(), e);
  assert.equal(r.status, 502);
  const log = [];
  e = env({ AI_SERVICE: aiSvc(log, () => new Response('{"ok":false,"error":"too-long"}', { status: 400, headers: { 'Content-Type': 'application/json' } })) });
  r = await call(req({ body: { q: 'x'.repeat(300) } }), e);
  assert.equal(r.status, 400);
  assert.equal(await errOf(r), 'too-long');
});

test('浏览器断开：转进去的请求带着浏览器请求的 signal', async () => {
  const ac = new AbortController();
  const e = env();
  const r0 = req();
  const r = new Request(r0, { signal: ac.signal });
  await call(r, e);
  const sig = e.log[0].signal;
  assert.equal(sig.aborted, false);
  ac.abort();
  assert.equal(sig.aborted, true);
});

test('wrangler.toml：AI_SERVICE → styrigx-ai、AI_LIMITER 2802（6 次 / 60 秒）；没有 AI_GLOBAL_LIMITER；SEARCH / CHAT 在 P4-2b 删除', () => {
  const toml = readFileSync(REPO + 'workers/space-core/wrangler.toml', 'utf8').replace(/^#.*$/gm, '');
  assert.match(toml, /\[\[services\]\]\s*\nbinding = "AI_SERVICE"\s*\nservice = "styrigx-ai"/);
  assert.match(toml, /\[\[ratelimits\]\]\s*\nname = "AI_LIMITER"\s*\nnamespace_id = "2802"\s*\nsimple = \{ limit = 6, period = 60 \}/);
  assert.doesNotMatch(toml, /AI_GLOBAL_LIMITER|2803/);
  assert.doesNotMatch(toml, /binding = "(SEARCH|CHAT)"|styrigx-search-index|styrigx-chat/);
  assert.equal(L.AI_GLOBAL_LIMIT, 60);
  assert.equal(L.AI_IP_PERIOD, 60);
});
