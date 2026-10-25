/**
 * 临时 LockKey 管理（账号页「临时钥匙」）。说明见 _kernel/lock-tempkey.js。
 *
 * POST /api/lock-tempkey { action, ... }（只接受同源；需站长锁屏会话 + 有效账号会话，和账号页设备管理同一道门槛）
 * - list → { keys: [{ id, name, createdAt, expiresAt }] }（只列还有效的，新到旧）
 * - create { name?, hours? | days? } → { key, code }
 *     有效期：hours 1–24 的整数，或 days 3 / 7 / 15 / 30（二选一）；名字可空，最多 24 字
 *     code 是 XXXX-XXXX-XXXX，只在这次返回，服务端只存哈希
 *     同时有效的钥匙最多 20 把（409 full）
 * - revoke { id } → 作废（拿这把钥匙进来的访客下一个请求就进不来）
 * 访客调用：middleware 已按站长专属接口 403；这里再验一次站长会话。
 */
import { ROLE_OWNER } from '../_kernel/lock-session.js';
import { verifyAccountCookie } from '../_kernel/account-session.js';
import { getPepper } from '../_kernel/password.js';
import { isSameOrigin, originDenied } from '../_kernel/http.js';
import { listTempkeys, createTempkey, revokeTempkey, durationMs, cleanName, isTempkeyId } from '../_kernel/lock-tempkey.js';
import { verifySessionDetailed } from '../_middleware.js';

/** @param {object} body @param {number} [status] */
function json(body, status) {
  return Response.json(body, { status: status || 200, headers: { 'Cache-Control': 'no-store' } });
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
export async function onRequestGet(context) {
  return json({ ok: false, error: 'method' }, 405);
}

/** @param {any} context */
async function handle(context) {
  const { request, env } = context;
  const kv = env && env.KV_LOCK_DOOR;
  if (!isSameOrigin(request)) return originDenied();
  const sess = await verifySessionDetailed(request, env);
  if (!sess.ok || sess.role !== ROLE_OWNER) return json({ ok: false, error: 'session' }, 401);
  const acc = await verifyAccountCookie(request, env);
  if (!acc.ok) return json({ ok: false, error: 'account', reason: acc.reason }, 401);
  if (!kv) return json({ ok: false, error: 'config' }, 500);

  let body;
  try { body = await request.json(); } catch (e) {
    return json({ ok: false, error: 'body' }, 400);
  }
  const action = (body && body.action) || '';

  if (action === 'list') {
    try {
      /* 分享短链自动签的钥匙（link，styrigx-share 经 ShareIssuer 签发）不出现在这里，只在短链列表里管 */
      const keys = (await listTempkeys(kv)).filter(function (k) { return !k.link; });
      return json({ ok: true, keys: keys });
    } catch (e) {
      return json({ ok: false, error: 'server' }, 503);
    }
  }

  if (action === 'create') {
    const ms = durationMs({ hours: body.hours, days: body.days });
    if (!ms) return json({ ok: false, error: 'duration' }, 400);
    const name = cleanName(body.name);
    if (name === null) return json({ ok: false, error: 'name' }, 400);
    const pepper = getPepper(env);
    if (!pepper) return json({ ok: false, error: 'config' }, 503);
    try {
      const r = await createTempkey(kv, pepper, { name: name, ms: ms });
      return json({ ok: true, key: r.key, code: r.code });
    } catch (e) {
      if (e && e.message === 'full') return json({ ok: false, error: 'full' }, 409);
      return json({ ok: false, error: 'server' }, 503);
    }
  }

  if (action === 'revoke') {
    const id = body.id;
    if (!isTempkeyId(id)) return json({ ok: false, error: 'params' }, 400);
    try {
      const ok = await revokeTempkey(kv, id);
      if (!ok) return json({ ok: false, error: 'not-found' }, 404);
      return json({ ok: true });
    } catch (e) {
      return json({ ok: false, error: 'server' }, 503);
    }
  }

  return json({ ok: false, error: 'action' }, 400);
}
