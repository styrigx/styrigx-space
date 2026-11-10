/**
 * @fileoverview 命名入口 HourlyJob（WorkerEntrypoint，2026-11-10）：每小时兜底重建搜索索引（内容没变不写 KV）。
 * 本 Worker 不再自带 Cron：免费账号整个账号只有 5 个 Cron Trigger，每小时任务并进 styrigx-status 的 "41 * * * *"，
 * 由 status 经服务绑定 JOB_DAYMARK 调 run()。只能经服务绑定调用，公网进不来。
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { rebuildSearchIndex } from '../search-index.js';

export class HourlyJob extends WorkerEntrypoint {
  /** @param {number} [_at] status 那轮 Cron 的 scheduledTime（本任务不用） */
  async run(_at) {
    try {
      await rebuildSearchIndex(this.env, Date.now(), { skipUnchanged: true });
      return { ok: true };
    } catch (e) {
      console.error('[daymark-core] hourly failed', e && /** @type {any} */ (e).name);
      return { ok: false };
    }
  }
}
