/**
 * v6 身份统一（P2c，定稿 v5 §八「到期：自动禁用并作废会话，宽限期后自动删除」）：到期用户的自动删除。
 *
 * - 到期（account_users.expires_at > 0 且 ≤ 现在）：admit 已经不认（core/identity-session.js 判 expires_at；会话作废、登录被拒），
 *   这里不管。
 * - 宽限期 EXPIRED_USER_GRACE_MS = 30 天（定稿没给数，Hark 定，改这一个常量即可）：到期满 30 天 → 删除，删法与 userdel 相同
 *   （core/users.js deleteUserRows：会话、身份栈、密码、通行密钥、组；用户行留墓碑 #deleted-<uid>，uid 不复用）。宽限期内用户行、凭据、组都还在（只是登不上）。
 * - 永不删 root（uid 0）与 styrigx（uid 1000）：SQL 排除 + deleteUserRows 再拦一道（两者本来也不能有期限）。
 * - 每删一个写一条身份审计 `expire userdel <名>`（uid = null：系统做的，不是谁的命令）。
 * - 谁来跑（不加 Cron：免费账号整个账号最多 5 个 Cron Trigger）：
 *   1. 每日一轮：styrigx-status 的 "41 * * * *" 在 03:41 CST 那一轮经服务绑定 JOB_ACCOUNT 调命名入口 AccountJanitor.purgeExpiredUsers(at)
 *      （rpc/account-janitor.js、workers/status/src/daily.js）；
 *   2. 懒清理：useradd 之前顺手跑一次（同名的过期用户不挡新建）。
 * 每轮最多删 PURGE_BATCH 个（D1 一次 batch 的语句数有限；剩下的下一轮再删）。
 *
 * 只 import lib/ 与 core/。
 */
import { onDb } from '../lib/db.js';
import { ROOT_UID, STYRIGX_UID } from './groups.js';
import { writeUserAudit } from './user-audit.js';
import { deleteUserRows } from './users.js';

/** 到期后的宽限期：30 天（定稿 v5 §八 没给数；Hark 2026-11-11 定，只改这里） */
export const EXPIRED_USER_GRACE_MS = 30 * 24 * 3600 * 1000;
/** 每轮最多删几个 */
export const PURGE_BATCH = 20;

/**
 * 删掉到期满宽限期的用户。出错抛错（调用方决定吞不吞）。
 * @param {any} env @param {number} [now]
 * @returns {Promise<{deleted: string[]}>}
 */
export async function purgeExpiredUsers(env, now) {
  const t = typeof now === 'number' ? now : Date.now();
  const cutoff = t - EXPIRED_USER_GRACE_MS;
  const rows = await onDb(env, async (d) => ((await d.prepare(
    'SELECT uid, name FROM account_users WHERE expires_at > 0 AND expires_at <= ? AND uid NOT IN (?, ?) ORDER BY expires_at LIMIT ?',
  ).bind(cutoff, ROOT_UID, STYRIGX_UID, PURGE_BATCH).all()).results) || []);
  const deleted = [];
  for (const r of rows) {
    const uid = Number(r.uid);
    if (await deleteUserRows(env, uid)) {
      deleted.push(String(r.name));
      await writeUserAudit(env, { uid: null, command: 'expire userdel ' + String(r.name).replace(/[^a-z0-9-]/g, '').slice(0, 32), ok: true, ip: '' });
    }
  }
  return { deleted };
}
