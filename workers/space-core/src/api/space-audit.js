/**
 * 进站凭证（SGX_SPACE_RECOVERY_KEY）使用审计列表：旷野 → 服务状态页（/status/）底部的「进站凭证使用记录」折叠区展开时才请求（apps/space-status.js；
 * 前端同时请求账号 Worker 的 audit-list，合成一张表并标注「锁屏 / 账号」，方案 5.2）。
 *
 * GET /api/space-audit
 * - 进门 + 账号会话（方案 3.4 R7、定案第 9 条）：没进门 / 坏会话 → 401 session；账号会话无效 → 401 account（经 askAuthorizeFor 问账号 Worker）。
 *   不要 LockReauthTicket（展开不另加复验）：只读、不含凭证，但含 IP 前缀；服务状态页展开时它和账号审计 audit-list 合成一张表，后者本来就要账号会话。
 * - 返回最近 50 条审计（时间、IP 前缀、结果），新的在前；不返回 decoy / via / path 标记
 * - 只读；D1 失败 → 503
 *
 * v6（割接）：旧进站会话 / 账号会话不成立时，v6 新会话的档够（root，账号 Worker 判）也给看；有 v6 身份但不是 root 403 forbidden（2b）；
 * 两样都没有照旧 401 session / account。
 *
 * 存储：D1 audit 表（realm = 'lock'，经 D1_SPACE，core/space-audit.js）：一条 ORDER BY ts DESC LIMIT 50。
 * 账号拆分前写在 realm='root' 的旧审计行已在 PR4 由 --cleanup 删除（锁屏那一半先由 apply 拷成 realm='lock'）。
 */
import { verifyLockSession } from '../core/lock-session.js';
import { listSpaceAudit } from '../core/space-audit.js';
import { askAuthorizeFor } from '../core/account-rpc.js';
import { json, apiError } from '../lib/http.js';
import { REALM_LOCK } from '../core/realms.js';
import { newSessionConclusion } from '../core/identity-admit.js';

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
  const account = sess.ok ? await askAuthorizeFor(request, env) : { ok: false };
  if (!sess.ok || !account.ok) {
    const v6 = await newSessionConclusion(env, request);
    if (!v6.allowed) return v6.signedIn ? apiError(403, 'forbidden') : apiError(401, sess.ok ? 'account' : 'session'); /* 2b：有 v6 身份但不是 root → 403 */
  }
  try {
    return json(200, { ok: true, items: await listSpaceAudit(env, AUDIT_SHOW) });
  } catch (e) {
    return apiError(503, 'server');
  }
}
