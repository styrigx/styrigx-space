/**
 * @fileoverview window.SGX 命名空间：必须跨脚本/模板共享的最小 API 集中于此。
 * 各模块优先使用 ES import；只有模板内联脚本或跨页面 bundle 的桥接才走这里。
 */

/**
 * @typedef {Object} SgxBridge
 */

/** @type {any} */
const w = window;
/** @type {SgxBridge} */
export const SGX = (w.SGX = w.SGX || {});
