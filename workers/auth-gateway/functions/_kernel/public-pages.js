/**
 * 公开页面路径（2.8.0 搜索收录整理）
 *
 * 未登录也能返回 200 的页面。sitemap 只收录这些。
 * 与 data/public-pages.yaml 保持同步（tests/kernel/sitemap.test.mjs 验证）。
 * L3 共享库：不含鉴权逻辑，只定义路径常量。
 */
export const PUBLIC_PAGE_PATHS = ['/', '/en/'];

/**
 * 判断路径是否为公开页（忽略末尾斜杠差异）。
 * @param {string} pathname
 * @returns {boolean}
 */
export function isPublicPage(pathname) {
  const p = pathname === '/en' ? '/en/' : pathname;
  return PUBLIC_PAGE_PATHS.includes(p);
}
