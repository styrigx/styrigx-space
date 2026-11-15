/**
 * styrigx-ai 语义召回（2026-11）：切段、嵌入、Cron 写 Vectorize（只在内容变了时、删多余向量、状态键）、语义召回两档过滤与去重、
 * 和关键词召回合并、奇趣只读固定查询（意图、参数、超时 / 出错不影响回答）、Gemini 联网来源（event: sources）、
 * 上游错误分类 + 脱敏日志（不打钥匙）、搜索工具被拒不带工具重试、scheduled。
 * 不调真实 Workers AI / Vectorize / Gemini：替身。运行：node --test tests/workers/ai/semantic-recall.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const W = '../../../workers/ai/src/';
const app = (await import(W + 'app.js')).default;
const R = await import(W + 'core/recall.js');
const M = await import(W + 'core/models.js');
const C = await import(W + 'core/chunk.js');
const E = await import(W + 'core/embed.js');
const V = await import(W + 'core/vector-sync.js');
const S = await import(W + 'core/semantic.js');
const F = await import(W + 'core/fixed.js');
const G = await import(W + 'core/gemini.js');
const ASK = await import(W + 'api/ask.js');

beforeEach(() => { R._resetCache(); M._resetModelsCache(); G._resetGeminiState(); });

/** 假嵌入：按文本里有没有几个关键字给出 1024 维向量（余弦相似度可控） */
const KEYS = ['主题', '锁屏', '电影', '账号', 'theme'];
function vecOf(t) {
  const v = new Array(1024).fill(0);
  KEYS.forEach((k, i) => { if (String(t).includes(k)) v[i] = 1; });
  v[1023] = 0.05;
  return v;
}
function fakeAI() {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      if (model === E.EMBED_MODEL) return { shape: [input.text.length, 1024], data: input.text.map(vecOf) };
      throw new Error('unexpected model ' + model);
    },
  };
}
const cos = (a, b) => {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return x && y ? d / Math.sqrt(x * y) : 0;
};
/** 内存 Vectorize：upsert / deleteByIds / query（支持 filter { private: false }） */
function fakeVec() {
  const m = new Map();
  const log = { upserts: 0, deletes: [], queries: [] };
  return {
    m, log,
    async upsert(list) { log.upserts++; for (const v of list) m.set(v.id, v); return { mutationId: 'x' }; },
    async deleteByIds(ids) { log.deletes.push(...ids); for (const id of ids) m.delete(id); return { mutationId: 'y' }; },
    async query(vec, o) {
      log.queries.push(o);
      let all = [...m.values()];
      if (o.filter && o.filter.private === false) all = all.filter((v) => v.metadata.private !== true);
      return { matches: all.map((v) => ({ id: v.id, score: cos(vec, v.values), metadata: o.returnMetadata === 'all' ? v.metadata : undefined })).sort((a, b) => b.score - a.score).slice(0, o.topK) };
    },
  };
}
function fakeKV(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    m, puts: [],
    async get(k, t) { const v = m.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { this.puts.push(k); m.set(k, v); },
  };
}
const SPACE = { site: 'space', items: [
  { id: 's1', type: 'setting', lang: 'zh', title: '主题模式', subtitle: '外观', text: '深色和浅色主题切换。', url: 'https://styrigx.com/zh/theme/' },
  { id: 's1', type: 'setting', lang: 'en', title: 'Theme mode', subtitle: 'Display', text: 'Dark and light theme.', url: 'https://styrigx.com/theme/' },
  { id: 's2', type: 'setting', lang: 'zh', title: '账号安全', text: '私密：账号里的东西。', url: 'https://styrigx.com/zh/account/secret/', private: true },
] };
const BLOG = { site: 'blog', items: [{ id: 'b1', type: 'post', lang: 'zh', title: '锁屏的设计', text: '锁屏。'.repeat(600), url: 'https://styrigx.com/blog/zh/post/lock/' }] };

/* ---------- 切段 ---------- */

