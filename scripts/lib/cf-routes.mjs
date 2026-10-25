/**
 * @fileoverview Cloudflare Workers 路由匹配（照线上实测的行为写，不照想当然）。
 *
 * 2026-10-21 线上实测（curl，无凭证）：
 *   styrigx.com/            → 走网关（x-sgx-runtime: worker）
 *   styrigx.com/?x=1        → 不走网关，Pages 直出（public, max-age=300，没有 data-sgx-lock-session）
 *   styrigx.com/en/?lock=1  → 走网关（styrigx.com/en/* 是前缀规则）
 *   blog.styrigx.com/about?a → 走网关（blog.styrigx.com/about* 前缀规则连查询串一起比）
 * 所以：
 *   - 不带 * 的规则是「整条 URL（host + path + 查询串）完全相等」才命中，带查询串就不命中；
 *   - 结尾 * 的规则是对 host + path + 查询串做前缀匹配；
 *   - 多条命中时取最具体（最长）的一条。
 * 以前 scripts/check-worker-routes.mjs 写的是「不看查询串」，和线上不符，
 * 导致 styrigx.com/?lock=1&return=…（锁屏入口本身）、blog/daymark 首页带任意查询串都不过网关。
 */

/** @param {string} toml wrangler.toml 全文 */
export function readRoutes(toml) {
  return [...toml.matchAll(/^pattern = "([^"]+)"$/gm)].map((m) => m[1]);
}

/**
 * @param {string} pattern 例如 'styrigx.com/' 或 'styrigx.com/en/*'
 * @param {string} host
 * @param {string} pathAndQuery 例如 '/?lock=1'
 */
export function routeMatches(pattern, host, pathAndQuery) {
  const target = host + pathAndQuery;
  if (pattern.endsWith('*')) return target.startsWith(pattern.slice(0, -1));
  return target === pattern;
}

/**
 * 命中的规则（最具体的一条）；都不命中返回 null（请求直达 Pages）。
 * @param {string[]} routes
 * @param {string} host
 * @param {string} pathAndQuery
 */
export function pickRoute(routes, host, pathAndQuery) {
  let best = null;
  for (const r of routes) {
    if (!routeMatches(r, host, pathAndQuery)) continue;
    if (!best || r.length > best.length) best = r;
  }
  return best;
}
