/**
 * 来源：MetaCubeX/meta-rules-dat 的 meta 分支（本 Worker 最早的唯一来源，2026-10-22 从后台手写的 mihomo-mrs 搬来）。
 *
 * 路径和上游仓库一致：/MetaCubeX/meta-rules-dat/meta/geo/<geosite|geoip>/<名字>.<mrs|yaml|list>
 *   例：/MetaCubeX/meta-rules-dat/meta/geo/geosite/cn.mrs
 * 上游：jsDelivr（主）→ raw.githubusercontent（备）。
 * 边缘缓存 24 小时：meta-rules-dat 每天更新一次，规则集本身 interval 也是 24h。
 *
 * 现有客户端配置都指向这些路径：白名单、上游顺序、缓存时长 MUST 保持不变。
 */

export const REPO = 'MetaCubeX/meta-rules-dat';
export const BRANCH = 'meta';
export const CACHE_TTL = 86400;
export const STALE_WHILE_REVALIDATE = 604800;
const PREFIX = `/${REPO}/${BRANCH}/`;

// 文件名形如 cn.mrs / geolocation-!cn.mrs / category-ai-!cn.yaml
export const ALLOW = /^\/MetaCubeX\/meta-rules-dat\/meta\/geo\/(geosite|geoip)\/[A-Za-z0-9][\w.!@~-]*\.(mrs|yaml|list)$/;

/** @param {string} pathname */
export function upstreamUrls(pathname) {
  const rest = pathname.slice(PREFIX.length);
  return [
    `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/${rest}`,
    `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${rest}`,
  ];
}

/** @type {import('../sources.js').Source} */
export const metacubex = {
  id: 'metacubex',
  allow: ALLOW,
  upstreams: upstreamUrls,
  cacheTtl: CACHE_TTL,
  staleWhileRevalidate: STALE_WHILE_REVALIDATE,
};
