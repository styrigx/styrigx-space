/**
 * 来源：自己的规则仓 styrigx/mihomo-rules 的 dist 分支（机器人每天生成，单个孤儿提交强推）。
 *
 * 路径和 GitHub raw 布局一致，也就是 mihomo-rules README 里写的地址：
 *   /styrigx/mihomo-rules/dist/<geosite|geoip>/<名字>.<mrs|yaml>
 *   例：/styrigx/mihomo-rules/dist/geosite/samsung.mrs
 * 严格白名单：只认 geosite、geoip 两个目录；名字只许 [a-z0-9-]（首尾不能是 -），后缀只许 .mrs / .yaml。
 *   manifest.json、.list、子目录、大写、`..` 都不放行。
 * 上游：raw.githubusercontent（主，dist 一推就能拿到）→ jsDelivr（备；它的分支缓存会滞后，所以不当主上游）。
 * 边缘缓存 1 小时：dist 每天重建，1 小时内就能拿到新版本。
 */

export const REPO = 'styrigx/mihomo-rules';
export const BRANCH = 'dist';
export const CACHE_TTL = 3600;
export const STALE_WHILE_REVALIDATE = 86400;
const PREFIX = `/${REPO}/${BRANCH}/`;

export const ALLOW = /^\/styrigx\/mihomo-rules\/dist\/(geosite|geoip)\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.(mrs|yaml)$/;

/** @param {string} pathname */
export function upstreamUrls(pathname) {
  const rest = pathname.slice(PREFIX.length);
  return [
    `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${rest}`,
    `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/${rest}`,
  ];
}

/** @type {import('../sources.js').Source} */
export const ownRepo = {
  id: 'own-repo',
  allow: ALLOW,
  upstreams: upstreamUrls,
  cacheTtl: CACHE_TTL,
  staleWhileRevalidate: STALE_WHILE_REVALIDATE,
};
