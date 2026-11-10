/**
 * @fileoverview 命名入口 ShareJanitor（WorkerEntrypoint，v5 S2，2026-11-10）：每日清理过期 / 作废满 7 天的分享链接。
 * 只给 styrigx-status 经服务绑定 JOB_SPACE 调（status 的 "41 * * * *" 那条 Cron，Asia/Shanghai 03 点那一轮 = UTC 19 点；
 * 不另占 Cron：免费账号整个账号只有 5 个）。公网进不来。
 * 单独一个入口，不挂在 SpaceVerifier 上：SpaceVerifier 绑给了 curio-core / daymark-core，删数据的方法不给它们。
 * 逻辑在 core/share-links.js purgeDeadLinks（一条 DELETE）；这里只接线，出错只打日志、回 { ok:false }，不抛给 status。
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { purgeDeadLinks } from '../core/share-links.js';

export class ShareJanitor extends WorkerEntrypoint {
  /**
   * @param {number} [at] status 那轮 Cron 的 scheduledTime（毫秒），默认现在
   * @returns {Promise<{ok:true, deleted:number}|{ok:false}>}
   */
  async purgeShareLinks(at) {
    try {
      const now = Number(at) || Date.now();
      const deleted = await purgeDeadLinks(this.env && this.env.D1_SPACE, now);
      return { ok: true, deleted };
    } catch (e) {
      console.error('[space-core] share purge failed', e && /** @type {any} */ (e).name);
      return { ok: false };
    }
  }
}
