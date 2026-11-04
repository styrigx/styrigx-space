/**
 * 进站凭证（SGX_LOCK_SPACE_KEY）使用审计列表：设置 → 服务状态页底部的「进站凭证使用记录」折叠区展开时才请求（apps/settings-status.js；
 * 前端同时请求账号 Worker 的 audit-list，合成一张表并标注「锁屏 / 账号」，方案 5.2）。
 *
 * GET /api/space-audit
 * - 进门 + 账号会话（方案 3.4 R7、定案第 9 条）：没进门 / 坏会话 → 401 session；账号会话无效 → 401 account（经 askAuthorizeFor 问账号 Worker）。
 *   不要 LockReauthTicket（展开不另加复验）：只读、不含凭证，但含 IP 前缀；服务状态页展开时它和账号审计 audit-list 合成一张表，后者本来就要账号会话。
 * - 返回最近 50 条审计（时间、IP 前缀、结果），新的在前；不返回 decoy / via / path 标记
 * - 只读；D1 失败 → 503
 *
 * 存储：D1 audit 表（realm = 'lock'，经 D1_LOCK_AUTH，core/space-audit.js）：一条 ORDER BY ts DESC LIMIT 50。
 * 账号拆分前写在 realm='root' 的旧审计行已在 PR4 由 --cleanup 删除（锁屏那一半先由 apply 拷成 realm='lock'）。
 */
import { verifyLockSession } from '../core/lock-session.js';
import { listSpaceAudit } from '../core/space-audit.js';
import { askAuthorizeFor } from '../core/account-rpc.js';
import { json, apiError } from '../lib/http.js';
import { REALM_LOCK } from '../core/realms.js';

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
  if (!sess.ok) {
    return apiError(401, 'session');
  }
  const account = await askAuthorizeFor(request, env);
  if (!account.ok) {
    return apiError(401, 'account');
  }
  try {
    return json(200, { ok: true, items: await listSpaceAudit(env, AUDIT_SHOW) });
  } catch (e) {
    return apiError(503, 'server');
  }
}
