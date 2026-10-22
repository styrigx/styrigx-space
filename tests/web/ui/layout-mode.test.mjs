/**
 * 2026-10-23 布局三档（Mobile · Auto · DeX）：只看可用视口。
 * 自动：w > h 且 w ≥ 840 且 h ≥ 500 → dex，其余 mobile；手动 DeX：w < 840 或 h < 500 → mobile；旧值 pc → dex。
 * 同时核对 prefs.js resolveLayout() 和 baseof.html 内联 __layoutMode() 给出同一结果。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLayout, normLayout, layoutBig } from '../../../web/assets/js/lib/prefs.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const baseof = readFileSync(path.join(REPO, 'web/layouts/_default/baseof.html'), 'utf8');
const src = baseof.match(/function __layoutMode\(\)\{[\s\S]*?\n\}/)[0];

/** 跑 baseof 的内联函数：stub window / localStorage / location */
function inline(pref, w, h, search = '') {
  const store = new Map(pref == null ? [] : [['sgx-layout', pref]]);
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const window = { innerWidth: w, innerHeight: h };
  const location = { search };
  const fn = new Function('window', 'localStorage', 'location', 'URLSearchParams', src + '\nreturn [__layoutMode(), localStorage.getItem("sgx-layout")];');
  return fn(window, localStorage, location, URLSearchParams);
}

const AUTO = [
  [915, 412, 'mobile'], // 手机横屏
  [932, 430, 'mobile'], // 大手机横屏
  [841, 673, 'dex'], // Z Fold 内屏横屏
  [1133, 744, 'dex'], // iPad mini 横屏
  [1366, 650, 'dex'],
  [412, 915, 'mobile'], // 手机竖屏
  [1024, 1366, 'mobile'], // 平板竖屏
  [1920, 950, 'dex'],
  [840, 500, 'dex'], // 正好在边界
  [839, 500, 'mobile'],
  [840, 499, 'mobile'],
  [1024, 700, 'dex'], // iPad 4:3 横屏带浏览器栏
  [1180, 760, 'dex'],
];

for (const [w, h, want] of AUTO) {
  test(`auto ${w}×${h} → ${want}`, () => {
    assert.equal(resolveLayout('auto', w, h), want);
    assert.equal(inline('auto', w, h)[0], want);
    assert.equal(inline(null, w, h)[0], want);
  });
}

test('手动 DeX：915×412 → mobile（高 < 500）；839×700 → mobile（宽 < 840）；1024×1366 → dex；偏好保留', () => {
  assert.equal(resolveLayout('dex', 915, 412), 'mobile');
  assert.deepEqual(inline('dex', 915, 412), ['mobile', 'dex']);
  assert.equal(resolveLayout('dex', 839, 700), 'mobile');
  assert.equal(inline('dex', 839, 700)[0], 'mobile');
  assert.equal(resolveLayout('dex', 1024, 1366), 'dex');
  assert.equal(inline('dex', 1024, 1366)[0], 'dex');
});

test('手动 Mobile：任何视口都是 mobile', () => {
  for (const [w, h] of [[1920, 950], [841, 673], [412, 915]]) {
    assert.equal(resolveLayout('mobile', w, h), 'mobile');
    assert.equal(inline('mobile', w, h)[0], 'mobile');
  }
});

test('旧值 pc → dex（写回 localStorage）；未知值 → auto', () => {
  assert.equal(normLayout('pc'), 'dex');
  assert.equal(normLayout('tablet'), 'auto');
  assert.equal(normLayout(null), 'auto');
  assert.deepEqual(inline('pc', 1920, 1080), ['dex', 'dex']);
  assert.deepEqual(inline('pc', 915, 412), ['mobile', 'dex']);
  assert.deepEqual(inline('tablet', 1920, 1080), ['dex', 'auto']);
  assert.equal(resolveLayout('pc', 1920, 1080), 'dex');
});

test('?layout=auto 逃生口重置偏好', () => {
  assert.deepEqual(inline('mobile', 1920, 1080, '?layout=auto'), ['dex', 'auto']);
});

test('layoutBig 边界：840 × 500', () => {
  assert.equal(layoutBig(840, 500), true);
  assert.equal(layoutBig(839, 500), false);
  assert.equal(layoutBig(840, 499), false);
});
