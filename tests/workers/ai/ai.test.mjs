/**
 * styrigx-ai（P4-1，方案 5.2 / 5.4；P4-2 并入外部模型、模型登记走 KV）：站内召回两档、/ask 上下文过滤、输入上限、历史截断、
 * SSE 事件顺序、浏览器断开时取消上游、思考段过滤、/healthz、/models、没有 /search 路由；模型登记与切换（只有账号会话能切）、
 * 外部模型（Gemini，替身 fetch）。
 * 不调真实 Workers AI / Gemini：env.AI 是替身，记下收到的 messages，回一个可控的 SSE 流；Gemini 用替换的 globalThis.fetch。
 * 运行：node --test tests/workers/ai/ai.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const W = '../../../workers/ai/src/';
const app = (await import(W + 'app.js')).default;
const R = await import(W + 'core/recall.js');
const P = await import(W + 'core/prompt.js');
const T = await import(W + 'core/think.js');
const ASK = await import(W + 'api/ask.js');
const M = await import(W + 'core/models.js');
const G = await import(W + 'core/gemini.js');

const IX = {
  space: { items: [
    { id: 's1', type: 'setting', lang: 'zh', title: '主题模式', subtitle: '外观', text: '深色和浅色主题切换。', url: '/settings/theme/' },
    { id: 's2', type: 'setting', lang: 'zh', title: '账号安全', text: '私密页正文：保险箱密码在抽屉里。', url: '/account/secret/', private: true },
    { id: 's3', type: 'setting', lang: 'en', title: 'Theme mode', text: 'Dark and light.', url: '/en/settings/theme/' },
  ] },
  blog: { items: [
    { id: 'b1', type: 'post', lang: 'zh', title: '主题模式的设计', text: 'x'.repeat(2000), url: '/blog/post/theme/' },
  ] },
};

function kvOf(map) {
  return { async get(k, t) { const v = map[k]; return v == null ? null : t === 'json' ? JSON.parse(v) : v; } };
}
const KV = kvOf({ 'site:space': JSON.stringify(IX.space), 'site:blog': JSON.stringify(IX.blog) });

const enc = new TextEncoder();
/** 可控的上游流：chunks 逐段推；hang=true 时不结束（测断开） */
function upstream(chunks, o = {}) {
  let cancelled = false;
  const stream = new ReadableStream({
    async pull(c) {
      if (chunks.length) { c.enqueue(enc.encode(chunks.shift())); return; }
      if (o.hang) { await new Promise((r) => setTimeout(r, 20)); return; }
      c.close();
    },
    cancel() { cancelled = true; },
  });
  return { stream, get cancelled() { return cancelled; } };
}
function fakeAI(chunks, o) {
  const calls = [];
  let up;
  return {
    calls,
    get up() { return up; },
    async run(model, input) {
      calls.push({ model, input });
      if (o && o.throws) throw new Error('boom');
      up = upstream(chunks.slice(), o);
      return up.stream;
    },
  };
}
const sse = (o) => 'data: ' + JSON.stringify(o) + '\n\n';

function ask(body, headers = {}, env = {}, init = {}) {
  return app.fetch(new Request('https://styrigx-ai/ask', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body), ...init,
  }), { KV_SEARCH_INDEX: KV, ...env });
}
/** 读完 SSE → [{event, data}] */
async function events(res) {
  const txt = await res.text();
  return txt.split('\n\n').filter(Boolean).map((b) => {
    const ev = /^event: (.+)$/m.exec(b)[1];
    const data = JSON.parse(/^data: (.+)$/m.exec(b)[1]);
    return { event: ev, data };
  });
}

beforeEach(() => { R._resetCache(); M._resetModelsCache(); });

/* ---------- 召回 ---------- */

test('召回两档：没账号会话不出私密条目；有账号会话才出；正文截 600 字', () => {
  const ix = [{ site: 'space', items: IX.space.items }, { site: 'blog', items: IX.blog.items }];
  assert.deepEqual(R.recall(ix, { q: '账号', lang: 'zh' }), []);
  assert.deepEqual(R.recall(ix, { q: '账号', lang: 'zh', showPrivate: 'yes' }), [], '只认 true');
  const priv = R.recall(ix, { q: '账号', lang: 'zh', showPrivate: true });
  assert.equal(priv.length, 1);
  assert.equal(priv[0].private, true);
  const theme = R.recall(ix, { q: '主题', lang: 'zh' });
  assert.deepEqual(theme.map((h) => h.url), ['/settings/theme/', '/blog/post/theme/']);
  assert.equal(theme[1].text.length, R.CONTEXT_CHARS);
  assert.deepEqual(R.recall(ix, { q: 'theme', lang: 'en' }).map((h) => h.url), ['/en/settings/theme/']);
  assert.equal(R.recall(ix, { q: '主题', lang: 'zh', limit: 1 }).length, 1);
  /* 给浏览器的来源不带正文和私密标记 */
  assert.deepEqual(Object.keys(R.publicHits(priv)[0]).sort(), ['site', 'subtitle', 'title', 'type', 'url']);
});

