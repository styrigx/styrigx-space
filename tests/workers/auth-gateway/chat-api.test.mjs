/**
 * 聊天 /api/chat（网关，functions/api/chat.js）：2026-10-22 起网关只做门 + 转发，聊天本身在 styrigx-chat（workers/chat）。
 * 这里测：门（同源 / 会话 / 只许管理员，GET 和 POST）、转发（服务绑定 CHAT、路径、X-Sgx-Role、请求体原样、不转 cookie）、
 * 响应原样流回（状态码 / 头 / SSE 不缓冲）、没绑定 503 no_key、绑定抛错 502 upstream、wrangler.toml（CHAT 绑定，
 * 没有 CHAT_* 变量和聊天钥匙绑定）、中间件；再接上真的 styrigx-chat 跑一遍端到端（上游 fetch mock）。
 * 聊天内核（校验、模型、SSE 转换、错误映射）见 tests/workers/chat/chat.test.mjs。
 * Ed25519 测试钥匙在测试内临时生成。
 * 运行：node --test tests/workers/auth-gateway/chat-api.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { signLockSessionTicket } from '../../../workers/auth-gateway/functions/_kernel/lock-session.js';
import * as chat from '../../../workers/auth-gateway/functions/api/chat.js';
import { API_ROUTES } from '../../../workers/auth-gateway/src/routes.js';
import { SECRET_NAMES } from '../../../workers/auth-gateway/src/secrets.js';
import chatWorker from '../../../workers/chat/src/index.js';
import { testLockSession } from './_tickets.mjs';
import { genKeyPair, withAuthD1 } from '../_harness.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;

const { priv: PRIV, pub: PUB } = await genKeyPair();
const ADMIN = await testLockSession(PRIV, 0, 'admin');
const VISITOR = await testLockSession(PRIV, 0, 'visitor');

function kv() {
  const m = new Map();
  return { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); }, async list() { return { keys: [] }; } };
}

/** 假的服务绑定：记下每个转进来的请求，按 fn 回答 */
let svcLog = [];
function svc(fn) {
  return {
    async fetch(r) {
      const body = r.method === 'GET' ? null : await r.clone().text();
      svcLog.push({ url: r.url, method: r.method, headers: Object.fromEntries(r.headers), body, signal: r.signal });
      return fn(r);
    },
  };
}
const noCall = () => svc(() => { throw new Error('不应转给 styrigx-chat'); });

function env(over = {}) {
  svcLog = [];
  return withAuthD1({ SGX_ENV: 'production', SGX_SITE: 'space', SGX_LOCK_PUBLIC: PUB, KV_LOCK_DOOR: kv(), CHAT: noCall(), ...over });
}

const MSGS = [{ role: 'user', text: 'Hugo 最新版本？' }];
function req(body, { cookie = ADMIN, origin = 'https://styrigx.com', raw } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = 'sgx-lock-session=' + cookie;
  if (origin) headers.Origin = origin;
  return new Request('https://styrigx.com/api/chat', { method: 'POST', headers, body: raw !== undefined ? raw : JSON.stringify(body) });
}
function getReq({ cookie = ADMIN, origin } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = 'sgx-lock-session=' + cookie;
  if (origin) headers.Origin = origin;
  return new Request('https://styrigx.com/api/chat', { method: 'GET', headers });
}
const call = (r, e = env()) => chat.onRequestPost({ request: r, env: e });
const getCall = (r, e = env()) => chat.onRequestGet({ request: r, env: e });

const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' } });

/** 读完 SSE，解析成事件数组 */
async function events(res) {
  const text = await res.text();
  return text.split('\n\n').filter(Boolean).map((b) => {
    assert.ok(b.startsWith('data: '), b);
    return JSON.parse(b.slice(6));
  });
}

const realFetch = globalThis.fetch;
let fetchLog = [];
function mockFetch(fn) {
  fetchLog = [];
  globalThis.fetch = async (url, init) => {
    fetchLog.push({ url: String(url), init, body: init && init.body ? JSON.parse(init.body) : null });
    return fn(String(url), init);
  };
}
afterEach(() => { globalThis.fetch = realFetch; });

/** 去掉注释行的 toml */
const tomlCode = (p) => readFileSync(REPO + p, 'utf8').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

