/**
 * @fileoverview 服务绑定 RPC 入口 DaymarkReader（R-35，2026-11-15）：给 styrigx-ai 取「今日一句」，公网路由进不来。
 * 根因：site:daymark 搜索索引只有句子本身、没有日期绑定，问「日刻今天那句是什么」召回不到；
 * styrigx-ai 认出「今天 + 日刻」时经这里取今日一句当上下文（workers/ai/src/core/fixed.js）。
 * 逻辑同 GET /daymark/api/today（daymark/api/today.js）：北京时间今天、只出公开句子、字段同 publicQuote（不带 note / 可见性）。
 * 放在 src/rpc/ 而不是 src/daymark/：写的时候 daymark/ 还要和旧 Worker 的代码逐字一致（2026-11-14 合并进 atlas-core，旧目录已删）。
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { ensureSchema, dayInShanghai } from '../daymark/api/_quotes.js';
import { resolveDay, publicQuote } from '../daymark/api/_today.js';

/**
 * 纯函数版（单测直接测）。永不抛错：出错 → { ok:false }。
 * @param {any} env @param {number} [now]
 */
export async function todayPick(env, now = Date.now()) {
  try {
    const db = env && env.D1_QUOTES;
    if (!db) return { ok: false, error: 'db-binding-missing' };
    await ensureSchema(db);
    const day = dayInShanghai(now);
    const row = await resolveDay(db, day, { persist: true, now });
    return { ok: true, day, quote: publicQuote(row) };
  } catch (e) {
    console.error('[atlas] daymark today rpc failed', e && /** @type {any} */ (e).name);
    return { ok: false, error: 'failed' };
  }
}

export class DaymarkReader extends WorkerEntrypoint {
  /** 今日一句：{ ok, day, quote|null } */
  async today() {
    return todayPick(this.env);
  }
}
