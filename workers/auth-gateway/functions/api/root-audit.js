/**
 * 2.11：root 使用审计列表（供 UI 显示）。
 *
 * GET /api/root-audit
 * - 需要 owner 会话 + 锁屏门票（sgx-door，door=lock）
 * - 返回最近 50 条 root-auth-audit 记录（时间、IP 前缀、结果）
 * - 只读；KV 失败 → 503
 */
import { verifySessionDetailed } from '../_middleware.js';
import { verifyDoorCookie, DOOR_LOCK } from '../_kernel/tickets.js';
import { ROLE_OWNER } from '../_kernel/lock-session.js';

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

  const sess = await verifySessionDetailed(request, env);
  if (!sess.ok || sess.role !== ROLE_OWNER) {
    return Response.json({ ok: false, error: 'session' }, { status: 401 });
  }
  const st = await verifyDoorCookie(request, env, DOOR_LOCK);
  if (!st.ok) {
    return Response.json({ ok: false, error: 'door', reason: st.reason }, { status: 403 });
  }

  try {
    const list = await kv.list({ prefix: 'root-auth-audit:', limit: 50 });
    const items = [];
    for (const k of list.keys || []) {
      try {
        const v = await kv.get(k.name, 'json');
        if (v) items.push({ ts: v.ts, ipPrefix: v.ipPrefix, ok: !!v.ok });
      } catch (e) {}
    }
    items.sort((a, b) => b.ts - a.ts);
    return Response.json({ ok: true, items: items.slice(0, 50) });
  } catch (e) {
    return Response.json({ ok: false, error: 'server' }, { status: 503 });
  }
}
