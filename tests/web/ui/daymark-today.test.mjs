/**
 * PR3：lib/daymark-today.js（主页小组件与锁屏共用）纯函数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtDaymarkDay, daymarkByline, daymarkCardHtml } from '../../../web/assets/js/lib/daymark-today.js';

test('日期格式：中文 10月21日，英文 Oct 21；非法返回空', () => {
  assert.equal(fmtDaymarkDay('2026-10-21', false), '10月21日');
  assert.equal(fmtDaymarkDay('2026-10-21', true), 'Oct 21');
  assert.equal(fmtDaymarkDay('bad', false), '');
});

test('出处：— 作者《出处》 / — Author, Source；只有作者也行', () => {
  assert.equal(daymarkByline({ author: '尼采', source: '偶像的黄昏' }, false), '— 尼采《偶像的黄昏》');
  assert.equal(daymarkByline({ author: '尼采', source: '《偶像的黄昏》' }, false), '— 尼采《偶像的黄昏》');
  assert.equal(daymarkByline({ author: 'Nietzsche', source: 'Twilight of the Idols' }, true), '— Nietzsche, Twilight of the Idols');
  assert.equal(daymarkByline({ author: '尼采' }, false), '— 尼采');
  assert.equal(daymarkByline(null, false), '');
});

test('卡片结构：与主页同一套 data-dm 槽位；锁屏版空状态不写「点开日刻」（不可点）', () => {
  const h = daymarkCardHtml(false, { emptyHint: false });
  for (const k of ['day', 'body', 'text', 'trans', 'by', 'empty']) assert.match(h, new RegExp('data-dm="' + k + '"'));
  assert.doesNotMatch(h, /点开日刻/);
  assert.match(daymarkCardHtml(false), /点开日刻/);
  assert.match(daymarkCardHtml(true), /DAYMARK/);
});
