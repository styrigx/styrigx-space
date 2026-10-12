/**
 * 清除 stepup 票据。
 *
 * POST /api/stepup-clear
 * 下发 `sgx-stepup=; Max-Age=0`（与签发时相同的 STEPUP_COOKIE_ATTRS），
 * 服务端清除 HttpOnly cookie。只清 stepup，不动 sgx-verified（站长会话不变）。
 *
 * 调用资格（任一满足即可）：
 * - 有效的 owner 会话（站长在锁屏管理页点「退出站长凭证」）
 * - 有效的 sgx-stepup 票据（含 scope=lockreset，重置流程的「完成」按钮用）
 *
 * 只接受 POST；校验 Origin；外层 try/catch 异常一律 { ok:false, error:'server' }。
 */
import { verifySessionDetailed } from '../_middleware.js';
import { verifyStepupCookie, STEPUP_COOKIE, STEPUP_COOKIE_ATTRS } from './stepup.js';
import { ROLE_OWNER } from '../_kernel/session.js';

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
    return Response.json({ ok: false, error: 'method' }, { status: 405 });
  }
  /* Origin 校验（CSRF 防护），与 stepup.js 一致 */
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

  /* 调用资格：有效 owner 会话，或有效 stepup 票据（含 lockreset） */
  let authed = false;
  try {
    const sess = await verifySessionDetailed(request, env);
    if (sess.ok && sess.role === ROLE_OWNER) authed = true;
  } catch (e) {}
  if (!authed) {
    try {
      const st = await verifyStepupCookie(request, env);
      if (st.ok) authed = true;
    } catch (e) {}
  }
  if (!authed) {
    return Response.json({ ok: false, error: 'auth' }, { status: 401 });
  }

  /* 清除 sgx-stepup：与签发相同的属性 + Max-Age=0 */
  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.append(
    'Set-Cookie',
    STEPUP_COOKIE + '=; ' + STEPUP_COOKIE_ATTRS + '; Max-Age=0'
  );
  return new Response(JSON.stringify({ ok: true }), { headers });
}
