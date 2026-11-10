/**
 * styrigx-ai GET /find（v5 S4 关键词搜索，workers/ai/src/api/find.js）：
 * - 不调模型（env.AI 碰都不碰）；全命中打分（rank.js search）；只回 { title, url, site, snippet }，正文 text 不回
 * - 私密条目一律不回（带账号结论头也一样）
 * - 先按 lang 找，没有再放开语言
 * - 读 KV 走 recall.js loadIndexes 的 60 秒缓存（第二次不再读 KV）
 * - KV 读不了 / 一个站都没有 → 200 degraded（不 500）
 * - q 为空 400 bad_request；太长 400 too-long
 * 运行：node --test tests/workers/ai/find.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const W = '../../../workers/ai/src/';
const app = (await import(W + 'app.js')).default;
const R = await import(W + 'core/recall.js');
const F = await import(W + 'api/find.js');

const IX = {
  space: { items: [
    { id: 's1', type: 'setting', lang: 'zh', title: '主题模式', subtitle: '外观', text: '深色和浅色主题切换。', url: 'https://styrigx.com/zh/theme/' },
    { id: 's2', type: 'setting', lang: 'zh', title: '主题账号安全', text: '私密页正文：保险箱密码在抽屉里。', url: 'https://styrigx.com/account/secret/', private: true },
    { id: 's3', type: 'setting', lang: 'en', title: 'Theme mode', subtitle: 'Appearance', text: 'Dark and light.', url: 'https://styrigx.com/theme/' },
  ] },
  blog: { items: [
    { id: 'b1', type: 'post', lang: 'zh', title: '主题模式的设计', subtitle: '博客', text: '正文很长'.repeat(200), url: 'https://styrigx.com/blog/zh/post/theme/' },
  ] },
  curio: { items: [
    { id: 'c1', type: 'item', lang: 'en', title: 'Galaxy Buds', subtitle: 'Devices · earbuds', text: 'theme song', url: 'https://styrigx.com/curio/devices/' },
  ] },
};

/** KV 替身：记下读了几次；fail = 每次读都抛错 */
function kvOf(map, o = {}) {
  const kv = {
    reads: 0,
    async get(k, t) {
      kv.reads++;
      if (o.fail) throw new Error('kv down');
      const v = map[k];
      return v == null ? null : t === 'json' ? JSON.parse(v) : v;
    },
  };
  return kv;
}
const full = () => kvOf({ 'site:space': JSON.stringify(IX.space), 'site:blog': JSON.stringify(IX.blog), 'site:curio': JSON.stringify(IX.curio) });
/** 模型替身：被调就记一笔（/find 不该调） */
function noAI() {
  const ai = { calls: 0, async run() { ai.calls++; throw new Error('find must not call the model'); } };
  return ai;
}
const find = (qs, env, headers = {}) => app.fetch(new Request('https://styrigx-ai/find' + qs, { headers }), env);

beforeEach(() => R._resetCache());

test('结果：全命中、按分排序；只回 title / url / site / snippet（snippet = 副标题，正文不回）；不调模型', async () => {
  const ai = noAI();
  const r = await find('?q=' + encodeURIComponent('主题模式') + '&lang=zh', { AI: ai, KV_SEARCH_INDEX: full() });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('Cache-Control') || '', /no-store/);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.q, '主题模式');
  assert.equal(j.degraded, undefined);
  assert.deepEqual(j.results, [
    { title: '主题模式', url: 'https://styrigx.com/zh/theme/', site: 'space', snippet: '外观' },
    { title: '主题模式的设计', url: 'https://styrigx.com/blog/zh/post/theme/', site: 'blog', snippet: '博客' },
  ]);
  for (const it of j.results) assert.deepEqual(Object.keys(it).sort(), ['site', 'snippet', 'title', 'url']);
  assert.equal(ai.calls, 0);
  assert.doesNotMatch(JSON.stringify(j), /正文很长|深色/);
});

test('私密条目一律不回：带账号结论头也一样', async () => {
  for (const headers of [{}, { 'X-Styrigx-Account-Session': '1' }]) {
    R._resetCache();
    const j = await (await find('?q=' + encodeURIComponent('账号安全'), { KV_SEARCH_INDEX: full() }, headers)).json();
    assert.deepEqual(j.results, [], JSON.stringify(headers));
    assert.doesNotMatch(JSON.stringify(j), /保险箱|account\/secret/);
  }
});

test('语言：先按 lang 找；没有再放开语言；lang 不认识当没给', async () => {
  let j = await (await find('?q=theme&lang=en', { KV_SEARCH_INDEX: full() })).json();
  assert.deepEqual(j.results.map((x) => x.url), ['https://styrigx.com/theme/', 'https://styrigx.com/curio/devices/']);
  j = await (await find('?q=buds&lang=zh', { KV_SEARCH_INDEX: full() })).json();
  assert.deepEqual(j.results.map((x) => x.title), ['Galaxy Buds'], 'zh 里没有 → 放开语言');
  j = await (await find('?q=buds&lang=fr', { KV_SEARCH_INDEX: full() })).json();
  assert.deepEqual(j.results.map((x) => x.title), ['Galaxy Buds']);
  j = await (await find('?q=nothing-here', { KV_SEARCH_INDEX: full() })).json();
  assert.deepEqual(j, { ok: true, q: 'nothing-here', results: [] });
});

test('缓存：60 秒内第二次搜索不再读 KV（同 recall.js loadIndexes）', async () => {
  const kv = full();
  await find('?q=theme', { KV_SEARCH_INDEX: kv });
  const n = kv.reads;
  assert.equal(n, R.SITES.length, '四个站各读一次');
  await find('?q=buds', { KV_SEARCH_INDEX: kv });
  assert.equal(kv.reads, n);
});

test('KV 读不了 / 没绑 / 一个站都没有 → 200 degraded（空结果），不 500', async () => {
  for (const env of [{ KV_SEARCH_INDEX: kvOf({}, { fail: true }) }, {}, { KV_SEARCH_INDEX: kvOf({}) }]) {
    R._resetCache();
    const r = await find('?q=theme', env);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, q: 'theme', results: [], degraded: true });
  }
});

test('q 为空 400 bad_request；超过 FIND_Q_MAX 400 too-long', async () => {
  for (const qs of ['', '?q=', '?q=%20%20']) {
    const r = await find(qs, { KV_SEARCH_INDEX: full() });
    assert.equal(r.status, 400, qs);
    assert.equal((await r.json()).error, 'bad_request');
  }
  const r = await find('?q=' + 'a'.repeat(F.FIND_Q_MAX + 1), { KV_SEARCH_INDEX: full() });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'too-long');
  assert.equal((await find('?q=' + 'a'.repeat(F.FIND_Q_MAX), { KV_SEARCH_INDEX: full() })).status, 200);
});

test('最多回 FIND_LIMIT 条', () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ id: 'x' + i, lang: 'en', title: 'muse tip ' + i, url: 'https://styrigx.com/blog/t' + i + '/' }));
  assert.equal(F.findIn([{ site: 'blog', items }], 'muse', 'en').length, F.FIND_LIMIT);
});
