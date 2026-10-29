/**
 * 用临时 LockKey 进门（锁屏「临时钥匙」）。说明见 _kernel/lock-tempkey.js。
 *
 * POST /api/lock-tempkey-unlock { code }（只接受同源；无需会话，在白名单里）
 * - 规范化后按哈希找钥匙；对得上 → 签 visitor 锁屏会话（LockSessionTicket：role=visitor，by=tempkey，
 *   tempkeyId=钥匙 id，lock 私钥签名），Max-Age = min(钥匙剩余时间, 12 小时)
 * - 输错：403 wrong；同一 IP（IPv6 按 /64）连错 5 次锁 15 分钟 → 429 cooldown；
 *   全站每小时错满 30 次后只减速（每次先等 2 秒），不封锁
 * - 格式不对（不是 12 位）也算一次输错，不提示格式
 * - 已有 admin 会话：直接 ok，不降级成访客
 * - D1 / 密钥出错一律 5xx，绝不签发会话
 */
import { issueLockSession, ROLE_ADMIN, ROLE_VISITOR } from '../_kernel/lock-session.js';
import { BY_TEMPKEY, REALM_LOCK } from '../_kernel/realms.js';
import { getPepper } from '../../../shared/password.js';
import { isSameOrigin, originDenied, json, apiError, clientIp } from '../../../shared/http.js';
import {
  normalizeCode,
  findByCode,
  isTempkeyLimited,
  recordTempkeyFail,
  clearTempkeyFail,
  TEMPKEY_SESSION_MAX,
} from '../_kernel/lock-tempkey.js';
import { verifyLockSession } from '../_kernel/lock-session.js';

/** @param {object} body @param {number} [status] */
/** @param {any} context */
export async function onRequestGet(context) {
  return apiError(405, 'method');
}

/** @param {any} context */
export async function onRequestPost(context) {
  try {
    return await handle(context);
  } catch (e) {
    return apiError(500, 'server');
  }
}

/** @param {any} context */
async function handle(context) {
  const { request, env } = context;
  const lockDb = env && env[REALM_LOCK.d1Binding]; /* D1_LOCK_AUTH（纪元、临时钥匙都在这里）：没绑 → 500 config */
  if (!isSameOrigin(request)) return originDenied();
  if (!lockDb) return apiError(500, 'config');

  let body;
  try { body = await request.json(); } catch (e) {
    return apiError(400, 'body');
  }
  const raw = body && body.code;
  if (!raw || typeof raw !== 'string') return apiError(400, 'code');

  /* 已经是管理员：不降级 */
  const cur = await verifyLockSession(request, env);
  if (cur.ok && cur.role === ROLE_ADMIN) return json(200, { ok: true, role: ROLE_ADMIN });

  const ip = clientIp(request);
  try {
    if (await isTempkeyLimited(env, ip)) return apiError(429, 'cooldown');
  } catch (e) {
    return apiError(503, 'server');
  }
  const pepper = getPepper(env);
  if (!pepper) return apiError(503, 'config');

  const code = normalizeCode(raw);
  let key = null;
  if (code) {
    try {
      key = await findByCode(env, pepper, code);
    } catch (e) {
      return apiError(503, 'server');
    }
  }
  if (!key) {
    let cooling = false;
    try { cooling = await recordTempkeyFail(env, ip); } catch (e) {
      return apiError(503, 'server');
    }
    return json(cooling ? 429 : 403, { ok: false, error: cooling ? 'cooldown' : 'wrong' });
  }
  await clearTempkeyFail(env, ip);

  const left = Math.floor((key.expiresAt - Date.now()) / 1000);
  const maxAge = Math.max(60, Math.min(TEMPKEY_SESSION_MAX, left));
  const headers = new Headers();
  const err = await issueLockSession(env, headers, { by: BY_TEMPKEY, role: ROLE_VISITOR, maxAge: maxAge, tempkeyId: key.id });
  if (err) return json(err.status, err.body);
  return json(200, { ok: true, role: 'visitor' }, headers);
}
