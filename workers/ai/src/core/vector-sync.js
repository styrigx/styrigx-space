/**
 * @fileoverview Cron（每小时，wrangler.toml [triggers]）：把各站索引切段、嵌入、写进 Vectorize（2026-11 AI 语义召回）。
 *
 * 为什么在 styrigx-ai、为什么读 KV：各站的内容早就由各自的主人导出成 KV site:<站名>（主站 / 博客由 CI 从生产构建写，
 * 奇趣 / 日刻由 curio-core / daymark-core 从自己的 D1 写，改内容即重建 + 每小时兜底）。这份 KV 就是各库的只读出口：
 * 这里只读它，不绑任何 D1，库还是只有各自的 core 能碰（避免一处绑定所有库）。账号库 styrigx-account 从来不进 KV 索引，这里也就碰不到。
 *
 * 每个站：
 *   1. 读 KV site:<站名>；没有 / 坏的 → 跳过（不删向量：可能只是这一轮没读到）。
 *   2. 内容指纹 sha256({items}) 和上次写成功时记下的状态 KV ai:recall:<站名> = { v:1, sha, ids, at } 一样 → 跳过（不花嵌入、不写 KV）。
 *   3. 切段（core/chunk.js）→ 嵌入（core/embed.js）→ upsert（每批最多 UPSERT_BATCH）→ 删掉上次有、这次没有的 id → 写状态。
 *      中途失败不写状态，下一轮整站重来（upsert 幂等）。
 * KV 写只发生在站点内容变了的那一轮（每站一次），不吃紧账号共享的写额度。
 * 每轮最多嵌入 RUN_CHUNK_BUDGET 段：超了的站留到下一轮（第一个站不受限，免得大站永远轮不上）。
 * 出错只打日志（不带内容、不带钥匙），永不抛给 scheduled。
 */
import { chunkItems, sha256Hex } from './chunk.js';
import { embed } from './embed.js';
import { SITES } from './recall.js';

export const STATE_PREFIX = 'ai:recall:';
export const UPSERT_BATCH = 500;
export const DELETE_BATCH = 500;
export const RUN_CHUNK_BUDGET = 3000;

/** @param {any} env */
export function hasVectorize(env) {
  const v = env && env.VECTORIZE;
  return !!(v && typeof v.upsert === 'function' && typeof v.query === 'function');
}

/**
 * 同步一个站。返回 { site, status: 'unchanged'|'synced'|'missing'|'deferred'|'error', chunks?, deleted? }。
 * @param {any} env @param {string} site @param {{ budget: number, first: boolean }} run
 */
export async function syncSite(env, site, run) {
  const kv = env.KV_SEARCH_INDEX;
  let ix = null;
  try { ix = await kv.get('site:' + site, 'json'); } catch (e) { ix = null; }
  if (!ix || !Array.isArray(ix.items)) return { site, status: 'missing' };
  const sha = await sha256Hex(JSON.stringify({ items: ix.items }));
  /** @type {any} */
  let prev = null;
  try { prev = await kv.get(STATE_PREFIX + site, 'json'); } catch (e) { prev = null; }
  if (prev && prev.v === 1 && prev.sha === sha) return { site, status: 'unchanged' };
  const chunks = await chunkItems(site, ix.items);
  if (!run.first && chunks.length > run.budget) return { site, status: 'deferred', chunks: chunks.length };
  run.budget -= chunks.length;
  const vecs = await embed(env, chunks.map((c) => c.text));
  for (let i = 0; i < chunks.length; i += UPSERT_BATCH) {
    await env.VECTORIZE.upsert(chunks.slice(i, i + UPSERT_BATCH).map((c, k) => ({ id: c.id, values: vecs[i + k], metadata: c.metadata })));
  }
  const now = new Set(chunks.map((c) => c.id));
  const stale = prev && Array.isArray(prev.ids) ? prev.ids.filter((id) => typeof id === 'string' && !now.has(id)) : [];
  for (let i = 0; i < stale.length; i += DELETE_BATCH) await env.VECTORIZE.deleteByIds(stale.slice(i, i + DELETE_BATCH));
  await kv.put(STATE_PREFIX + site, JSON.stringify({ v: 1, sha, ids: [...now], at: new Date().toISOString() }));
  return { site, status: 'synced', chunks: chunks.length, deleted: stale.length };
}

/**
 * 整轮同步（scheduled 调）。永不抛错。
 * @param {any} env
 * @returns {Promise<Array<{site: string, status: string}>>}
 */
export async function syncAll(env) {
  if (!hasVectorize(env) || !env.KV_SEARCH_INDEX || typeof env.KV_SEARCH_INDEX.put !== 'function') {
    console.error('[ai-recall] sync skipped: binding missing', JSON.stringify({ vectorize: hasVectorize(env), kv: !!(env && env.KV_SEARCH_INDEX) }));
    return [];
  }
  const run = { budget: RUN_CHUNK_BUDGET, first: true };
  const out = [];
  for (const site of SITES) {
    let r;
    try {
      r = await syncSite(env, site, run);
      if (r.status === 'synced') run.first = false;
    } catch (e) {
      console.error('[ai-recall] sync failed', JSON.stringify({ site, error: String((e && /** @type {any} */ (e).message) || 'error').slice(0, 200) }));
      r = { site, status: 'error' };
    }
    out.push(r);
  }
  console.log('[ai-recall] sync', JSON.stringify(out));
  return out;
}
