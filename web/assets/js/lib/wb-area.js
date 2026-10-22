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
  /* 区域键沿用 'browser'：2026-10-20 浏览器页拆成 书签 + 全网搜索 /search/；2026-10-21 主站书签下线（迁到 珍格 Curio），只剩搜索 */
  if (p.startsWith('/search/') || p.startsWith('/browser/') || p.startsWith('/links/')) return 'browser';
  /* 账号页 2026-10-22 从 /settings/account/ 挪到 /account/：时长照旧记在「设置」区域 */
  if (p.startsWith('/settings/') || p.startsWith('/account/')) return 'settings';
  return null;
}
