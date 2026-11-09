/**
 * @fileoverview B2-7 主站页面 → 数字健康区域键。
 */
import { stripLang } from './lang-path.js';

/**
 * 旷野子页（P4-3 PR-4b：原设置子页去掉 settings 一层，直接挂在根下；P4-3 PR-4c 起英文无前缀、中文 /zh/ 前缀）。
 * 新增 data/space-cats.yaml 分类时这里同步加一项（tests/space/ui/build/space-merge.test.mjs 对照检查）。
 */
export const SPACE_SUB_RE = /^(?:\/zh)?\/(?:wild)\//;

/**
 * B2-7：当前页面属于哪个数字健康区域（主站：旷野 / 我的文件 / 浏览器）。
 * P4-3 PR-4b：主页和设置合成旷野页，区域键 home / settings 合并为 space（只写新键；旧键的历史数据读的时候并进 space：
 * Worker 汇总 sectionOf、lib/wb-view.js foldSections、apps/space.js 本机记录）。
 * 验证页、404 等不计时（返回 null）。
 * @param {string} path location.pathname
 * @returns {string|null}
 */
export function wbAreaOf(path) {
  const p = stripLang(path);
  if (p === '/' || p === '') return 'space';
  if (p.startsWith('/files/')) return 'files';
  /* 区域键沿用 'browser'：2026-10-20 浏览器页拆成 书签 + 全网搜索 /search/；2026-10-21 主站书签下线（迁到 奇趣 Curio），只剩搜索 */
  if (p.startsWith('/search/') || p.startsWith('/browser/') || p.startsWith('/links/')) return 'browser';
  /* 旷野子页（PR-4b 前在 settings 一层下）和账号页（2026-10-22 从设置下挪到 /account/）：时长记在旷野区域 */
  if (SPACE_SUB_RE.test(p) || p.startsWith('/account/')) return 'space';
  return null;
}
