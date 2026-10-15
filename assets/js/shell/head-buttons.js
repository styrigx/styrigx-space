/**
 * @fileoverview 子页面标题区按钮状态（B1-7 统一标准）。
 * 状态只有两种，由滚动位置决定：
 * - data-state="solid"：y <= 1（大标题完全展开），← 和 ⋮ 为实体无背景样式，在大标题下方原位.
 * - data-state="float"：y > 1（上滑中/上滑后），← 和 ⋮ 为浮动圆钮，贴在顶栏正下方。
 * 不在各页面写判断，只改这一套。
 * data-menu="none" 的 ⋮ 不绑定菜单（只作样式，点了无反应）。
 * @param {import('../lib/scheduler.js').Scheduler} [S]
 */
import { getScheduler } from '../lib/scheduler.js';

/** @param {Element} el */
function isVisible(el) {
  try {
    return el.getClientRects().length > 0;
  } catch (e) {
    return false;
  }
}

export function initHeadButtons(S) {
  const sched = S || getScheduler();
  /* 设置页手机/DeX 各有一份标题（DeX 那份 noTimeline 无 data-subpage-head），
     只取当前可见的那一份；主页没有标题区，直接返回。 */
  const heads = document.querySelectorAll('[data-subpage-head]');
  let head = null;
  for (let i = 0; i < heads.length; i++) {
    if (isVisible(heads[i])) {
      head = /** @type {HTMLElement} */ (heads[i]);
      break;
    }
  }
  if (!head) return;
  const backBtn = /** @type {HTMLElement|null} */ (head.querySelector('.subpage-back'));
  const moreActions = /** @type {HTMLElement|null} */ (head.querySelector('.subpage-actions'));
  const moreBtn =
    /** @type {HTMLElement|null} */ (moreActions && moreActions.querySelector('#files-more, .subpage-more'));
  if (!backBtn && !moreBtn) return;

  /* D3：小标题是 position:fixed，必须相对视口；把它搬到 body 下，避免被
     .set-layout 的 contain:layout 收进包含块导致定位错误（aria-hidden、无监听，移动安全）。
     无 trap 的页面（我的文件）搬家前后视觉一致。 */
  try {
    const mini = head.parentElement && head.parentElement.querySelector(':scope > .subpage-mini-title');
    if (mini && mini.parentElement !== document.body) document.body.appendChild(mini);
  } catch (e) {}

  /* safe-area-inset-top 实测（与 files.js 原实现一致） */
  let safeTop = 0;
  try {
    const probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top,0px)';
    document.body.appendChild(probe);
    safeTop = parseFloat(getComputedStyle(probe).paddingTop) || 0;
    probe.remove();
  } catch (e) {}

  /* 吸住时三点距右边缘（与 files.js 原实现一致：内容区 1100px，横屏小宽例外 640） */
  function stuckRight() {
    const land =
      window.matchMedia && window.matchMedia('(orientation:landscape) and (max-width:979.5px)').matches;
    const w = land ? 640 : 1100;
    return Math.max(16, (window.innerWidth - w) / 2 + (land ? 0 : 16));
  }

  /** @param {number} [y] */
  function updateStick(y) {
    if (y === undefined) y = window.scrollY || 0;
    /* B1-7：状态只有 solid/float 两种，由滚动位置决定。
       y <= 1 → solid（大标题完全展开，容忍亚像素）；y > 1 → float（浮动圆钮）。 */
    const state = y <= 1 ? 'solid' : 'float';
    if (head.getAttribute('data-state') !== state) {
      head.setAttribute('data-state', state);
    }
    /* 浮动时三点距右边缘（与原实现一致：内容区 1100px，横屏小宽例外 640） */
    if (moreBtn && state === 'float') {
      moreBtn.style.right = stuckRight() + 'px';
    } else if (moreBtn) {
      moreBtn.style.right = '';
    }
  }
  sched.onScroll(updateStick);
  sched.onResize(function () {
    updateStick(window.scrollY || 0);
  });
  updateStick(window.scrollY || 0);
  /* 5.3 P2：bfcache 恢复时（pageshow persisted）重新计算按钮吸顶状态。 */
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) updateStick(window.scrollY || 0);
  });
}
