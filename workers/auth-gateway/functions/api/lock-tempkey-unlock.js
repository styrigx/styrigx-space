/**
 * 用临时 LockKey 进门（锁屏「临时钥匙」）。说明见 _kernel/lock-tempkey.js。
 *
 * POST /api/lock-tempkey-unlock { code }（只接受同源；无需会话，在白名单里）
 * - 规范化后按哈希找钥匙；对得上 → 签 visitor 会话（sgx-verified，by=owner，lock 私钥签名）
 *   + 钥匙票 sgx-tk，两者 Max-Age 都是 min(钥匙剩余时间, 12 小时)
 * - 输错：403 wrong；同一 IP 连错 5 次锁 15 分钟、全站每小时错 30 次暂停 1 小时 → 429 cooldown
 * - 格式不对（不是 12 位）也算一次输错，不提示格式
 * - 已有站长会话：直接 ok，不降级成访客
 * - KV / 密钥出错一律 5xx，绝不签发会话
 */
import { issueSessionCookie, ROLE_OWNER, ROLE_VISITOR } from '../_kernel/lock-session.js';
import { getPepper } from '../_kernel/password.js';
import { isSameOrigin, originDenied } from '../_kernel/http.js';
import {
  normalizeCode,
  findByCode,
  signTk,
  setTkCookie,
  isTempkeyLimited,
  recordTempkeyFail,
  clearTempkeyFail,
  TEMPKEY_SESSION_MAX,
} from '../_kernel/lock-tempkey.js';
import { verifySessionDetailed } from '../_middleware.js';

/** @param {object} body @param {number} [status] */
function json(body, status) {
  return Response.json(body, { status: status || 200, headers: { 'Cache-Control': 'no-store' } });
}

/** @param {any} context */
export async function onRequestGet(context) {
  return json({ ok: false, error: 'method' }, 405);
}

/** @param {any} context */
export async function onRequestPost(context) {
  try {
    return await handle(context);
  } catch (e) {
    return json({ ok: false, error: 'server' }, 500);
  }
}

/** @param {any} context */
async function handle(context) {
  const { request, env } = context;
  const kv = env && env.KV_LOCK_DOOR;
  if (!isSameOrigin(request)) return originDenied();
  if (!kv) return json({ ok: false, error: 'config' }, 500);

  let body;
  try { body = await request.json(); } catch (e) {
    return json({ ok: false, error: 'body' }, 400);
  }
  const raw = body && body.code;
  if (!raw || typeof raw !== 'string') return json({ ok: false, error: 'code' }, 400);

  /* 已经是站长：不降级 */
  const cur = await verifySessionDetailed(request, env);
  if (cur.ok && cur.role === ROLE_OWNER) return json({ ok: true, role: 'owner' });

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  try {
    if (await isTempkeyLimited(kv, ip)) return json({ ok: false, error: 'cooldown' }, 429);
  } catch (e) {
    return json({ ok: false, error: 'server' }, 503);
  }
  const pepper = getPepper(env);
  if (!pepper) return json({ ok: false, error: 'config' }, 503);

  const code = normalizeCode(raw);
  let key = null;
  if (code) {
    try {
      key = await findByCode(kv, pepper, code);
    } catch (e) {
      return json({ ok: false, error: 'server' }, 503);
    }
  }
  if (!key) {
    let cooling = false;
    try { cooling = await recordTempkeyFail(kv, ip); } catch (e) {
      return json({ ok: false, error: 'server' }, 503);
    }
    return json({ ok: false, error: cooling ? 'cooldown' : 'wrong' }, cooling ? 429 : 403);
  }
  await clearTempkeyFail(kv, ip);

  const left = Math.floor((key.expiresAt - Date.now()) / 1000);
  const maxAge = Math.max(60, Math.min(TEMPKEY_SESSION_MAX, left));
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  let tk;
  try {
    tk = await signTk(env, key.id, Date.now() + maxAge * 1000);
  } catch (e) {
    return json({ ok: false, error: 'no-session-key' }, 500);
  }
  const err = await issueSessionCookie(env, headers, ROLE_VISITOR, 'owner', maxAge);
  if (err) return json(err.body, err.status);
  setTkCookie(headers, tk, maxAge);
  return new Response(JSON.stringify({ ok: true, role: 'visitor' }), { headers });
}
