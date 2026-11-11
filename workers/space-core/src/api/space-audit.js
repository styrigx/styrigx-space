/**
 * 进站凭证使用审计列表（v6 P4-3 起恢复写入：定稿 v5.5 §四「进站审计接口与状态页审计卡保留，恢复写入：记录 v6 的 su / sudo，字段按第十节审计条」）：
 * 新行 = 账号侧身份审计（account_user_audit）里的 su / sudo（含登录失败），经 ACCOUNT_VERIFIER.auditList 读（会话在账号 Worker 重新判，root 档）；
 * 旧行 = 旧进站审计（D1 audit realm='lock'，不再有新行，7 天内自然过期），两者按时间合成一张表、新的在前、最多 AUDIT_SHOW 条。
 * 以下是旧说明：旷野 → 服务状态页（/status/）底部的「进站凭证使用记录」折叠区展开时才请求（apps/space-status.js；
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
    const fresh = await v6AuditItems(env, request);
    if (fresh === null) return apiError(503, 'server');
    const old = await listSpaceAudit(env, AUDIT_SHOW);
    return json(200, { ok: true, items: mergeAudit(fresh, old, AUDIT_SHOW) });
  } catch (e) {
    return apiError(503, 'server');
  }
}

/**
 * v6 的 su / sudo 审计（账号 Worker AccountVerifier.auditList）。没绑定 / 旧版本没有 auditList → []（只显示旧行）；读失败 → null。
 * @param {any} env @param {Request} request
 * @returns {Promise<Array<{ts:number, ipPrefix:string, ok:boolean, uid:number|null, command:string}>|null>}
 */
async function v6AuditItems(env, request) {
  const v = env && env.ACCOUNT_VERIFIER;
  if (!v || typeof v.auditList !== 'function') return [];
  try {
    const r = await v.auditList(request.headers.get('Cookie') || '');
    if (!r || r.ok !== true || !Array.isArray(r.items)) return null;
    return r.items;
  } catch (e) {
    return null;
  }
}

/**
 * 新旧两份按时间合成（新的在前），截到 max 条。
 * @param {any[]} a @param {any[]} b @param {number} max
 */
export function mergeAudit(a, b, max) {
  return a.concat(b).filter((x) => x && Number.isFinite(Number(x.ts))).sort((x, y) => Number(y.ts) - Number(x.ts)).slice(0, max);
}
