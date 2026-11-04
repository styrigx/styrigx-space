/**
 * @fileoverview 站内召回（内部函数，不对外：没有 /search 端点，定案第 2 条）。两档过滤在这里（方案 5.4、风险 R-8）：
 * - 没有账号会话（网关没写 X-Styrigx-Account-Session: 1）→ 只召回公开条目；
 * - 有账号会话 → 公开 + 私密。
 * 过滤在召回阶段做，不靠提示词：私密条目进不了 hits，也进不了给模型的上下文。
 *
 * 索引：KV KV_SEARCH_INDEX，每个站一条 site:<站名>，值 { site, generated, items: Item[] }（格式见 core/rank.js 文件头）。
 * 读索引带 60 秒 isolate 内缓存（同 search-index），不多吃 KV 读额度。
 */
import { search } from './rank.js';

export const SITES = Object.freeze(['space', 'blog', 'daymark', 'curio']);
const CACHE_MS = 60 * 1000;
/** 每条上下文正文最多多少字（方案 5.2） */
export const CONTEXT_CHARS = 600;

/** @type {{at: number, data: Array<{site: string, items: any[]}>}|null} */
let cache = null;

/**
 * 读四个站的索引（缺哪个站就少哪个站；一个都没有不算错，由调用方决定）。没绑 KV / KV 整个读不了 → 抛错。
 * @param {any} env
 * @returns {Promise<Array<{site: string, items: any[]}>>}
 */
export async function loadIndexes(env) {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const kv = env && env.KV_SEARCH_INDEX;
  if (!kv || typeof kv.get !== 'function') throw new Error('no-kv');
  const data = (await Promise.all(SITES.map((s) => kv.get('site:' + s, 'json').catch(() => null))))
    /* 先按下标配上站名再过滤：缺了某站时后面的站不会被错标 */
    .map((ix, i) => (ix && Array.isArray(ix.items) ? { site: SITES[i], items: ix.items } : null))
    .filter(Boolean);
  cache = { at: Date.now(), data: /** @type {any} */ (data) };
  return /** @type {any} */ (data);
}

/** 单测用：清缓存 */
export function _resetCache() { cache = null; }

/**
 * @typedef {{site: string, type: string, title: string, subtitle: string, url: string, text: string, private: boolean}} RecallHit
 */

/**
 * 召回：rank.js 打分取前 limit 条，按 site + url（中英文地址不同，一个地址一条）找回条目本身拿正文（截 CONTEXT_CHARS 字，只在服务端用）。
 * showPrivate 不是 true 时，私密条目在这里再挡一次（rank.js 已经挡过；两道都在召回阶段）。
 * @param {Array<{site: string, items: any[]}>} indexes
 * @param {{q: string, lang?: string, showPrivate?: boolean, limit?: number}} opt
 * @returns {RecallHit[]}
 */
export function recall(indexes, opt) {
  const showPrivate = opt.showPrivate === true;
  const limit = Math.max(1, Math.min(10, opt.limit || 5));
  /** @type {Map<string, any>} */
  const byKey = new Map();
  for (const ix of indexes || []) {
    if (!ix || !Array.isArray(ix.items)) continue;
    for (const it of ix.items) {
      if (it && typeof it.url === 'string') {
        const k = ix.site + '\n' + it.url;
        if (!byKey.has(k)) byKey.set(k, it);
      }
    }
  }
  const lang = opt.lang === 'en' || opt.lang === 'zh' ? opt.lang : undefined;
  /** @type {RecallHit[]} */
  const out = [];
  for (const h of search(indexes || [], { q: opt.q, lang, showPrivate, limit: limit * 2 })) {
    const it = byKey.get(h.site + '\n' + h.url);
    if (!it) continue;
    const isPrivate = it.private === true;
    if (isPrivate && !showPrivate) continue;
    out.push({
      site: h.site, type: h.type, title: h.title, subtitle: h.subtitle, url: h.url,
      text: String(it.text || '').slice(0, CONTEXT_CHARS),
      private: isPrivate,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 给浏览器的来源列表：不带正文和内部字段（同 search-index 的约定）。
 * @param {RecallHit[]} hits
 */
export function publicHits(hits) {
  return hits.map((h) => ({ site: h.site, type: h.type, title: h.title, subtitle: h.subtitle, url: h.url }));
}
