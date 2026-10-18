/**
 * 2.11：root 使用审计列表（供 UI 显示）。
 *
 * GET /api/root-audit
 * - 需要 owner 会话 + stepup（任何 scope）
 * - 返回最近 50 条 root-auth-audit 记录（时间、IP 前缀、结果）
 * - 只读；KV 失败 → 503
 */
import { verifySessionDetailed } from '../_middleware.js';
import { verifyStepupCookie } from './stepup.js';
import { ROLE_OWNER } from '../_kernel/session.js';

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
  const kv = env && env.OWNER_KV;
  if (!kv) {
    return Response.json({ ok: false, error: 'config' }, { status: 500 });
  }

  const sess = await verifySessionDetailed(request, env);
  if (!sess.ok || sess.role !== ROLE_OWNER) {
    return Response.json({ ok: false, error: 'session' }, { status: 401 });
  }
  const st = await verifyStepupCookie(request, env);
  if (!st.ok) {
    return Response.json({ ok: false, error: 'stepup' }, { status: 403 });
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
