/**
 * @fileoverview 账号 Worker 的命名入口 AccountJanitor（WorkerEntrypoint，RPC；v6 P2c）：到期用户满宽限期自动删除（core/user-expiry.js）。
 * 本 Worker 不自带 Cron（免费账号整个账号只有 5 个 Cron Trigger）：styrigx-status 的 "41 * * * *" 在 03:41 CST 那一轮
 * 经服务绑定 JOB_ACCOUNT 调 purgeExpiredUsers(at)（workers/status/src/daily.js）。只能经服务绑定调用，公网进不来。
 * 只回删了几个，不回名字（名字进身份审计）。
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { purgeExpiredUsers } from '../core/user-expiry.js';

export class AccountJanitor extends WorkerEntrypoint {
  /** @param {number} [_at] status 那轮 Cron 的 scheduledTime（本任务按当前时间算） */
  async purgeExpiredUsers(_at) {
    try {
      const r = await purgeExpiredUsers(this.env, Date.now());
      return { ok: true, deleted: r.deleted.length };
    } catch (e) {
      console.error('[account] expired-user purge failed', e && /** @type {any} */ (e).name);
      return { ok: false, deleted: 0 };
    }
  }
}
