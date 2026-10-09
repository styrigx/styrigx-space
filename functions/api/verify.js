/**
 * 2.4.0 H：Turnstile 入站验证。
 * POST /api/verify { token }
 * - 用 TURNSTILE_SECRET 调 siteverify，校验 success、hostname（styrigx.com）、action
 * - 通过：返回 { ok: true } + 设会话 cookie（HttpOnly; Secure; SameSite=Lax；无 Max-Age）
 * - 失败：返回 { ok: false }
 * 只接受 POST；校验 Origin。
 */

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const HOSTNAME = 'styrigx.com';
const ACTION = 'sgx-entry';

/**
 * @param {any} context
 */
export async function onRequestPost(context) {
  const { request, env } = context;

  /* 只接受 POST */
  if (request.method !== 'POST') {
    return Response.json({ ok: false, error: 'method' }, { status: 405 });
  }

  /* 校验 Origin（防 CSRF） */
  try {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);
    if (origin && new URL(origin).host !== url.host) {
      return Response.json({ ok: false, error: 'origin' }, { status: 403 });
    }
  } catch (e) {}

  let token = '';
  try {
    const body = await request.json();
    token = (body && body.token) || '';
  } catch (e) {}
  if (!token) {
    return Response.json({ ok: false, error: 'token' }, { status: 400 });
  }

  const secret = (env && env.TURNSTILE_SECRET) || '';
  if (!secret) {
    return Response.json({ ok: false, error: 'config' }, { status: 500 });
  }

  /* 调 siteverify */
  let vr;
  try {
    const form = new FormData();
    form.append('secret', secret);
    form.append('response', token);
    const r = await fetch(SITEVERIFY, { method: 'POST', body: form });
    vr = await r.json();
  } catch (e) {
    return Response.json({ ok: false, error: 'verify' }, { status: 502 });
  }

  /* 校验 success、hostname、action */
  if (!vr || vr.success !== true) {
    return Response.json({ ok: false, error: 'failed' }, { status: 403 });
  }
  const hostname = vr.hostname || '';
  if (hostname !== HOSTNAME && hostname !== 'www.' + HOSTNAME) {
    return Response.json({ ok: false, error: 'hostname' }, { status: 403 });
  }
  if (vr.action && vr.action !== ACTION) {
    return Response.json({ ok: false, error: 'action' }, { status: 403 });
  }

  /* 通过：设会话 cookie（无 Max-Age，浏览器关闭即失效） */
  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.append(
    'Set-Cookie',
    'sgx-verified=1; Path=/; HttpOnly; Secure; SameSite=Lax'
  );
  return new Response(JSON.stringify({ ok: true }), { headers });
}
