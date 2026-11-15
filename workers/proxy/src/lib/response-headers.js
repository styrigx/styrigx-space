/**
 * 规则文件的响应头全部重建：上游只取 ETag / Last-Modified，其余自己定。
 * 上游（jsDelivr / GitHub）的 CSP、HSTS、Set-Cookie、x-github-*、x-jsd-* 等一律不透传（workers #33）。
 */
import { contentType } from './content-type.js';

/** 从上游响应里只留下这几个（小写） */
export const PASS_HEADERS = ['etag', 'last-modified'];

/**
 * 缓存命中时也走这里：部署前写进 Cache API 的旧条目还带着上游原样的头，读出来照样洗一遍。
 * @param {Headers} upstream
 * @param {string} pathname
 * @param {number} maxAge                Cache-Control max-age（秒），按来源定
 * @param {number} staleWhileRevalidate  Cache-Control stale-while-revalidate（秒），按来源定
 * @param {'HIT'|'MISS'} cacheState
 * @param {string|null} upstreamHost
 */
export function freshHeaders(upstream, pathname, maxAge, staleWhileRevalidate, cacheState, upstreamHost) {
  const h = new Headers();
  for (const k of PASS_HEADERS) {
    const v = upstream.get(k);
    if (v) h.set(k, v);
  }
  h.set('Content-Type', contentType(pathname));
  h.set('Cache-Control', `public, max-age=${maxAge}, stale-while-revalidate=${staleWhileRevalidate}`);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Proxy-Rules-Cache', cacheState);
  const up = upstreamHost || upstream.get('X-Proxy-Rules-Upstream');
  if (up) h.set('X-Proxy-Rules-Upstream', up);
  return h;
}