test('recall：自然语言问句——不要求每个词都中、问法词不算、问句语言没有就放开语言', () => {
  const ix = [
    { site: 'space', items: [
      { type: 'setting', lang: 'zh', title: '锁屏凭证', subtitle: '安全', url: '/settings/security/lock/', text: '解锁密码 通行密钥' },
      { type: 'setting', lang: 'en', title: 'Lock screen credentials', subtitle: 'Security', url: '/en/settings/security/lock/' },
    ] },
    { site: 'blog', items: [
      { type: 'page', lang: 'zh', title: '博客', url: '/blog/' },
      { type: 'post', lang: 'zh', title: '博客迁移复盘', url: '/blog/post/m/', text: '这篇文章讲迁移' },
      { type: 'post', lang: 'zh', title: '怎么写什么都行', url: '/blog/post/noise/' },
    ] },
  ];
  /* 2026-11-05 冒烟：这三句旧逻辑（全词命中）一条都召不回 */
  assert.deepEqual(R.recall(ix, { q: '博客有什么文章', lang: 'zh' }).map((h) => h.url), ['/blog/', '/blog/post/m/']);
  assert.equal(R.recall(ix, { q: '锁屏怎么开', lang: 'zh' })[0].url, '/settings/security/lock/');
  assert.deepEqual(R.recall(ix, { q: '你好，请用一句话介绍你自己', lang: 'zh' }), [], '只有问法词 → 空');
  assert.deepEqual(R.recall(ix, { q: '怎么', lang: 'zh' }), [], '问法词不召回「怎么写什么都行」');
  /* 英文页面问中文：en 条目里没有 → 放开语言 */
  assert.equal(R.recall(ix, { q: '锁屏怎么开', lang: 'en' })[0].url, '/settings/security/lock/');
  assert.equal(R.recall(ix, { q: 'how do I turn on the lock screen', lang: 'en' })[0].url, '/en/settings/security/lock/');
});

test('prompt：召回为空时上下文写明没有相关条目，允许正常回应打招呼', () => {
  const zh = P.buildMessages({ q: '你好', lang: 'zh', hits: [] })[0].content;
  assert.match(zh, /没有找到相关条目/);
  assert.match(zh, /打招呼/);
  assert.match(P.buildMessages({ q: 'hi', lang: 'en', hits: [] })[0].content, /No matching site content/);
});

/* rank.js 的分词和打分（搬自已删的 tests/workers/search-index/search.test.mjs；P4-2b 起这里是唯一一份） */
const K = await import(W + 'core/rank.js');
const RIX = [
  { site: 'space', items: [
    { id: 'a', type: 'setting', lang: 'zh', title: '壁纸和主题', subtitle: '', url: 'https://styrigx.com/settings/theme/' },
    { id: 'b', type: 'setting', lang: 'zh', title: '主题模式', subtitle: '显示', text: '跟随系统 浅色 深色', url: 'https://styrigx.com/settings/display/' },
    { id: 'c', type: 'setting', lang: 'zh', title: '账号信息', subtitle: '账号', url: 'https://styrigx.com/account/profile/', private: true },
    { id: 'd', type: 'setting', lang: 'en', title: 'Theme mode', subtitle: 'Display', url: 'https://styrigx.com/en/settings/display/' },
  ] },
  { site: 'blog', items: [{ id: 'p', type: 'post', lang: 'zh', title: 'AI 代理协作开发规范白皮书', subtitle: '', url: 'https://styrigx.com/blog/post/x/' }] },
];

test('rank.js：分词（中文二元组、英文按词、去重、大小写）', () => {
  assert.deepEqual(K.tokenize('主题模式'), ['主题', '题模', '模式']);
  assert.deepEqual(K.tokenize('深'), ['深']);
  assert.deepEqual(K.tokenize('Theme  MODE theme'), ['theme', 'mode']);
  assert.deepEqual(K.tokenize('AI 白皮书'), ['ai', '白皮', '皮书']);
  assert.deepEqual(K.tokenize('  ，。 '), []);
});

