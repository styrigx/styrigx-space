/**
 * 聊天 /api/chat（网关，2026-10-22，functions/api/chat.js）：门（同源 / 会话 / 只许站长）、请求校验、没钥匙、
 * Gemini SSE → 我们自己的事件（delta / sources / done / error，来源去重 ≤ 8）、上游 429 → rate_limited、OpenAI 兼容模式。
 * 上游 fetch 一律 mock（globalThis.fetch），不发真实请求；Ed25519 测试钥匙在测试内临时生成。
 * 运行：node --test tests/workers/auth-gateway/chat-api.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { signSessionCookie } from '../../../workers/auth-gateway/functions/_kernel/session.js';
import * as chat from '../../../workers/auth-gateway/functions/api/chat.js';
import { API_ROUTES } from '../../../workers/auth-gateway/src/routes.js';
import { SECRET_NAMES } from '../../../workers/auth-gateway/src/secrets.js';

const REPO = new URL('../../../', import.meta.url).pathname;

function derToPem(der, label) {
  const lines = Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}
const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const PRIV = derToPem(await crypto.subtle.exportKey('pkcs8', kp.privateKey), 'PRIVATE KEY');
const PUB = derToPem(await crypto.subtle.exportKey('spki', kp.publicKey), 'PUBLIC KEY');
const OWNER = await signSessionCookie(PRIV, 0, 'owner');
const VISITOR = await signSessionCookie(PRIV, 0, 'visitor', 'owner');

function kv() {
  const m = new Map();
  return { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); }, async list() { return { keys: [] }; } };
}
/** Secrets Store 绑定的样子 */
const storeKey = (v) => ({ async get() { if (v instanceof Error) throw v; return v; } });

function env(over = {}) {
  return {
    SGX_ENV: 'production', SGX_SITE: 'space', SGX_LOCK_PUBLIC: PUB, OWNER_KV: kv(),
    CHAT_PROVIDER: 'gemini', CHAT_API_BASE: 'https://generativelanguage.googleapis.com/v1beta', CHAT_MODEL: 'gemini-2.5-flash', CHAT_SEARCH: 'on',
    SGX_CHAT_API_KEY: storeKey('test-chat-key'),
    ...over,
  };
}

const MSGS = [{ role: 'user', text: 'Hugo 最新版本？' }];
function req(body, { cookie = OWNER, origin = 'https://styrigx.com', raw } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = 'sgx-verified=' + cookie;
  if (origin) headers.Origin = origin;
  return new Request('https://styrigx.com/api/chat', { method: 'POST', headers, body: raw !== undefined ? raw : JSON.stringify(body) });
}
const call = (r, e = env()) => chat.onRequestPost({ request: r, env: e });

/** 一个按段吐出的上游 SSE 响应 */
function sseResponse(blocks, status = 200, sep = '\r\n\r\n') {
  const enc = new TextEncoder();
  const text = blocks.map((b) => 'data: ' + (typeof b === 'string' ? b : JSON.stringify(b)) + sep).join('');
  /* 故意按 7 字节切块，测跨块拼接 */
  const parts = [];
  for (let i = 0; i < text.length; i += 7) parts.push(text.slice(i, i + 7));
  return new Response(new ReadableStream({ start(c) { for (const p of parts) c.enqueue(enc.encode(p)); c.close(); } }), { status, headers: { 'Content-Type': 'text/event-stream' } });
}

/** 读完我们的 SSE，解析成事件数组 */
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

const gem = (text, extra = {}) => ({ candidates: [{ content: { role: 'model', parts: [{ text }] }, ...extra }] });

test('路由表登记了 /api/chat；聊天钥匙不进每个请求都预读的 SECRET_NAMES；wrangler.toml 有变量和 Secrets Store 绑定', () => {
  assert.equal(API_ROUTES.get('/api/chat'), chat);
  assert.ok(!SECRET_NAMES.includes('SGX_CHAT_API_KEY'));
  const toml = readFileSync(REPO + 'workers/auth-gateway/wrangler.toml', 'utf8');
  assert.match(toml, /^CHAT_PROVIDER = "gemini"$/m);
  assert.match(toml, /^CHAT_API_BASE = "https:\/\/generativelanguage\.googleapis\.com\/v1beta"$/m);
  assert.match(toml, /^CHAT_MODEL = "gemini-2\.5-flash"$/m);
  assert.match(toml, /^CHAT_SEARCH = "on"$/m);
  assert.match(toml, /binding = "SGX_CHAT_API_KEY"\nstore_id = "a5a984f365424401bad5ad6ddcd44479"\nsecret_name = "SGX_CHAT_API_KEY"/);
});

