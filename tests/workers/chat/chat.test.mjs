/**
 * 聊天 Worker styrigx-chat（workers/chat，2026-10-22 从网关拆出来）：请求校验、没钥匙、
 * 模型切换（CHAT_MODELS 白名单、GET /models、bad_model、每个模型的工具开关、model_unavailable、工具被拒不带工具重试一次）、
 * Gemini SSE → 我们自己的事件（delta / sources / done / error，来源去重 ≤ 8）、上游 429 → rate_limited、OpenAI 兼容模式、
 * 入口只认网关写的 X-Sgx-Role: admin、wrangler.toml（变量、钥匙绑定、没有公开地址）。
 * 门（同源 / 会话 / 只许管理员）和转发在网关，见 tests/workers/auth-gateway/chat-api.test.mjs。
 * 上游 fetch 一律 mock（globalThis.fetch），不发真实请求。
 * 运行：node --test tests/workers/chat/*.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../../../workers/chat/src/index.js';
import * as chat from '../../../workers/chat/src/chat.js';

const REPO = new URL('../../../', import.meta.url).pathname;

/** Secrets Store 绑定的样子 */
const storeKey = (v) => ({ async get() { if (v instanceof Error) throw v; return v; } });

function env(over = {}) {
  return {
    CHAT_PROVIDER: 'gemini', CHAT_API_BASE: 'https://generativelanguage.googleapis.com/v1beta', CHAT_MODEL: 'gemini-2.5-flash', CHAT_SEARCH: 'on',
    SGX_CHAT_API_KEY: storeKey('test-chat-key'),
    ...over,
  };
}

