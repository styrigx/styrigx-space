/**
 * 边缘默认缓存 caches.default。条目的有效期由写进去的响应头 Cache-Control max-age 决定（按来源）。
 */

/** 缓存键去掉 query，避免缓存键污染 */
export function cacheKey(url) {
  return new Request(url.origin + url.pathname, { method: 'GET' });
}

/** @param {Request} key */
export function cacheGet(key) {
  return caches.default.match(key);
}

/** @param {Request} key @param {Response} res */
export function cachePut(key, res) {
  return caches.default.put(key, res);
}