test('门：不同源 / 没 Origin 403 origin；没会话 / 坏会话 401；访客 403 owner_only；都不调上游', async () => {
  mockFetch(() => { throw new Error('不应调用上游'); });
  let r = await call(req({ messages: MSGS }, { origin: 'https://evil.example' }));
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'origin');
  r = await call(req({ messages: MSGS }, { origin: null }));
  assert.equal(r.status, 403);
  r = await call(req({ messages: MSGS }, { cookie: null }));
  assert.equal(r.status, 401);
  r = await call(req({ messages: MSGS }, { cookie: 'garbage.1.2' }));
  assert.equal(r.status, 401);
  r = await call(req({ messages: MSGS }, { cookie: VISITOR }));
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { ok: false, error: 'owner_only' });
  assert.equal(r.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(fetchLog.length, 0);
});

test('校验：坏 JSON、空、> 20 条、单条 > 4000、合计 > 24000、最后不是 user、坏角色、空文字 → 400', async () => {
  mockFetch(() => { throw new Error('不应调用上游'); });
  const bad = [
    { raw: '{nope' },
    {},
    { messages: [] },
    { messages: 'x' },
    { messages: Array.from({ length: 21 }, (_, i) => ({ role: i % 2 ? 'model' : 'user', text: 'x' })) },
    { messages: [{ role: 'user', text: 'x'.repeat(4001) }] },
    { messages: Array.from({ length: 7 }, (_, i) => ({ role: i % 2 ? 'model' : 'user', text: 'x'.repeat(3500) })) },
    { messages: [{ role: 'user', text: 'a' }, { role: 'model', text: 'b' }] },
    { messages: [{ role: 'system', text: 'a' }] },
    { messages: [{ role: 'assistant', text: 'a' }, { role: 'user', text: 'b' }] },
    { messages: [{ role: 'user', text: '   ' }] },
    { messages: [{ role: 'user', text: 5 }] },
  ];
  for (const b of bad) {
    const r = await call(b.raw !== undefined ? req(null, { raw: b.raw }) : req(b));
    assert.equal(r.status, 400, JSON.stringify(b).slice(0, 80));
    assert.equal((await r.json()).error, 'bad_request');
  }
  /* 边界：正好 20 条、单条 4000、合计 24000 → 通过校验 */
  const ok20 = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'model' : 'user', text: 'x' })).concat([]);
  ok20[19] = { role: 'user', text: 'x' };
  assert.equal(chat.validateMessages({ messages: ok20 }).ok, true);
  assert.equal(chat.validateMessages({ messages: [{ role: 'user', text: 'x'.repeat(4000) }] }).ok, true);
  const six = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'model' : 'user', text: 'x'.repeat(4000) }));
  six[5].role = 'user';
  six[4].role = 'model';
  assert.equal(chat.validateMessages({ messages: six }).ok, true);
  assert.equal(fetchLog.length, 0);
});

test('没钥匙：没绑定 / 绑定读出空 / 读抛错 → 503 no_key，不调上游、不打印钥匙', async () => {
  mockFetch(() => { throw new Error('不应调用上游'); });
  for (const k of [undefined, storeKey(''), storeKey(new Error('secret not found')), '']) {
    const e = env();
    if (k === undefined) delete e.SGX_CHAT_API_KEY; else e.SGX_CHAT_API_KEY = k;
    const r = await call(req({ messages: MSGS }), e);
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { ok: false, error: 'no_key' });
  }
  assert.equal(fetchLog.length, 0);
});

