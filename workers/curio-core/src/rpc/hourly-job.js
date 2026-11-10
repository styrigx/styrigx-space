/**
 * @fileoverview 命名入口 HourlyJob（WorkerEntrypoint，2026-11-10）：每小时兜底重建搜索索引，扫除时段顺带清扫照片。
 * 本 Worker 不再自带 Cron：免费账号整个账号只有 5 个 Cron Trigger，每小时任务并进 styrigx-status 的 "41 * * * *"，
 * 由 status 经服务绑定 JOB_CURIO 调 run(at)。逻辑同 app.js 的 scheduled（runHourly）。只能经服务绑定调用，公网进不来。
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { runHourly } from '../app.js';

export class HourlyJob extends WorkerEntrypoint {
  /** @param {number} [at] status 那轮 Cron 的 scheduledTime（决定是不是清扫照片的那一小时） */
  async run(at) {
    try {
      await runHourly(this.env, Number(at) || Date.now());
      return { ok: true };
    } catch (e) {
      console.error('[curio-core] hourly failed', e && /** @type {any} */ (e).name);
      return { ok: false };
    }
  }
}