test('rank.js：打分与排序、语言过滤、私密只给 showPrivate、跨站与 site 过滤', () => {
  const toks = K.tokenize('主题');
  assert.ok(K.score({ title: '主题模式' }, toks, '主题') > K.score({ title: '壁纸', subtitle: '主题' }, toks, '主题'));
  assert.equal(K.score({ title: '壁纸' }, toks, '主题'), 0);
  assert.deepEqual(K.search(RIX, { q: '主题', lang: 'zh' }).map((h) => h.title), ['主题模式', '壁纸和主题']);
  assert.deepEqual(K.search(RIX, { q: 'theme', lang: 'en' }).map((h) => h.title), ['Theme mode']);
  assert.deepEqual(K.search(RIX, { q: '深色', lang: 'zh' }).map((h) => h.title), ['主题模式']);
  assert.equal(K.search(RIX, { q: '账号', lang: 'zh' }).length, 0);
  assert.equal(K.search(RIX, { q: '账号', lang: 'zh', showPrivate: true }).length, 1);
  assert.equal(K.search(RIX, { q: '白皮书' })[0].site, 'blog');
  assert.equal(K.search(RIX, { q: '白皮书', site: 'space' }).length, 0);
});

/* ---------- /ask ---------- */

test('/ask：没账号会话 → 私密条目不进来源、不进上下文；scope public', async () => {
  const ai = fakeAI([sse({ response: '没有。' }), 'data: [DONE]\n\n']);
  const res = await ask({ q: '账号 安全' }, {}, { AI: ai });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Styrigx-AI-Scope'), 'public');
  const ev = await events(res);
  assert.deepEqual(ev[0], { event: 'hits', data: { hits: [] } });
  assert.equal(ai.calls.length, 1, '召回为空也调模型');
  assert.match(ai.calls[0].input.messages[0].content, /没有找到相关条目/);
  assert.deepEqual(ev.map((e) => e.event), ['hits', 'delta', 'done']);
  assert.ok(!JSON.stringify(ev).includes('保险箱'));
  assert.ok(!ai.calls[0].input.messages[0].content.includes('保险箱'), '私密正文不进上下文');
});

test('/ask：浏览器伪造别的值的账号头不算；只有网关写的 1 才进私密', async () => {
  for (const v of ['true', 'yes', '0', ' 1']) {
    R._resetCache();
    const ai = fakeAI([sse({ response: 'x' })]);
    const res = await ask({ q: '账号' }, { 'X-Styrigx-Account-Session': v }, { AI: ai });
    assert.equal(res.headers.get('X-Styrigx-AI-Scope'), v.trim() === '1' ? 'private' : 'public', v);
  }
});

test('/ask：有账号会话 → 私密条目进来源和上下文；scope private', async () => {
  const ai = fakeAI([sse({ response: '在抽屉里。' }), 'data: [DONE]\n\n']);
  const res = await ask({ q: '账号' }, { 'X-Styrigx-Account-Session': '1' }, { AI: ai });
  assert.equal(res.headers.get('X-Styrigx-AI-Scope'), 'private');
  const ev = await events(res);
  assert.equal(ev[0].data.hits[0].url, '/account/secret/');
  assert.equal(ev[0].data.hits[0].text, undefined, '正文不回浏览器');
  assert.match(ai.calls[0].input.messages[0].content, /保险箱/);
});

test('/ask：SSE 顺序 hits → delta… → done；模型参数；上下文只有召回到的条目', async () => {
  const ai = fakeAI([sse({ response: '主题' }), sse({ response: '在设置里。' }), sse({ choices: [{ delta: { content: '!' } }] }), 'data: [DONE]\n\n']);
  const res = await ask({ q: '主题', lang: 'zh' }, {}, { AI: ai, AI_MODELS: JSON.stringify({ default: '@cf/test/m', models: [{ id: '@cf/test/m' }] }), AI_MAX_TOKENS: '300', AI_CONTEXT_HITS: '1' });
  assert.equal(res.headers.get('Content-Type'), 'text/event-stream; charset=utf-8');
  assert.match(res.headers.get('Cache-Control'), /no-store/);
  const ev = await events(res);
  assert.deepEqual(ev.map((e) => e.event), ['hits', 'delta', 'delta', 'delta', 'done']);
  assert.equal(ev.slice(1, 4).map((e) => e.data.text).join(''), '主题在设置里。!');
  const { model, input } = ai.calls[0];
  assert.equal(model, '@cf/test/m');
  assert.equal(input.stream, true);
  assert.equal(input.max_tokens, 300);
  assert.equal(ev[0].data.hits.length, 1);
  assert.match(input.messages[0].content, /\[1\] 主题模式/);
  assert.doesNotMatch(input.messages[0].content, /\[2\]/);
  assert.equal(input.messages.at(-1).role, 'user');
  assert.equal(input.messages.at(-1).content, '主题');
  assert.equal(res.headers.get('X-Styrigx-AI-Model'), '@cf/test/m');
});

