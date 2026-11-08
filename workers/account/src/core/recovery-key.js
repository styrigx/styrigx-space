/**
 * 恢复密钥（RecoveryKey，Secrets Store SGX_ACCOUNT_RECOVERY_KEY）：限速 + 比对，一份实现。
 * 唯一用途：POST /api/account/reset { action:'recovery-key', key } 换 reset 票（core/reset.js openReset）。
 * 不能登录、不能换 reauth 票、不签会话。
 *
 * 规则：
 * - 单 IP（IPv6 按 /64）连错 RECOVERY_KEY_IP_MAX_FAIL 次锁 15 分钟（锁定中码对也 429 cooldown）
 * - 全局只减速、不封锁：每小时真比对失败满 RECOVERY_KEY_GLOBAL_SLOW_AT 次后，之后每次先等 RECOVERY_KEY_GLOBAL_DELAY_MS 再比对。
 *   不设全局暂停：恢复密钥是钥匙都丢了时的入口，任何人都不能靠刷错把主人锁在外面
 * - 比对前两边都去掉全部空白（normalizeRecoveryKey），恒定时间比较；去空白后为空一律拒绝
 * - 失败统一 401 auth，返回前对齐到 MIN_DELAY_MS；每次真比对写审计 reset-recovery-key（ok 列区分）
 * - 缺密值或账号库 → 500 config；限速 / 计数 D1 出错 → 503 server（fail closed）
 *
 * 存储：account_attempt_limit kind = 'recovery-key'（bucket = IP 分桶；'*' = 全局窗口）。
 */
import { timingSafeEqual } from '../lib/crypto.js';
import { ipBucket, apiError } from '../lib/http.js';
import { dbReady } from '../lib/db.js';
import { readAttempt, globalHot, recordAttempt, recordGlobal, clearAttempt } from '../lib/attempt-limit.js';
import { RECOVERY_KEY_SECRET } from './config.js';
import { writeAudit } from './audit.js';

export { RECOVERY_KEY_SECRET };

/** 限速 kind */
export const RECOVERY_KEY_KIND = 'recovery-key';
export const RECOVERY_KEY_IP_MAX_FAIL = 5;
export const RECOVERY_KEY_IP_LOCK_MS = 15 * 60 * 1000;
export const RECOVERY_KEY_GLOBAL_SLOW_AT = 20;
export const RECOVERY_KEY_GLOBAL_WINDOW_MS = 60 * 60 * 1000;
export const RECOVERY_KEY_GLOBAL_DELAY_MS = 3000;
const IP_TTL_MS = 3600 * 1000;

/** 失败返回前对齐的最短耗时 */
export const MIN_DELAY_MS = 200;

/** @param {number} ms */
export function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

/** 从 t0 起至少等到 MIN_DELAY_MS @param {number} t0 */
export async function padTo(t0) {
  const wait = t0 + MIN_DELAY_MS - Date.now();
  if (wait > 0) await sleep(wait);
}

/**
 * 恢复密钥规范化：去掉所有空白字符（单行密码框，粘贴多行时浏览器会去掉换行；两边同样处理后再比对）。
 * 只有恢复密钥这样处理；账号密码不做任何规范化。
 * @param {any} s
 */
export function normalizeRecoveryKey(s) {
  return String(s || '').replace(/\s+/g, '');
}

/**
 * 是否被限速；D1 出错抛错。
 * @param {any} env @param {string} ip
 * @returns {Promise<{limited:boolean, delayMs:number}>}
 */
export async function recoveryKeyLimit(env, ip) {
  const rec = await readAttempt(env, RECOVERY_KEY_KIND, ipBucket(ip));
  if (rec && rec.lockedUntil > Date.now()) return { limited: true, delayMs: 0 };
  const hot = await globalHot(env, RECOVERY_KEY_KIND, RECOVERY_KEY_GLOBAL_WINDOW_MS, RECOVERY_KEY_GLOBAL_SLOW_AT);
  return { limited: false, delayMs: hot ? RECOVERY_KEY_GLOBAL_DELAY_MS : 0 };
}

/** 记一次真比对失败（单 IP + 全局，原子）。D1 出错抛错。 @param {any} env @param {string} ip */
export async function recordRecoveryKeyFail(env, ip) {
  await recordAttempt(env, RECOVERY_KEY_KIND, ipBucket(ip), { max: RECOVERY_KEY_IP_MAX_FAIL, ttlMs: IP_TTL_MS, lockMs: RECOVERY_KEY_IP_LOCK_MS });
  await recordGlobal(env, RECOVERY_KEY_KIND, RECOVERY_KEY_GLOBAL_WINDOW_MS);
}

/** 成功后清掉该 IP 的计数（尽力而为） @param {any} env @param {string} ip */
export async function clearRecoveryKeyFail(env, ip) {
  try { await clearAttempt(env, RECOVERY_KEY_KIND, ipBucket(ip)); } catch (e) {}
}

/**
 * 校验恢复密钥：限速 → 比对 → 失败计数 + 审计 / 成功清计数。不签任何票（签票和成功审计在 core/reset.js）。
 * @param {{env:any, ip:string, key:any, t0:number}} o t0 = 请求开始时刻（失败返回前对齐耗时）
 * @returns {Promise<{ok:true}|{ok:false, response:Response}>}
 */
export async function checkRecoveryKey(o) {
  const { env, ip, t0 } = o;
  const secret = (env && env[RECOVERY_KEY_SECRET]) || '';
  if (!secret || !dbReady(env)) return { ok: false, response: apiError(500, 'config') };
  try {
    const lim = await recoveryKeyLimit(env, ip);
    if (lim.limited) {
      await writeAudit(env, ip, 'reset-recovery-key', false);
      return { ok: false, response: apiError(429, 'cooldown') };
    }
    if (lim.delayMs) await sleep(lim.delayMs);
  } catch (e) {
    return { ok: false, response: apiError(503, 'server') };
  }
  const key = normalizeRecoveryKey(typeof o.key === 'string' ? o.key : '');
  const ok = !!key && (await timingSafeEqual(key, normalizeRecoveryKey(secret)));
  if (!ok) {
    try {
      await recordRecoveryKeyFail(env, ip);
    } catch (e) {
      await writeAudit(env, ip, 'reset-recovery-key', false);
      return { ok: false, response: apiError(503, 'server') };
    }
    /* 审计写入放在对齐之前 */
    await writeAudit(env, ip, 'reset-recovery-key', false);
    await padTo(t0);
    return { ok: false, response: apiError(401, 'auth') };
  }
  await clearRecoveryKeyFail(env, ip);
  return { ok: true };
}
