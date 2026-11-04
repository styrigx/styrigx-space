/**
 * @fileoverview /api/ai 的两档限流（P4-1，方案 5.6；定案第 3 条）。都在调 styrigx-ai 之前执行，先查第一档再查第二档，两档不共用计数。
 *
 * 第一档：每 IP 每 60 秒 6 次。Workers Rate Limiting 绑定 AI_LIMITER（wrangler.toml [[ratelimits]]，namespace 2802；
 *   写法同 core/anon-limit.js，不和 ANON_LIMITER 共用 namespace，免得 AI 请求挤占锁屏接口的配额）。
 *   超了 → 429 cooldown + Retry-After: 60。绑定缺失（本地、单测）或调用出错 → 放行，打一行日志（它是防刷的闸，不是安全门）。
 *
 * 第二档：全站总闸，每分钟 60 次（Gray 2026-11-04 00:30 定案）。Rate Limiting 按机房计数，做不出全站总数，
 *   所以复用 D1_LOCK_AUTH 现有的 attempt_limit 表（不改表结构、不加迁移）：
 *   realm = 'ai'、kind = 'global'、bucket = 当前分钟（Date.now() / 60000 取整）。
 *   一条 INSERT … ON CONFLICT DO UPDATE SET count = count + 1 WHERE count < 60 RETURNING count 完成「判断 + 计数」：
 *   有返回行 = 放行；没返回行 = 超闸（超闸的请求不写行）→ 429 busy + Retry-After（到下一分钟的秒数）。
 *   expires_at = 窗口结束 + 2 分钟；每分钟第一次放行时顺手清掉 realm='ai' 的过期行（d1-state.js sweepExpired，尽力而为）。
 *   D1 出错 → fail closed（429 busy）：总闸的目的就是护成本。
 */
import { onAuthDb, sweepExpired } from './d1-state.js';
import { apiError, clientIp } from '../lib/http.js';

/** 和 wrangler.toml 里 AI_LIMITER 的 simple.period 一致（秒） */
export const AI_IP_PERIOD = 60;
/** 全站总闸：每个窗口最多放行多少次（定案） */
export const AI_GLOBAL_LIMIT = 60;
/** 全站总闸的窗口（毫秒）= 一分钟 */
export const AI_GLOBAL_WINDOW_MS = 60 * 1000;
/** 计数行多留多久（窗口结束后） */
export const AI_GLOBAL_GRACE_MS = 2 * 60 * 1000;

/** 总闸那一行所在的域：同一个 D1（D1_LOCK_AUTH），realm 列写 'ai'（attempt_limit 的 realm 是自由文本，不加迁移） */
export const REALM_AI = Object.freeze({ id: 'ai', d1Binding: 'D1_LOCK_AUTH' });
export const AI_GLOBAL_KIND = 'global';

/**
 * 第一档：每 IP。超了回 429 响应，否则 null。
 * @param {Request} request @param {any} env
 * @returns {Promise<Response|null>}
 */
export async function aiIpLimit(request, env) {
  const limiter = env && env.AI_LIMITER;
  if (!limiter || typeof limiter.limit !== 'function') {
    console.log('[sgx-ai-limit] no AI_LIMITER binding, pass');
    return null;
  }
  let ok = true;
  try {
    const r = await limiter.limit({ key: clientIp(request) });
    ok = !(r && r.success === false);
  } catch (e) {
    console.log('[sgx-ai-limit] limiter error, pass: ' + (e && /** @type {any} */ (e).message));
    return null;
  }
  if (ok) return null;
  return apiError(429, 'cooldown', { retryAfter: AI_IP_PERIOD }, { 'Retry-After': String(AI_IP_PERIOD) });
}

const GLOBAL_SQL =
  'INSERT INTO attempt_limit (realm, kind, bucket, count, strikes, locked_until, window_start, expires_at) ' +
  'VALUES (?1, ?2, ?3, 1, 0, 0, ?4, ?5) ' +
  'ON CONFLICT (realm, kind, bucket) DO UPDATE SET count = attempt_limit.count + 1 WHERE attempt_limit.count < ?6 ' +
  'RETURNING count';

/**
 * 第二档：全站总闸。放行回 null，超闸或 D1 出错回 429 busy。
 * @param {any} env @param {number} [now]
 * @returns {Promise<Response|null>}
 */
export async function aiGlobalGate(env, now) {
  const t = Number.isFinite(now) ? /** @type {number} */ (now) : Date.now();
  const minute = Math.floor(t / AI_GLOBAL_WINDOW_MS);
  const windowStart = minute * AI_GLOBAL_WINDOW_MS;
  const windowEnd = windowStart + AI_GLOBAL_WINDOW_MS;
  const retryAfter = Math.max(1, Math.ceil((windowEnd - t) / 1000));
  let row;
  try {
    row = await onAuthDb(env, REALM_AI, async (db, r) => {
      const res = await db.prepare(GLOBAL_SQL)
        .bind(r.id, AI_GLOBAL_KIND, String(minute), windowStart, windowEnd + AI_GLOBAL_GRACE_MS, AI_GLOBAL_LIMIT)
        .first();
      if (res && Number(res.count) === 1) await sweepExpired(db, 'attempt_limit', r.id, t);
      return res;
    });
  } catch (e) {
    console.error('[sgx-ai-limit] global gate d1 error, fail closed: ' + (e && /** @type {any} */ (e).message));
    return apiError(429, 'busy', { retryAfter }, { 'Retry-After': String(retryAfter) });
  }
  if (row && Number.isFinite(Number(row.count))) return null;
  return apiError(429, 'busy', { retryAfter }, { 'Retry-After': String(retryAfter) });
}
