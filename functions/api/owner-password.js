/**
 * 2.4.0 I：本人密码解锁 —— 密码设置/修改/验证。
 * fix/hi-owner：PBKDF2 迭代次数 600000 → 100000（Cloudflare Workers 生产环境上限，
 * 超过抛 NotSupportedError）。verify 按记录里的 iterations 校验。
 *
 * POST /api/owner-password
 * Body: { action: "set"|"change"|"verify"|"remove", ... }
 *
 * - set: { token, password } — 设置初始密码（需有效的 owner-auth token，且未设置过）
 * - change: { token, newPassword } — 修改密码（需有效的 owner-auth token；改完后旧会话失效）
 * - verify: { password } — 解锁验证（IP 限流：5 次失败 → 30 秒锁定）
 * - remove: { token } — 删除解锁密码（需有效的 owner-auth token；同时清 pw-fail:* 和 pw-lock:*）
 *
 * 密码存储：PBKDF2-SHA256 + 随机 salt，存 OWNER_KV；恒定时间比较（SHA-256 后比较）。
 * 会话可吊销：KV 存 session-epoch，Ed25519(SGX_ED25519_PRIVATE) 签进 cookie；
 * 改密码/删密码/lockout 时 +1，旧 cookie 失效。
 * sgx-verified cookie 的设置/清除统一走 _lib/session.js（属性只定义一处）。
 * KV 读取出错时抛错→接口返回 503，绝不继续写入。
 * 只接受 POST；校验 Origin；未设置密码时 verify 一律拒绝。
 * 外层 try/catch：任何未捕获异常都返回 JSON { ok:false, error:'server' }，不返回 500 HTML。
 */
import { b64enc, b64dec, timingSafeEqual, hmacVerify } from '../_lib/crypto.js';
import {
  setVerifiedCookie,
  clearVerifiedCookie,
  signSessionCookie,
  getSessionEpoch,
  bumpSessionEpoch,
} from '../_lib/session.js';

const ITERATIONS = 100000; // Workers PBKDF2 上限（实测：超过抛 NotSupportedError）
const SALT_LEN = 16;
const KEY_LEN = 32; // 256 bit
const MAX_FAIL = 5;
const LOCK_MS = 30000;
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

/**
 * 验 owner-auth token（owner-auth 签发，SESSION_SECRET 签名，用途前缀 "owner-auth|"）。
 * @param {string} token
 * @param {string} secret
 */
async function verifyOwnerToken(token, secret) {
  if (!token || !secret) return false;
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const payload = parts[0];
    const sig = parts[1];
    if (!(await hmacVerify(secret, 'owner-auth|', payload, sig))) return false;
    const data = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return !!(data && data.exp > Date.now() && data.scope === 'owner-auth');
  } catch (e) {
    return false;
  }
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
      ok = await timingSafeEqual(hashB64, stored.hash);
    } catch (e) {}
    if (!ok) {
      const locked = await recordFail();
      return Response.json(
        { ok: false, error: locked ? 'locked' : 'wrong' },
        { status: locked ? 429 : 403 }
      );
    }
    await clearFail();
    /* 通过：设 Ed25519 签名会话 cookie（与 passkey/Turnstile 同格式，middleware 验签） */
    const headers = new Headers({ 'Content-Type': 'application/json' });
    const edPriv = (env && env.SGX_ED25519_PRIVATE) || '';
    if (edPriv) {
      let ver;
      try {
        ver = await getSessionEpoch(kv);
      } catch (e) {
        /* KV 读取出错：抛错→503，绝不签发会话 */
        return new Response(JSON.stringify({ ok: false, error: 'server' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const cv = await signSessionCookie(edPriv, ver);
      setVerifiedCookie(headers, cv);
    }
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  /* ============ set/change/remove：需 owner-auth token ============ */
  if (action === 'set' || action === 'change' || action === 'remove' || action === 'lockout') {
    const token = (body && body.token) || '';
    const secret = (env && env.SESSION_SECRET) || '';
    if (!secret) {
      return Response.json({ ok: false, error: 'config' }, { status: 500 });
    }
    if (!token || !(await verifyOwnerToken(token, secret))) {
      return Response.json({ ok: false, error: 'token' }, { status: 403 });
    }

    /* lockout：立即锁定并退出所有设备（session-epoch +1，用 Set-Cookie 清当前 cookie） */
    if (action === 'lockout') {
      try {
        await bumpSessionEpoch(kv);
      } catch (e) {
        /* KV 出错：绝不写入，返回 503 */
        return Response.json({ ok: false, error: 'server' }, { status: 503 });
      }
      const headers = new Headers({ 'Content-Type': 'application/json' });
      clearVerifiedCookie(headers);
      return new Response(JSON.stringify({ ok: true }), { headers });
    }

    /* remove：删除解锁密码，同时清掉失败计数和锁定 */
    if (action === 'remove') {
      try {
        await kv.delete('owner-pw');
      } catch (e) {
        return Response.json({ ok: false, error: 'server' }, { status: 503 });
      }
      /* 清掉所有 pw-fail:* 和 pw-lock:*（IP 限流残留） */
      try {
        const list = await kv.list({ prefix: 'pw-fail:' });
        for (const k of list.keys || []) { try { await kv.delete(k.name); } catch (e) {} }
      } catch (e) {}
      try {
        const list = await kv.list({ prefix: 'pw-lock:' });
        for (const k of list.keys || []) { try { await kv.delete(k.name); } catch (e) {} }
      } catch (e) {}
      /* 会话吊销：session-epoch +1（KV 出错→503，绝不继续） */
      try {
        await bumpSessionEpoch(kv);
      } catch (e) {
        return Response.json({ ok: false, error: 'server' }, { status: 503 });
      }
      return Response.json({ ok: true });
    }

    const newPassword = (body && (body.password || body.newPassword)) || '';
    if (!newPassword || typeof newPassword !== 'string') {
      return Response.json({ ok: false, error: 'params' }, { status: 400 });
    }
    if (newPassword.length < 8) {
      return Response.json({ ok: false, error: 'short' }, { status: 400 });
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
    try {
      await kv.put('owner-pw', JSON.stringify(record));
    } catch (e) {
      return Response.json({ ok: false, error: 'server' }, { status: 503 });
    }

    /* 改密码后：session-epoch +1，旧会话 cookie 失效（KV 出错→503） */
    try {
      await bumpSessionEpoch(kv);
    } catch (e) {
      return Response.json({ ok: false, error: 'server' }, { status: 503 });
    }
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false, error: 'action' }, { status: 400 });
}
