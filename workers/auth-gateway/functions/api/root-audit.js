/**
 * 根凭证（RootKey）使用审计列表：账号 → 服务状态页底部的「根凭证使用记录」折叠区展开时才请求（apps/account-status.js）。
 *
 * GET /api/root-audit
 * - 只要 admin 锁屏会话（访客 / 无会话 / 坏会话 → 401 session）。不要 LockReauthTicket：
 *   只读、不含凭证；页面在账号区里，访客被网关 302 出 /account/*，管理员已解锁；这里仍在服务端校验 admin，防直接调接口。
 * - 返回最近 50 条 root-audit 记录（时间、IP 前缀、结果），新的在前；不返回 decoy / via / path 标记
 * - 只读；KV 失败 → 503
 *
 * 键是 root-audit:<毫秒时间戳>:<随机>，kv.list 按键名升序返回（= 时间从旧到新），一页最多 1000 个。
 * 所以要翻完所有页、取最后 50 个，不能只拿第一页的前 50 个（那是窗口里最旧的 50 条）。
 * 最多翻 AUDIT_MAX_PAGES 页（7 天保留期内超过这个量时，显示的是这些页里最新的 50 条）。
 */
import { verifyLockSession } from '../_kernel/lock-session.js';
import { AUDIT_PREFIX } from '../_kernel/root-audit.js';
import { ROLE_ADMIN } from '../_kernel/lock-session.js';
import { json, apiError } from '../_kernel/http.js';

/** 显示条数 */
export const AUDIT_SHOW = 50;
/** 最多翻几页 kv.list（每页最多 1000 个键） */
export const AUDIT_MAX_PAGES = 20;

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
  const kv = env && env.KV_LOCK_DOOR;
  if (!kv) {
    return apiError(500, 'config');
  }

  const sess = await verifyLockSession(request, env);
  if (!sess.ok || sess.role !== ROLE_ADMIN) {
    return apiError(401, 'session');
  }
  try {
    /* 翻页取键名，只留最后（最新）AUDIT_SHOW 个 */
    let names = [];
    let cursor = undefined;
    for (let page = 0; page < AUDIT_MAX_PAGES; page++) {
      const list = await kv.list(cursor ? { prefix: AUDIT_PREFIX, cursor: cursor } : { prefix: AUDIT_PREFIX });
      for (const k of (list && list.keys) || []) names.push(k.name);
      if (names.length > AUDIT_SHOW) names = names.slice(-AUDIT_SHOW);
      if (!list || list.list_complete !== false || !list.cursor) break;
      cursor = list.cursor;
    }
    const items = [];
    const recs = await Promise.all(names.map(function (name) {
      return kv.get(name, 'json').catch(function () { return null; });
    }));
    for (const v of recs) {
      if (v) items.push({ ts: v.ts, ipPrefix: v.ipPrefix, ok: !!v.ok });
    }
    items.sort((a, b) => b.ts - a.ts);
    return json(200, { ok: true, items: items.slice(0, AUDIT_SHOW) });
  } catch (e) {
    return apiError(503, 'server');
  }
}