test('gemini：请求形状（streamGenerateContent?alt=sse、x-goog-api-key、角色、搜索工具、系统提示）', async () => {
  mockFetch(() => sseResponse([gem('ok', { finishReason: 'STOP' })]));
  const msgs = [{ role: 'user', text: 'Q1' }, { role: 'model', text: 'A1' }, { role: 'user', text: 'Q2' }];
  const r = await call(req({ messages: msgs }));
  assert.equal(r.status, 200);
  await r.text();
  assert.equal(fetchLog.length, 1);
  const f = fetchLog[0];
  assert.equal(f.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
  assert.equal(f.init.method, 'POST');
  assert.equal(f.init.headers['x-goog-api-key'], 'test-chat-key');
  assert.ok(!('Authorization' in f.init.headers));
  assert.deepEqual(f.body.contents, [
    { role: 'user', parts: [{ text: 'Q1' }] },
    { role: 'model', parts: [{ text: 'A1' }] },
    { role: 'user', parts: [{ text: 'Q2' }] },
  ]);
  assert.deepEqual(f.body.tools, [{ google_search: {} }, { url_context: {} }]);
  assert.match(f.body.systemInstruction.parts[0].text, /Google Search/);
  assert.match(f.body.systemInstruction.parts[0].text, /Today is \d{4}-\d{2}-\d{2}/);
  assert.ok(f.init.signal, '要带 AbortSignal（超时 / 浏览器断开）');
  /* CHAT_SEARCH=off → 不带工具 */
  mockFetch(() => sseResponse([gem('ok')]));
  await (await call(req({ messages: MSGS }), env({ CHAT_SEARCH: 'off' }))).text();
  assert.equal(fetchLog[0].body.tools, undefined);
  /* 普通字符串钥匙（本地）也行 */
  mockFetch(() => sseResponse([gem('ok')]));
  await (await call(req({ messages: MSGS }), env({ SGX_CHAT_API_KEY: 'plain-key' }))).text();
  assert.equal(fetchLog[0].init.headers['x-goog-api-key'], 'plain-key');
});

test('gemini SSE → delta / sources / done：跳过 thought、来源去重 + 只要 http(s) + 最多 8 条、url_context 也算来源', async () => {
  const chunks = Array.from({ length: 10 }, (_, i) => ({ web: { uri: 'https://vertexaisearch.cloud.google.com/r/' + i, title: 'site' + i + '.com' } }));
  mockFetch(() => sseResponse([
    { candidates: [{ content: { parts: [{ text: '想一想', thought: true }, { text: 'Hugo ' }] } }] },
    gem('**v0.168.0**'),
    '{bad json',
    gem('。', {
      finishReason: 'STOP',
      groundingMetadata: { groundingChunks: [chunks[0], chunks[0], { web: { uri: 'javascript:alert(1)', title: 'x' } }, ...chunks.slice(1)] },
    }),
  ]));
  const r = await call(req({ messages: MSGS }));
  assert.equal(r.status, 200);
  assert.match(r.headers.get('Content-Type'), /^text\/event-stream/);
  assert.equal(r.headers.get('Cache-Control'), 'private, no-store');
  const ev = await events(r);
  assert.deepEqual(ev.filter((e) => e.t === 'delta').map((e) => e.text), ['Hugo ', '**v0.168.0**', '。']);
  const src = ev.find((e) => e.t === 'sources');
  assert.equal(src.items.length, 8);
  assert.deepEqual(src.items[0], { title: 'site0.com', uri: 'https://vertexaisearch.cloud.google.com/r/0' });
  assert.equal(new Set(src.items.map((s) => s.uri)).size, 8);
  assert.ok(src.items.every((s) => s.uri.startsWith('https://')));
  assert.deepEqual(ev[ev.length - 1], { t: 'done' });
  assert.ok(ev.indexOf(src) < ev.length - 1, 'sources 在 done 前面');

  /* url_context：读成功的地址也进来源；没有接地 → 不发 sources；\n\n 分隔也认 */
  mockFetch(() => sseResponse([gem('读了', { urlContextMetadata: { urlMetadata: [
    { retrievedUrl: 'https://example.com/a', urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS' },
    { retrievedUrl: 'https://example.com/b', urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_ERROR' },
  ] } })], 200, '\n\n'));
  let e2 = await events(await call(req({ messages: MSGS })));
  assert.deepEqual(e2.find((e) => e.t === 'sources').items, [{ title: '', uri: 'https://example.com/a' }]);
  mockFetch(() => sseResponse([gem('无来源')]));
  e2 = await events(await call(req({ messages: MSGS })));
  assert.deepEqual(e2.map((e) => e.t), ['delta', 'done']);
});

test('gemini：上游 429 → 429 rate_limited；其他错误 / fetch 抛错 → 502 upstream；流里的 error / 被拦截 → error 事件', async () => {
  mockFetch(() => new Response('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}', { status: 429 }));
  let r = await call(req({ messages: MSGS }));
  assert.equal(r.status, 429);
  assert.deepEqual(await r.json(), { ok: false, error: 'rate_limited' });
  for (const st of [400, 403, 500, 503]) {
    mockFetch(() => new Response('{"error":{}}', { status: st }));
    r = await call(req({ messages: MSGS }));
    assert.equal(r.status, 502, String(st));
    assert.equal((await r.json()).error, 'upstream');
  }
  mockFetch(() => { throw new TypeError('network'); });
  r = await call(req({ messages: MSGS }));
  assert.equal(r.status, 502);
  /* 流到一半 */
  mockFetch(() => sseResponse([gem('半'), { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }, gem('不该出现')]));
  let ev = await events(await call(req({ messages: MSGS })));
  assert.deepEqual(ev, [{ t: 'delta', text: '半' }, { t: 'error', code: 'rate_limited' }]);
  mockFetch(() => sseResponse([{ promptFeedback: { blockReason: 'SAFETY' } }]));
  ev = await events(await call(req({ messages: MSGS })));
  assert.deepEqual(ev, [{ t: 'error', code: 'upstream' }]);
  /* 上游流读到一半抛错 */
  mockFetch(() => new Response(new ReadableStream({
    n: 0,
    pull(c) { if (this.n++ === 0) c.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(gem('a')) + '\n\n')); else c.error(new Error('reset')); },
  }), { status: 200 }));
  ev = await events(await call(req({ messages: MSGS })));
  assert.deepEqual(ev, [{ t: 'delta', text: 'a' }, { t: 'error', code: 'upstream' }]);
});

test('openai 模式：/chat/completions、Bearer、model → assistant、system 提示、stream:true；增量转成 delta，没有 sources；429 → rate_limited', async () => {
  const e = env({ CHAT_PROVIDER: 'openai', CHAT_API_BASE: 'https://api.example.com/v1/', CHAT_MODEL: 'some-model' });
  mockFetch(() => sseResponse([
    { choices: [{ delta: { role: 'assistant' } }] },
    { choices: [{ delta: { content: '你' } }] },
    { choices: [{ delta: { content: '好' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    '[DONE]',
  ]));
  const r = await call(req({ messages: [{ role: 'user', text: 'Q1' }, { role: 'model', text: 'A1' }, { role: 'user', text: 'Q2' }] }), e);
  assert.equal(r.status, 200);
  const ev = await events(r);
  assert.deepEqual(ev, [{ t: 'delta', text: '你' }, { t: 'delta', text: '好' }, { t: 'done' }]);
  const f = fetchLog[0];
  assert.equal(f.url, 'https://api.example.com/v1/chat/completions');
  assert.equal(f.init.headers.Authorization, 'Bearer test-chat-key');
  assert.equal(f.body.model, 'some-model');
  assert.equal(f.body.stream, true);
  assert.deepEqual(f.body.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(f.body.messages[2].content, 'A1');
  assert.equal(f.body.tools, undefined);
  mockFetch(() => new Response('{}', { status: 429 }));
  const r2 = await call(req({ messages: MSGS }), e);
  assert.equal(r2.status, 429);
  /* openai 模式没配 CHAT_API_BASE → 按没配置处理 */
  mockFetch(() => { throw new Error('不应调用上游'); });
  const r3 = await call(req({ messages: MSGS }), env({ CHAT_PROVIDER: 'openai', CHAT_API_BASE: '' }));
  assert.equal(r3.status, 503);
});

test('gateway 中间件：/api/chat 没会话 401（不进接口）；访客能到接口（由接口回 owner_only）', async () => {
  const { onRequest: mw } = await import('../../../workers/auth-gateway/functions/_middleware.js');
  const mk = (cookie) => ({
    request: new Request('https://styrigx.com/api/chat', { method: 'POST', headers: Object.assign({ Origin: 'https://styrigx.com', 'Content-Type': 'application/json' }, cookie ? { Cookie: 'sgx-verified=' + cookie } : {}), body: JSON.stringify({ messages: MSGS }) }),
    env: env(),
    next: async () => call(req({ messages: MSGS }, { cookie }), env()),
  });
  let r = await mw(mk(null));
  assert.equal(r.status, 401);
  r = await mw(mk(VISITOR));
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'owner_only');
});
