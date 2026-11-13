/**
 * @fileoverview 每小时任务（2026-11-10）：免费账号整个账号只有 5 个 Cron Trigger，
 * ai / curio-core / daymark-core 原来各占一个每小时 Cron，现在并进本 Worker 的 "41 * * * *"，
 * 经服务绑定调它们的命名入口 HourlyJob.run(at)。任务代码仍在各自 Worker 里，这里只按顺序叫：
 *   1. atlas（奇趣 + 日刻，2026-11-14 合并成一个 Worker，内部先奇趣后日刻）重建 KV 搜索索引（内容没变不写）
 *   2. 结束后 ai 再把索引同步进 Vectorize（原来 17 / 23 分重建、41 分同步，顺序不变）
 * 某个绑定没配（本地 / 单测）就跳过；某个失败只打日志，不挡后面的。
 */

/** 先跑的一批（并行），再跑的一批 */
export const HOURLY_ORDER = Object.freeze([Object.freeze(['JOB_ATLAS']), Object.freeze(['JOB_AI'])]);

/**
 * @param {Record<string, any>} env
 * @param {number} at 这轮 Cron 的 scheduledTime
 * @returns {Promise<Record<string, 'ok'|'failed'|'skipped'>>}
 */
export async function runHourlyJobs(env, at) {
  /** @type {Record<string, 'ok'|'failed'|'skipped'>} */
  const out = {};
  for (const batch of HOURLY_ORDER) {
    await Promise.all(batch.map(async (name) => {
      const svc = env && env[name];
      if (!svc || typeof svc.run !== 'function') { out[name] = 'skipped'; return; }
      try {
        const r = await svc.run(at);
        out[name] = r && r.ok === false ? 'failed' : 'ok';
      } catch (e) {
        out[name] = 'failed';
      }
      if (out[name] === 'failed') console.error('[status] hourly job failed', name);
    }));
  }
  return out;
}
