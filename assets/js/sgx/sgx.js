/**
 * @fileoverview window.SGX 命名空间：必须跨脚本/模板共享的最小 API 集中于此。
 * 各模块优先使用 ES import；只有模板内联脚本或跨页面 bundle 的桥接才走这里。
 */

/**
 * @typedef {Object} SgxBridge
 * @property {(page: string, q: string) => string} [capSearch] 胶囊搜索回调（store 页设置）
 * @property {() => void} [npPause] 暂停首页试听（首页 bundle 设置，书架页读取）
 */

/** @type {any} */
const w = window;
/** @type {SgxBridge} */
export const SGX = (w.SGX = w.SGX || {});
