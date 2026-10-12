/**
 * @fileoverview 弹层跟随键盘上移。
 * 用 vk.js onKeyboardHeight，输入框聚焦时把底部弹层上移键盘高度，关闭时清理。
 * 覆盖所有带输入的弹层。
 */
import { onKeyboardHeight } from './vk.js';

/**
 * 让 dialog 跟随键盘上移。
 * @param {HTMLDialogElement} dlg
 * @returns {() => void} 清理函数
 */
export function followKeyboard(dlg) {
  if (!dlg) return function () {};
  const card = dlg.querySelector('.sgx-verify-card') || dlg;
  const cleanup = onKeyboardHeight(function (h) {
    try {
      if (h > 0) {
        card.style.transform = 'translateY(' + (-h) + 'px)';
      } else {
        card.style.transform = '';
      }
    } catch (e) {}
  });
  return function () {
    try {
      cleanup();
      card.style.transform = '';
    } catch (e) {}
  };
}
