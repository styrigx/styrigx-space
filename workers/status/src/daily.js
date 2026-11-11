/**
 * @fileoverview 每日任务（v5 S2，2026-11-10；v6 P2c 加账号到期清理）：不另加 Cron（免费账号整个账号只有 5 个 Cron Trigger，现用 3 个），
 * 挂在每小时那条 "41 * * * *" 上，只在 Asia/Shanghai 03 点那一轮（= UTC 19 点；上海不用夏令时，恒等）跑：
 *   - JOB_ACCOUNT（v6 P2c）：styrigx-account 的命名入口 AccountJanitor.purgeExpiredUsers(at)，删掉到期满 30 天宽限期的用户
 *     （逻辑在 account core/user-expiry.js；永不删 root / styrigx）。
 * v6 P4（定稿 v5.2 §十三）：分享短链整套删除，原 JOB_SPACE（space-core ShareJanitor.purgeShareLinks）随之删除。
 * 任务并行、互不挡。不是那一小时 → 什么都不做；绑定没配（本地 / 单测）→ 跳过；失败只打日志，不挡同一轮的用量和每小时任务。
 */

/** 每日任务跑在哪一小时（UTC）：19 = Asia/Shanghai 03 点 */
export const DAILY_UTC_HOUR = 19;

/** 每日任务：绑定名 → 要调的方法 */
export const DAILY_JOBS = Object.freeze({ JOB_ACCOUNT: 'purgeExpiredUsers' });

/** @param {number} at 毫秒 */
export function isDailyHour(at) {
  return new Date(at).getUTCHours() === DAILY_UTC_HOUR;
}

/**
 * @param {Record<string, any>} env
 * @param {number} at 这轮 Cron 的 scheduledTime
 * @returns {Promise<Record<string, 'ok'|'failed'|'skipped'|'not-now'>>}
 */
export async function runDailyJobs(env, at) {
  /** @type {Record<string, 'ok'|'failed'|'skipped'|'not-now'>} */
  const out = {};
  const names = Object.keys(DAILY_JOBS);
  if (!isDailyHour(at)) {
    for (const n of names) out[n] = 'not-now';
    return out;
  }
  await Promise.all(names.map(async (name) => {
    const svc = env && env[name];
    const method = DAILY_JOBS[/** @type {keyof typeof DAILY_JOBS} */ (name)];
    if (!svc || typeof svc[method] !== 'function') { out[name] = 'skipped'; return; }
    /** @type {'ok'|'failed'} */
    let st = 'failed';
    try {
      const r = await svc[method](at);
      st = r && r.ok === false ? 'failed' : 'ok';
    } catch (e) {
      st = 'failed';
    }
    if (st === 'failed') console.error('[status] daily job failed', name);
    out[name] = st;
  }));
  return out;
}
