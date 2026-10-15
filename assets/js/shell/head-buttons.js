/**
 * @fileoverview 子页面标题区按钮吸顶（D5 公共模块，从 apps/files.js 逐行抽出）。
 * 管理展开态「左返回（.subpage-back）＋右三点（.subpage-actions 内的按钮）」：
 * 平时都在标题区底部（bottom: var(--sgx-head-btn-gap)），随内容上滚；
 * 滚到「顶栏底边 + 8px」时左右两个按钮同一帧加 .stuck，吸住成 44px 磨砂圆；
 * 滚回顶部时同时去掉 .stuck，回到标题区底部。
 * 判定公式与 files.js 原实现完全一致：
 *   stuckTop = navH + 8 + safeTop；stick = y > 0 && y >= 按钮文档top − stuckTop，
 * 因此我的文件的三点吸住时机、位置、尺寸逐帧不变。
 * 返回键吸住后图标由 CSS 切到 ‹（.subpage-back.stuck .sgx-bk-fold），与我的文件折叠态一致。
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
    /* 锚点取标题区本身：按钮文档 top = header 文档底边 − gap − 按钮高（D4 统一：gap 8px，按钮 44px）。
       不直接取 .subpage-actions 的 rect——按钮 fixed 后它会塌陷到高度 0，导致阈值来回跳变、
       按钮在阈值附近闪烁；header 高度稳定，推导出的阈值恒定。 */
    const hr = head.getBoundingClientRect();
    const headDocTop = hr.top + y;
    const gap =
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sgx-head-btn-gap')) || 8;
    const btnH = (backBtn && backBtn.offsetHeight) || (moreBtn && moreBtn.offsetHeight) || 44;
    const docTop = headDocTop + hr.height - gap - btnH;
    const navH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--nav-h')) || 64;
    const stuckTop = navH + 8 + safeTop;
    const stick = y > 0 && y >= docTop - stuckTop;
    if (backBtn) backBtn.classList.toggle('stuck', stick);
    if (moreBtn) {
      moreBtn.classList.toggle('stuck', stick);
      moreBtn.style.right = stick ? stuckRight() + 'px' : '';
    }
  }
  sched.onScroll(updateStick);
  sched.onResize(function () {
    updateStick(window.scrollY || 0);
  });
  updateStick(window.scrollY || 0);
}
