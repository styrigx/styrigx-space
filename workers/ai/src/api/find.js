/**
 * @fileoverview GET /find?q=&lang=：关键词搜索（v5 S4，Gray 2026-11-10 16:13 定）。不调模型、不读钥匙、不看账号结论头。
 * 只经网关 GET /api/find 的服务绑定 AI_SERVICE 进来（网关那边公开、FIND_LIMITER 限流）。
 *
 * 索引：和 /ask 的关键词召回同一条路（core/recall.js loadIndexes：KV site:space / site:blog / site:curio / site:daymark，60 秒 isolate 内缓存）；
 *   打分用搜索框那套全命中（core/rank.js search：每个词都要命中，标题 > 副标题 > 正文）。
 * 只回公开条目：private 条目一律不进（showPrivate 固定 false，请求头带什么都一样）。
 * 回答只带页面元数据：{ title, url, site, snippet }，snippet = 索引里的副标题（正文 text 不回）。
 *   200 { ok: true, q, results: [...] }
 *   200 { ok: true, q, results: [], degraded: true }：KV 读不了 / 一个站的索引都没有（降级，不 500）
 *   400 { ok: false, error: 'bad_request' }：q 为空；400 too-long：q 超过 Q_MAX 个字符
 * 语言：先只看 lang 的条目，一条都没有再放开语言（同 recall.js）。
 */
import { loadIndexes } from '../core/recall.js';
import { search } from '../core/rank.js';
import { json, apiError } from '../lib/http.js';

/** q 最多多少个字符（同 /ask 的 Q_MAX 量级；rank.js 分词本身只看前 100 字） */
export const FIND_Q_MAX = 100;
/** 最多回几条 */
export const FIND_LIMIT = 10;

/**
 * 索引条目 → 回给浏览器的公开字段（只这四个）。
 * @param {{site: string, title: string, subtitle: string, url: string}} h
 */
export function findItem(h) {
  return { title: h.title, url: h.url, site: h.site, snippet: h.subtitle || '' };
}

/**
 * @param {Array<{site: string, items: any[]}>} indexes
 * @param {string} q
 * @param {string|undefined} lang
 */
export function findIn(indexes, q, lang) {
  const base = { q, showPrivate: false, limit: FIND_LIMIT };
  let hits = lang ? search(indexes, { ...base, lang }) : [];
  if (!hits.length) hits = search(indexes, base);
  return hits.map(findItem);
}

/** @param {Request} request @param {any} env */
export async function onRequestGet(request, env) {
  const url = new URL(request.url);
  const q = String(url.searchParams.get('q') || '').normalize('NFKC').trim();
  if (!q) return apiError(400, 'bad_request');
  if ([...q].length > FIND_Q_MAX) return apiError(400, 'too-long');
  const l = url.searchParams.get('lang');
  const lang = l === 'zh' || l === 'en' ? l : undefined;
  let indexes;
  try {
    indexes = await loadIndexes(env);
  } catch (e) {
    console.error('[ai-find] index unavailable', e && /** @type {any} */ (e).message);
    return json(200, { ok: true, q, results: [], degraded: true });
  }
  if (!indexes.length) return json(200, { ok: true, q, results: [], degraded: true });
  return json(200, { ok: true, q, results: findIn(indexes, q, lang) });
}
