/**
 * @fileoverview 每日任务（v5 S2，2026-11-10）：不另加 Cron（免费账号整个账号只有 5 个 Cron Trigger，现用 3 个），
 * 挂在每小时那条 "41 * * * *" 上，只在 Asia/Shanghai 03 点那一轮（= UTC 19 点；上海不用夏令时，恒等）跑：
 *   经服务绑定 JOB_SPACE 调 styrigx-space-core 的命名入口 ShareJanitor.purgeShareLinks(at)，
 *   删掉过期 / 作废满 7 天的分享链接（逻辑在 space-core core/share-links.js purgeDeadLinks）。
 * 不是那一小时 → 什么都不做；绑定没配（本地 / 单测）→ 跳过；失败只打日志，不挡同一轮的用量和每小时任务。
 */

/** 每日任务跑在哪一小时（UTC）：19 = Asia/Shanghai 03 点 */
export const DAILY_UTC_HOUR = 19;

/** @param {number} at 毫秒 */
export function isDailyHour(at) {
  return new Date(at).getUTCHours() === DAILY_UTC_HOUR;
}

/**
 * @param {Record<string, any>} env
 * @param {number} at 这轮 Cron 的 scheduledTime
 * @returns {Promise<{JOB_SPACE: 'ok'|'failed'|'skipped'|'not-now'}>}
 */
export async function runDailyJobs(env, at) {
  if (!isDailyHour(at)) return { JOB_SPACE: 'not-now' };
  const svc = env && env.JOB_SPACE;
  if (!svc || typeof svc.purgeShareLinks !== 'function') return { JOB_SPACE: 'skipped' };
  /** @type {'ok'|'failed'} */
  let st = 'failed';
  try {
    const r = await svc.purgeShareLinks(at);
    st = r && r.ok === false ? 'failed' : 'ok';
  } catch (e) {
    st = 'failed';
  }
  if (st === 'failed') console.error('[status] daily job failed', 'JOB_SPACE');
  return { JOB_SPACE: st };
}
