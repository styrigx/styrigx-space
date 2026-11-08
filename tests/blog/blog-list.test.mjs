// 博客首页列表 / 目录页（2026-11 对齐 PR-C，space/web/assets/blog/js/blog/blog-list.js）：地址状态、旧 hash 转址、分页条页码。
// 取代 app-tabs.test.mjs（首页 · 文章 · 专题 三面板退役）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseListQuery, listUrl, legacyHashTarget, pagerItems } from '../../space/web/assets/blog/js/blog/blog-list.js';

test('查询串 → 列表状态：tag 优先于 cat；page 从 1 起，非法当 1', () => {
  assert.deepEqual(parseListQuery(''), { key: null, slug: '', page: 1 });
  assert.deepEqual(parseListQuery('?tag=ai'), { key: 'tag', slug: 'ai', page: 1 });
  assert.deepEqual(parseListQuery('?cat=tech&page=3'), { key: 'cat', slug: 'tech', page: 3 });
  assert.deepEqual(parseListQuery('?cat=tech&tag=ai'), { key: 'tag', slug: 'ai', page: 1 });
  assert.deepEqual(parseListQuery('?tag=%E5%AE%89%E5%85%A8'), { key: 'tag', slug: '安全', page: 1 });
  for (const bad of ['?page=0', '?page=-2', '?page=x']) assert.equal(parseListQuery(bad).page, 1, bad);
});

test('列表状态 → 地址：第 1 页不写 page，没筛选不写键', () => {
  assert.equal(listUrl('/blog/zh/', { key: null, slug: '', page: 1 }), '/blog/zh/');
  assert.equal(listUrl('/blog/zh/', { key: null, slug: '', page: 2 }), '/blog/zh/?page=2');
  assert.equal(listUrl('/blog/', { key: 'tag', slug: 'ai', page: 1 }), '/blog/?tag=ai');
  assert.equal(listUrl('/blog/', { key: 'cat', slug: 'tech', page: 4 }), '/blog/?cat=tech&page=4');
  const st = parseListQuery(listUrl('/blog/', { key: 'tag', slug: 'AI 代理', page: 2 }).split('?')[1]);
  assert.deepEqual(st, { key: 'tag', slug: 'AI 代理', page: 2 }, '往返不丢字');
});

test('旧 hash（专题面板时代）→ 新地址；文章锚点等认不出的返回 null', () => {
  const T = (h) => legacyHashTarget(h, '/blog/zh/', '/blog/zh/tree/');
  assert.equal(T('#posts'), '/blog/zh/');
  assert.equal(T('#topics'), '/blog/zh/tree/');
  assert.equal(T('#topics/tag/ai'), '/blog/zh/?tag=ai');
  assert.equal(T('#topics/category/tech'), '/blog/zh/?cat=tech');
  assert.equal(T('#topics/series/styrigx-ui-%E9%89%B4'), '/blog/zh/tree/#series-styrigx-ui-%E9%89%B4');
  assert.equal(T(''), null);
  assert.equal(T('#some-heading'), null);
  assert.equal(T('#%E0%A4%A'), null, '坏编码');
});

test('分页条页码：≤ 5 页全列；多了 1 · 当前前后 · … · 末页（设计稿「1 · 2 · 3 … 6」）', () => {
  assert.deepEqual(pagerItems(1, 1), [1]);
  assert.deepEqual(pagerItems(2, 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(pagerItems(1, 6), [1, 2, 3, '…', 6]);
  assert.deepEqual(pagerItems(4, 9), [1, '…', 3, 4, 5, '…', 9]);
  assert.deepEqual(pagerItems(9, 9), [1, '…', 7, 8, 9]);
});
