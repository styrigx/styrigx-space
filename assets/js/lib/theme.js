/**
 * @fileoverview 主题模式（浅色/深色/跟随系统）。
 * <head> 内联预应用脚本负责首屏无闪烁；这里负责运行时的切换与跟随。
 * 2.4.0-G：经 features.js 统一读写（key 不变，老用户设置不丢）。
 */
import { get as featGet, set as featSet } from './features.js';

/**
 * 按当前偏好应用主题。
 * @returns {boolean} 是否深色
 */
export function applyTheme() {
  const m = featGet('theme-mode');
  const dark =
    m === 'dark' ||
    ((!m || m === 'system') && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  return dark;
}

/**
 * 设置主题模式并广播（features.set 内派发 sgx-settings-changed；此处保留旧事件）。
 * @param {'light'|'dark'|'system'} mode
 */
export function setThemeMode(mode) {
  featSet('theme-mode', mode);
  applyTheme();
  window.dispatchEvent(new Event('sgx-theme-changed'));
}

/**
 * 跟随系统变化（仅当偏好为跟随系统时生效）。
 */
export function initThemeListener() {
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const cb = function () {
      const m = featGet('theme-mode');
      if (!m || m === 'system') applyTheme();
    };
    (mq.addEventListener || mq.addListener).call(mq, 'change', cb);
  } catch (e) {}
}
