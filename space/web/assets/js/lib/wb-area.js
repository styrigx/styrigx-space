/**
 * @fileoverview B2-7 主站页面 → 数字健康区域键。
 */

/**
 * 旷野子页（P4-3 PR-4b：原设置子页去掉 settings 一层，直接挂在根下；英文 /en/ 前缀）。
 * 新增 data/space-cats.yaml 分类时这里同步加一项（tests/space/ui/space/space-cats.test.mjs 对照检查）。
 */
export const SPACE_SUB_RE = /^(?:\/en)?\/(?:display|theme|wellbeing|about|status|security)\//;

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
  /* 区域键沿用 'browser'：2026-10-20 浏览器页拆成 书签 + 全网搜索 /search/；2026-10-21 主站书签下线（迁到 奇趣 Curio），只剩搜索 */
  if (p.startsWith('/search/') || p.startsWith('/browser/') || p.startsWith('/links/')) return 'browser';
  /* 旷野子页（PR-4b 前在 settings 一层下）和账号页（2026-10-22 从设置下挪到 /account/）：时长记在「设置」区域 */
  if (SPACE_SUB_RE.test(p) || p.startsWith('/account/')) return 'settings';
  return null;
}
