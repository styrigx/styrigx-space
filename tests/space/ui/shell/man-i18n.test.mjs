/**
 * man 页的译文（S9，Gray 2026-11-11 手机截图：中文页 man sudo / man sub 的 DESCRIPTION / NOTES / AUTH 是英文）：
 * - 正文的英文底在 shell/term/man/pages.js；en.yaml 的 manBody 和它逐行一致，zh.yaml 的 manBody 每一页、每一节、每一行都有译文
 * - 中文译文里没有没翻的英文句子（命令写法、提示符、域名可以出现，但每行都要有中文）
 * - 中文页上 man <命令> 交给阅读页的正文全是中文表的行（man.js 读 manBody）
 * 运行：node --test tests/space/ui/shell/man-i18n.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { PAGES } from '../../../../space/web/assets/common/js/frame/term/man/pages.js';
import { createShell } from '../../../../space/web/assets/common/js/frame/term/terminal.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const TR = Object.fromEntries(['en', 'zh'].map((l) => [l, /** @type {any} */ (yaml.load(readFileSync(path.join(REPO, 'space/web/data/common/frame/i18n/' + l + '.yaml'), 'utf8')))]));
const SECS = ['desc', 'auth', 'notes', 'opt'];
const CJK = /[\u4e00-\u9fff]/;
/** @param {any} v @returns {string[]} */
const lines = (v) => (Array.isArray(v) ? v.map((x) => (Array.isArray(x) ? x[1] : x)) : v == null ? [] : [v]);

test('en.yaml manBody = pages.js 英文底（同样的页、同样的节、逐行相同）', () => {
  const withBody = Object.keys(PAGES).filter((n) => SECS.some((k) => /** @type {any} */ (PAGES)[n][k]));
  assert.deepEqual(Object.keys(TR.en.manBody).sort(), withBody.sort());
  for (const n of withBody) {
    for (const k of SECS) assert.deepEqual(lines(TR.en.manBody[n][k]), lines(/** @type {any} */ (PAGES)[n][k]), n + '.' + k);
  }
});

test('zh.yaml：每一页的 NAME 说明和正文都有译文，行数对得上，每一行都是中文', () => {
  for (const [n, pg] of Object.entries(PAGES)) {
    assert.ok(CJK.test(TR.zh.man[n]), 'man.' + n + ' 没翻：' + TR.zh.man[n]);
    for (const k of SECS) {
      const en = lines(/** @type {any} */ (pg)[k]);
      if (!en.length) continue;
      const zh = lines(TR.zh.manBody[n] && TR.zh.manBody[n][k]);
      assert.equal(zh.length, en.length, 'manBody.' + n + '.' + k + ' 行数');
      zh.forEach((l, i) => {
        assert.ok(CJK.test(l), 'manBody.' + n + '.' + k + '[' + i + '] 没翻：' + l);
        assert.notEqual(l, en[i], 'manBody.' + n + '.' + k + '[' + i + '] 和英文一样');
      });
    }
  }
});

/** 假页面：#sgx-i18n-frame 是中文表（叠在英文上，同 tr.html） */
function zhPage() {
  const merged = JSON.parse(JSON.stringify(TR.en));
  for (const [k, v] of Object.entries(TR.zh)) merged[k] = v && typeof v === 'object' && !Array.isArray(v) ? Object.assign({}, merged[k], v) : v;
  const el = { textContent: JSON.stringify(merged) };
  /** @type {any} */ (globalThis).document = { getElementById: (id) => (id === 'sgx-i18n-frame' ? el : null) };
}

test('中文页 man <命令>：阅读页里的正文（DESCRIPTION 含「需要：」末行 / OPTIONS 说明 / NOTES）每一行都是中文，没有英文底', async () => {
  zhPage();
  const who = { get: () => /** @type {any} */ ('root'), on() {} };
  const sh = createShell({ act: /** @type {any} */ ({}), storage: null, who, str: TR.zh.term });
  try {
    for (const n of Object.keys(PAGES)) {
      const r = await sh.exec('man ' + n);
      assert.equal(r.pager, n.toUpperCase() + '(1)');
      const txt = r.out.map((o) => o.seg.map((s) => s[1]).join(''));
      const name = txt[txt.indexOf('NAME') + 1];
      assert.ok(CJK.test(name), n + ' NAME：' + name);
      let inBody = false;
      txt.forEach((l, i) => {
        if (/^(DESCRIPTION|NOTES)$/.test(l)) { inBody = true; return; }
        if (/^[A-Z ]+$/.test(l)) { inBody = false; return; }
        if ((inBody || r.out[i].cls === 'm2') && l.trim()) assert.ok(CJK.test(l), 'man ' + n + ' 正文没翻：' + l);
      });
      if (/** @type {any} */ (PAGES)[n].auth) assert.ok(txt.some((l) => l.startsWith('    需要：')), 'man ' + n + ' 需要：');
    }
  } finally {
    delete /** @type {any} */ (globalThis).document;
  }
});