const MSGS = [{ role: 'user', text: 'Hugo 最新版本？' }];
/** 网关转进来的样子：POST https://styrigx-chat/chat + X-Sgx-Role: admin（不带 cookie / Origin） */
function req(body, { role = 'admin', raw, path = '/chat', method = 'POST' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (role) headers['X-Sgx-Role'] = role;
  return new Request('https://styrigx-chat' + path, { method, headers, body: method === 'GET' ? undefined : raw !== undefined ? raw : JSON.stringify(body) });
}
const call = (r, e = env()) => worker.fetch(r, e);

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

test('wrangler.toml：没有公开地址（workers_dev / preview_urls 关、没有路由）；有 CHAT_* 变量和 Secrets Store 钥匙绑定（放在文件最后）', () => {
  const toml = readFileSync(REPO + 'workers/chat/wrangler.toml', 'utf8');
  assert.match(toml, /^name = "styrigx-chat"$/m);
  assert.match(toml, /^workers_dev = false$/m);
  assert.match(toml, /^preview_urls = false$/m);
  assert.doesNotMatch(toml, /^\s*\[\[routes\]\]|^\s*routes\s*=|^\s*route\s*=/m);
  assert.match(toml, /^CHAT_PROVIDER = "gemini"$/m);
  assert.match(toml, /^CHAT_API_BASE = "https:\/\/generativelanguage\.googleapis\.com\/v1beta"$/m);
  assert.match(toml, /^CHAT_MODEL = "gemini-2\.5-flash"$/m);
  assert.match(toml, /^CHAT_SEARCH = "on"$/m);
  assert.match(toml, /binding = "SGX_CHAT_API_KEY"\nstore_id = "a5a984f365424401bad5ad6ddcd44479"\nsecret_name = "SGX_CHAT_API_KEY"/);
  /* deploy.yml 的退路部署从第一个 [[secrets_store_secrets]] 删到末尾：删完只能少这一段，别的配置都要还在 */
  const nokey = toml.slice(0, toml.search(/^\[\[secrets_store_secrets\]\]/m));
  const code = nokey.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(code, /secrets_store_secrets|SGX_CHAT_API_KEY/);
  assert.match(nokey, /^CHAT_MODELS = '/m);
  assert.match(nokey, /^main = "src\/index\.js"$/m);
  assert.doesNotMatch(toml.slice(toml.search(/^\[\[secrets_store_secrets\]\]/m)), /^\[(?!\[secrets_store_secrets\]\])/m, '钥匙段后面不能再有别的表');
});

test('入口：只认网关写的 X-Sgx-Role: admin（没有 / visitor / 别的 → 403 admin_only）；未知路径 404；方法不对 405；都不调上游', async () => {
  mockFetch(() => { throw new Error('不应调用上游'); });
  for (const role of [null, 'visitor', 'Admin', 'owner']) {
    let r = await call(req({ messages: MSGS }, { role }));
    assert.equal(r.status, 403, String(role));
    assert.deepEqual(await r.json(), { ok: false, error: 'admin_only' });
    r = await call(req(null, { role, path: '/models', method: 'GET' }));
    assert.equal(r.status, 403);
  }
  for (const path of ['/', '/api/chat', '/chat/', '/models/x']) {
    const r = await call(req({ messages: MSGS }, { path }));
    assert.equal(r.status, 404, path);
    assert.equal((await r.json()).error, 'not-found');
  }
  let r = await call(req(null, { method: 'GET' }));
  assert.equal(r.status, 405);
  assert.equal((await r.json()).error, 'method');
  r = await call(req({}, { path: '/models', method: 'POST' }));
  assert.equal(r.status, 405);
  r = await call(req({ messages: MSGS }, { method: 'PUT' }));
  assert.equal(r.status, 405);
  /* handleChat 直接被别的方法调到也 405 */
  r = await chat.handleChat(new Request('https://styrigx-chat/chat', { method: 'PUT', body: '{}' }), env());
  assert.equal(r.status, 405);
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

/* ---------- 模型切换（2026-10-22）：CHAT_MODELS 白名单、GET /api/chat、POST model、每个模型的工具开关、上游按模型的错误 ---------- */

const MODELS_JSON = JSON.stringify([
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', search: true },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', search: true },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', search: false },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', search: false },
]);
const menv = (over = {}) => env({ CHAT_MODELS: MODELS_JSON, ...over });
const getReq = () => req(null, { path: '/models', method: 'GET' });
const getCall = (r, e = menv()) => worker.fetch(r, e);

test('wrangler.toml：CHAT_MODELS 是合法 JSON，2.5 Flash / Flash-Lite 联网、3.x 不联网；CHAT_MODEL 在列表里', () => {
  const toml = readFileSync(REPO + 'workers/chat/wrangler.toml', 'utf8');
  const m = toml.match(/^CHAT_MODELS = '(.*)'$/m);
  assert.ok(m, 'CHAT_MODELS 要是一行单引号字面量字符串');
  const list = JSON.parse(m[1]);
  assert.deepEqual(list.map((x) => [x.id, x.search]), [
    ['gemini-2.5-flash', true], ['gemini-2.5-flash-lite', true], ['gemini-3.8-flash', false], ['gemini-3.5-flash-lite', false],
  ]);
  const r = chat.chatModels({ CHAT_MODELS: m[1], CHAT_MODEL: 'gemini-2.5-flash', CHAT_SEARCH: 'on' });
  assert.equal(r.def, 'gemini-2.5-flash');
  assert.equal(r.models.length, 4);
});

test('GET /models：200 { ok, default, models }，不调上游、不读钥匙', async () => {
  mockFetch(() => { throw new Error('不应调用上游'); });
  let r;
  const e = menv();
  e.SGX_CHAT_API_KEY = { async get() { throw new Error('不该读钥匙'); } };
  r = await getCall(getReq(), e);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(await r.json(), {
    ok: true,
    default: 'gemini-2.5-flash',
    models: [
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', search: true },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', search: true },
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', search: false },
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', search: false },
    ],
    configured: true,
  });
  assert.equal(fetchLog.length, 0);
});

test('GET /models：没钥匙绑定（deploy.yml 退一步部署的版本）/ API 地址空 → configured:false，模型列表照给；不读钥匙', async () => {
  mockFetch(() => { throw new Error('不应调用上游'); });
  const noBinding = menv();
  delete noBinding.SGX_CHAT_API_KEY;
  let r = await getCall(getReq(), noBinding);
  assert.equal(r.status, 200);
  let j = await r.json();
  assert.equal(j.configured, false);
  assert.equal(j.ok, true);
  assert.equal(j.models.length, 4);
  r = await getCall(getReq(), menv({ CHAT_PROVIDER: 'openai', CHAT_API_BASE: '' }));
  assert.equal((await r.json()).configured, false);
  /* 绑定在但值读不出来：GET 不读钥匙，照样 configured:true；POST 时才 503 no_key */
  const e = menv();
  e.SGX_CHAT_API_KEY = { async get() { throw new Error('不该读钥匙'); } };
  assert.equal((await (await getCall(getReq(), e)).json()).configured, true);
  assert.equal(chat.isConfigured(menv()), true);
  assert.equal(chat.isConfigured(noBinding), false);
  assert.equal(fetchLog.length, 0);
});

test('意外错误（开始回答之前抛出）→ 500 { ok:false, error:"internal" } JSON，不带堆栈、不回 Cloudflare 错误页', async () => {
  const orig = console.error;
  const logged = [];
  console.error = (...a) => { logged.push(a.join(' ')); };
  try {
    /* env 的 getter 抛错：模拟绑定 / 配置读取时的意外异常 */
    const boom = menv();
    Object.defineProperty(boom, 'CHAT_PROVIDER', { get() { const e = new TypeError('secret detail /path/to/file.js:1'); throw e; } });
    for (const r of [await call(req({ messages: MSGS }), boom), await getCall(getReq(), boom)]) {
      assert.equal(r.status, 500);
      assert.equal(r.headers.get('Content-Type'), 'application/json; charset=utf-8');
      const text = await r.text();
      assert.deepEqual(JSON.parse(text), { ok: false, error: 'internal' });
      assert.ok(!/secret detail|\.js:|at /.test(text), text);
    }
    assert.ok(logged.every((l) => !l.includes('secret detail')), '日志只记错误类型');
  } finally {
    console.error = orig;
  }
});

test('CHAT_MODELS 坏 / 没配 / 没一条合格 → 退回只有 CHAT_MODEL；坏条目跳过、去重、没 label 用 id；总开关 off / openai 模式 search 一律 false', async () => {
  const fb = (search) => ({ def: 'gemini-2.5-flash', models: [{ id: 'gemini-2.5-flash', label: 'gemini-2.5-flash', search }] });
  for (const bad of [undefined, '', '{nope', '[]', '"x"', '{"id":"a"}', JSON.stringify([{ id: 'bad id!' }, { id: 5 }, null, { label: 'x' }, { id: '' }])]) {
    assert.deepEqual(chat.chatModels(env({ CHAT_MODELS: bad })), fb(true), String(bad));
  }
  assert.deepEqual(chat.chatModels(env({ CHAT_MODELS: '{nope', CHAT_SEARCH: 'off' })), fb(false));
  let r = await getCall(getReq(), env({ CHAT_MODELS: '{nope' }));
  assert.deepEqual(await r.json(), { ok: true, default: 'gemini-2.5-flash', models: fb(true).models, configured: true });
  /* 坏条目跳过 + 去重 + label 兜底；search 只认 true */
  const mixed = JSON.stringify([{ id: 'x/../y z' }, { id: 'm1', search: 'yes' }, { id: 'm1', label: 'dup' }, { id: 'm2', label: '  M2  ', search: true }]);
  assert.deepEqual(chat.chatModels(env({ CHAT_MODELS: mixed })), {
    def: 'm1', /* CHAT_MODEL 不在列表里 → 第一个 */
    models: [{ id: 'm1', label: 'm1', search: false }, { id: 'm2', label: 'M2', search: true }],
  });
  /* 数组本身（不是字符串）也认 */
  assert.equal(chat.chatModels(env({ CHAT_MODELS: [{ id: 'gemini-2.5-flash', search: true }] })).models[0].search, true);
  /* 最多 12 条 */
  assert.equal(chat.chatModels(env({ CHAT_MODELS: JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ id: 'm' + i }))) })).models.length, chat.MAX_MODELS);
  assert.ok(chat.chatModels(menv({ CHAT_SEARCH: 'off' })).models.every((m) => !m.search));
  assert.ok(chat.chatModels(menv({ CHAT_PROVIDER: 'openai' })).models.every((m) => !m.search));
});

