/**
 * @fileoverview 顶部边缘渐进模糊（旧 baseof 内联脚本）。
 * 支持 animation-timeline:scroll() 时由 CSS scroll-driven animation 接管，
 * 这里只在不支持的浏览器启用 JS 类切换。
 * @param {import('./scheduler.js').Scheduler} S
 */

export function initScrollFx(S) {
  try {
    if (window.CSS && CSS.supports && CSS.supports('animation-timeline', 'scroll()')) return;
  } catch (e) {}
  const b = document.body;
  /** @param {number} y */
  function onY(y) {
    b.classList.toggle('sgx-scrolled', y > 24);
  }
  S.onScroll(onY);
  onY(window.scrollY || 0);
}
