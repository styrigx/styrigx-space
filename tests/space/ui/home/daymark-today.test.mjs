/**
 * PR3：lib/daymark-today.js（主页 [03] 日刻）纯函数 + paintDaymark 画槽位（对齐 PR-B 起卡片结构在模板里，旧 daymarkCardHtml 删除）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installI18nDom, setI18nLang } from '../../../fixtures/i18n-dom.mjs';
import { fmtDaymarkDay, daymarkByline, paintDaymark } from '../../../../space/web/assets/shell/js/lib/daymark-today.js';

/* 语言包化 2026-11-07：文案和日期按页面语言（<html lang> + #sgx-i18n-space），参数 en 只是兼容旧调用 */
installI18nDom('zh');
/** @param {boolean} en @param {() => any} fn */
const inLang = (en, fn) => { setI18nLang(en ? 'en' : 'zh'); try { return fn(); } finally { setI18nLang('zh'); } };

test('日期格式：中文 10月21日，英文 Oct 21；非法返回空', () => {
  assert.equal(fmtDaymarkDay('2026-10-21', false), '10月21日');
  assert.equal(inLang(true, () => fmtDaymarkDay('2026-10-21', true)), 'Oct 21');
  assert.equal(fmtDaymarkDay('bad', false), '');
});

test('出处：— 作者《出处》 / — Author, Source；只有作者也行', () => {
  assert.equal(daymarkByline({ author: '尼采', source: '偶像的黄昏' }, false), '— 尼采《偶像的黄昏》');
  assert.equal(daymarkByline({ author: '尼采', source: '《偶像的黄昏》' }, false), '— 尼采《偶像的黄昏》');
  assert.equal(inLang(true, () => daymarkByline({ author: 'Nietzsche', source: 'Twilight of the Idols' }, true)), '— Nietzsche, Twilight of the Idols');
  assert.equal(daymarkByline({ author: '尼采' }, false), '— 尼采');
  assert.equal(daymarkByline(null, false), '');
});

/** 最小假节点：textContent / classList / hidden，querySelector 按 data-dm 找 */
function fakeEl(/** @type {string[]} */ cls = []) {
  const set = new Set(cls);
  return {
    textContent: '', hidden: false,
    classList: {
      add: (/** @type {string} */ c) => set.add(c), remove: (/** @type {string} */ c) => set.delete(c),
      contains: (/** @type {string} */ c) => set.has(c),
      toggle: (/** @type {string} */ c, /** @type {boolean} */ on) => (on ? set.add(c) : set.delete(c)),
    },
  };
}
function fakeRoot() {
  /** @type {Record<string, any>} */
  const slots = { day: fakeEl(), body: fakeEl(), text: fakeEl(), trans: fakeEl(['hidden']), by: fakeEl(), empty: fakeEl(['hidden']) };
  const root = /** @type {any} */ (fakeEl(['hidden']));
  root.hidden = true;
  root.querySelector = (/** @type {string} */ sel) => slots[(sel.match(/data-dm="([a-z]+)"/) || [])[1]] || null;
  return { root, slots };
}

test('paintDaymark：有句子 → 正文 / 译文 / 出处 / 日期画进槽位，空状态藏起，外层显示', () => {
  const { root, slots } = fakeRoot();
  const ok = paintDaymark(root, { ok: true, day: '2026-10-21', quote: { text: '成为你自己。', trans: 'Become who you are.', author: '尼采', source: '快乐的科学' } }, false);
  assert.equal(ok, true);
  assert.equal(slots.text.textContent, '成为你自己。');
  assert.equal(slots.trans.textContent, 'Become who you are.');
  assert.equal(slots.trans.classList.contains('hidden'), false);
  assert.equal(slots.by.textContent, '— 尼采《快乐的科学》');
  assert.equal(slots.day.textContent, '10月21日');
  assert.equal(slots.body.classList.contains('hidden'), false);
  assert.equal(slots.empty.classList.contains('hidden'), true);
  assert.equal(root.classList.contains('hidden'), false);
  assert.equal(root.hidden, false);
});

test('paintDaymark：没有译文时译文行藏起；今天没句子 → 显示空状态；无效数据不动卡片', () => {
  let { root, slots } = fakeRoot();
  paintDaymark(root, { ok: true, day: '2026-10-21', quote: { text: 'x', author: 'a' } }, false);
  assert.equal(slots.trans.classList.contains('hidden'), true);
  assert.equal(slots.trans.textContent, '');
  ({ root, slots } = fakeRoot());
  assert.equal(paintDaymark(root, { ok: true, day: '2026-10-21', quote: null }, false), true);
  assert.equal(slots.body.classList.contains('hidden'), true);
  assert.equal(slots.empty.classList.contains('hidden'), false);
  assert.equal(root.hidden, false);
  ({ root, slots } = fakeRoot());
  assert.equal(paintDaymark(root, { ok: false }, false), false);
  assert.equal(paintDaymark(root, null, false), false);
  assert.equal(root.hidden, true, '无效数据：卡片保持隐藏');
  assert.equal(slots.text.textContent, '');
});

test('模板：主页 #w-daymark 有同一套 data-dm 槽位（day / body / text / trans / by / empty），空状态写「点开日刻」', async () => {
  const { readFileSync } = await import('node:fs');
  const idx = readFileSync(new URL('../../../../space/web/layouts/index.html', import.meta.url), 'utf8');
  const blk = (idx.match(/<a id="w-daymark"[\s\S]*?<\/a>/) || [''])[0];
  assert.ok(blk, '#w-daymark');
  for (const k of ['day', 'body', 'text', 'trans', 'by', 'empty']) assert.match(blk, new RegExp('data-dm="' + k + '"'), k);
  assert.match(blk, /tapToKeepOne/);
  assert.doesNotMatch(blk, /dm-w-/, '旧大引号卡片样式不再用');
});