test('/ask：上游出错 → 已发 hits 后 event: error，不发 done', async () => {
  const res = await ask({ q: '主题' }, {}, { AI: fakeAI([], { throws: true }) });
  const ev = await events(res);
  assert.deepEqual(ev.map((e) => e.event), ['hits', 'error']);
  assert.deepEqual(ev[1].data, { code: 'upstream' });
});

test('/ask：输入上限与坏请求', async () => {
  const ai = fakeAI([]);
  assert.equal((await ask({ q: '字'.repeat(200) }, {}, { AI: fakeAI([sse({ response: 'x' })]) })).status, 200);
  let r = await ask({ q: '字'.repeat(201) }, {}, { AI: ai });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'too-long');
  for (const b of ['{', '[]', JSON.stringify({ q: '' }), JSON.stringify({ q: '   ' }), JSON.stringify({ q: 3 })]) {
    r = await ask(b, {}, { AI: ai });
    assert.equal(r.status, 400, b);
    assert.equal((await r.json()).error, 'bad_request');
  }
  r = await ask(JSON.stringify({ q: 'a', pad: 'x'.repeat(ASK.BODY_MAX) }), {}, { AI: ai });
  assert.equal(r.status, 413);
  assert.equal(ai.calls.length, 0);
});

test('/ask：没绑 AI → 503 config；KV 读不了 → 503 index', async () => {
  let r = await ask({ q: '主题' }, {}, {});
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, 'config');
  r = await app.fetch(new Request('https://styrigx-ai/ask', { method: 'POST', body: JSON.stringify({ q: '主题' }) }), { AI: fakeAI([]) });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, 'index');
});

test('/ask：浏览器断开（流被取消）→ 上游 Workers AI 的流一起取消', async () => {
  const ai = fakeAI([sse({ response: '第一段' })], { hang: true });
  const res = await ask({ q: '主题' }, {}, { AI: ai });
  const reader = res.body.getReader();
  await reader.read();
  for (let i = 0; i < 20 && !ai.up; i++) await new Promise((r) => setTimeout(r, 5));
  await reader.read();
  await reader.cancel();
  for (let i = 0; i < 40 && !ai.up.cancelled; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(ai.up.cancelled, true);
});

test('/ask：request.signal abort → 上游取消', async () => {
  const ai = fakeAI([sse({ response: 'a' })], { hang: true });
  const ac = new AbortController();
  const res = await ask({ q: '主题' }, {}, { AI: ai }, { signal: ac.signal });
  const reader = res.body.getReader();
  await reader.read();
  for (let i = 0; i < 20 && !ai.up; i++) await new Promise((r) => setTimeout(r, 5));
  ac.abort();
  for (let i = 0; i < 40 && !ai.up.cancelled; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(ai.up.cancelled, true);
});

/* ---------- 提示词与历史 ---------- */

test('历史：最多 6 条、总长 2000 字（从最近的往回取）、坏条目跳过、按时间顺序', () => {
  const h = [];
  for (let i = 0; i < 10; i++) h.push({ role: i % 2 ? 'assistant' : 'user', text: 'm' + i });
  const n = P.normalizeHistory(h);
  assert.equal(n.length, 6);
  assert.deepEqual(n.map((m) => m.content), ['m4', 'm5', 'm6', 'm7', 'm8', 'm9']);
  const long = P.normalizeHistory([{ role: 'user', text: 'a'.repeat(1500) }, { role: 'assistant', text: 'b'.repeat(1500) }]);
  assert.equal(long.map((m) => m.content).join('').length, 2000);
  assert.equal(long[1].content, 'b'.repeat(1500));
  assert.deepEqual(P.normalizeHistory([{ role: 'system', text: 'x' }, { role: 'user' }, null, { role: 'user', content: 'ok' }]), [{ role: 'user', content: 'ok' }]);
  assert.deepEqual(P.normalizeHistory('nope'), []);
  const msgs = P.buildMessages({ q: 'Q', lang: 'en', history: h, hits: [{ title: 'T', url: '/u', text: 'body' }] });
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[0].content, /Site content:\n\n\[1\] T\nURL: \/u\nText: body/);
  assert.equal(msgs.length, 8);
});

test('思考段过滤：<think>…</think> 去掉，标签被切开也认；开头空白不发', () => {
  const f = T.thinkFilter();
  const out = ['<thi', 'nk>想一想', '…</th', 'ink>\n\n答', '案 <b', '>x'].map((c) => f.push(c)).join('') + f.flush();
  assert.equal(out, '答案 <b>x');
  const g = T.thinkFilter();
  assert.equal(g.push('没有思考段') + g.flush(), '没有思考段');
  const h = T.thinkFilter();
  assert.equal(h.push('<think>到结束都没关') + h.flush(), '');
});

/* ---------- 其余端点 ---------- */

test('/healthz：有 AI 且有索引 200；缺 AI / 一个索引都没有 503；不调模型', async () => {
  const ai = fakeAI([]);
  let r = await app.fetch(new Request('https://styrigx-ai/healthz'), { AI: ai, KV_SEARCH_INDEX: KV });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, sites: 2, missing: ['daymark', 'curio'] });
  assert.equal(ai.calls.length, 0);
  r = await app.fetch(new Request('https://styrigx-ai/healthz'), { KV_SEARCH_INDEX: KV });
  assert.equal(r.status, 503);
  R._resetCache();
  r = await app.fetch(new Request('https://styrigx-ai/healthz'), { AI: ai, KV_SEARCH_INDEX: kvOf({}) });
  assert.equal(r.status, 503);
});

