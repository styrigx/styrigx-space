/**
 * 旧进站凭证使用审计列表（v6 P4 起只读、不再有新行）：旷野 → 服务状态页（/status/）底部的「进站凭证使用记录」折叠区展开时才请求（apps/space-status.js；
 * 前端同时请求账号 Worker 的 audit-list，合成一张表并标注「锁屏 / 账号」，方案 5.2）。
 *
 * GET /api/space-audit
 * - v6 P4 起只认 v6 会话：路由档 root（账号 Worker 判）；没身份 → 401 session；有身份不是 root → 403 forbidden。只读、不含凭证，但含 IP 前缀。
 * - 返回最近 50 条审计（时间、IP 前缀、结果），新的在前；不返回 decoy / via / path 标记
 * - 只读；D1 失败 → 503
 *
 *
 * 存储：D1 audit 表（realm = 'lock'，经 D1_SPACE，core/space-audit.js）：一条 ORDER BY ts DESC LIMIT 50。
 * 账号拆分前写在 realm='root' 的旧审计行已在 PR4 由 --cleanup 删除（锁屏那一半先由 apply 拷成 realm='lock'）。
 */
import { listSpaceAudit } from '../core/space-audit.js';
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

  /* v6 P4：只认 v6 会话的路由档（root，账号 Worker 判）；有 v6 身份但不是 root → 403；没身份 → 401 session */
  const v6 = await newSessionConclusion(env, request);
  if (!v6.allowed) return v6.signedIn ? apiError(403, 'forbidden') : apiError(401, 'session');
  try {
    return json(200, { ok: true, items: await listSpaceAudit(env, AUDIT_SHOW) });
  } catch (e) {
    return apiError(503, 'server');
  }
}