test('路由表登记了 /api/chat；网关 wrangler.toml：服务绑定 CHAT → styrigx-chat，没有 CHAT_* 变量、没有聊天钥匙绑定；钥匙不在 SECRET_NAMES', () => {
  assert.equal(API_ROUTES.get('/api/chat'), chat);
  assert.ok(!SECRET_NAMES.includes('SGX_CHAT_API_KEY'));
  const toml = tomlCode('workers/auth-gateway/wrangler.toml');
  assert.match(toml, /\[\[services\]\]\nbinding = "CHAT"\nservice = "styrigx-chat"/);
  assert.doesNotMatch(toml, /^CHAT_/m);
  assert.doesNotMatch(toml, /SGX_CHAT_API_KEY/);
  /* 网关的 Secrets Store 绑定只剩签名钥匙那 7 个（缺了哪个都会让网关部署失败，所以不能多绑） */
  const bound = [...toml.matchAll(/\[\[secrets_store_secrets\]\]\nbinding = "([A-Z_]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(bound, [...SECRET_NAMES].sort());
});

test('POST 门：不同源 / 没 Origin 403 origin；没会话 / 坏会话 401；访客 403 admin_only；都不转给 styrigx-chat', async () => {
  const e = env();
  let r = await call(req({ messages: MSGS }, { origin: 'https://evil.example' }), e);
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'origin');
  r = await call(req({ messages: MSGS }, { origin: null }), e);
  assert.equal(r.status, 403);
  r = await call(req({ messages: MSGS }, { cookie: null }), e);
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'unauthorized');
  r = await call(req({ messages: MSGS }, { cookie: 'garbage.1.2' }), e);
  assert.equal(r.status, 401);
  r = await call(req({ messages: MSGS }, { cookie: VISITOR }), e);
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { ok: false, error: 'admin_only' });
  assert.equal(r.headers.get('Cache-Control'), 'private, no-store');
  /* 门在没绑定 CHAT 时也照样先拦 */
  r = await call(req({ messages: MSGS }, { cookie: VISITOR }), env({ CHAT: undefined }));
  assert.equal(r.status, 403);
  assert.equal(svcLog.length, 0);
});

test('GET 门：没会话 / 坏会话 401、访客 403 admin_only；管理员 → GET /models 原样转回，不看 Origin；路由按方法分到 onRequestGet / onRequestPost', async () => {
  const e = env();
  let r = await getCall(getReq({ cookie: null }), e);
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'unauthorized');
  r = await getCall(getReq({ cookie: 'garbage.1.2' }), e);
  assert.equal(r.status, 401);
  r = await getCall(getReq({ cookie: VISITOR }), e);
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { ok: false, error: 'admin_only' });
  assert.equal(svcLog.length, 0);
  const list = { ok: true, default: 'm1', models: [{ id: 'm1', label: 'M1', search: true }] };
  const e2 = env({ CHAT: svc(() => jsonRes(200, list)) });
  for (const origin of [undefined, 'https://styrigx.com', 'https://evil.example']) {
    r = await getCall(getReq({ origin }), e2);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('Cache-Control'), 'private, no-store');
    assert.deepEqual(await r.json(), list);
  }
  assert.equal(svcLog.length, 3);
  assert.equal(svcLog[0].url, 'https://styrigx-chat/models');
  assert.equal(svcLog[0].method, 'GET');
  assert.equal(svcLog[0].headers['x-sgx-role'], 'admin');
  assert.ok(!('cookie' in svcLog[0].headers), '不转 cookie');
  const { pickHandler } = await import('../../../workers/auth-gateway/src/index.js');
  assert.equal(pickHandler(API_ROUTES.get('/api/chat'), 'GET'), chat.onRequestGet);
  assert.equal(pickHandler(API_ROUTES.get('/api/chat'), 'POST'), chat.onRequestPost);
});