test('chunk：短正文一段、长正文按 700 字切且重叠、句末断开；id ≤ 64 字节且和内容无关；metadata 带原文与 private', async () => {
  assert.deepEqual(C.splitText(''), []);
  assert.deepEqual(C.splitText('短句。'), ['短句。']);
  const long = C.splitText('一二三四五六七八九十。'.repeat(200));
  assert.ok(long.length > 2);
  for (const p of long) assert.ok([...p].length <= C.CHUNK_CHARS);
  assert.ok(long[0].endsWith('。'), '在句末断开');
  const tail0 = [...long[0]].slice(-20).join('');
  assert.ok(long[1].includes(tail0.slice(-10)), '相邻两段有重叠');
  assert.ok(C.splitText('字'.repeat(100000)).length <= C.MAX_CHUNKS_PER_ITEM);

  const a = await C.chunkItems('blog', BLOG.items);
  const b = await C.chunkItems('blog', [{ ...BLOG.items[0], text: '别的内容。' }]);
  assert.ok(a.length > 1);
  assert.equal(a[0].id, b[0].id, 'id 只和站 + 条目 id 有关');
  for (const c of a) {
    assert.ok(new TextEncoder().encode(c.id).length <= 64, c.id);
    assert.match(c.id, /^blog:[0-9a-f]{16}:\d+$/);
    assert.ok(c.text.startsWith('锁屏的设计\n'));
    assert.equal(c.metadata.private, false);
    assert.equal(c.metadata.url, BLOG.items[0].url);
    assert.ok(new TextEncoder().encode(JSON.stringify(c.metadata)).length < 10 * 1024);
  }
  const sp = await C.chunkItems('space', SPACE.items);
  assert.equal(sp.length, 3, '同 id 不同语言是两条');
  assert.equal(sp.find((c) => c.metadata.title === '账号安全').metadata.private, true);
  assert.equal(sp.find((c) => c.metadata.title === '主题模式').text, '主题模式 — 外观\n深色和浅色主题切换。');
  /* 缺 url / 标题的跳过 */
  assert.equal((await C.chunkItems('x', [{ title: 'a' }, { url: '/x' }, null])).length, 0);
});

test('embed：bge-m3、按 50 段一批、维度不对 / 形状不对 / 没绑 AI 抛错', async () => {
  const ai = fakeAI();
  const texts = Array.from({ length: 120 }, (_, i) => '主题 ' + i);
  const out = await E.embed({ AI: ai }, texts);
  assert.equal(out.length, 120);
  assert.equal(ai.calls.length, 3);
  assert.equal(ai.calls[0].model, '@cf/baai/bge-m3');
  assert.equal(E.EMBED_DIMS, 1024);
  await assert.rejects(E.embed({}, ['x']), /no-ai/);
  await assert.rejects(E.embed({ AI: { async run() { return { data: [[1, 2]] }; } } }, ['x']), /embed-dims/);
  await assert.rejects(E.embed({ AI: { async run() { return {}; } } }, ['x']), /embed-shape/);
  /* 也认 { response } */
  assert.equal((await E.embed({ AI: { async run(m, i) { return { response: i.text.map(vecOf) }; } } }, ['a'])).length, 1);
});

/* ---------- Cron 同步 ---------- */

test('vector-sync：首轮写全部站；内容没变不嵌入不写；变了覆盖并删多余 id；缺站跳过不删；状态键只在变时写', async () => {
  const kv = fakeKV({ 'site:space': JSON.stringify(SPACE), 'site:blog': JSON.stringify(BLOG) });
  const ai = fakeAI();
  const vec = fakeVec();
  const env = { AI: ai, VECTORIZE: vec, KV_SEARCH_INDEX: kv };
  let r = await V.syncAll(env);
  assert.deepEqual(r.map((x) => [x.site, x.status]), [['space', 'synced'], ['blog', 'synced'], ['daymark', 'missing'], ['curio', 'missing']]);
  const n1 = vec.m.size;
  assert.ok(n1 > 3);
  assert.deepEqual(kv.puts.sort(), ['ai:recall:blog', 'ai:recall:space']);
  const st = JSON.parse(kv.m.get('ai:recall:blog'));
  assert.equal(st.v, 1);
  assert.match(st.sha, /^[0-9a-f]{64}$/);
  assert.ok(st.ids.length > 1);

  /* 第二轮：没变 → 不嵌入、不写 */
  ai.calls.length = 0; kv.puts.length = 0;
  r = await V.syncAll(env);
  assert.deepEqual(r.map((x) => x.status), ['unchanged', 'unchanged', 'missing', 'missing']);
  assert.equal(ai.calls.length, 0);
  assert.equal(kv.puts.length, 0);

  /* 博文变短 → 多出来的段删掉；博客站从 KV 消失 → 跳过（不删） */
  kv.m.set('site:blog', JSON.stringify({ site: 'blog', items: [{ ...BLOG.items[0], text: '短了。' }] }));
  r = await V.syncAll(env);
  assert.equal(r.find((x) => x.site === 'blog').status, 'synced');
  assert.ok(vec.log.deletes.length >= st.ids.length - 1);
  assert.equal([...vec.m.keys()].filter((k) => k.startsWith('blog:')).length, 1);
  kv.m.delete('site:blog');
  const before = vec.m.size;
  r = await V.syncAll(env);
  assert.equal(r.find((x) => x.site === 'blog').status, 'missing');
  assert.equal(vec.m.size, before, 'KV 没读到不删向量');
});

