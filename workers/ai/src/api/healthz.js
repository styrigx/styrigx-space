/**
 * @fileoverview GET /healthz：绑定齐不齐、索引读不读得到（不调模型，不花 Neurons）。
 * 200 { ok: true, sites: n, missing: [...] }：有 AI 绑定，且至少一个站的索引读得到（缺个别子站只算缺项）；
 * 503 { ok: false, error: 'config' }：没绑 AI；503 { ok: false, error: 'index', missing }：一个站的索引都没有 / KV 读不了。
 * P4-2 起 styrigx-status 经服务绑定 AI_SERVICE 每分钟测一次（方案 5.3 状态监测）。
 */
import { loadIndexes, SITES } from '../core/recall.js';
import { json, apiError } from '../lib/http.js';

/** @param {Request} request @param {any} env */
export async function onRequestGet(request, env) {
  if (!(env && env.AI && typeof env.AI.run === 'function')) return apiError(503, 'config');
  let indexes;
  try {
    indexes = await loadIndexes(env);
  } catch (e) {
    return json(503, { ok: false, error: 'index', missing: SITES.slice() });
  }
  const have = new Set(indexes.map((x) => x.site));
  const missing = SITES.filter((s) => !have.has(s));
  if (!have.size) return json(503, { ok: false, error: 'index', missing });
  return json(200, { ok: true, sites: have.size, missing });
}
