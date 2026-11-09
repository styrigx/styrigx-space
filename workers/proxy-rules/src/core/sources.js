/**
 * 规则集来源登记表：一个来源一个文件（core/sources/*.js），这里按顺序问一遍谁认这个路径。
 *
 * 每个来源导出同一个形状（Source）：
 *   id                    诊断用名字
 *   allow                 严格白名单正则（整条 pathname），不认就不转发——防止被当成开放代理
 *   upstreams(pathname)   上游完整 URL，按顺序尝试（第一个是主上游）
 *   cacheTtl              边缘缓存秒数（Cache-Control max-age、fetch 的 cf.cacheTtl）
 *   staleWhileRevalidate  Cache-Control 的 stale-while-revalidate 秒数
 *
 * 各来源的路径前缀互不重叠（/<仓库>/<分支>/…），所以顺序不影响结果。
 */
import { metacubex } from './sources/metacubex.js';
import { ownRepo } from './sources/own-repo.js';

/**
 * @typedef {object} Source
 * @property {string} id
 * @property {RegExp} allow
 * @property {(pathname: string) => string[]} upstreams
 * @property {number} cacheTtl
 * @property {number} staleWhileRevalidate
 */

/** @type {Source[]} */
export const SOURCES = [metacubex, ownRepo];

/**
 * @param {string} pathname  已经由 URL 解析过（`..`、`%2e%2e` 段已折叠）
 * @returns {{ source: Source, upstreams: string[] } | null}
 */
export function matchSource(pathname) {
  for (const source of SOURCES) {
    if (source.allow.test(pathname)) return { source, upstreams: source.upstreams(pathname) };
  }
  return null;
}