test('vector-sync：没绑 Vectorize 跳过；某站嵌入失败不写状态、别的站照常、下一轮重来；超预算的站留到下一轮', async () => {
  assert.deepEqual(await V.syncAll({ KV_SEARCH_INDEX: fakeKV() }), []);
  const kv = fakeKV({ 'site:space': JSON.stringify(SPACE), 'site:blog': JSON.stringify(BLOG) });
  let fail = true;
  const ai = { async run(m, i) { if (fail && i.text.some((t) => t.includes('锁屏'))) throw new Error('neurons'); return { data: i.text.map(vecOf) }; } };
  const env = { AI: ai, VECTORIZE: fakeVec(), KV_SEARCH_INDEX: kv };
  let r = await V.syncAll(env);
  assert.deepEqual(r.slice(0, 2).map((x) => x.status), ['synced', 'error']);
  assert.equal(kv.m.has('ai:recall:blog'), false);
  fail = false;
  r = await V.syncAll(env);
  assert.deepEqual(r.slice(0, 2).map((x) => x.status), ['unchanged', 'synced']);
  /* 预算：第一个要同步的站不受限，之后的站超了就 deferred */
  const big = { site: 'blog', items: Array.from({ length: V.RUN_CHUNK_BUDGET + 5 }, (_, i) => ({ id: 'p' + i, lang: 'zh', title: 'T' + i, url: '/p' + i })) };
  const kv2 = fakeKV({ 'site:space': JSON.stringify(SPACE), 'site:blog': JSON.stringify(big) });
  const env2 = { AI: { async run(m, i) { return { data: i.text.map(vecOf) }; } }, VECTORIZE: fakeVec(), KV_SEARCH_INDEX: kv2 };
  r = await V.syncAll(env2);
  assert.deepEqual(r.slice(0, 2).map((x) => x.status), ['synced', 'deferred']);
  r = await V.syncAll(env2);
  assert.deepEqual(r.slice(0, 2).map((x) => x.status), ['unchanged', 'synced']);
});

test('scheduled：调 syncAll，ctx.waitUntil 接住，出错不抛', async () => {
  const kv = fakeKV({ 'site:space': JSON.stringify(SPACE) });
  const vec = fakeVec();
  const waits = [];
  await app.scheduled({ scheduledTime: Date.now() }, { AI: fakeAI(), VECTORIZE: vec, KV_SEARCH_INDEX: kv }, { waitUntil(p) { waits.push(p); } });
  assert.equal(waits.length, 1);
  assert.ok(vec.m.size > 0);
  await app.scheduled({}, {}, { waitUntil() {} });
});

/* ---------- 语义召回 ---------- */

async function seeded() {
  const vec = fakeVec();
  const env = { AI: fakeAI(), VECTORIZE: vec, KV_SEARCH_INDEX: fakeKV({ 'site:space': JSON.stringify(SPACE), 'site:blog': JSON.stringify(BLOG) }) };
  await V.syncAll(env);
  return env;
}

