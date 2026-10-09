/**
 * @fileoverview 桌面布局（auto/phone/dex）变更钩子。
 * <head> 内联脚本定义了 __applyLayout / __setHeadH，布局变化时调用 window.__dexLayoutChanged；
 * 这里提供注册表，各模块订阅，替代旧代码里层层覆盖 window.__dexLayoutChanged 的写法。
 */

/** @type {Array<(m: string) => void>} */
const hooks = [];

/**
 * 订阅布局变更（m 为 'phone' | 'dex'）。
 * @param {(m: string) => void} fn
 */
export function onDexLayoutChange(fn) {
  hooks.push(fn);
}

/**
 * 把 window.__dexLayoutChanged 接到注册表（保留旧的直接赋值，做链式兼容）。
 */
export function initDexBridge() {
  const w = /** @type {any} */ (window);
  const prev = w.__dexLayoutChanged;
  w.__dexLayoutChanged = function (/** @type {string} */ m) {
    if (typeof prev === 'function') {
      try {
        prev(m);
      } catch (e) {}
    }
    hooks.forEach(function (fn) {
      try {
        fn(m);
      } catch (e) {}
    });
  };
}

/**
 * 触发一次布局重算（<head> 内联定义的 __applyLayout）。
 */
export function applyLayout() {
  const w = /** @type {any} */ (window);
  if (typeof w.__applyLayout === 'function') w.__applyLayout();
}
