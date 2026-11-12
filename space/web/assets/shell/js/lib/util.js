/**
 * @fileoverview 基础工具：HTML 转义、语言判定、rAF 节流。
 * 无副作用，可被任意模块导入（会被 tree-shaking）。
 */

/**
 * HTML 转义（插入 innerHTML 前用）。
 * @param {any} s
 * @returns {string}
 */
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/**
 * 当前页面是否为英文版（<html lang="en">）。
 * @returns {boolean}
 */
export function isEn() {
  return document.documentElement.lang === 'en';
}

/**
 * 是否开启减弱动效（设置项或系统偏好）。
 * @returns {boolean}
 */
export function reducedMotion() {
  return (
    document.documentElement.classList.contains('reduced-motion') ||
    (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  );
}

