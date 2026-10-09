/**
 * @fileoverview 子页面大标题滚动联动动画（旧 sgx-base-a.js 2.3.14.7）。
 * - 上滚：大标题随滚动上移最多 24px，同时透明度 1→0；标题区滚过约一半时完全消失。
 * - 大标题完全消失后，小标题才开始出现（透明度 0→1，带 6px 从下往上位移）。
 * - 下拉反过来；只改 opacity 和 transform，不触发重排；减少动画时只做淡入淡出。
 * - 支持 scroll-driven animations 时由 CSS 接管，这里只做 JS 回退。
 * @param {import('./scheduler.js').Scheduler} S
 */
import { reducedMotion } from './util.js';
import { applyAppHero } from './vt.js';

export function initSubHead(S) {
  /* 2.4.0 D：从主页图标进来的 View Transitions 共享元素 */
  applyAppHero();
  /* 支持 view-timeline-name 时由 CSS 接管 */
  try {
    if (window.CSS && CSS.supports && CSS.supports('view-timeline-name', '--sgx-subhead')) return;
  } catch (e) {}
  const head = document.querySelector('[data-subpage-head]');
  const floats = document.querySelectorAll('.subpage-back-float');
  const minis = document.querySelectorAll('.subpage-mini-title');
  if (!head || (!floats.length && !minis.length)) return;
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
    /* 小标题：大标题完全消失（0.5）之后才开始出现，0.5→0.7 区间淡入 */
    const mp = canScroll ? Math.min(Math.max((y - headH * 0.5) / (headH * 0.2), 0), 1) : 0;
    minis.forEach(function (m) {
      const mm = /** @type {HTMLElement} */ (m);
      mm.style.opacity = String(mp);
      mm.style.transform = rm
        ? 'translateX(-50%)'
        : 'translateX(-50%) translateY(' + (6 * (1 - mp)).toFixed(1) + 'px)';
    });
    /* 悬浮返回键：保持原来的二值逻辑 */
    const show = canScroll && y > headH * 0.55;
    floats.forEach(function (f) {
      f.classList.toggle('show', !!show);
    });
    /* 滚动后小标题/返回键与顶栏合并为同一层模糊底 */
    document.body.classList.toggle('subpage-scrolled', !!show);
  }
  S.onScroll(onScroll);
  S.onResize(function () {
    onScroll(window.scrollY || 0);
  });
  onScroll(window.scrollY || 0);
}