test('POST 转发：POST https://styrigx-chat/chat、X-Sgx-Role: admin、Content-Type 原样、请求体一字不改（坏 JSON 也原样，由 styrigx-chat 回 400）、不转 cookie / Origin、带 signal', async () => {
  const e = env({ CHAT: svc(() => jsonRes(400, { ok: false, error: 'bad_request' })) });
  const raw = JSON.stringify({ messages: MSGS, model: 'gemini-2.5-flash-lite' });
  let r = await call(req(null, { raw }), e);
  assert.equal(r.status, 400);
  assert.equal(svcLog.length, 1);
  const f = svcLog[0];
  assert.equal(f.url, 'https://styrigx-chat/chat');
  assert.equal(f.method, 'POST');
  assert.equal(f.headers['x-sgx-role'], 'admin');
  assert.equal(f.headers['content-type'], 'application/json');
  assert.equal(f.body, raw);
  assert.ok(!('cookie' in f.headers) && !('origin' in f.headers));
  assert.ok(f.signal, '要带 AbortSignal（浏览器断开一起取消）');
  r = await call(req(null, { raw: '{nope' }), e);
  assert.equal(svcLog[1].body, '{nope');
  assert.deepEqual(await r.json(), { ok: false, error: 'bad_request' });
});

test('响应原样流回：JSON 错误（400 bad_request / bad_model、503 no_key、429 rate_limited、502 model_unavailable / upstream）状态码 + 体 + 头不改；SSE 不缓冲', async () => {
  for (const [st, code] of [[400, 'bad_request'], [400, 'bad_model'], [503, 'no_key'], [429, 'rate_limited'], [502, 'model_unavailable'], [502, 'upstream']]) {
    const r = await call(req({ messages: MSGS }), env({ CHAT: svc(() => jsonRes(st, { ok: false, error: code })) }));
    assert.equal(r.status, st, code);
    assert.equal(r.headers.get('Content-Type'), 'application/json; charset=utf-8');
    assert.equal(r.headers.get('Cache-Control'), 'private, no-store');
    assert.deepEqual(await r.json(), { ok: false, error: code });
  }
  /* SSE：第一段到了就能读到（styrigx-chat 的流还没结束），不等整段回答 */
  const enc = new TextEncoder();
  let ctl;
  const upstream = new ReadableStream({ start(c) { ctl = c; } });
  const sseHeaders = { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
  const r = await call(req({ messages: MSGS }), env({ CHAT: svc(() => new Response(upstream, { status: 200, headers: sseHeaders })) }));
  assert.equal(r.status, 200);
  for (const [k, v] of Object.entries(sseHeaders)) assert.equal(r.headers.get(k), v, k);
  const reader = r.body.getReader();
  ctl.enqueue(enc.encode('data: {"t":"delta","text":"半"}\n\n'));
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), 'data: {"t":"delta","text":"半"}\n\n');
  ctl.enqueue(enc.encode('data: {"t":"done"}\n\n'));
  ctl.close();
  const second = await reader.read();
  assert.equal(new TextDecoder().decode(second.value), 'data: {"t":"done"}\n\n');
  assert.equal((await reader.read()).done, true);
});

test('浏览器断开 → 取消流回去的 body → styrigx-chat 的流也被取消', async () => {
  let cancelled = false;
  const upstream = new ReadableStream({ pull() {}, cancel() { cancelled = true; } });
  const r = await call(req({ messages: MSGS }), env({ CHAT: svc(() => new Response(upstream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) }));
  await r.body.cancel();
  assert.equal(cancelled, true);
});

test('没绑定 CHAT → 503 no_key（GET / POST）；调 styrigx-chat 抛错 → 502 upstream', async () => {
  for (const CHAT of [undefined, null, {}, { fetch: 'x' }]) {
    let r = await call(req({ messages: MSGS }), env({ CHAT }));
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { ok: false, error: 'no_key' });
    r = await getCall(getReq(), env({ CHAT }));
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { ok: false, error: 'no_key' });
  }
  const boom = svc(() => { throw new TypeError('service down'); });
  let r = await call(req({ messages: MSGS }), env({ CHAT: boom }));
  assert.equal(r.status, 502);
  assert.deepEqual(await r.json(), { ok: false, error: 'upstream' });
  assert.equal(r.headers.get('Cache-Control'), 'private, no-store');
  r = await getCall(getReq(), env({ CHAT: boom }));
  assert.equal(r.status, 502);
});

test('gateway 中间件：/api/chat 没会话 401（不进接口）；访客能到接口（由接口回 admin_only）', async () => {
  const { onRequest: mw } = await import('../../../workers/auth-gateway/functions/_middleware.js');
  const mk = (cookie) => ({
    request: new Request('https://styrigx.com/api/chat', { method: 'POST', headers: Object.assign({ Origin: 'https://styrigx.com', 'Content-Type': 'application/json' }, cookie ? { Cookie: 'sgx-lock-session=' + cookie } : {}), body: JSON.stringify({ messages: MSGS }) }),
    env: env(),
    next: async () => call(req({ messages: MSGS }, { cookie }), env()),
  });
  let r = await mw(mk(null));
  assert.equal(r.status, 401);
  r = await mw(mk(VISITOR));
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'admin_only');
});

