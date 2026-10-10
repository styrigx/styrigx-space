/**
 * 2.4.0 I：OWNER_KEY 门禁。
 * POST /api/owner-auth { key }
 * - 恒定时间比较 env.OWNER_KEY（SHA-256 后比较，防长度泄露）
 * - 限流：IP 连错 5 次锁 15 分钟；全局每小时失败 20 次暂停验证 1 小时
 * - 通过：签发 5 分钟有效的 token（SESSION_SECRET HMAC 签名，scope=owner-auth，用途前缀 "owner-auth|"）
 * 只接受 POST；校验 Origin。
 */
import { b64enc, b64urlEnc, timingSafeEqual, hmacSign } from '../_kernel/crypto.js';

/* 限流参数 */
const IP_MAX_FAIL = 5;
const IP_LOCK_MS = 15 * 60 * 1000;
const GLOBAL_MAX_FAIL = 20;
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;
const GLOBAL_PAUSE_MS = 60 * 60 * 1000;

/** @param {any} context */
export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return Response.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

/**
 * 获取客户端 IP。
 * @param {any} request
 */
function getClientIp(request) {
  return request.headers.get('CF-Connecting-IP') ||
         request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
         'unknown';
}

/** @param {any} context */
async function handlePost(context) {
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

  const kv = env && env.OWNER_KV;
  const ip = getClientIp(request);

  /* 全局限流检查 */
  if (kv) {
    try {
      const g = await kv.get('owner-auth-global', 'json');
      if (g && g.pausedUntil > Date.now()) {
        return Response.json({ ok: false, error: 'locked' }, { status: 429 });
      }
      /* 清理过期窗口 */
      if (g && g.windowStart + GLOBAL_WINDOW_MS < Date.now()) {
        await kv.delete('owner-auth-global');
      }
    } catch (e) {}
    /* IP 限流检查 */
    try {
      const rec = await kv.get('owner-auth-fail:' + ip, 'json');
      if (rec && rec.lockedUntil > Date.now()) {
        return Response.json({ ok: false, error: 'locked' }, { status: 429 });
      }
    } catch (e) {}
  }

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

  const ok = key && (await timingSafeEqual(String(key), String(ownerKey)));
  if (!ok) {
    /* 记录失败 */
    if (kv) {
      const now = Date.now();
      /* IP 计数 */
      try {
        const rec = (await kv.get('owner-auth-fail:' + ip, 'json')) || { count: 0 };
        rec.count = (rec.count || 0) + 1;
        if (rec.count >= IP_MAX_FAIL) {
          rec.lockedUntil = now + IP_LOCK_MS;
          rec.count = 0; /* 锁定后重置，下次解锁重新计 */
        }
        await kv.put('owner-auth-fail:' + ip, JSON.stringify(rec), { expirationTtl: 3600 });
      } catch (e) {}
      /* 全局计数 */
      try {
        const g = (await kv.get('owner-auth-global', 'json')) || { count: 0, windowStart: now };
        if (g.windowStart + GLOBAL_WINDOW_MS < now) {
          g.count = 0;
          g.windowStart = now;
        }
        g.count = (g.count || 0) + 1;
        if (g.count >= GLOBAL_MAX_FAIL) {
          g.pausedUntil = now + GLOBAL_PAUSE_MS;
          g.count = 0;
        }
        await kv.put('owner-auth-global', JSON.stringify(g), { expirationTtl: 7200 });
      } catch (e) {}
    }
    return Response.json({ ok: false }, { status: 403 });
  }

  /* 成功：清掉该 IP 的失败计数 */
  if (kv) {
    try { await kv.delete('owner-auth-fail:' + ip); } catch (e) {}
  }

  /* 签发 token（5 分钟，用途前缀 "owner-auth|"） */
  const payload = b64urlEnc(
    new TextEncoder().encode(JSON.stringify({ scope: 'owner-auth', exp: Date.now() + 300000 })).buffer
  );
  const sig = await hmacSign(sessionSecret, 'owner-auth|', payload);
  return Response.json({ ok: true, token: payload + '.' + sig });
}
