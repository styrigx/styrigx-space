/**
 * @fileoverview 命名入口 HourlyJob（WorkerEntrypoint，2026-11-10）：每小时同步语义召回向量（core/vector-sync.js syncAll）。
 * 本 Worker 不再自带 Cron：免费账号整个账号只有 5 个 Cron Trigger，ai / curio-core / daymark-core 的每小时任务
 * 并进 styrigx-status 的 "41 * * * *"，由 status 经服务绑定 JOB_AI 调 run()（先等 daymark、curio 重建完 KV 索引）。
 * 只能经服务绑定调用，公网进不来。出错只打日志，不抛给调用方。
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { syncAll } from '../core/vector-sync.js';

export class HourlyJob extends WorkerEntrypoint {
  /** @param {number} [_at] status 那轮 Cron 的 scheduledTime（本任务不用） */
  async run(_at) {
    try {
      await syncAll(this.env);
      return { ok: true };
    } catch (e) {
      console.error('[ai-recall] hourly failed', e && /** @type {any} */ (e).name);
      return { ok: false };
    }
  }
}
