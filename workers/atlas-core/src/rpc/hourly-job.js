/**
 * @fileoverview HourlyJob：给 styrigx-status 的服务绑定（切换后由 JOB_CURIO / JOB_DAYMARK 两条合成一条），公网进不来。
 * 一轮里先奇趣后日刻（app.js runHourly）。
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { runHourly } from '../app.js';

export class HourlyJob extends WorkerEntrypoint {
  /** @param {number} [at] status 那轮 Cron 的 scheduledTime（决定是不是奇趣清扫照片的那一小时） */
  async run(at) {
    try {
      const r = await runHourly(this.env, Number(at) || Date.now());
      return { ok: r.curio && r.daymark, curio: r.curio, daymark: r.daymark };
    } catch (e) {
      console.error('[atlas] hourly failed', e && /** @type {any} */ (e).name);
      return { ok: false, curio: false, daymark: false };
    }
  }
}