test('semantic：没账号会话带 filter private:false、结果里也不出私密；有会话才出；低分不要；同一页面只留一段、问句语言优先', async () => {
  const env = await seeded();
  let hits = await S.semanticRecall(env, { q: '账号', lang: 'zh' });
  assert.deepEqual(env.VECTORIZE.log.queries.at(-1).filter, { private: false });
  assert.equal(env.VECTORIZE.log.queries.at(-1).returnMetadata, 'all');
  assert.ok(env.VECTORIZE.log.queries.at(-1).topK <= 50);
  assert.equal(hits.some((h) => h.private), false);
  hits = await S.semanticRecall(env, { q: '账号', lang: 'zh', showPrivate: true });
  assert.equal(env.VECTORIZE.log.queries.at(-1).filter, undefined);
  assert.equal(hits[0].title, '账号安全');
  /* 元数据过滤没生效（索引没建好）也守得住：结果里再按 private 过滤 */
  const leaky = { ...env, VECTORIZE: { ...env.VECTORIZE, query: (v, o) => env.VECTORIZE.query(v, { ...o, filter: undefined }) } };
  assert.equal((await S.semanticRecall(leaky, { q: '账号', lang: 'zh' })).some((h) => h.private), false);
  /* 锁屏博文切了好几段，只回一条 */
  hits = await S.semanticRecall(env, { q: '锁屏', lang: 'zh' });
  assert.equal(hits.filter((h) => h.url === BLOG.items[0].url).length, 1);
  assert.ok([...hits[0].text].length <= R.CONTEXT_CHARS);
  /* 中英两份同一页面：问英文留英文那份 */
  hits = await S.semanticRecall(env, { q: '主题 theme', lang: 'en' });
  assert.equal(hits.filter((h) => /theme\/$/.test(h.url)).length, 1);
  assert.equal(hits[0].url, 'https://styrigx.com/theme/');
  /* 无关问题：分数都低于门槛 → 空 */
  assert.deepEqual(await S.semanticRecall(env, { q: '天气怎么样', lang: 'zh' }), []);
  await assert.rejects(S.semanticRecall({ AI: fakeAI() }, { q: 'x' }), /no-vectorize/);
});

test('mergeHits：语义在前、关键词补后、同站同地址只留一次、最多 limit', () => {
  const a = { site: 's', url: '/a', title: 'A' };
  const b = { site: 's', url: '/b', title: 'B' };
  const c = { site: 't', url: '/a', title: 'C' };
  assert.deepEqual(S.mergeHits([a, b], [b, c, a], 5).map((h) => h.title), ['A', 'B', 'C']);
  assert.deepEqual(S.mergeHits([a], [b, c], 2).map((h) => h.title), ['A', 'B']);
});

/* ---------- /ask 接上三路召回 ---------- */

function chatAI(env) {
  const calls = [];
  const emb = env.AI;
  return {
    calls,
    async run(model, input) {
      if (model === E.EMBED_MODEL) return emb.run(model, input);
      calls.push({ model, input });
      return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"response":"好"}\n\n')); c.close(); } });
    },
  };
}
async function events(res) {
  const txt = await res.text();
  return txt.split('\n\n').filter(Boolean).map((b) => ({ event: /^event: (.+)$/m.exec(b)[1], data: JSON.parse(/^data: (.+)$/m.exec(b)[1]) }));
}
function ask(body, env, headers = {}) {
  return app.fetch(new Request('https://styrigx-ai/ask', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }), env);
}

test('/ask：语义召回的段进上下文（关键词召回不中的问法也能中）；私密段只给账号会话；语义出错退回关键词', async () => {
  const env = await seeded();
  const ai = chatAI(env);
  /* 「锁屏设计思路」关键词召回也能中；这里换成只有语义能对上的说法：向量替身按「锁屏」给分，问句里有锁屏但 KV 里清空 */
  const env2 = { ...env, AI: ai, KV_SEARCH_INDEX: fakeKV({}) };
  let ev = await events(await ask({ q: '讲讲锁屏', lang: 'zh' }, env2));
  assert.deepEqual(ev.map((e) => e.event), ['delta', 'done']);
  const sys = ai.calls.at(-1).input.messages[0].content;
  assert.match(sys, /锁屏的设计/);
  assert.doesNotMatch(sys, /账号安全/);
  R._resetCache();
  await events(await ask({ q: '账号', lang: 'zh' }, { ...env2 }, { 'X-Styrigx-Account-Session': '1' }));
  assert.match(ai.calls.at(-1).input.messages[0].content, /账号安全/);
  R._resetCache();
  await events(await ask({ q: '账号', lang: 'zh' }, { ...env2 }));
  assert.doesNotMatch(ai.calls.at(-1).input.messages[0].content, /账号安全/);
  /* Vectorize 坏了：退回关键词召回，照常回答 */
  R._resetCache();
  const broken = { ...env, AI: ai, VECTORIZE: { async query() { throw new Error('index not found'); }, async upsert() {} } };
  ev = await events(await ask({ q: '主题', lang: 'zh' }, broken));
  assert.deepEqual(ev.map((e) => e.event), ['delta', 'done']);
  assert.match(ai.calls.at(-1).input.messages[0].content, /主题模式/);
  /* KV 和 Vectorize 都用不了 → 503 index */
  R._resetCache();
  const r = await ask({ q: '主题', lang: 'zh' }, { AI: ai });
  assert.equal(r.status, 503);
});

