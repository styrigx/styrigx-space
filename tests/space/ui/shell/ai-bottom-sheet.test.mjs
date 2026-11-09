/**
 * 2026-11-09 AI 窗口手机底部半屏（feat/ai-bottom-sheet）：视口 ≤ 640px、非桌面布局时 AI 窗口贴底全宽、半屏高，下滑 / 点外面 / 系统返回 / × 关；电脑不变。
 * 这里只验纯函数（松手关不关）和 CSS 规则在 input.css 与派生的 shell.css 里都在；几何与手势见 e2e topbar/ai-open.spec.js。
 * 运行：node --test tests/space/ui/shell/ai-bottom-sheet.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL('../../../../' + p, import.meta.url), 'utf8');
const TP = await import('../../../../space/web/assets/js/shell/topbar-panel.js');

test('swipeShouldClose：拖过 80px 关；拖得短但甩得快（≥ 0.5 px/ms 且 > 12px）也关；其余弹回', () => {
  assert.equal(TP.SWIPE_CLOSE_PX, 80);
  assert.equal(TP.SWIPE_CLOSE_V, 0.5);
  assert.equal(TP.swipeShouldClose(80, 0), true);
  assert.equal(TP.swipeShouldClose(200, -1), true);
  assert.equal(TP.swipeShouldClose(79, 0.1), false);
  assert.equal(TP.swipeShouldClose(30, 0.6), true);
  assert.equal(TP.swipeShouldClose(10, 2), false); /* 太短：当成手抖 */
  assert.equal(TP.swipeShouldClose(0, 0), false);
});

test('mountSheetSwipe：没有 handle 时什么也不做（不抛错）', () => {
  assert.doesNotThrow(() => TP.mountSheetSwipe(/** @type {any} */ ({}), null, () => {}, () => true));
});

for (const f of ['space/web/assets/css/input.css', 'space/web/assets/css/shell/shell.css']) {
  test(`${f}：≤ 640px 非桌面布局 AI 窗口 = 底部半屏面板；拖动时关过渡；头部不选字、不滚页`, () => {
    const s = rd(f);
    const i = s.indexOf('@media (max-width: 640px) {\n  :root:not([data-sgx-layout="desktop"]) .sgx-ai .sgx-qp-sheet');
    assert.ok(i >= 0, '手机底部面板的媒体查询');
    const block = s.slice(i, s.indexOf('\n}\n', i));
    assert.match(block, /top: auto; left: 0; right: 0; bottom: 0;/);
    assert.match(block, /height: min\(max\(50dvh, 360px\), 100%\)/);
    assert.match(block, /border-radius: 16px 16px 0 0/);
    assert.match(block, /transform: translateY\(100%\)/);
    assert.match(block, /\.sgx-ai\.is-open \.sgx-qp-sheet \{ transform: translateY\(var\(--sgx-ai-drag, 0px\)\); \}/);
    assert.match(block, /\.sgx-ai\[data-drag\] \.sgx-qp-sheet \{ transition: none; \}/);
    assert.match(block, /\.sgx-ai-head \{[^}]*touch-action: none;[^}]*user-select: none;/);
  });
}