test('路由：只有 POST /ask、GET /models、GET /healthz；没有 /search；方法不对 405', async () => {
  const { ROUTES } = await import(W + 'router.js');
  assert.deepEqual([...ROUTES.keys()].sort(), ['/ask', '/healthz', '/models']);
  for (const p of ['/search', '/', '/api/ai', '/ask/x']) {
    const r = await app.fetch(new Request('https://styrigx-ai' + p), { AI: fakeAI([]), KV_SEARCH_INDEX: KV });
    assert.equal(r.status, 404, p);
  }
  assert.equal((await app.fetch(new Request('https://styrigx-ai/ask'), {})).status, 405);
  assert.equal((await app.fetch(new Request('https://styrigx-ai/healthz', { method: 'POST' }), {})).status, 405);
});

test('wrangler.toml：没有公开地址、绑定 AI、只读索引、外部模型钥匙（复用 SGX_CHAT_API_KEY）、三个变量；没有千问；入口只再导出', () => {
  const toml = readFileSync(new URL('../../../workers/ai/wrangler.toml', import.meta.url), 'utf8').replace(/^#.*$/gm, '');
  assert.match(toml, /^name = "styrigx-ai"$/m);
  assert.match(toml, /^main = "src\/index\.js"$/m);
  assert.match(toml, /^workers_dev = false$/m);
  assert.match(toml, /^preview_urls = false$/m);
  assert.doesNotMatch(toml, /\[\[routes\]\]|^route\s*=|d1_databases|r2_buckets/m);
  assert.match(toml, /\[\[secrets_store_secrets\]\]\s*\nbinding = "SGX_CHAT_API_KEY"\s*\nstore_id = "a5a984f365424401bad5ad6ddcd44479"\s*\nsecret_name = "SGX_CHAT_API_KEY"/);
  assert.equal((toml.match(/\[\[secrets_store_secrets\]\]/g) || []).length, 1);
  assert.doesNotMatch(toml, /qwen/i);
  const reg = M.parseModels(/^AI_MODELS = '(.+)'$/m.exec(toml)[1]);
  assert.equal(reg.def, '@cf/google/gemma-4-26b-a4b-it');
  assert.deepEqual(reg.models.map((m) => [m.id, m.provider]), [['@cf/google/gemma-4-26b-a4b-it', 'workers-ai'], ['@cf/openai/gpt-oss-20b', 'workers-ai'], ['gemini-2.5-flash', 'gemini']]);
  assert.match(toml, /\[ai\]\s*\nbinding = "AI"/);
  assert.match(toml, /binding = "KV_SEARCH_INDEX"\s*\nid = "bd1babcc3fe74d58994e254c74d34ced"/);
  for (const v of ['AI_MODELS', 'AI_MAX_TOKENS = "1024"', 'AI_CONTEXT_HITS = "5"']) assert.ok(toml.includes(v), v);
  const idx = readFileSync(new URL(W + 'index.js', import.meta.url), 'utf8');
  assert.match(idx, /export \{ default \} from '\.\/app\.js';/);
});

test('check-worker-routes：styrigx-ai 登记为没有公开地址的 Worker，当前配置 0 条路由；加路由会报错', async () => {
  const { NO_ROUTE_WORKERS, checkNoRoutes } = await import('../../../scripts/check-worker-routes.mjs');
  assert.ok(NO_ROUTE_WORKERS.some((w) => w.name === 'styrigx-ai' && w.dir === 'workers/ai'));
  const toml = readFileSync(new URL('../../../workers/ai/wrangler.toml', import.meta.url), 'utf8');
  assert.deepEqual(checkNoRoutes([{ name: 'styrigx-ai', toml }]), []);
  const bad = toml + '\n[[routes]]\npattern = "styrigx.com/api/ai"\nzone_name = "styrigx.com"\n';
  assert.equal(checkNoRoutes([{ name: 'styrigx-ai', toml: bad }]).length, 1);
  assert.equal(checkNoRoutes([{ name: 'styrigx-ai', toml: toml.replace('workers_dev = false', 'workers_dev = true') }]).length, 1);
});

/* ---------- P4-2：模型登记、切换、外部模型 ---------- */

const REG = { default: '@cf/a/one', models: [{ id: '@cf/a/one', label: 'One' }, { id: '@cf/b/two', label: 'Two', provider: 'workers-ai' }, { id: 'gemini-x', label: 'G', provider: 'gemini' }] };

test('模型登记：KV ai:models 优先，坏的退 vars，再退内置（Gemma 4 默认 + GPT-OSS 20B）；坏条目跳过', async () => {
  let reg = await M.loadModels({ KV_SEARCH_INDEX: kvOf({ 'ai:models': JSON.stringify(REG) }), AI_MODELS: JSON.stringify({ models: [{ id: '@cf/v/v' }] }) });
  assert.equal(reg.def, '@cf/a/one');
  assert.deepEqual(reg.models.map((m) => m.provider), ['workers-ai', 'workers-ai', 'gemini']);
  M._resetModelsCache();
  reg = await M.loadModels({ KV_SEARCH_INDEX: kvOf({ 'ai:models': '{' }), AI_MODELS: JSON.stringify({ models: [{ id: '@cf/v/v' }] }) });
  assert.deepEqual([reg.def, reg.models.length], ['@cf/v/v', 1]);
  M._resetModelsCache();
  reg = await M.loadModels({ KV_SEARCH_INDEX: { async get() { throw new Error('kv'); } } });
  assert.equal(reg.def, '@cf/google/gemma-4-26b-a4b-it');
  assert.deepEqual(reg.models.map((m) => m.id), ['@cf/google/gemma-4-26b-a4b-it', '@cf/openai/gpt-oss-20b']);
  /* 坏条目：非 @cf/ 的 workers-ai、未知 provider、非法字符、重复；default 不在列表 → 第一条 */
  const p = M.parseModels({ default: 'nope', models: [{ id: 'plain', provider: 'workers-ai' }, { id: '@cf/x', provider: 'other' }, { id: 'a b' }, { id: '@cf/ok' }, { id: '@cf/ok' }] });
  assert.deepEqual([p.def, p.models.map((m) => m.id)], ['@cf/ok', ['@cf/ok']]);
  assert.equal(M.parseModels({ models: [] }), null);
});

test('切模型：只有账号会话的 model 生效；进站一律默认；不在登记里 → 400 bad_model', async () => {
  const env = (ai) => ({ AI: ai, KV_SEARCH_INDEX: kvOf({ 'site:space': JSON.stringify(IX.space), 'ai:models': JSON.stringify(REG) }) });
  let ai = fakeAI([sse({ response: 'x' })]);
  let r = await ask({ q: '主题', model: '@cf/b/two' }, {}, env(ai));
  await r.text();
  assert.equal(ai.calls[0].model, '@cf/a/one');
  M._resetModelsCache();
  ai = fakeAI([sse({ response: 'x' })]);
  r = await ask({ q: '主题', model: '@cf/b/two' }, { 'X-Styrigx-Account-Session': '1' }, env(ai));
  await r.text();
  assert.equal(ai.calls[0].model, '@cf/b/two');
  assert.equal(r.headers.get('X-Styrigx-AI-Model'), '@cf/b/two');
  M._resetModelsCache();
  ai = fakeAI([]);
  for (const bad of ['@cf/evil', 3]) {
    r = await ask({ q: '主题', model: bad }, { 'X-Styrigx-Account-Session': '1' }, env(ai));
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'bad_model');
  }
  /* 进站带了坏 model：忽略，不报错 */
  r = await ask({ q: '主题', model: '@cf/evil' }, {}, env(fakeAI([sse({ response: 'x' })])));
  assert.equal(r.status, 200);
  await r.text();
  assert.equal(ai.calls.length, 0);
});