/* ---------- 固定查询 ---------- */

test('fixed：意图——最近 N 部电影（数字 / 中文数字 / 默认 5 / 上限 20）、音乐；无关问题不查', () => {
  assert.deepEqual(F.detectIntents('最近看了哪些电影'), [{ name: 'recentMovies', params: { n: 5 } }]);
  assert.deepEqual(F.detectIntents('最近 3 部电影'), [{ name: 'recentMovies', params: { n: 3 } }]);
  assert.deepEqual(F.detectIntents('最近十部电影'), [{ name: 'recentMovies', params: { n: 10 } }]);
  assert.deepEqual(F.detectIntents('最近二十三部电影'), [{ name: 'recentMovies', params: { n: 20 } }]);
  assert.deepEqual(F.detectIntents('last 7 movies you watched'), [{ name: 'recentMovies', params: { n: 7 } }]);
  assert.equal(F.parseCount('2025 年的电影'), 0, '年份不当数量');
  assert.deepEqual(F.detectIntents('专辑 OK Computer 有哪些曲目').map((x) => x.name), ['music']);
  assert.equal(F.detectIntents('Tell me about the album Blue').at(0).params.q, 'Tell me about the album Blue');
  assert.deepEqual(F.detectIntents('主题怎么换'), []);
  assert.deepEqual(F.detectIntents('电影院在哪'), [], '只说电影不说最近：交给语义召回');
});

test('fixed：调 CURIO.query（只传查询名 + 参数，不传 SQL）；结果成一条上下文（中英）；没绑 / 超时 / 出错 → 空，不抛', async () => {
  const calls = [];
  const env = { CURIO: { async query(name, params) {
    calls.push([name, params]);
    if (name === 'recentMovies') return { ok: true, movies: [{ title: '花样年华', original_title: 'In the Mood for Love', year: 2000, director: '王家卫', rating: 5, review: '好', watched_at: '2026-10-01' }] };
    return { ok: true, albums: [{ title: 'Blue', artist: 'Joni Mitchell', year: 1971, tracks: [{ no: 1, title: 'All I Want', duration: 214 }] }] };
  } } };
  let hits = await F.fixedHits(env, '最近 2 部电影和专辑 Blue 的曲目', 'zh');
  assert.deepEqual(calls, [['recentMovies', { n: 2 }], ['music', { q: '最近 2 部电影和专辑 Blue 的曲目' }]]);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].url, 'https://styrigx.com/curio/zh/movies/');
  assert.match(hits[0].text, /1\. 花样年华（In the Mood for Love） — 2000，王家卫，评分 5\/5，观看 2026-10-01。短评：好/);
  assert.equal(hits[1].url, 'https://styrigx.com/curio/zh/music/');
  assert.match(hits[1].text, /Blue — Joni Mitchell \(1971\)\n {2}1\. All I Want 3:34/);
  hits = await F.fixedHits(env, 'latest movies', 'en');
  assert.equal(hits[0].url, 'https://styrigx.com/curio/movies/');
  assert.equal(hits[0].title, 'Recently watched movies');
  assert.deepEqual(await F.fixedHits({}, '最近的电影', 'zh'), []);
  assert.deepEqual(await F.fixedHits({ CURIO: { async query() { throw new Error('rpc'); } } }, '最近的电影', 'zh'), []);
  assert.deepEqual(await F.fixedHits({ CURIO: { async query() { return { ok: true, movies: [] }; } } }, '最近的电影', 'zh'), []);
  assert.deepEqual(await F.fixedHits({ CURIO: { async query() { return { ok: false, error: 'failed' }; } } }, '最近的电影', 'zh'), []);
  const t0 = Date.now();
  const slow = { CURIO: { query: () => new Promise((r) => setTimeout(() => r({ ok: true, movies: [{ title: 'x' }] }), F.FIXED_TIMEOUT_MS + 500)) } };
  assert.deepEqual(await F.fixedHits(slow, '最近的电影', 'zh'), []);
  assert.ok(Date.now() - t0 < F.FIXED_TIMEOUT_MS + 400);
});

