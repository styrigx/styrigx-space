/**
 * 2.11：SGX_ROOT_KEY = 根凭证（恢复用）。
 *
 * 未解锁也能用：校验 SGX_ROOT_KEY 通过后，签发：
 * - sgx-stepup(by=root, scope=root)（约 10 分钟，带当前 epoch）
 *   只能管理 owner passkey / owner 密码（入口 1）
 *
 * 根接管：某层未配置自己的凭证时，root 可代开该层：
 * - 未配 owner → root 可用 scope=root 票进入口 2（管理 lock/APP）
 * - 未配 lock → root 可开锁屏会话（约 1 小时）
 * - 某 aud 未配 app key → root 可代开该 app
 * 该层一旦配置自己的凭证，root 对该层失效（403）。
 * "是否已配置"从 KV 读；KV 读取失败 fail closed，拒绝 root。
 *
 * 不能签 sgx-app。
 *
 * POST /api/root-auth { key }
 * - 恒定时间比较 env.SGX_ROOT_KEY（防长度泄露）
 * - 限流：IP 连错 5 次锁 15 分钟；全局每小时失败 20 次暂停验证 1 小时
 *   KV 读写出错一律拒绝（fail closed）；所有 root 路径共用一套限速/审计
 * - 通过：签发 sgx-stepup(by=root, scope=root) cookie
 * - 失败：401 auth（并计数）；超限：429
 * - 缺 SGX_ROOT_KEY / SGX_STEPUP_PRIVATE → 拒绝（500/503）
 *
 * 审计：每次使用（成功/失败）都在 KV 留一条记录：
 *   root-auth-audit:<ts>:<rand> = { ts, ipPrefix, ok }，TTL 7 天。
 *   写入失败则不签发（fail closed）。
 *
 * 只接受 POST；校验 Origin（缺失/解析失败 403）。
 * 旧 /api/owner-auth 不再可用。
 */
import { timingSafeEqual } from '../_kernel/crypto.js';
import { getSessionEpoch } from '../_kernel/session.js';
import { signStepupCookie, STEPUP_COOKIE, STEPUP_COOKIE_ATTRS, STEPUP_MAX_AGE, STEPUP_BY_ROOT, STEPUP_SCOPE_ROOT } from './stepup.js';

/* 限流参数 */
const IP_MAX_FAIL = 5;
const IP_LOCK_MS = 15 * 60 * 1000;
const GLOBAL_MAX_FAIL = 20;
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;
const GLOBAL_PAUSE_MS = 60 * 60 * 1000;
/* 审计记录 TTL：7 天 */
const AUDIT_TTL = 7 * 24 * 3600;

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

/**
 * IP 前缀（审计用，不存完整 IP）。
 * IPv4 取前 3 段，IPv6 取前 4 组，其他取前 12 字符。
 */
function ipPrefix(ip) {
  if (!ip || ip === 'unknown') return 'unknown';
  if (ip.includes('.')) {
    const parts = ip.split('.');
    return parts.length >= 3 ? parts.slice(0, 3).join('.') + '.x' : ip;
  }
  if (ip.includes(':')) {
    const parts = ip.split(':');
    return parts.slice(0, 4).join(':') + '::x';
  }
  return String(ip).slice(0, 12);
}

/**
 * 写审计记录（只写不读）。
 * 2.10.2：写入失败返回 false（调用方 fail closed，不签发会话）；
 * 无 KV 时也返回 false。
 * @returns {Promise<boolean>} 是否写入成功
 */
async function writeAudit(kv, ip, ok) {
  if (!kv) return false;
  try {
    const key = 'root-auth-audit:' + Date.now() + ':' + Math.random().toString(36).slice(2, 10);
    await kv.put(key, JSON.stringify({ ts: Date.now(), ipPrefix: ipPrefix(ip), ok: !!ok }), { expirationTtl: AUDIT_TTL });
    return true;
  } catch (e) {
    return false;
  }
}