test('/models：列表 + 默认 + canChoose 跟账号结论头；不调模型、不读钥匙', async () => {
  const key = { get() { throw new Error('不该读钥匙'); } };
  const env = { KV_SEARCH_INDEX: kvOf({ 'ai:models': JSON.stringify(REG) }), SGX_CHAT_API_KEY: key, AI: fakeAI([]) };
  let r = await app.fetch(new Request('https://styrigx-ai/models'), env);
  let b = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual([b.default, b.models.map((m) => m.id), b.canChoose], ['@cf/a/one', ['@cf/a/one', '@cf/b/two', 'gemini-x'], false]);
  r = await app.fetch(new Request('https://styrigx-ai/models', { headers: { 'X-Styrigx-Account-Session': '1' } }), env);
  b = await r.json();
  assert.equal(b.canChoose, true);
  assert.equal(env.AI.calls.length, 0);
  assert.equal(JSON.stringify(b).includes('key'), false);
});

function withFetch(impl, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => { globalThis.fetch = orig; });
}
const gEnv = (o = {}) => ({ KV_SEARCH_INDEX: kvOf({ 'site:space': JSON.stringify(IX.space), 'ai:models': JSON.stringify({ default: 'gemini-x', models: [{ id: 'gemini-x', provider: 'gemini' }] }) }), ...o });

