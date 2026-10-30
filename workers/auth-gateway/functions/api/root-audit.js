/**
 * 锁屏根密钥（SGX_ADMIN_KEY）使用审计列表：账号 → 服务状态页底部的「根密钥使用记录」折叠区展开时才请求（apps/account-status.js；
 * 前端同时请求账号 Worker 的 audit-list，合成一张表并标注「锁屏 / 账号」，方案 5.2）。
 *
 * GET /api/root-audit
 * - 只要 admin 锁屏会话（访客 / 无会话 / 坏会话 → 401 session）。不要 LockReauthTicket：
 *   只读、不含凭证；页面在账号区里，访客被网关 302 出 /account/*，管理员已解锁；这里仍在服务端校验 admin，防直接调接口。
 * - 返回最近 50 条审计（时间、IP 前缀、结果），新的在前；不返回 decoy / via / path 标记
 * - 只读；D1 失败 → 503
 *
 * 存储：D1 audit 表（realm = 'lock'，经 D1_LOCK_AUTH，_kernel/root-audit.js）：一条 ORDER BY ts DESC LIMIT 50。
 * 账号拆分前写在 realm='root' 的旧审计行不再读（7 天自然过期，PR4 cleanup 删除）。
 */
import { verifyLockSession } from '../_kernel/lock-session.js';
import { listRootAudit } from '../_kernel/root-audit.js';
import { ROLE_ADMIN } from '../_kernel/lock-session.js';
import { json, apiError } from '../_kernel/lib/http.js';
import { REALM_LOCK } from '../_kernel/realms.js';

/** 显示条数 */
export const AUDIT_SHOW = 50;

/** @param {any} context */
export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return apiError(500, 'server');
  }
}

/** @param {any} context */
async function handleGet(context) {
  const { request, env } = context;
  if (!(env && env[REALM_LOCK.d1Binding])) {
    return apiError(500, 'config');
  }

  const sess = await verifyLockSession(request, env);
  if (!sess.ok || sess.role !== ROLE_ADMIN) {
    return apiError(401, 'session');
  }
  try {
    return json(200, { ok: true, items: await listRootAudit(env, AUDIT_SHOW) });
  } catch (e) {
    return apiError(503, 'server');
  }
}
