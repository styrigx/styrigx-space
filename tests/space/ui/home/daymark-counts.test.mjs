/**
 * 2026-11-15 偏离收尾 P3 / R-05：主页日刻小字「拾录 N · 百味 N」与日刻页同一算法。
 * daymark-counts.js（主页，ES 模块）对照 assets/daymark/js/daymark.js（日刻页 IIFE，node 下导出纯函数）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { countBy, authorGroups, daymarkCounts } from '../../../../space/web/assets/common/js/frame/apps/daymark-counts.js';

const require = createRequire(import.meta.url);
const dm = require('../../../../space/web/assets/daymark/js/daymark.js');

const QUOTES = [
  { id: 'a', text: '1', author: '尼采' },
  { id: 'b', text: '2', author: '尼采' },
  { id: 'c', text: '3', author: ' 路桥川 ' },
  { id: 'd', text: '4', author: '' },
  { id: 'e', text: '5' },
  { id: 'f', text: '6', author: '菲茨杰拉德' },
];
const COLS = [{ id: 'c1', name: '尼采', quote_ids: ['a', 'b'] }, { id: 'c2', name: '了不起的盖茨比', quote_ids: ['f'] }];

test('authorGroups 与日刻页同结果（没写作者不分组、去空白、按次数→名字排）', () => {
  assert.deepEqual(authorGroups(QUOTES), dm.authorGroups(QUOTES));
  assert.deepEqual(authorGroups(QUOTES).map((g) => g.name), ['尼采', '菲茨杰拉德', '路桥川']);
  assert.deepEqual(countBy([], (q) => q), []);
});

test('拾录 = 句子数；百味 = 专题数 + 人物数（= 日刻页 renderWindows 的 groups.length）', () => {
  assert.deepEqual(daymarkCounts(QUOTES, COLS), { trove: 6, flavors: 2 + dm.authorGroups(QUOTES).length });
  assert.deepEqual(daymarkCounts(QUOTES, COLS), { trove: 6, flavors: 5 });
  assert.deepEqual(daymarkCounts(null, undefined), { trove: 0, flavors: 0 });
});
