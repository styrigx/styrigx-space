/**
 * @fileoverview 布局（auto/mobile/dex）：<head> 内联脚本定义了 __applyLayout（按设置切 layout-* class）。
 */

/**
 * 触发一次布局重算（<head> 内联定义的 __applyLayout）。
 */
export function applyLayout() {
  const w = /** @type {any} */ (window);
  if (typeof w.__applyLayout === 'function') w.__applyLayout();
}
