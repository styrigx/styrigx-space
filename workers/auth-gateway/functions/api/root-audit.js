/**
 * 2.11：root 使用审计列表（供 UI 显示）。
 *
 * GET /api/root-audit
 * - 需要 admin 锁屏会话 + LockReauthTicket（sgx-lock-reauth）
 * - 返回最近 50 条 root-audit 记录（时间、IP 前缀、结果），新的在前
 * - 只读；KV 失败 → 503
 *
 * 键是 root-audit:<毫秒时间戳>:<随机>，kv.list 按键名升序返回（= 时间从旧到新），一页最多 1000 个。
 * 所以要翻完所有页、取最后 50 个，不能只拿第一页的前 50 个（那是窗口里最旧的 50 条）。
 * 最多翻 AUDIT_MAX_PAGES 页（7 天保留期内超过这个量时，显示的是这些页里最新的 50 条）。
 */
import { verifyLockSession } from '../_kernel/lock-session.js';
import { AUDIT_PREFIX } from '../_kernel/root-audit.js';
import { verifyLockReauthTicket } from '../_kernel/tickets.js';
import { ROLE_ADMIN } from '../_kernel/lock-session.js';

/** 显示条数 */
export const AUDIT_SHOW = 50;
/** 最多翻几页 kv.list（每页最多 1000 个键） */
export const AUDIT_MAX_PAGES = 20;

/** @param {any} context */
export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return Response.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

/** @param {any} context */
async function handleGet(context) {
  const { request, env } = context;
  const kv = env && env.KV_LOCK_DOOR;
  if (!kv) {
    return Response.json({ ok: false, error: 'config' }, { status: 500 });
  }

  const sess = await verifyLockSession(request, env);
  if (!sess.ok || sess.role !== ROLE_ADMIN) {
    return Response.json({ ok: false, error: 'session' }, { status: 401 });
  }
  const st = await verifyLockReauthTicket(request, env);
  if (!st.ok) {
    return Response.json({ ok: false, error: 'reauth', reason: st.reason }, { status: 403 });
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
    return Response.json({ ok: true, items: items.slice(0, AUDIT_SHOW) });
  } catch (e) {
    return Response.json({ ok: false, error: 'server' }, { status: 503 });
  }
}