test('外部模型（Gemini）：钥匙走头不进 URL；系统提示 + 上下文进 systemInstruction；thought 跳过；SSE 同格式', async () => {
  const seen = [];
  await withFetch(async (url, init) => {
    seen.push({ url: String(url), init });
    const body = sse({ candidates: [{ content: { parts: [{ text: '想', thought: true }, { text: '主题' }] } }] }) + sse({ candidates: [{ content: { parts: [{ text: '在设置里' }] } }] });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }, async () => {
    const res = await ask({ q: '主题', history: [{ role: 'user', text: '早' }, { role: 'assistant', text: '好' }] }, {}, gEnv({ SGX_CHAT_API_KEY: { async get() { return ' K123 '; } } }));
    const ev = await events(res);
    assert.deepEqual(ev.map((e) => e.event), ['hits', 'delta', 'delta', 'done']);
    assert.equal(ev.slice(1, 3).map((e) => e.data.text).join(''), '主题在设置里');
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-x:streamGenerateContent?alt=sse');
  assert.equal(seen[0].init.headers['x-goog-api-key'], 'K123');
  assert.doesNotMatch(seen[0].url, /K123/);
  const body = JSON.parse(seen[0].init.body);
  assert.match(body.systemInstruction.parts[0].text, /站内内容：[\s\S]*\[1\] 主题模式/);
  assert.deepEqual(body.contents.map((c) => c.role), ['user', 'model', 'user']);
  assert.equal(body.contents.at(-1).parts[0].text, '主题');
  assert.equal(body.tools, undefined);
  assert.equal(body.generationConfig.maxOutputTokens, 1024);
});

test('外部模型：钥匙没绑 / 读不到 → 503 no_key（不调上游）；上游 404 → error model_unavailable，429 → rate_limited', async () => {
  let calls = 0;
  await withFetch(async () => { calls++; return new Response('{}', { status: 200 }); }, async () => {
    let r = await ask({ q: '主题' }, {}, gEnv());
    assert.deepEqual([r.status, (await r.json()).error], [503, 'no_key']);
    M._resetModelsCache();
    r = await ask({ q: '主题' }, {}, gEnv({ SGX_CHAT_API_KEY: { async get() { throw new Error('x'); } } }));
    assert.deepEqual([r.status, (await r.json()).error], [503, 'no_key']);
  });
  assert.equal(calls, 0);
  for (const [status, code] of [[404, 'model_unavailable'], [429, 'rate_limited'], [500, 'upstream']]) {
    M._resetModelsCache();
    await withFetch(async () => new Response('{"error":{}}', { status }), async () => {
      const ev = await events(await ask({ q: '主题' }, {}, gEnv({ SGX_CHAT_API_KEY: 'k' })));
      assert.deepEqual(ev.map((e) => e.event), ['hits', 'error']);
      assert.equal(ev[1].data.code, code);
    });
  }
  assert.equal(G.classifyUpstream(400, 'model not found'), 'model_unavailable');
  assert.deepEqual(G.geminiChunk({ error: { status: 'RESOURCE_EXHAUSTED' } }), { text: '', error: 'rate_limited' });
});

/* 2026-11-05 run 42007357284：退路「Prepare keyless config」的 guard 按全文 grep，wrangler.toml 注释里的
   [[secrets_store_secrets]] 被当成残留绑定，退路没跑成。这里照原样跑 deploy.yml 里那段 run 脚本（去掉 echo 警告），
   核对：能过 guard、删掉的只有钥匙段、注释保留也不误报。 */
test('deploy.yml 退路：Prepare keyless config 的脚本对真 wrangler.toml 跑得通（注释里有表头字样也不误报）', () => {
  const yml = readFileSync(new URL('../../../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const i = yml.indexOf('- name: Prepare keyless config (fallback)', yml.indexOf('deploy-ai-worker:'));
  assert.ok(i > 0);
  const step = yml.slice(i, yml.indexOf('\n      - name:', i + 10));
  assert.match(step, /working-directory: workers\/ai/);
  const run = step.slice(step.indexOf('run: |') + 6).split('\n').map((l) => l.replace(/^ {10}/, '')).filter((l) => l && !/^echo "::warning::/.test(l)).join('\n');
  const dir = mkdtempSync(path.join(tmpdir(), 'ai-nokey-'));
  const toml = readFileSync(new URL('../../../workers/ai/wrangler.toml', import.meta.url), 'utf8');
  writeFileSync(path.join(dir, 'wrangler.toml'), toml);
  execFileSync('bash', ['-eo', 'pipefail', '-c', run], { cwd: dir, stdio: 'pipe' });
  const nokey = readFileSync(path.join(dir, 'wrangler.nokey.toml'), 'utf8');
  assert.equal(nokey, toml.slice(0, toml.search(/^\[\[secrets_store_secrets\]\]/m)));
  assert.doesNotMatch(nokey, /^\s*\[\[secrets_store_secrets\]\]/m);
  assert.doesNotMatch(nokey, /SGX_CHAT_API_KEY"?\s*$/m);
  assert.doesNotMatch(toml.slice(toml.search(/^\[\[secrets_store_secrets\]\]/m)), /^\[(?!\[secrets_store_secrets\]\])/m, '钥匙段后面不能再有别的表');
  /* guard 本身还管用：真留下表头就报错 */
  writeFileSync(path.join(dir, 'wrangler.toml'), toml + '\n[[secrets_store_secrets]]\nbinding = "X"\n');
  const guard = run.split('\n').find((l) => /keyless config still has/.test(l));
  writeFileSync(path.join(dir, 'wrangler.nokey.toml'), '[[secrets_store_secrets]]\n');
  assert.throws(() => execFileSync('bash', ['-c', guard], { cwd: dir, stdio: 'pipe' }));
});

/* 2026-11-05 #273 冒烟：Gemma 4 默认开思考，带上下文时思考把 max_tokens 用完、正文为空，前端只显示「没能拿到回答」 */
test('/ask：Gemma 4 关思考；其他模型不带这个参数；默认额度 1024', async () => {
  const M4 = JSON.stringify({ default: '@cf/google/gemma-4-26b-a4b-it', models: [{ id: '@cf/google/gemma-4-26b-a4b-it' }, { id: '@cf/openai/gpt-oss-20b' }] });
  R._resetCache();
  const ai = fakeAI([sse({ choices: [{ delta: { content: '在设置里。' } }] }), 'data: [DONE]\n\n']);
  await events(await ask({ q: '主题' }, {}, { AI: ai, AI_MODELS: M4 }));
  assert.deepEqual(ai.calls[0].input.chat_template_kwargs, { enable_thinking: false });
  assert.equal(ai.calls[0].input.max_tokens, 1024);
  assert.deepEqual(ASK.runExtras('@cf/openai/gpt-oss-20b'), {});
});

test('/ask：模型只吐思考段、没有正文 → error empty（不当成功 done）', async () => {
  R._resetCache();
  const ai = fakeAI([
    sse({ choices: [{ delta: { reasoning_content: '让我想想……'.repeat(50) } }] }),
    sse({ choices: [{ delta: {}, finish_reason: 'length' }] }),
    'data: [DONE]\n\n',
  ]);
  const ev = await events(await ask({ q: '主题' }, {}, { AI: ai }));
  assert.deepEqual(ev.map((e) => e.event), ['hits', 'error']);
  assert.equal(ev[1].data.code, 'empty');
  assert.equal(ASK.chunkReasoning({ choices: [{ delta: { reasoning_content: 'abc' } }] }), 3);
});
