/**
 * 规则集文件：命中边缘缓存直接回；否则按来源给的顺序试上游，拿到就写缓存。
 * 哪些路径算规则集、上游是谁、缓存多久，都由 core/sources/ 里的来源决定；这里只管流程。
 */
import { cacheKey, cacheGet, cachePut } from '../lib/cache.js';
import { freshHeaders } from '../lib/response-headers.js';
import { text } from '../lib/http.js';
import { fetchFirst } from '../lib/upstream.js';

/**
 * @param {Request} request  只会是 GET / HEAD（router.js 已经挡了别的方法）
 * @param {{ waitUntil(p: Promise<unknown>): void }} ctx
 * @param {URL} url
 * @param {{ source: import('../core/sources.js').Source, upstreams: string[] }} match
 */
export async function rules(request, ctx, url, { source, upstreams }) {
  const { pathname } = url;
  const ttl = source.cacheTtl;
  const key = cacheKey(url);

  // HEAD 不读也不写缓存
  if (request.method === 'GET') {
    const hit = await cacheGet(key);
    if (hit) {
      return new Response(hit.body, { status: hit.status, headers: freshHeaders(hit.headers, pathname, ttl, source.staleWhileRevalidate, 'HIT', null) });
    }
  }

  const { response: upstream, status } = await fetchFirst(upstreams, { method: request.method, cacheTtl: ttl });
  if (!upstream) return text('Upstream Error', status === 404 ? 404 : 502);

  let upHost = null;
  try { upHost = new URL(upstream.url).host; } catch { /* 没有 url 就不写 */ }
  const res = new Response(upstream.body, { status: upstream.status, headers: freshHeaders(upstream.headers, pathname, ttl, source.staleWhileRevalidate, 'MISS', upHost) });

  if (request.method === 'GET') ctx.waitUntil(cachePut(key, res.clone()));
  return res;
}
