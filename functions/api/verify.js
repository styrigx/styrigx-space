/**
 * 2.4.0 H：Turnstile 入站验证。
 * POST /api/verify { token }
 * - 用 TURNSTILE_SECRET 调 siteverify，校验 success、hostname、action
 * - hostname 接受：styrigx.com 及 www/blog/book 子域（widget 配置覆盖范围）
 * - 通过：返回 { ok: true } + 设会话 cookie（HttpOnly; Secure; SameSite=Lax；无 Max-Age）
 * - 失败：返回 { ok: false }
 * 只接受 POST；校验 Origin。
 */

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/* widget styrigx-lock 的 hostname 覆盖范围 */
const ALLOWED_HOSTNAMES = ['styrigx.com', 'www.styrigx.com', 'blog.styrigx.com', 'book.styrigx.com'];
const ACTION = 'sgx-entry';

/**
 * 签名会话 cookie 值：exp.HMAC(SESSION_SECRET, exp)，24 小时有效。
 * 防伪造：无签名的值服务端不认。
 * @param {string} secret
 */
async function signVerifiedCookie(secret) {
  const exp = String(Date.now() + 86400000);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBits = await crypto.subtle.sign('HMAC', key, enc.encode(exp));
  let s = '';
  const u8 = new Uint8Array(sigBits);
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  const sig = btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return exp + '.' + sig;
}

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

  /* 通过：设签名会话 cookie（SESSION_SECRET HMAC + 24h 过期，防伪造） */
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const sessionSecret = (env && env.SESSION_SECRET) || '';
  if (sessionSecret) {
    const cv = await signVerifiedCookie(sessionSecret);
    headers.append('Set-Cookie', 'sgx-verified=' + cv + '; Path=/; HttpOnly; Secure; SameSite=Lax');
  }
  return new Response(JSON.stringify({ ok: true }), { headers });
}
