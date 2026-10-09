/**
 * @fileoverview 应用商店功能开关：sgx-apps-hidden（旧 sgx-base-a.js 末尾）。
 * 未安装的应用不在首页网格、抽屉、浏览器搜索出现；商店里仍列出；直接访问 URL 可用。
 * 切换后触发 sgx-settings-changed，各处即时生效不刷新。
 */
import { on } from './events.js';
import { getJSON, setJSON } from './storage.js';

/**
 * @returns {string[]} 已隐藏的应用 id 列表
 */
export function getHiddenApps() {
  const v = getJSON('sgx-apps-hidden', []);
  return Array.isArray(v) ? v : [];
}

/**
 * @param {string} id
 * @param {boolean} hidden
 */
export function setAppHidden(id, hidden) {
  const h = getHiddenApps();
  const i = h.indexOf(id);
  if (hidden && i === -1) h.push(id);
  if (!hidden && i !== -1) h.splice(i, 1);
  setJSON('sgx-apps-hidden', h);
  window.dispatchEvent(new Event('sgx-settings-changed'));
}

/**
 * 应用抽屉 + 首页网格按 hidden 过滤。
 */
export function applyAppVisibility() {
  const h = getHiddenApps();
  document.querySelectorAll('[data-appid]').forEach(function (el) {
    const id = el.getAttribute('data-appid');
    /** @type {HTMLElement} */ (el).style.display = h.indexOf(id || '') !== -1 ? 'none' : '';
  });
}

/**
 * 初始化：监听设置变更即时生效；首屏应用一次。
 */
export function initAppVisibility() {
  on(window, 'sgx-settings-changed', applyAppVisibility);
  applyAppVisibility();
}
