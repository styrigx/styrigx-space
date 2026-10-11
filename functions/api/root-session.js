/**
 * 2.11 定稿：root 代开锁屏会话。
 *
 * 未配置 lock 层凭证时，root 可用 stepup(by=root, scope=root) 代开锁屏会话。
 * - 会话约 1 小时（短于正常的 12 小时）
 * - 会话 by=root，标记为代开
 * - lock 层一旦配置自己的凭证，root 代开失效（403）
 * - KV 读取失败按已配置处理（拒绝，fail closed）
 *
 * POST /api/root-session
 * - 需要有效的 stepup(by=root, scope=root) cookie（不验 owner 会话，
 *   因为代开场景下用户可能还没有任何会话）
 *
 * 只接受 POST；校验 Origin。
 */
import { issueSessionCookie, ROLE_OWNER, BY_ROOT } from '../_kernel/session.js';
import { verifyStepupCookie, STEPUP_BY_ROOT, STEPUP_SCOPE_ROOT } from './stepup.js';
import { checkRootTakeover, LAYER_LOCK } from '../_kernel/layers.js';

/* root 代开的会话时长：约 1 小时 */
const ROOT_SESSION_MAX_AGE = 3600;

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
  if (request.method !== 'POST') {
    return Response.json({ ok: false }, { status: 405 });
  }
  /* Origin 校验 */
  {
    const origin = request.headers.get('Origin') || '';
    let originOk = false;
    try {
      const url = new URL(request.url);
      originOk = !!origin && new URL(origin).host === url.host;
    } catch (e) {
      originOk = false;
    }
    if (!originOk) {
      return Response.json({ ok: false, error: 'origin' }, { status: 403 });
    }
  }

  const kv = env && env.OWNER_KV;
  if (!kv) {
    return Response.json({ ok: false, error: 'config' }, { status: 500 });
  }

  /* 验 stepup：必须是 by=root, scope=root */
  const st = await verifyStepupCookie(request, env);
  if (!st.ok) {
    return Response.json({ ok: false, error: 'stepup' }, { status: 403 });
  }
  if (st.by !== STEPUP_BY_ROOT || st.scope !== STEPUP_SCOPE_ROOT) {
    return Response.json({ ok: false, error: 'scope' }, { status: 403 });
  }

  /* 检查 lock 层是否已配置：已配置（含 KV 读失败按已配置）则 root 代开失效 */
  const takeover = await checkRootTakeover(kv, LAYER_LOCK);
  if (!takeover.allowed) {
    return Response.json({ ok: false, error: 'configured' }, { status: 403 });
  }

  /* 签发 by=root 的 owner 会话，约 1 小时 */
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const sessErr = await issueSessionCookie(env, headers, ROLE_OWNER, BY_ROOT, ROOT_SESSION_MAX_AGE);
  if (sessErr) {
    return new Response(JSON.stringify(sessErr.body), {
      status: sessErr.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ ok: true, by: 'root', takeover: true }), { headers });
}
