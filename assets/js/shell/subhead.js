/**
 * @fileoverview 子页面大标题滚动联动（顶栏统一规格 v1.0）。
 * - 小标题 .subpage-mini-title 搬进顶栏卡片（水平垂直绝对居中）。
 * - 卡片版 ←/⋮：点击时调用原按钮（.subpage-back / #files-more / #sec-more / .subpage-more）
 *   的 click()，功能、菜单位置、aria-label 与原按钮一致；原按钮跟着标题区正常滚走。
 * - 上滚：大标题随滚动上移最多 24px，同时透明度 1→0；标题区滚过约一半时完全消失。
 * - 大标题完全消失后，小标题才开始出现（透明度 0→1，带 6px 从下往上位移）。
 * - 品牌组与小标题交叉淡入淡出；卡片 ←/⋮ 只做透明度。
 * - 下拉反过来；只改 opacity 和 transform，不触发重排；减少动画时只做淡入淡出。
 * - 支持 scroll-driven animations 时由 CSS 接管（同一阈值），这里只做 JS 回退。
 * @param {import('./scheduler.js').Scheduler} S
 */
import { reducedMotion } from '../lib/util.js';
import { applyAppHero } from '../lib/vt.js';

/** @param {Element} el */
function isVisible(el) {
  try {
    return el.getClientRects().length > 0;
  } catch (e) {
    return false;
  }
}

export function initSubHead(S) {
  /* 2.4.0 D：从主页图标进来的 View Transitions 共享元素 */
  applyAppHero();

  const card = document.getElementById('sgx-topcard');
  const cardBack = document.getElementById('sgx-topcard-back');
  const cardMore = document.getElementById('sgx-topcard-more');

  /* 只取当前可见的那一份标题（设置页手机/DeX 各有一份时避免选中 display:none 的）；
     主页没有标题区，卡片保持默认态。 */
  const heads = document.querySelectorAll('[data-subpage-head]');
  let head = null;
  for (let i = 0; i < heads.length; i++) {
    if (isVisible(heads[i])) {
      head = heads[i];
      break;
    }
  }
  if (!head && heads.length) head = heads[0];

  if (head && card) {
    /* 小标题搬进卡片（aria-hidden、无监听，移动安全） */
    try {
      const mini = head.parentElement && head.parentElement.querySelector(':scope > .subpage-mini-title');
      if (mini && mini.parentElement !== card) card.appendChild(mini);
    } catch (e) {}
    /* 卡片版 ←/⋮：调用原按钮的 click()；aria-label 与原按钮一致 */
    const origBack = head.querySelector('.subpage-back');
    const moreWrap = head.querySelector('.subpage-actions');
    const origMore =
      moreWrap && moreWrap.querySelector('#files-more, #sec-more, .subpage-more');
    if (cardBack && origBack) {
      const al = origBack.getAttribute('aria-label');
      if (al) cardBack.setAttribute('aria-label', al);
      cardBack.addEventListener('click', function () {
        origBack.click();
      });
    }
    if (cardMore && origMore) {
      const al = origMore.getAttribute('aria-label');
      if (al) cardMore.setAttribute('aria-label', al);
      cardMore.addEventListener('click', function () {
        origMore.click();
      });
    }
  }

  /* 支持 view-timeline-name 时由 CSS 接管（阈值与下述 JS 公式一致） */
  try {
    if (window.CSS && CSS.supports && CSS.supports('view-timeline-name', '--sgx-subhead')) return;
  } catch (e) {}
  const minis = document.querySelectorAll('.subpage-mini-title');
  if (!head || !minis.length) return;
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
    /* 小标题（卡片内绝对居中）：大标题完全消失（0.5）之后才开始出现，0.5→0.7 区间淡入 */
    const mp = canScroll ? Math.min(Math.max((y - headH * 0.5) / (headH * 0.2), 0), 1) : 0;
    minis.forEach(function (m) {
      const mm = /** @type {HTMLElement} */ (m);
      mm.style.opacity = String(mp);
      mm.style.transform = rm
        ? 'translate(-50%,-50%)'
        : 'translate(-50%,-50%) translateY(' + (6 * (1 - mp)).toFixed(1) + 'px)';
    });
    /* 品牌组淡出 / 卡片 ←/⋮ 淡入：与 CSS 的 exit 55%→57% 同一阈值（y > headH*0.55） */
    const show = canScroll && y > headH * 0.55;
    document.body.classList.toggle('subpage-scrolled', !!show);
  }
  S.onScroll(onScroll);
  S.onResize(function () {
    onScroll(window.scrollY || 0);
  });
  onScroll(window.scrollY || 0);
  /* 5.3 P2：bfcache 恢复时（pageshow persisted）重新计算标题展开/折叠状态，
     否则大标题可能半透明叠在卡片下。 */
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) onScroll(window.scrollY || 0);
  });
}