/** @param {any} context */
async function handlePost(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return Response.json({ ok: false }, { status: 405 });
  }
  /* 2.10.2：Origin 必须存在、可解析且 host 一致（CSRF 防护）；
     缺失或解析失败一律 403，不再放行。 */
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
  const ip = getClientIp(request);

  /* 缺关键配置 → 直接拒绝（fail closed） */
  const rootKey = (env && env.SGX_ROOT_KEY) || '';
  const stepupKey = (env && env.SGX_STEPUP_PRIVATE) || '';
  if (!rootKey) {
    await writeAudit(kv, ip, false);
    return Response.json({ ok: false, error: 'config' }, { status: 500 });
  }
  if (!stepupKey) {
    await writeAudit(kv, ip, false);
    return Response.json({ ok: false, error: 'no-stepup-key' }, { status: 500 });
  }
  if (!kv) {
    return Response.json({ ok: false, error: 'config' }, { status: 500 });
  }

  /* 限流检查：KV 出错一律拒绝（fail closed） */
  try {
    const g = await kv.get('root-auth-global', 'json');
    if (g && g.pausedUntil > Date.now()) {
      await writeAudit(kv, ip, false);
      return Response.json({ ok: false, error: 'locked' }, { status: 429 });
    }
    if (g && g.windowStart + GLOBAL_WINDOW_MS < Date.now()) {
      await kv.delete('root-auth-global');
    }
  } catch (e) {
    return Response.json({ ok: false, error: 'server' }, { status: 503 });
  }
  try {
    const rec = await kv.get('root-auth-fail:' + ip, 'json');
    if (rec && rec.lockedUntil > Date.now()) {
      await writeAudit(kv, ip, false);
      return Response.json({ ok: false, error: 'locked' }, { status: 429 });
    }
  } catch (e) {
    return Response.json({ ok: false, error: 'server' }, { status: 503 });
  }

  let key = '';
  try {
    const body = await request.json();
    key = (body && body.key) || '';
  } catch (e) {}

  const ok = key && (await timingSafeEqual(String(key), String(rootKey)));
  if (!ok) {
    /* 记录失败：KV 出错也拒绝（fail closed） */
    try {
      const now = Date.now();
      const rec = (await kv.get('root-auth-fail:' + ip, 'json')) || { count: 0 };
      rec.count = (rec.count || 0) + 1;
      if (rec.count >= IP_MAX_FAIL) {
        rec.lockedUntil = now + IP_LOCK_MS;
        rec.count = 0;
      }
      await kv.put('root-auth-fail:' + ip, JSON.stringify(rec), { expirationTtl: 3600 });
    } catch (e) {
      await writeAudit(kv, ip, false);
      return Response.json({ ok: false, error: 'server' }, { status: 503 });
    }
    try {
      const now = Date.now();
      const g = (await kv.get('root-auth-global', 'json')) || { count: 0, windowStart: now };
      if (g.windowStart + GLOBAL_WINDOW_MS < now) {
        g.count = 0;
        g.windowStart = now;
      }
      g.count = (g.count || 0) + 1;
      if (g.count >= GLOBAL_MAX_FAIL) {
        g.pausedUntil = now + GLOBAL_PAUSE_MS;
        g.count = 0;
      }
      await kv.put('root-auth-global', JSON.stringify(g), { expirationTtl: 7200 });
    } catch (e) {
      await writeAudit(kv, ip, false);
      return Response.json({ ok: false, error: 'server' }, { status: 503 });
    }
    await writeAudit(kv, ip, false);
    return Response.json({ ok: false, error: 'auth' }, { status: 401 });
  }

  /* 成功：清掉该 IP 的失败计数（失败不影响主流程） */
  try { await kv.delete('root-auth-fail:' + ip); } catch (e) {}

  /* 2.11：只签发 sgx-stepup(by=root, scope=root)，不签发会话 */
  const headers = new Headers({ 'Content-Type': 'application/json' });
  let epoch;
  try {
    epoch = await getSessionEpoch(kv);
  } catch (e) {
    await writeAudit(kv, ip, false);
    return Response.json({ ok: false, error: 'server' }, { status: 503 });
  }
  let stepupVal;
  try {
    stepupVal = await signStepupCookie(stepupKey, STEPUP_BY_ROOT, STEPUP_SCOPE_ROOT, epoch);
  } catch (e) {
    await writeAudit(kv, ip, false);
    return Response.json({ ok: false, error: 'sign-failed' }, { status: 500 });
  }
  headers.append(
    'Set-Cookie',
    STEPUP_COOKIE + '=' + stepupVal + '; ' + STEPUP_COOKIE_ATTRS + '; Max-Age=' + STEPUP_MAX_AGE
  );

  /* 2.10.2：审计写入失败则不签发会话（fail closed） */
  if (!(await writeAudit(kv, ip, true))) {
    return Response.json({ ok: false, error: 'server' }, { status: 503 });
  }
  return new Response(JSON.stringify({ ok: true }), { headers });
}
