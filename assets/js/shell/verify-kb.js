/**
 * @fileoverview 底部验证弹层键盘避让。
 * 输入框聚焦键盘弹出时，把弹层卡片上移键盘高度；键盘收起或弹层关闭时复位并清理。
 * 基于 shell/vk.js 的 onKeyboardHeight（VirtualKeyboard API 或 visualViewport 回退）。
 * 只动 transform，不碰鉴权逻辑。
 */
import { onKeyboardHeight } from './vk.js';

/**
 * 为底部弹层启用键盘避让。
 * @param {HTMLDialogElement} dlg 弹层（需含 .sgx-verify-card）
 * @returns {() => void} 清理函数（弹层关闭时调用，复位 transform 并移除监听）
 */
export function armVerifyKeyboard(dlg) {
  if (!dlg) return function () {};
  const card = dlg.querySelector('.sgx-verify-card');
  if (!card) return function () {};

  /** @param {number} h 键盘高度（px） */
  const applyShift = function (h) {
    try {
      card.style.transform = h > 0 ? 'translateY(' + -h + 'px)' : '';
    } catch (e) {}
  };
  /* 测试缝隙：e2e 用它模拟键盘高度，断言弹层底边不超出 visualViewport。
     生产代码不调用它，只在测试里用。 */
  try {
    dlg.__sgxKbShift = applyShift;
  } catch (e) {}

  let cleanup = null;
  try {
    cleanup = onKeyboardHeight(applyShift, card);
  } catch (e) {}

  return function () {
    try {
      if (cleanup) cleanup();
    } catch (e) {}
    try {
      card.style.transform = '';
      delete dlg.__sgxKbShift;
    } catch (e) {}
  };
}