test('fixed：单曲（kind=single，音乐 v1.13 ②）标「单曲」/ single，专辑不标；「单曲」也认作音乐意图', () => {
  assert.deepEqual(F.detectIntents('有哪些单曲').map((x) => x.name), ['music']);
  const r = { ok: true, albums: [{ title: 'River', kind: 'single', artist: 'Joni Mitchell', year: 1971, tracks: [{ no: 1, title: 'River', duration: 240 }] }, { title: 'Blue', kind: 'album', artist: 'Joni Mitchell', year: 1971, tracks: [] }] };
  const zh = F.toHit('music', r, 'zh').text;
  assert.match(zh, /^River — Joni Mitchell \(1971\) \[单曲\]\n/);
  assert.match(zh, /\n\nBlue — Joni Mitchell \(1971\)$/);
  assert.match(F.toHit('music', r, 'en').text, /^River — Joni Mitchell \(1971\) \[single\]/);
});

test('/ask：固定查询结果排在上下文最前', async () => {
  const env = await seeded();
  const ai = chatAI(env);
  env.CURIO = { async query() { return { ok: true, movies: [{ title: '花样年华', year: 2000 }] }; } };
  await events(await ask({ q: '最近看的电影', lang: 'zh' }, { ...env, AI: ai }));
  assert.match(ai.calls.at(-1).input.messages[0].content, /站内内容：\n\n\[1\] 最近看的电影 — 奇趣 › 电影\n地址：https:\/\/styrigx\.com\/curio\/zh\/movies\//);
});

/* ---------- Gemini：联网来源、错误分类、脱敏日志 ---------- */

async function withFetch(fn, run) {
  const orig = globalThis.fetch;
  globalThis.fetch = fn;
  try { return await run(); } finally { globalThis.fetch = orig; }
}
async function withConsole(run) {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => { lines.push(a.map(String).join(' ')); };
  try { await run(); } finally { console.error = orig; }
  return lines;
}
const sse = (o) => 'data: ' + JSON.stringify(o) + '\n\n';
const gEnv = (o = {}) => ({ KV_SEARCH_INDEX: fakeKV({ 'site:space': JSON.stringify(SPACE), 'ai:models': JSON.stringify({ default: 'gemini-x', models: [{ id: 'gemini-x', provider: 'gemini' }] }) }), SGX_CHAT_API_KEY: 'AIzaSySECRETSECRETSECRET123', ...o });

test('Gemini 联网：带 google_search；groundingChunks → event: sources（去重、只认 http(s)、done 之前）；AI_GEMINI_SEARCH=0 不带', async () => {
  const bodies = [];
  await withFetch(async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(sse({ candidates: [{ content: { parts: [{ text: '今天晴' }] } }] }) + sse({ candidates: [{ content: { parts: [{ text: '。' }] }, groundingMetadata: { groundingChunks: [
      { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', title: 'weather.com' } },
      { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', title: 'dup' } },
      { web: { uri: 'javascript:alert(1)', title: 'bad' } },
      { web: { uri: 'https://example.org/x' } },
    ] } }] }), { status: 200 });
  }, async () => {
    const ev = await events(await ask({ q: '今天天气', lang: 'zh' }, gEnv()));
    assert.deepEqual(ev.map((e) => e.event), ['delta', 'delta', 'sources', 'done']);
    assert.deepEqual(ev[2].data.items, [
      { title: 'weather.com', url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc' },
      { title: 'example.org', url: 'https://example.org/x' },
    ]);
    M._resetModelsCache(); R._resetCache();
    await events(await ask({ q: '今天天气', lang: 'zh' }, gEnv({ AI_GEMINI_SEARCH: '0' })));
  });
  assert.deepEqual(bodies[0].tools, [{ google_search: {} }]);
  assert.equal(bodies[1].tools, undefined);
  assert.doesNotMatch(bodies[1].systemInstruction.parts[0].text, /Google 搜索/);
});

test('Gemini 故障：地区不支持 → code region + 日志 reason=location；日志脱敏不含钥匙；工具被拒不带工具重试一次', async () => {
  const errBody = JSON.stringify({ error: { code: 400, message: 'User location is not supported for the API use. key=AIzaSySECRETSECRETSECRET123', status: 'FAILED_PRECONDITION' } });
  let ev;
  const lines = await withConsole(async () => {
    await withFetch(async () => new Response(errBody, { status: 400 }), async () => {
      ev = await events(await ask({ q: '主题', lang: 'zh' }, gEnv()));
    });
  });
  assert.deepEqual(ev, [{ event: 'error', data: { code: 'region' } }]);
  const log = lines.find((l) => l.includes('[ai] gemini upstream'));
  assert.ok(log, lines.join('\n'));
  assert.match(log, /"reason":"location"/);
  assert.match(log, /"googleStatus":"FAILED_PRECONDITION"/);
  assert.match(log, /"status":400/);
  for (const l of lines) assert.doesNotMatch(l, /SECRETSECRET/, '日志里不能有钥匙');

  /* 工具被拒：第一次 400 提到 google_search，第二次不带 tools 成功 */
  M._resetModelsCache(); R._resetCache();
  const seen = [];
  await withConsole(async () => {
    await withFetch(async (u, init) => {
      const b = JSON.parse(init.body);
      seen.push(b.tools);
      if (b.tools) return new Response(JSON.stringify({ error: { code: 400, message: 'Tool google_search is not supported for this model', status: 'INVALID_ARGUMENT' } }), { status: 400 });
      return new Response(sse({ candidates: [{ content: { parts: [{ text: '好' }] } }] }), { status: 200 });
    }, async () => {
      ev = await events(await ask({ q: '主题', lang: 'zh' }, gEnv()));
    });
  });
  assert.deepEqual(seen, [[{ google_search: {} }], undefined]);
  assert.deepEqual(ev.map((e) => e.event), ['delta', 'done']);
});

test('describeUpstream / classifyUpstream / redact：分类与脱敏', () => {
  assert.equal(G.classifyUpstream(400, 'User location is not supported for the API use.'), 'region');
  assert.equal(G.classifyUpstream(429, ''), 'rate_limited');
  assert.equal(G.classifyUpstream(404, ''), 'model_unavailable');
  assert.equal(G.classifyUpstream(500, ''), 'upstream');
  assert.equal(G.describeUpstream(400, JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } })).reason, 'key');
  assert.equal(G.describeUpstream(429, '{"error":{"status":"RESOURCE_EXHAUSTED"}}').reason, 'quota');
  assert.equal(G.describeUpstream(503, 'oops').reason, 'server');
  assert.equal(G.describeUpstream(400, JSON.stringify([{ error: { message: 'User location is not supported', status: 'FAILED_PRECONDITION' } }])).reason, 'location', '数组格式也认');
  assert.equal(G.redact('x AIzaSyA1234567890abcdefghijk y'), 'x [key] y');
  assert.equal(G.redact('url?key=abc123&alt=sse'), 'url?key=[key]&alt=sse');
  assert.equal(G.redact('"x-goog-api-key": "abc"'), '"x-goog-api-key": "[key]"');
  assert.equal(G.redact('API key not valid'), 'API key not valid', '不误伤正常句子');
  assert.ok(G.redact('a'.repeat(1000)).length <= 300);
  assert.deepEqual(G.geminiChunk({ error: { message: 'User location is not supported' } }), { text: '', error: 'region' });
  assert.equal(G.toolRejected(400, 'google_search tool not enabled'), true);
  assert.equal(G.toolRejected(400, 'User location is not supported'), false);
  assert.deepEqual(G.geminiSources({ candidates: [{}] }), []);
});

test('aiConfig：AI_RECALL_MIN_SCORE 0–1 才认；AI_GEMINI_SEARCH 默认开', () => {
  assert.equal(ASK.aiConfig({ AI_RECALL_MIN_SCORE: '0.5' }).minScore, 0.5);
  assert.equal(ASK.aiConfig({ AI_RECALL_MIN_SCORE: '7' }).minScore, undefined);
  assert.equal(ASK.aiConfig({}).geminiSearch, true);
  assert.equal(ASK.aiConfig({ AI_GEMINI_SEARCH: '0' }).geminiSearch, false);
});
