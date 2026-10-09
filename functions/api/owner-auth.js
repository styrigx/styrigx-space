/**
 * 2.4.0 I：OWNER_KEY 门禁。
 * POST /api/owner-auth { key }
 * - 恒定时间比较 env.OWNER_KEY
 * - 通过：签发 10 分钟有效的 token（SESSION_SECRET HMAC 签名，scope=owner-auth）
 * 只接受 POST；校验 Origin。
 */

/** @param {string} s */
function b64enc(s) {
  return btoa(String.fromCharCode(...new Uint8Array(s)));
}

/** @param {string} a @param {string} b */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** @param {any} context */
export async function onRequestPost(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return Response.json({ ok: false }, { status: 405 });
  }
  try {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);
    if (origin && new URL(origin).host !== url.host) {
      return Response.json({ ok: false }, { status: 403 });
    }
  } catch (e) {}

  let key = '';
  try {
    const body = await request.json();
    key = (body && body.key) || '';
  } catch (e) {}
  const ownerKey = (env && env.OWNER_KEY) || '';
  const sessionSecret = (env && env.SESSION_SECRET) || '';
  if (!ownerKey || !sessionSecret) {
    return Response.json({ ok: false }, { status: 500 });
  }
  if (!key || !timingSafeEqual(String(key), String(ownerKey))) {
    /* 恒定时间比较；失败不透露原因 */
    return Response.json({ ok: false }, { status: 403 });
  }

  /* 签发 token（10 分钟） */
  const payload = b64enc(
    new TextEncoder().encode(JSON.stringify({ scope: 'owner-auth', exp: Date.now() + 600000 })).buffer
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey('raw', enc.encode(sessionSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBits = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(payload));
  const sig = b64enc(sigBits).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return Response.json({ ok: true, token: payload + '.' + sig });
}