/* ---------- 端到端：网关 → 真的 styrigx-chat（workers/chat/src/index.js）→ mock 的 Gemini ---------- */

const gem = (text, extra = {}) => ({ candidates: [{ content: { role: 'model', parts: [{ text }] }, ...extra }] });
function sseResponse(blocks, status = 200) {
  const enc = new TextEncoder();
  const text = blocks.map((b) => 'data: ' + (typeof b === 'string' ? b : JSON.stringify(b)) + '\r\n\r\n').join('');
  return new Response(new ReadableStream({ start(c) { for (let i = 0; i < text.length; i += 7) c.enqueue(enc.encode(text.slice(i, i + 7))); c.close(); } }), { status, headers: { 'Content-Type': 'text/event-stream' } });
}
const MODELS_JSON = JSON.stringify([
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', search: true },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', search: false },
]);
function chatEnv(over = {}) {
  return {
    CHAT_PROVIDER: 'gemini', CHAT_API_BASE: 'https://generativelanguage.googleapis.com/v1beta', CHAT_MODEL: 'gemini-2.5-flash', CHAT_SEARCH: 'on',
    CHAT_MODELS: MODELS_JSON, SGX_CHAT_API_KEY: { async get() { return 'test-chat-key'; } }, ...over,
  };
}
/** 服务绑定 = 真的 styrigx-chat */
const e2e = (over = {}) => env({ CHAT: { fetch: (r) => chatWorker.fetch(r, chatEnv(over)) } });

test('端到端：GET 模型列表、POST 流式回答（delta / sources / done）、模型切换、bad_request / bad_model / no_key / rate_limited，和拆分前同一套 API', async () => {
  let r = await getCall(getReq(), e2e());
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, default: 'gemini-2.5-flash', models: JSON.parse(MODELS_JSON) });

  mockFetch(() => sseResponse([gem('Hugo '), gem('v0.168.0', { groundingMetadata: { groundingChunks: [{ web: { uri: 'https://gohugo.io/', title: 'gohugo.io' } }] } })]));
  r = await call(req({ messages: MSGS }), e2e());
  assert.equal(r.status, 200);
  assert.match(r.headers.get('Content-Type'), /^text\/event-stream/);
  assert.equal(r.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(await events(r), [
    { t: 'delta', text: 'Hugo ' }, { t: 'delta', text: 'v0.168.0' },
    { t: 'sources', items: [{ title: 'gohugo.io', uri: 'https://gohugo.io/' }] }, { t: 'done' },
  ]);
  assert.equal(fetchLog[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
  assert.equal(fetchLog[0].init.headers['x-goog-api-key'], 'test-chat-key');
  assert.deepEqual(fetchLog[0].body.contents, [{ role: 'user', parts: [{ text: 'Hugo 最新版本？' }] }]);

  mockFetch(() => sseResponse([gem('ok')]));
  await (await call(req({ messages: MSGS, model: 'gemini-3.8-flash' }), e2e())).text();
  assert.match(fetchLog[0].url, /\/models\/gemini-3\.8-flash:/);
  assert.equal(fetchLog[0].body.tools, undefined);

  mockFetch(() => { throw new Error('不应调用上游'); });
  r = await call(req(null, { raw: '{nope' }), e2e());
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { ok: false, error: 'bad_request' });
  r = await call(req({ messages: MSGS, model: 'evil-model' }), e2e());
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { ok: false, error: 'bad_model' });
  r = await call(req({ messages: MSGS }), e2e({ SGX_CHAT_API_KEY: undefined }));
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { ok: false, error: 'no_key' });
  r = await call(req({ messages: MSGS }, { cookie: VISITOR }), e2e());
  assert.equal(r.status, 403);
  assert.equal(fetchLog.length, 0);

  mockFetch(() => new Response('{"error":{"code":429}}', { status: 429 }));
  r = await call(req({ messages: MSGS }), e2e());
  assert.equal(r.status, 429);
  assert.deepEqual(await r.json(), { ok: false, error: 'rate_limited' });
});
