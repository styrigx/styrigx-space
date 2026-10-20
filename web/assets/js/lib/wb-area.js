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
  /* 区域键沿用 'browser'：2026-10-20 浏览器页拆成 书签 /bookmarks/ + 全网搜索 /search/（旧 /browser/ 跳转过来） */
  if (p.startsWith('/bookmarks/') || p.startsWith('/search/') || p.startsWith('/browser/') || p.startsWith('/links/')) return 'browser';
  if (p.startsWith('/settings/')) return 'settings';
  return null;
}
