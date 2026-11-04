/**
 * styrigx-ai（P4-1，方案 5.2 / 5.4）：站内召回两档、/ask 上下文过滤、输入上限、历史截断、SSE 事件顺序、
 * 浏览器断开时取消上游、思考段过滤、/healthz、没有 /search 路由。
 * 不调真实 Workers AI：env.AI 是替身，记下收到的 messages，回一个可控的 SSE 流。
 * 运行：node --test tests/workers/ai/ai.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const W = '../../../workers/ai/src/';
const app = (await import(W + 'app.js')).default;
const R = await import(W + 'core/recall.js');
const P = await import(W + 'core/prompt.js');
const T = await import(W + 'core/think.js');
const ASK = await import(W + 'api/ask.js');

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

beforeEach(() => R._resetCache());

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

test('rank.js 拷自 search-index：逻辑一致（只改了文件头）', () => {
  const strip = (s) => s.replace(/^\/\*\*[\s\S]*?\*\/\n/, '');
  assert.equal(strip(readFileSync(new URL(W + 'core/rank.js', import.meta.url), 'utf8')),
    strip(readFileSync(new URL('../../../workers/search-index/src/rank.js', import.meta.url), 'utf8')));
});

/* ---------- /ask ---------- */

test('/ask：没账号会话 → 私密条目不进来源、不进上下文；scope public', async () => {
  const ai = fakeAI([sse({ response: '没有。' }), 'data: [DONE]\n\n']);
  const res = await ask({ q: '账号 安全' }, {}, { AI: ai });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Styrigx-AI-Scope'), 'public');
  const ev = await events(res);
  assert.deepEqual(ev[0], { event: 'hits', data: { hits: [] } });
  assert.equal(ai.calls.length, 0, '召回为空不调模型');
  assert.deepEqual(ev.map((e) => e.event), ['hits', 'delta', 'done']);
  assert.equal(ev[1].data.text, P.NOTHING_FOUND.zh);
  assert.ok(!JSON.stringify(ev).includes('保险箱'));
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
  const res = await ask({ q: '主题', lang: 'zh' }, {}, { AI: ai, AI_MODEL: '@cf/test/m', AI_MAX_TOKENS: '300', AI_CONTEXT_HITS: '1' });
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
  assert.match(input.messages.at(-1).content, /^主题/);
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

test('路由：只有 POST /ask、GET /healthz；没有 /search；方法不对 405', async () => {
  const { ROUTES } = await import(W + 'router.js');
  assert.deepEqual([...ROUTES.keys()].sort(), ['/ask', '/healthz']);
  for (const p of ['/search', '/', '/api/ai', '/ask/x']) {
    const r = await app.fetch(new Request('https://styrigx-ai' + p), { AI: fakeAI([]), KV_SEARCH_INDEX: KV });
    assert.equal(r.status, 404, p);
  }
  assert.equal((await app.fetch(new Request('https://styrigx-ai/ask'), {})).status, 405);
  assert.equal((await app.fetch(new Request('https://styrigx-ai/healthz', { method: 'POST' }), {})).status, 405);
});

test('wrangler.toml：没有公开地址、绑定 AI 和只读索引、三个变量；入口只再导出', () => {
  const toml = readFileSync(new URL('../../../workers/ai/wrangler.toml', import.meta.url), 'utf8').replace(/^#.*$/gm, '');
  assert.match(toml, /^name = "styrigx-ai"$/m);
  assert.match(toml, /^main = "src\/index\.js"$/m);
  assert.match(toml, /^workers_dev = false$/m);
  assert.match(toml, /^preview_urls = false$/m);
  assert.doesNotMatch(toml, /\[\[routes\]\]|^route\s*=|d1_databases|r2_buckets|secrets_store/m);
  assert.match(toml, /\[ai\]\s*\nbinding = "AI"/);
  assert.match(toml, /binding = "KV_SEARCH_INDEX"\s*\nid = "bd1babcc3fe74d58994e254c74d34ced"/);
  for (const v of ['AI_MODEL', 'AI_MAX_TOKENS = "512"', 'AI_CONTEXT_HITS = "5"']) assert.ok(toml.includes(v), v);
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
