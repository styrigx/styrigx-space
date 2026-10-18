/**
 * @fileoverview 子页面大标题滚动联动动画（旧 sgx-base-a.js 2.3.14.7）。
 * - 上滚：大标题随滚动上移最多 24px，同时透明度 1→0；标题区滚过约一半时完全消失。
 * - 下拉反过来；只改 opacity 和 transform，不触发重排；减少动画时只做淡入淡出。
 * - 支持 scroll-driven animations 时由 CSS 接管，这里只做 JS 回退。
 * - 小标题与品牌淡出由顶栏 v2.0 的 body.sgx-stuck 控制（head-buttons.js）。
 * @param {import('./scheduler.js').Scheduler} S
 */
import { reducedMotion, visibleSubHead } from '../lib/util.js';

export function initSubHead(S) {
  /* 支持 view-timeline-name 时由 CSS 接管 */
  try {
    if (window.CSS && CSS.supports && CSS.supports('view-timeline-name', '--sgx-subhead')) return;
  } catch (e) {}
  /* D3：设置页手机/DeX 各有一份标题，JS 回退只取当前可见的那一份 */
  const head = visibleSubHead();
  if (!head) return;
  const hero = head.querySelector('.subpage-hero');

  /** @param {number} y */
  function onScroll(y) {
    const headH = /** @type {HTMLElement} */ (head).offsetHeight || 1;
    const canScroll = document.documentElement.scrollHeight > window.innerHeight + 10;
    const rm = reducedMotion();
    /* will-change 只在滚动活跃时临时加，停 240ms 后移除 */
    if (hero) {
      const h = /** @type {HTMLElement} */ (hero);
      h.style.willChange = 'opacity,transform';
      const prevT = /** @type {any} */ (h)._sgxWcT;
      if (prevT) clearTimeout(prevT);
      /** @type {any} */ (h)._sgxWcT = window.setTimeout(function () {
        h.style.willChange = '';
      }, 240);
    }
    /* 大标题：滚动 0 → 标题区一半，透明度 1→0，上移最多 24px */
    if (hero) {
      const h = /** @type {HTMLElement} */ (hero);
      const hp = canScroll ? Math.min(Math.max(y / (headH * 0.5), 0), 1) : 0;
      h.style.opacity = String(1 - hp);
      h.style.transform = rm ? '' : 'translateY(' + (-24 * hp).toFixed(1) + 'px)';
    }
  }
  S.onScroll(onScroll);
  S.onResize(function () {
    onScroll(window.scrollY || 0);
  });
  onScroll(window.scrollY || 0);
  /* 5.3 P2：bfcache 恢复时（pageshow persisted）重新计算大标题折叠状态 */
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) onScroll(window.scrollY || 0);
  });
}
