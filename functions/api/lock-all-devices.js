/**
 * 2.8.0：锁定所有设备 —— 独立 L2 API（从 owner-password 的 lockout action 拆出）。
 *
 * POST /api/lock-all-devices
 * - 只允许 owner 会话调用（L1 middleware 已按 OWNER_ONLY_APIS 拒绝 visitor → 403；
 *   本接口再做一次角色校验，纵深防御）。
 * - 无会话 → 401；visitor 会话 → 403 {ok:false, error:'role'}。
 * - 逻辑：KV session-epoch +1（所有设备旧 cookie 失效），用 Set-Cookie 清当前 cookie。
 * - 返回 {ok:true}。
 *
 * 注意：blog/book 缓存 epoch 约 60 秒，锁定后最多 60 秒内在 blog/book 生效。
 * 只接受 POST；外层 try/catch：任何未捕获异常都返回 JSON { ok:false, error:'server' }。
 */
import { verifySessionDetailed } from '../_middleware.js';
import {
  clearVerifiedCookie,
  bumpSessionEpoch,
  ROLE_OWNER,
} from '../_kernel/session.js';

/** @param {any} context */
export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return Response.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

/** @param {any} context */
async function handlePost(context) {
  const { request, env } = context;
  const kv = env && env.OWNER_KV;
  if (!kv) {
    return Response.json({ ok: false, error: 'config' }, { status: 500 });
  }

  /* 会话校验：必须是 owner。L1 已拒绝 visitor（403），这里再验一次。 */
  const sess = await verifySessionDetailed(request, env);
  if (!sess.ok) {
    return Response.json({ ok: false }, { status: 401 });
  }
  if (sess.role !== ROLE_OWNER) {
    return Response.json({ ok: false, error: 'role' }, { status: 403 });
  }

  /* session-epoch +1：KV 出错 → 503，绝不继续 */
  try {
    await bumpSessionEpoch(kv);
  } catch (e) {
    return Response.json({ ok: false, error: 'server' }, { status: 503 });
  }

  /* 清当前 cookie（带 Domain=.styrigx.com，三站一起锁） */
  const headers = new Headers({ 'Content-Type': 'application/json' });
  clearVerifiedCookie(headers);
  return new Response(JSON.stringify({ ok: true }), { headers });
}
