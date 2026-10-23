/**
 * @fileoverview 主站顶栏三栏（主页 / 聊天 / 状态）左右滑切换（2026-10-24，手感照子站 daymark / curio / blog：
 * 内容里横着滑 ≥ 70px、横向位移 ≥ 竖向 1.6 倍、700ms 内 → 上一栏 / 下一栏，不循环）。
 *
 * - 切换走顶栏标签链接本身（link.click()），所以跨页 view transition 照旧；松手瞬间先把药丸高亮挪到目标栏。
 * - 不抢这些手势：屏幕左右边缘 24px 内起手（系统返回 / 抽屉的边缘手势）、多指、竖滑（角度门槛）、
 *   输入框 / 文本域 / 可编辑区（聊天输入框）、能横向滚动的容器（代码块、表格、横排卡片）、有选中文字、
 *   打开着的弹层（<dialog open>、锁屏、方式弹层）、[data-no-swipe] 里面。
 * - 只在有顶栏三栏的页面、粗指针（触屏）上生效；鼠标不管。
 */

const EDGE = 24;
const MIN_DX = 70;
const RATIO = 1.6;
const MAX_MS = 700;

/** @param {Element|null} el */
function inHScroller(el) {
  for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth + 1) {
      const ox = getComputedStyle(n).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
  }
  return false;
}

/** @param {Element|null} el */
function blockedTarget(el) {
  if (!el || !el.closest) return true;
  if (el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [data-no-swipe], dialog, #sgx-lock, #sgx-method-sheet, .sgx-tb-tabs')) return true;
  return false;
}

function overlayOpen() {
  return !!document.querySelector('dialog[open], #sgx-lock, #sgx-method-sheet');
}

export function initTabSwipe() {
  const nav = document.querySelector('.sgx-tb-tabs');
  if (!nav) return;
  const tabs = /** @type {HTMLAnchorElement[]} */ (Array.from(nav.querySelectorAll('a.sgx-tb-tab')));
  if (tabs.length < 2) return;
  let x0 = 0, y0 = 0, t0 = 0, armed = false;
  document.addEventListener('touchstart', function (e) {
    armed = false;
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    if (t.clientX < EDGE || t.clientX > window.innerWidth - EDGE) return;
    const target = /** @type {Element|null} */ (e.target);
    if (blockedTarget(target) || overlayOpen() || inHScroller(target)) return;
    x0 = t.clientX; y0 = t.clientY; t0 = Date.now(); armed = true;
  }, { passive: true });
  document.addEventListener('touchmove', function (e) {
    /* 多指（双指缩放）中途加进来：取消 */
    if (armed && e.touches.length !== 1) armed = false;
  }, { passive: true });
  document.addEventListener('touchcancel', function () { armed = false; }, { passive: true });
  document.addEventListener('touchend', function (e) {
    if (!armed) return;
    armed = false;
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - x0, dy = t.clientY - y0;
    if (Math.abs(dx) < MIN_DX || Math.abs(dx) < Math.abs(dy) * RATIO || Date.now() - t0 > MAX_MS) return;
    try {
      const sel = window.getSelection && window.getSelection();
      if (sel && !sel.isCollapsed && String(sel).trim()) return;
    } catch (err) {}
    if (overlayOpen()) return;
    const cur = tabs.findIndex(function (a) { return a.getAttribute('aria-current') === 'page'; });
    if (cur < 0) return;
    const next = cur + (dx < 0 ? 1 : -1);
    if (next < 0 || next >= tabs.length) return;
    /* 药丸高亮先跟过去（导航开始前的一帧就能看到），再走链接本身（跨页 view transition 不变） */
    tabs[cur].removeAttribute('aria-current');
    tabs[next].setAttribute('aria-current', 'page');
    tabs[next].click();
  }, { passive: true });
}
