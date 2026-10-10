/**
 * 2.4.0 H：Turnstile 入站验证。
 * POST /api/verify { token }
 * - 用 TURNSTILE_SECRET 调 siteverify，校验 success、hostname、action
 * - hostname 接受：styrigx.com 及 www/blog/book 子域（widget 配置覆盖范围）
 * - 通过：返回 { ok: true } + 设 Ed25519 签名会话 cookie（含 session-epoch，
 *   与密码/passkey 同格式，middleware 验签；统一走 _kernel/session.js）
 * - KV 读取出错 → 503，绝不签发会话
 * - 失败：返回 { ok: false }
 * 只接受 POST；校验 Origin。
 */
import {
  issueSessionCookie,
  ROLE_VISITOR,
} from '../_kernel/session.js';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/* widget styrigx-lock 的 hostname 覆盖范围 */
const ALLOWED_HOSTNAMES = ['styrigx.com', 'www.styrigx.com', 'blog.styrigx.com', 'book.styrigx.com'];
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
  if (!ALLOWED_HOSTNAMES.includes(hostname)) {
    return Response.json({ ok: false, error: 'hostname' }, { status: 403 });
  }
  if (vr.action && vr.action !== ACTION) {
    return Response.json({ ok: false, error: 'action' }, { status: 403 });
  }

  /* 通过：签发 Ed25519 会话 cookie（fail closed：无密钥/签发失败 → 5xx，
     绝不静默跳过然后返回 ok:true） */
  const headers = new Headers({ 'Content-Type': 'application/json' });
  /* 2.8.0：Turnstile 只签 visitor（1 小时），没有主人权限 */
  const signErr = await issueSessionCookie(env, headers, ROLE_VISITOR);
  if (signErr) {
    return new Response(JSON.stringify(signErr.body), {
      status: signErr.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ ok: true }), { headers });
}
