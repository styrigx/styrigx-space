/**
 * 临时 LockKey 管理（账号页「临时钥匙」）。说明见 _kernel/lock-tempkey.js。
 *
 * POST /api/lock-tempkey { action, ... }（只接受同源；需管理员锁屏会话 + 有效账号会话，和账号页设备管理同一道门槛）
 * - list → { keys: [{ id, name, createdAt, expiresAt }] }（只列还有效的，新到旧）
 * - create { name?, hours? | days? } → { key, code }
 *     有效期：hours 1–24 的整数，或 days 3 / 7 / 15 / 30（二选一）；名字可空，最多 24 字
 *     code 是 XXXX-XXXX-XXXX，只在这次返回，服务端只存哈希
 *     同时有效的钥匙最多 20 把（409 full）
 * - revoke { id } → 作废（拿这把钥匙进来的访客下一个请求就进不来）
 * 访客调用：middleware 已按管理员专属接口 403；这里再验一次admin 会话。
 */
import { REALM_LOCK } from '../_kernel/realms.js';
import { ROLE_ADMIN } from '../_kernel/lock-session.js';
import { verifyAccountSession } from '../_kernel/account-session.js';
import { getPepper } from '../_kernel/lib/password.js';
import { isSameOrigin, originDenied, json, apiError } from '../_kernel/lib/http.js';
import { listTempkeys, createTempkey, revokeTempkey, durationMs, cleanName, isTempkeyId } from '../_kernel/lock-tempkey.js';
import { verifyLockSession } from '../_kernel/lock-session.js';

/** @param {object} body @param {number} [status] */
/** @param {any} context */
export async function onRequestPost(context) {
  try {
    return await handle(context);
  } catch (e) {
    return apiError(500, 'server');
  }
}

/** @param {any} context */
export async function onRequestGet(context) {
  return apiError(405, 'method');
}

/** @param {any} context */
async function handle(context) {
  const { request, env } = context;
  const lockDb = env && env[REALM_LOCK.d1Binding]; /* D1_LOCK_AUTH（纪元、临时钥匙都在这里）：没绑 → 500 config */
  if (!isSameOrigin(request)) return originDenied();
  const sess = await verifyLockSession(request, env);
  if (!sess.ok || sess.role !== ROLE_ADMIN) return apiError(401, 'session');
  const acc = await verifyAccountSession(request, env);
  if (!acc.ok) return apiError(401, 'account', { reason: acc.reason });
  if (!lockDb) return apiError(500, 'config');

  let body;
  try { body = await request.json(); } catch (e) {
    return apiError(400, 'body');
  }
  const action = (body && body.action) || '';

  if (action === 'list') {
    try {
      /* 分享短链自动签的钥匙（link，styrigx-share 经 ShareIssuer 签发）不出现在这里，只在短链列表里管 */
      const keys = (await listTempkeys(env)).filter(function (k) { return !k.link; });
      return json(200, { ok: true, keys: keys });
    } catch (e) {
      return apiError(503, 'server');
    }
  }

  if (action === 'create') {
    const ms = durationMs({ hours: body.hours, days: body.days });
    if (!ms) return apiError(400, 'duration');
    const name = cleanName(body.name);
    if (name === null) return apiError(400, 'name');
    const pepper = getPepper(env);
    if (!pepper) return apiError(503, 'config');
    try {
      const r = await createTempkey(env, pepper, { name: name, ms: ms });
      return json(200, { ok: true, key: r.key, code: r.code });
    } catch (e) {
      if (e && e.message === 'full') return apiError(409, 'full');
      return apiError(503, 'server');
    }
  }

  if (action === 'revoke') {
    const id = body.id;
    if (!isTempkeyId(id)) return apiError(400, 'params');
    try {
      const ok = await revokeTempkey(env, id);
      if (!ok) return apiError(404, 'not-found');
      return json(200, { ok: true });
    } catch (e) {
      return apiError(503, 'server');
    }
  }

  return apiError(400, 'action');
}
