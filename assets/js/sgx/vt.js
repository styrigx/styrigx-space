/**
 * @fileoverview 2.4.0 D：View Transitions 共享元素。
 * 主页 App 图标 → 子页面大标题：点击图标时给图标写 view-transition-name，
 * 并在 sessionStorage 留标记；目标页 subpage-head 读到标记后给标题区写同名，
 * 形成 One UI 打开应用式的图标放大过渡。不支持的浏览器自动退化（无过渡）。
 */
import { reducedMotion } from './util.js';

const FLAG = 'sgx-vt-app';

/**
 * 主页调用：用户点 App 图标时标记共享元素。
 * @param {HTMLElement} iconEl 图标元素
 */
export function markAppIcon(iconEl) {
  if (reducedMotion()) return;
  try {
    // @ts-ignore
    if (!document.startViewTransition) return;
    iconEl.style.viewTransitionName = 'sgx-app-icon';
    sessionStorage.setItem(FLAG, '1');
    /* 导航发生后清理行内样式（bfcache 返回时也不残留） */
    window.setTimeout(function () {
      iconEl.style.viewTransitionName = '';
    }, 800);
  } catch (e) {}
}

/**
 * 子页面调用：若带标记，给标题区写同名 view-transition-name。
 */
export function applyAppHero() {
  let flagged = false;
  try {
    flagged = sessionStorage.getItem(FLAG) === '1';
    sessionStorage.removeItem(FLAG);
  } catch (e) {}
  if (!flagged || reducedMotion()) return;
  try {
    // @ts-ignore
    if (!document.startViewTransition) return;
    const hero = document.querySelector('.subpage-hero');
    if (hero) {
      /** @type {HTMLElement} */ (hero).style.viewTransitionName = 'sgx-app-icon';
    }
  } catch (e) {}
}
