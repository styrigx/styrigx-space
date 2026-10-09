/**
 * @fileoverview 2.4.0 D：VirtualKeyboard 统一封装（合并 capsule.js / page-browser.js 重复实现）。
 * - 有 VirtualKeyboard API（Chrome）：overlaysContent=true，键盘悬浮不顶页面；
 *   geometrychange → 回调键盘高度 h（px）。
 * - 无 API：visualViewport resize/scroll → rAF 节流 → 回调估算高度。
 * 返回 disposer 数组的清理函数。
 */

/**
 * 订阅键盘高度变化。
 * @param {(h: number) => void} cb 键盘高度（px）变化回调
 * @param {HTMLElement} [syncEl] 无 VK API 时需要加 .sgx-kb-sync 类做 transform 跟随的元素
 * @returns {() => void} 清理函数
 */
export function onKeyboardHeight(cb, syncEl) {
  /** @type {Array<() => void>} */ const disposers = [];
  let useVK = false;
  try {
    const vk = /** @type {any} */ (navigator).virtualKeyboard;
    if (vk && 'overlaysContent' in vk) {
      vk.overlaysContent = true;
      useVK = true;
    }
  } catch (e) {}
  if (useVK) {
    document.documentElement.classList.add('sgx-vk');
    /** @param {any} e */
    const onGeo = function (e) {
      let h = 0;
      try {
        h = (e.target && e.target.boundingRect && e.target.boundingRect.height) || 0;
      } catch (_) {}
      cb(Math.max(0, h));
    };
    try {
      /** @type {any} */ (navigator).virtualKeyboard.addEventListener('geometrychange', onGeo);
    } catch (e) {}
    disposers.push(function () {
      try {
        /** @type {any} */ (navigator).virtualKeyboard.removeEventListener('geometrychange', onGeo);
      } catch (e) {}
    });
    cb(0);
  } else {
    const vv = window.visualViewport;
    if (!vv) return function () {};
    if (syncEl) syncEl.classList.add('sgx-kb-sync');
    let raf = 0;
    const upd = function () {
      raf = 0;
      const h = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      cb(h);
    };
    const sched = function () {
      if (!raf) raf = requestAnimationFrame(upd);
    };
    vv.addEventListener('resize', sched);
    vv.addEventListener('scroll', sched);
    disposers.push(function () {
      vv.removeEventListener('resize', sched);
      vv.removeEventListener('scroll', sched);
      if (raf) cancelAnimationFrame(raf);
      if (syncEl) syncEl.classList.remove('sgx-kb-sync');
    });
    sched();
  }
  return function () {
    disposers.forEach(function (d) {
      try {
        d();
      } catch (e) {}
    });
  };
}
