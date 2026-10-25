/**
 * 全站搜索 styrigx-search-index（workers/search-index）：分词、打分、私密过滤、入口。
 * 运行：node --test tests/workers/search-index/search.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, score, search } from '../../../workers/search-index/src/rank.js';
import worker, { _resetCache } from '../../../workers/search-index/src/index.js';

const IX = [
  { site: 'space', items: [
    { id: 'a', type: 'setting', lang: 'zh', title: '壁纸和主题', subtitle: '', url: 'https://styrigx.com/settings/theme/' },
    { id: 'b', type: 'setting', lang: 'zh', title: '主题模式', subtitle: '显示', text: '跟随系统 浅色 深色', url: 'https://styrigx.com/settings/display/' },
    { id: 'c', type: 'setting', lang: 'zh', title: '账号信息', subtitle: '账号', url: 'https://styrigx.com/account/profile/', private: true },
    { id: 'd', type: 'setting', lang: 'en', title: 'Theme mode', subtitle: 'Display', url: 'https://styrigx.com/en/settings/display/' },
  ] },
  { site: 'blog', items: [
    { id: 'p', type: 'post', lang: 'zh', title: 'AI 代理协作开发规范白皮书', subtitle: '', url: 'https://blog.styrigx.com/post/x/' },
  ] },
];

test('分词：中文二元组、英文按词、去重、大小写', () => {
  assert.deepEqual(tokenize('主题模式'), ['主题', '题模', '模式']);
  assert.deepEqual(tokenize('深'), ['深']);
  assert.deepEqual(tokenize('Theme  MODE theme'), ['theme', 'mode']);
  assert.deepEqual(tokenize('AI 白皮书'), ['ai', '白皮', '皮书']);
  assert.deepEqual(tokenize('  ，。 '), []);
});

test('打分：每个词都要中；标题 > 副标题 > 正文；整句在标题加分', () => {
  const toks = tokenize('主题');
  assert.ok(score({ title: '主题模式' }, toks, '主题') > score({ title: '壁纸', subtitle: '主题' }, toks, '主题'));
  assert.equal(score({ title: '壁纸' }, tokenize('主题'), '主题'), 0);
  assert.ok(score({ title: '主题模式', text: '深色' }, tokenize('深色'), '深色') > 0, '正文也能搜到');
});

test('搜索：主题 → 主题模式排在壁纸和主题前；按语言过滤', () => {
  const hs = search(IX, { q: '主题', lang: 'zh' });
  assert.deepEqual(hs.map((h) => h.title), ['主题模式', '壁纸和主题']);
  assert.deepEqual(search(IX, { q: 'theme', lang: 'en' }).map((h) => h.title), ['Theme mode']);
  assert.deepEqual(search(IX, { q: '深色', lang: 'zh' }).map((h) => h.title), ['主题模式']);
});

test('私密：访客搜不到，管理员能搜到', () => {
  assert.equal(search(IX, { q: '账号', lang: 'zh' }).length, 0);
  assert.equal(search(IX, { q: '账号', lang: 'zh', admin: true }).length, 1);
});

test('跨站：博客文章也在结果里；site 只搜一个站', () => {
  assert.equal(search(IX, { q: '白皮书' })[0].site, 'blog');
  assert.equal(search(IX, { q: '白皮书', site: 'space' }).length, 0);
});

function kvOf(map) {
  return { async get(k, t) { const v = map[k]; return v === undefined ? null : t === 'json' ? JSON.parse(v) : v; } };
}

test('入口：GET /search 回结果、不回正文；角色头只认 admin；没 KV 503', async () => {
  _resetCache();
  const env = { KV_SEARCH_INDEX: kvOf({ 'site:space': JSON.stringify(IX[0]), 'site:blog': JSON.stringify(IX[1]) }) };
  let r = await worker.fetch(new Request('https://x/search?q=' + encodeURIComponent('主题模式') + '&lang=zh'), env);
  let j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.hits[0].title, '主题模式');
  assert.equal(j.hits[0].text, undefined);
  r = await worker.fetch(new Request('https://x/search?q=' + encodeURIComponent('账号')), env);
  assert.equal((await r.json()).hits.length, 0);
  r = await worker.fetch(new Request('https://x/search?q=' + encodeURIComponent('账号'), { headers: { 'X-Sgx-Role': 'admin' } }), env);
  assert.equal((await r.json()).hits.length, 1);
  assert.equal((await worker.fetch(new Request('https://x/other'), env)).status, 404);
  assert.equal((await worker.fetch(new Request('https://x/search?q=a', { method: 'POST' }), env)).status, 405);
  _resetCache();
  assert.equal((await worker.fetch(new Request('https://x/search?q=a'), {})).status, 503);
});
