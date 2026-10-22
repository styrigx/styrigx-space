/**
 * styrigx-proxy-rules：MetaCubeX/meta-rules-dat 规则集加速反代（只干一件事）。
 *
 * 公开地址：https://proxy-rules.styrigx.com
 * 路径和上游仓库一致：/MetaCubeX/meta-rules-dat/meta/geo/<geosite|geoip>/<名字>.<mrs|yaml|list>
 *   例：/MetaCubeX/meta-rules-dat/meta/geo/geosite/cn.mrs
 * 上游：jsDelivr（主）→ raw.githubusercontent（备），依次尝试。
 * 严格白名单：只放行规则集文件，其他路径一律 404，防止被当成开放代理。
 * 边缘缓存 24 小时：meta-rules-dat 每天更新一次，规则集本身 interval 也是 24h。
 * 不验会话、不持任何钥匙、没有绑定。
 *
 * 来历：2026-10-22 从 Cloudflare 后台手写的 mihomo-mrs Worker（版本 a4b2fe55）搬进本仓库，
 * 逻辑不变，白名单从只认 .mrs 放宽到 .mrs / .yaml / .list。
 */

export const REPO = 'MetaCubeX/meta-rules-dat';
export const BRANCH = 'meta';
export const CACHE_TTL = 86400;
const PREFIX = `/${REPO}/${BRANCH}/`;

// 文件名形如 cn.mrs / geolocation-!cn.mrs / category-ai-!cn.yaml
export const ALLOW = /^\/MetaCubeX\/meta-rules-dat\/meta\/geo\/(geosite|geoip)\/[A-Za-z0-9][\w.!@~-]*\.(mrs|yaml|list)$/;

const TYPES = {
  mrs: 'application/octet-stream',
  yaml: 'text/yaml; charset=utf-8',
  list: 'text/plain; charset=utf-8',
};

export function contentType(pathname) {
  return TYPES[pathname.slice(pathname.lastIndexOf('.') + 1)] || 'application/octet-stream';
}

export function upstreamUrls(pathname) {
  const rest = pathname.slice(PREFIX.length);
  return [
    `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/${rest}`,
    `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${rest}`,
  ];
}

const text = (body, status = 200, extra = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra } });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 健康检查
    if (url.pathname === '/' || url.pathname === '/healthz') return text('styrigx-proxy-rules ok\n');

    if (request.method !== 'GET' && request.method !== 'HEAD') return text('Method Not Allowed', 405, { allow: 'GET, HEAD' });
    if (!ALLOW.test(url.pathname)) return text('Not Found', 404);

    // 缓存键去掉 query，避免缓存键污染
    const cache = caches.default;
    const cacheKey = new Request(url.origin + url.pathname, { method: 'GET' });

    if (request.method === 'GET') {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const res = new Response(hit.body, hit);
        res.headers.set('X-Proxy-Rules-Cache', 'HIT');
        return res;
      }
    }

    // 主备上游依次尝试
    let upstream = null;
    let lastStatus = 502;
    for (const u of upstreamUrls(url.pathname)) {
      try {
        const r = await fetch(
          new Request(u, {
            method: request.method,
            headers: { 'User-Agent': 'styrigx-proxy-rules/1.0', Accept: '*/*' },
            redirect: 'follow',
          }),
          { cf: { cacheTtl: CACHE_TTL, cacheEverything: true } },
        );
        if (r.ok) { upstream = r; break; }
        lastStatus = r.status;
      } catch {
        lastStatus = 502;
      }
    }

    if (!upstream) return text('Upstream Error', lastStatus === 404 ? 404 : 502);

    const res = new Response(upstream.body, upstream);
    res.headers.set('Content-Type', contentType(url.pathname));
    res.headers.set('Cache-Control', `public, max-age=${CACHE_TTL}, stale-while-revalidate=604800`);
    res.headers.set('Access-Control-Allow-Origin', '*');
    res.headers.delete('Set-Cookie');
    res.headers.set('X-Proxy-Rules-Cache', 'MISS');
    try { res.headers.set('X-Proxy-Rules-Upstream', new URL(upstream.url).host); } catch { /* 没有 url 就不写 */ }

    if (request.method === 'GET') ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  },
};
