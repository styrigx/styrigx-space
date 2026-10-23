/**
 * @fileoverview styrigx-search-index 入口。只接网关服务绑定转来的 GET /search（没有公开地址，见 wrangler.toml）。
 *
 * 请求：GET https://search/search?q=…&lang=zh|en&site=&limit=
 *   头 X-Sgx-Role: owner | visitor（网关验完会话写的；没有 / 别的值一律当访客）
 * 回答：{ ok: true, q, hits: [{ site, type, title, subtitle, url }] }
 *   私密条目（private）只在 owner 时出现；正文 text 永远不回。
 */
import { search } from './rank.js';

const SITES = ['space', 'blog', 'daymark', 'curio'];
const CACHE_MS = 60 * 1000;

/** @type {{at: number, data: any[]}|null} */
let cache = null;

/** @param {any} env */
async function loadIndexes(env) {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const kv = env && env.KV_SEARCH_INDEX;
  if (!kv) throw new Error('no-kv');
  const data = (await Promise.all(SITES.map((s) => kv.get('site:' + s, 'json').catch(() => null))))
    // 先按下标配上站名再过滤：缺了某站的 key 时，后面的站不会被错标成别的站
    .map((ix, i) => (ix ? { site: SITES[i], items: ix.items || [] } : null))
    .filter(Boolean);
  cache = { at: Date.now(), data };
  return data;
}

/** @param {number} status @param {any} body */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' },
  });
}

export default {
  /** @param {Request} request @param {any} env */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/search') return json(404, { ok: false, error: 'not-found' });
    if (request.method !== 'GET') return json(405, { ok: false, error: 'method' });
    const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
    if (!q) return json(200, { ok: true, q: '', hits: [] });
    const lang = url.searchParams.get('lang');
    const site = url.searchParams.get('site') || '';
    const limit = parseInt(url.searchParams.get('limit') || '20', 10) || 20;
    const owner = request.headers.get('X-Sgx-Role') === 'owner';
    let indexes;
    try {
      indexes = await loadIndexes(env);
    } catch (e) {
      console.error('[search] index load failed', e && e.message);
      return json(503, { ok: false, error: 'index' });
    }
    const hits = search(indexes, {
      q,
      lang: lang === 'en' || lang === 'zh' ? lang : undefined,
      site: SITES.indexOf(site) !== -1 ? site : undefined,
      owner,
      limit,
    }).map((h) => ({ site: h.site, type: h.type, title: h.title, subtitle: h.subtitle, url: h.url }));
    return json(200, { ok: true, q, hits });
  },
};

/** 单测用：清缓存 */
export function _resetCache() { cache = null; }
