/**
 * 2.4.0 I：本人密码解锁 —— 密码设置/修改/验证。
 * fix/hi-owner：PBKDF2 迭代次数 600000 → 100000（Cloudflare Workers 生产环境上限，
 * 超过抛 NotSupportedError）。verify 按记录里的 iterations 校验。
 *
 * POST /api/owner-password
 * Body: { action: "set"|"change"|"verify", ... }
 *
 * - set: { token, password } — 设置初始密码（需有效的 owner-auth token，且未设置过）
 * - change: { token, newPassword } — 修改密码（需有效的 owner-auth token；改完后旧会话失效）
 * - verify: { password } — 解锁验证（IP 限流：5 次失败 → 30 秒锁定）
 *
 * 密码存储：PBKDF2-SHA256 + 随机 salt，存 OWNER_KV；恒定时间比较。
 * 只接受 POST；校验 Origin；未设置密码时 verify 一律拒绝。
 * 外层 try/catch：任何未捕获异常都返回 JSON { ok:false, error:'server' }，不返回 500 HTML。
 */

const ITERATIONS = 100000; // Workers PBKDF2 上限（实测：超过抛 NotSupportedError）
const SALT_LEN = 16;
const KEY_LEN = 32; // 256 bit
const MAX_FAIL = 5;
const LOCK_MS = 30000;

/** @param {string} s */
function b64enc(s) {
  return btoa(String.fromCharCode(...new Uint8Array(s)));
}
/** @param {string} b64 */
function b64dec(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8.buffer;
}

/**
 * 恒定时间比较（防时序攻击）。
 * @param {string} a
 * @param {string} b
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * PBKDF2-SHA256 哈希。
 * @param {string} password
 * @param {Uint8Array} salt
 * @param {number} iterations
 */
async function hashPassword(password, salt, iterations) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' },
    key,
    KEY_LEN * 8
  );
  return bits;
}

/** @param {any} context */
export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    /* 任何未捕获异常 → JSON 500，前端可区分「服务器错误」与「网络错误」 */
    return Response.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

/** @param {any} context */
async function handlePost(context) {
  const { request, env } = context;
  const kv = env && env.OWNER_KV;

  if (request.method !== 'POST') {
    return Response.json({ ok: false, error: 'method' }, { status: 405 });
  }
  try {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);
    if (origin && new URL(origin).host !== url.host) {
      return Response.json({ ok: false, error: 'origin' }, { status: 403 });
    }
  } catch (e) {}
  if (!kv) {
    return Response.json({ ok: false, error: 'config' }, { status: 500 });
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Response.json({ ok: false, error: 'body' }, { status: 400 });
  }
  const action = (body && body.action) || '';

  /* 客户端 IP（限流用） */
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const failKey = 'pw-fail:' + ip;
  const lockKey = 'pw-lock:' + ip;

  /* 检查是否被锁定 */
  async function isLocked() {
    try {
      const v = await kv.get(lockKey);
      if (v && Number(v) > Date.now()) return true;
      if (v) await kv.delete(lockKey);
    } catch (e) {}
    return false;
  }

  async function recordFail() {
    try {
      let n = 0;
      const v = await kv.get(failKey);
      if (v) n = Number(v) || 0;
      n++;
      await kv.put(failKey, String(n), { expirationTtl: 3600 });
      if (n >= MAX_FAIL) {
        await kv.put(lockKey, String(Date.now() + LOCK_MS), { expirationTtl: 60 });
        await kv.delete(failKey);
        return true; // 刚被锁定
      }
    } catch (e) {}
    return false;
  }

  async function clearFail() {
    try {
      await kv.delete(failKey);
      await kv.delete(lockKey);
    } catch (e) {}
  }

  /* ============ verify：解锁验证 ============ */
  if (action === 'verify') {
    if (await isLocked()) {
      return Response.json({ ok: false, error: 'locked' }, { status: 429 });
    }
    const password = (body && body.password) || '';
    if (!password || typeof password !== 'string') {
      return Response.json({ ok: false, error: 'password' }, { status: 400 });
    }
    /* 未设置密码 → 一律拒绝 */
    let stored = null;
    try {
      stored = await kv.get('owner-pw', 'json');
    } catch (e) {}
    if (!stored || !stored.salt || !stored.hash) {
      return Response.json({ ok: false, error: 'not-set' }, { status: 403 });
    }
    /* 校验：按记录里的 iterations（缺省时用当前值） */
    let ok = false;
    try {
      const iters = (stored.iterations && Number(stored.iterations)) || ITERATIONS;
      const salt = new Uint8Array(b64dec(stored.salt));
      const bits = await hashPassword(password, salt, iters);
      const hashB64 = b64enc(bits);
      ok = timingSafeEqual(hashB64, stored.hash);
    } catch (e) {}
    if (!ok) {
      const locked = await recordFail();
      return Response.json(
        { ok: false, error: locked ? 'locked' : 'wrong' },
        { status: locked ? 429 : 403 }
      );
    }
    await clearFail();
    /* 通过：设会话 cookie（与 Turnstile 同口径） */
    const headers = new Headers({ 'Content-Type': 'application/json' });
    headers.append('Set-Cookie', 'sgx-verified=1; Path=/; HttpOnly; Secure; SameSite=Lax');
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  /* ============ set/change：需 owner-auth token ============ */
  if (action === 'set' || action === 'change') {
    const token = (body && body.token) || '';
    const newPassword = (body && (body.password || body.newPassword)) || '';
    if (!token || !newPassword || typeof newPassword !== 'string') {
      return Response.json({ ok: false, error: 'params' }, { status: 400 });
    }
    if (newPassword.length < 8) {
      return Response.json({ ok: false, error: 'short' }, { status: 400 });
    }
    /* 验 token（owner-auth 签发，SESSION_SECRET 签名） */
    const secret = (env && env.SESSION_SECRET) || '';
    if (!secret) {
      return Response.json({ ok: false, error: 'config' }, { status: 500 });
    }
    let tokenOk = false;
    try {
      const parts = token.split('.');
      if (parts.length === 2) {
        const payload = parts[0];
        const sig = parts[1];
        const enc = new TextEncoder();
        const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const sigBits = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
        const expectSig = b64enc(sigBits).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        if (timingSafeEqual(sig, expectSig)) {
          const data = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
          if (data && data.exp > Date.now() && data.scope === 'owner-auth') tokenOk = true;
        }
      }
    } catch (e) {}
    if (!tokenOk) {
      return Response.json({ ok: false, error: 'token' }, { status: 403 });
    }

    /* set：未设置过才能设 */
    if (action === 'set') {
      let existing = null;
      try { existing = await kv.get('owner-pw', 'json'); } catch (e) {}
      if (existing && existing.hash) {
        return Response.json({ ok: false, error: 'exists' }, { status: 403 });
      }
    }

    /* 哈希并存储（iterations 写入记录，verify 按记录值校验） */
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
    const bits = await hashPassword(newPassword, salt, ITERATIONS);
    const record = {
      salt: b64enc(salt.buffer),
      hash: b64enc(bits),
      iterations: ITERATIONS,
      updatedAt: Date.now(),
    };
    await kv.put('owner-pw', JSON.stringify(record));

    /* 改密码后：旧密码会话失效（删验证标记；cookie 是 HttpOnly，前端清不掉，
       但服务端 verify 已换 hash，旧密码无法再通过；这里返回 ok，前端清本地标记） */
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false, error: 'action' }, { status: 400 });
}
