/**
 * @fileoverview 语义召回（2026-11 AI 语义召回）：问句嵌入 → Vectorize 查 topK → 去重 → 和关键词召回（core/recall.js）合并。
 *
 * 两档过滤同 core/recall.js（方案 5.4、风险 R-8）：没有账号会话时查询带 filter { private: false }（Vectorize 的元数据索引 private，布尔），
 * 私密段进不了结果；另外结果里再按 metadata.private 过滤一遍（元数据索引没建好时 filter 不生效，不能靠它单独守门）。
 * 分数低于 minScore 的不要（余弦相似度；bge-m3 无关内容一般在 0.3 上下）。同一页面（站 + 地址）只留分数最高的一段；
 * 问句语言的页面优先（同一条目中英两份时留问句语言那份）。
 * 出任何错（没绑、嵌入失败、查询失败）→ 抛给调用方，ask.js 退回只用关键词召回，不影响回答。
 */
import { embed } from './embed.js';
import { CONTEXT_CHARS } from './recall.js';

export const TOPK = 20;
export const MIN_SCORE = 0.42;

/** 中英两份同一页面的归并键：去掉语言段 /zh/ @param {string} site @param {string} url */
function pageKey(site, url) {
  return site + '\n' + String(url || '').replace(/\/zh(\/|$)/, '/');
}

/**
 * @param {any} env
 * @param {{ q: string, lang?: string, showPrivate?: boolean, limit?: number, minScore?: number }} opt
 * @returns {Promise<import('./recall.js').RecallHit[]>}
 */
export async function semanticRecall(env, opt) {
  const v = env && env.VECTORIZE;
  if (!v || typeof v.query !== 'function') throw new Error('no-vectorize');
  const showPrivate = opt.showPrivate === true;
  const limit = Math.max(1, Math.min(10, opt.limit || 5));
  const minScore = typeof opt.minScore === 'number' ? opt.minScore : MIN_SCORE;
  const [vec] = await embed(env, [opt.q]);
  /** @type {Record<string, any>} */
  const qo = { topK: TOPK, returnMetadata: 'all' };
  if (!showPrivate) qo.filter = { private: false };
  const r = await v.query(vec, qo);
  const matches = r && Array.isArray(r.matches) ? r.matches : [];
  /** @type {Map<string, {score: number, m: any}>} */
  const best = new Map();
  for (const x of matches) {
    const m = x && x.metadata;
    if (!m || typeof m.url !== 'string' || typeof m.title !== 'string') continue;
    if (m.private === true && !showPrivate) continue;
    const score = typeof x.score === 'number' ? x.score : 0;
    if (score < minScore) continue;
    /* 问句语言的那份略占先：同分时留它 */
    const adj = score + (opt.lang && m.lang === opt.lang ? 0.01 : 0);
    const k = pageKey(String(m.site || ''), m.url);
    const cur = best.get(k);
    if (!cur || adj > cur.score) best.set(k, { score: adj, m });
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit).map(({ m }) => ({
    site: String(m.site || ''), type: String(m.type || ''), title: m.title, subtitle: String(m.subtitle || ''), url: m.url,
    text: String(m.text || '').slice(0, CONTEXT_CHARS), private: m.private === true,
  }));
}

/**
 * 合并语义召回和关键词召回：语义在前（按相似度），关键词补后面；同一地址只留一次；最多 limit 条。
 * @param {import('./recall.js').RecallHit[]} sem @param {import('./recall.js').RecallHit[]} kw @param {number} limit
 */
export function mergeHits(sem, kw, limit) {
  const out = [];
  const seen = new Set();
  for (const h of [...(sem || []), ...(kw || [])]) {
    const k = h.site + '\n' + h.url;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}
