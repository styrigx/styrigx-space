/**
 * @fileoverview 布局 resize 跟随（旧 sgx-base-b.js）。
 * 2026-10-19：Mobile 悬浮 Dock、DeX 底部 Dock 和应用抽屉已全部删除
 * （设置入口在主页顶栏 ⋮，浏览器入口是主页左侧搜索圆）。
 */
import { applyLayout } from './layout.js';

/**
 * @param {import('./scheduler.js').Scheduler} S
 */
export function initNav(S) {
  /* resize 时重算布局（防抖） */
  /** @type {number|null} */
  let rt = null;
  S.onResize(function () {
    if (rt) clearTimeout(rt);
    rt = window.setTimeout(function () {
      applyLayout();
    }, 180);
  });
}