test('POST model：不在白名单 / 不是字符串 → 400 bad_model，不调上游；null / 不给 → 默认模型', async () => {
  mockFetch(() => { throw new Error('不应调用上游'); });
  for (const model of ['evil-model', 'gemini-2.5-pro', '', 5, true, {}, ['gemini-2.5-flash'], '../gemini-2.5-flash', 'GEMINI-2.5-FLASH']) {
    const r = await call(req({ messages: MSGS, model }), menv());
    assert.equal(r.status, 400, JSON.stringify(model));
    assert.deepEqual(await r.json(), { ok: false, error: 'bad_model' });
  }
  /* 回退列表时也只认 CHAT_MODEL */
  let r = await call(req({ messages: MSGS, model: 'gemini-3.8-flash' }), env());
  assert.equal(r.status, 400);
  assert.equal(fetchLog.length, 0);
  for (const model of [null, undefined]) {
    mockFetch(() => sseResponse([gem('ok')]));
    r = await call(req({ messages: MSGS, model }), menv());
    assert.equal(r.status, 200);
    await r.text();
    assert.match(fetchLog[0].url, /\/models\/gemini-2\.5-flash:streamGenerateContent/);
  }
});

test('每个模型的工具：2.5 Flash-Lite 带 google_search + url_context；3.x 不带（系统提示也不提搜索）；总开关 off 都不带；openai 模式 model 原样转发', async () => {
  mockFetch(() => sseResponse([gem('ok')]));
  await (await call(req({ messages: MSGS, model: 'gemini-2.5-flash-lite' }), menv())).text();
  assert.equal(fetchLog[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:streamGenerateContent?alt=sse');
  assert.deepEqual(fetchLog[0].body.tools, [{ google_search: {} }, { url_context: {} }]);
  assert.match(fetchLog[0].body.systemInstruction.parts[0].text, /Google Search/);

  mockFetch(() => sseResponse([gem('ok')]));
  await (await call(req({ messages: MSGS, model: 'gemini-3.8-flash' }), menv())).text();
  assert.equal(fetchLog[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
  assert.equal(fetchLog[0].body.tools, undefined);
  assert.doesNotMatch(fetchLog[0].body.systemInstruction.parts[0].text, /Google Search/);
  assert.match(fetchLog[0].body.systemInstruction.parts[0].text, /not available/);

  mockFetch(() => sseResponse([gem('ok')]));
  await (await call(req({ messages: MSGS, model: 'gemini-2.5-flash' }), menv({ CHAT_SEARCH: 'off' }))).text();
  assert.equal(fetchLog[0].body.tools, undefined);

  const oe = menv({ CHAT_PROVIDER: 'openai', CHAT_API_BASE: 'https://api.example.com/v1', CHAT_MODELS: JSON.stringify([{ id: 'org/a', search: true }, { id: 'b' }]), CHAT_MODEL: 'org/a' });
  mockFetch(() => sseResponse([{ choices: [{ delta: { content: 'x' } }] }, '[DONE]']));
  await (await call(req({ messages: MSGS, model: 'b' }), oe)).text();
  assert.equal(fetchLog[0].url, 'https://api.example.com/v1/chat/completions');
  assert.equal(fetchLog[0].body.model, 'b');
  assert.equal(fetchLog[0].body.tools, undefined);
  mockFetch(() => sseResponse([{ choices: [{ delta: { content: 'x' } }] }, '[DONE]']));
  await (await call(req({ messages: MSGS }), oe)).text();
  assert.equal(fetchLog[0].body.model, 'org/a');
  /* openai 模式也只认自己的列表 */
  const rb = await call(req({ messages: MSGS, model: 'gemini-2.5-flash' }), oe);
  assert.equal(rb.status, 400);
  assert.equal((await rb.json()).error, 'bad_model');
});

test('classifyUpstream：429 → rate_limited；400 带工具 + 说工具 → tools；404 / 403·400 not found·not supported·permission → model_unavailable；其他 → upstream', () => {
  const C = chat.classifyUpstream;
  assert.equal(C(429, '', true), 'rate_limited');
  assert.equal(C(429, 'model not found', false), 'rate_limited');
  assert.equal(C(400, '{"error":{"message":"Tool use with google_search is not supported for this model."}}', true), 'tools');
  assert.equal(C(400, 'Search Grounding is not supported.', true), 'tools');
  assert.equal(C(400, 'url_context is unsupported', true), 'tools');
  /* 没带工具时说工具 → 不是 tools（不会无限重试） */
  assert.equal(C(400, 'google_search is not supported', false), 'model_unavailable');
  assert.equal(C(400, 'tools are bad', false), 'upstream');
  assert.equal(C(404, '', false), 'model_unavailable');
  assert.equal(C(404, '{"error":{"status":"NOT_FOUND"}}', true), 'model_unavailable');
  assert.equal(C(403, '{"error":{"status":"PERMISSION_DENIED","message":"permission denied for model"}}', false), 'model_unavailable');
  assert.equal(C(400, 'models/gemini-9 is not found for API version v1beta, or is not supported for generateContent', false), 'model_unavailable');
  assert.equal(C(400, 'This model is not available on the free tier', false), 'model_unavailable');
  assert.equal(C(403, '{"error":{}}', false), 'upstream');
  assert.equal(C(400, 'API key not valid', false), 'upstream');
  assert.equal(C(500, 'not found', false), 'upstream');
  assert.equal(C(503, '', true), 'upstream');
});

test('上游按模型的错误：404 / 403 permission / 400 not supported → 502 model_unavailable；429 → rate_limited；流里 404 → error model_unavailable', async () => {
  const cases = [
    [404, '{"error":{"code":404,"status":"NOT_FOUND"}}'],
    [403, '{"error":{"code":403,"message":"Permission denied on model","status":"PERMISSION_DENIED"}}'],
    [400, '{"error":{"code":400,"message":"models/gemini-3.8-flash is not supported for streamGenerateContent"}}'],
  ];
  for (const [st, body] of cases) {
    for (const model of ['gemini-2.5-flash', 'gemini-3.8-flash']) {
      mockFetch(() => new Response(body, { status: st }));
      const r = await call(req({ messages: MSGS, model }), menv());
      assert.equal(r.status, 502, st + ' ' + model);
      assert.deepEqual(await r.json(), { ok: false, error: 'model_unavailable' });
      assert.equal(fetchLog.length, 1, '不重试');
    }
  }
  mockFetch(() => new Response('{"error":{"code":429}}', { status: 429 }));
  let r = await call(req({ messages: MSGS, model: 'gemini-3.8-flash' }), menv());
  assert.equal(r.status, 429);
  assert.deepEqual(await r.json(), { ok: false, error: 'rate_limited' });
  assert.equal(fetchLog.length, 1);
  mockFetch(() => sseResponse([gem('半'), { error: { code: 404, status: 'NOT_FOUND' } }]));
  const ev = await events(await call(req({ messages: MSGS }), menv()));
  assert.deepEqual(ev, [{ t: 'delta', text: '半' }, { t: 'error', code: 'model_unavailable' }]);
});

test('工具被上游拒（400 说 google_search 不支持）→ 不带工具重试一次，回答开头 meta web:false；只重试一次；不联网模型不重试', async () => {
  const toolErr = '{"error":{"code":400,"message":"Tool use with google_search is not supported for this model","status":"INVALID_ARGUMENT"}}';
  let n = 0;
  mockFetch(() => (n++ === 0 ? new Response(toolErr, { status: 400 }) : sseResponse([gem('凭记忆回答')])));
  let r = await call(req({ messages: MSGS, model: 'gemini-2.5-flash-lite' }), menv());
  assert.equal(r.status, 200);
  const ev = await events(r);
  assert.deepEqual(ev, [{ t: 'meta', web: false }, { t: 'delta', text: '凭记忆回答' }, { t: 'done' }]);
  assert.equal(fetchLog.length, 2);
  assert.deepEqual(fetchLog[0].body.tools, [{ google_search: {} }, { url_context: {} }]);
  assert.equal(fetchLog[1].body.tools, undefined);
  assert.equal(fetchLog[1].url, fetchLog[0].url, '同一个模型');
  assert.doesNotMatch(fetchLog[1].body.systemInstruction.parts[0].text, /Google Search/);
  /* 第二次还是 400 → 不再重试，502 upstream */
  mockFetch(() => new Response(toolErr, { status: 400 }));
  r = await call(req({ messages: MSGS, model: 'gemini-2.5-flash' }), menv());
  assert.equal(r.status, 502);
  assert.equal(fetchLog.length, 2);
  /* 第二次 429 → rate_limited */
  n = 0;
  mockFetch(() => (n++ === 0 ? new Response(toolErr, { status: 400 }) : new Response('{}', { status: 429 })));
  r = await call(req({ messages: MSGS }), menv());
  assert.equal(r.status, 429);
  /* 不联网的模型本来就没带工具：同样的 400 不重试 */
  mockFetch(() => new Response(toolErr, { status: 400 }));
  r = await call(req({ messages: MSGS, model: 'gemini-3.8-flash' }), menv());
  assert.equal(fetchLog.length, 1);
  assert.equal(r.status, 502);
  /* 正常联网回答不发 meta */
  mockFetch(() => sseResponse([gem('ok')]));
  const ev2 = await events(await call(req({ messages: MSGS }), menv()));
  assert.deepEqual(ev2.map((e) => e.t), ['delta', 'done']);
});

test('GET /healthz：钥匙读得到 → 200 { ok:true }；不要求 X-Sgx-Role、不调上游、不回钥匙', async () => {
  mockFetch(() => { throw new Error('不应调用上游'); });
  for (const role of [null, 'visitor', 'admin']) {
    const r = await call(req(null, { role, path: '/healthz', method: 'GET' }));
    assert.equal(r.status, 200, String(role));
    const text = await r.text();
    assert.deepEqual(JSON.parse(text), { ok: true });
    assert.ok(!text.includes('test-chat-key'));
  }
  assert.equal(fetchLog.length, 0);
});

test('GET /healthz：没绑定 / 读出空 / 读抛错 / API 地址空 → 503 no_key；POST → 405', async () => {
  mockFetch(() => { throw new Error('不应调用上游'); });
  for (const k of [undefined, storeKey(''), storeKey(new Error('secret not found')), '']) {
    const e = env();
    if (k === undefined) delete e.SGX_CHAT_API_KEY; else e.SGX_CHAT_API_KEY = k;
    const r = await call(req(null, { role: null, path: '/healthz', method: 'GET' }), e);
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { ok: false, error: 'no_key' });
  }
  const r = await call(req(null, { role: null, path: '/healthz', method: 'GET' }), env({ CHAT_PROVIDER: 'openai', CHAT_API_BASE: '' }));
  assert.equal(r.status, 503);
  assert.equal((await call(req({}, { role: null, path: '/healthz', method: 'POST' }))).status, 405);
  assert.equal(fetchLog.length, 0);
});
