/**
 * @fileoverview B2-7 主站页面 → 数字健康区域键。
 */

/**
 * B2-7：当前页面属于哪个数字健康区域（主站：主页 / 我的文件 / 浏览器 / 设置）。
 * 验证页、404 等不计时（返回 null）。
 * @param {string} path location.pathname
 * @returns {string|null}
 */
export function wbAreaOf(path) {
  const p = path.replace(/^\/en(?=\/)/, '');
  if (p === '/' || p === '') return 'home';
  if (p.startsWith('/files/')) return 'files';
  if (p.startsWith('/browser/') || p.startsWith('/links/')) return 'browser';
  if (p.startsWith('/settings/')) return 'settings';
  return null;
}
