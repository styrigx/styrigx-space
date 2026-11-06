/**
 * @fileoverview 站内召回（内部函数，不对外：没有 /search 端点，定案第 2 条）。两档过滤在这里（方案 5.4、风险 R-8）：
 * - 没有账号会话（网关没写 X-Styrigx-Account-Session: 1）→ 只召回公开条目；
 * - 有账号会话 → 公开 + 私密。
 * 过滤在召回阶段做，不靠提示词：私密条目进不了 hits，也进不了给模型的上下文。
 *
 * 索引：KV KV_SEARCH_INDEX，每个站一条 site:<站名>，值 { site, generated, items: Item[] }（格式见 core/rank.js 文件头）。
 * 读索引带 60 秒 isolate 内缓存（同 search-index），不多吃 KV 读额度。
 */
import { tokenize } from './rank.js';

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
 * 问句里不表达主题的词（问法、代词、客套）。只在召回里去掉；搜索框的 rank.js 不用。
 * 中文是 tokenize 切出的二元组，英文是整词。
 */
export const STOP = new Set([
  '什么', '怎么', '怎样', '如何', '哪些', '哪里', '哪个', '为什', '是什', '有什', '有哪', '有没', '没有', '是不', '能不', '可不', '可以',
  '一下', '请问', '请用', '一句', '句话', '一个', '介绍', '你好', '您好', '你是', '我的', '你的', '自己', '这个', '那个', '吗', '呢',
  'the', 'a', 'an', 'is', 'are', 'was', 'what', 'how', 'do', 'does', 'did', 'i', 'to', 'of', 'on', 'in', 'and', 'or', 'you', 'your',
  'me', 'my', 'please', 'can', 'there', 'any', 'with', 'for', 'about', 'it', 'this', 'that', 'hi', 'hello', 'tell', 'which', 'where',
]);

/**
 * 召回打分：问句是自然语言，不能像搜索框那样要求每个词都命中（rank.js 的 search 是全命中，
 * 「博客有什么文章」切出「客有」「么文」就一条都中不了）。这里按命中词加权求和、再乘命中比例：
 * 标题 10、副标题 4、正文 1；去掉 STOP 后至少命中一个词才算。
 * @param {any} it
 * @param {string[]} toks 已去掉 STOP
 * @param {string} phrase 小写整句
 */
export function recallScore(it, toks, phrase) {
  const t = String(it.title || '').toLowerCase();
  const d = String(it.subtitle || '').toLowerCase();
  const x = String(it.text || '').toLowerCase();
  let s = 0;
  let n = 0;
  for (const k of toks) {
    if (t.indexOf(k) !== -1) { s += 10; n++; }
    else if (d.indexOf(k) !== -1) { s += 4; n++; }
    else if (x.indexOf(k) !== -1) { s += 1; n++; }
  }
  if (!n) return 0;
  if (phrase && t && phrase.indexOf(t) !== -1) s += 15;
  return s * (n / toks.length);
}

/**
 * @param {Array<{site: string, items: any[]}>} indexes
 * @param {string[]} toks
 * @param {string} phrase
 * @param {string|undefined} lang
 * @param {boolean} showPrivate
 */
function rankAll(indexes, toks, phrase, lang, showPrivate) {
  const hits = [];
  for (const ix of indexes) {
    if (!ix || !Array.isArray(ix.items)) continue;
    for (const it of ix.items) {
      if (!it || typeof it.url !== 'string' || typeof it.title !== 'string') continue;
      if (it.private === true && !showPrivate) continue;
      if (lang && (it.lang || 'zh') !== lang) continue;
      const s = recallScore(it, toks, phrase);
      if (s > 0) hits.push({ site: ix.site, it, score: s });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.it.title.length - b.it.title.length);
  return hits;
}

/**
 * @typedef {{site: string, type: string, title: string, subtitle: string, url: string, text: string, private: boolean}} RecallHit
 */

/**
 * 召回：按 recallScore 取前 limit 条，带正文（截 CONTEXT_CHARS 字，只在服务端用）。
 * 先只看问句语言（lang）的条目；一条都没有再放开语言（中文页面问英文、英文页面问中文都能中）。
 * showPrivate 不是 true 时私密条目不进来（召回阶段过滤，不靠提示词）。
 * @param {Array<{site: string, items: any[]}>} indexes
 * @param {{q: string, lang?: string, showPrivate?: boolean, limit?: number}} opt
 * @returns {RecallHit[]}
 */
export function recall(indexes, opt) {
  const showPrivate = opt.showPrivate === true;
  const limit = Math.max(1, Math.min(10, opt.limit || 5));
  const phrase = String(opt.q || '').toLowerCase().normalize('NFKC').trim();
  const toks = tokenize(phrase).filter((k) => !STOP.has(k));
  if (!toks.length) return [];
  const lang = opt.lang === 'en' || opt.lang === 'zh' ? opt.lang : undefined;
  let ranked = rankAll(indexes || [], toks, phrase, lang, showPrivate);
  if (!ranked.length && lang) ranked = rankAll(indexes || [], toks, phrase, undefined, showPrivate);
  /** @type {RecallHit[]} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const h of ranked) {
    const k = h.site + '\n' + h.it.url;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      site: h.site, type: String(h.it.type || ''), title: h.it.title, subtitle: String(h.it.subtitle || ''), url: h.it.url,
      text: String(h.it.text || '').slice(0, CONTEXT_CHARS),
      private: h.it.private === true,
    });
    if (out.length >= limit) break;
  }
  return out;
}
