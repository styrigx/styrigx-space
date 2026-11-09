/**
 * 临时 LockKey 管理（设置 → 安全「临时钥匙」）。说明见 core/lock-tempkey.js。
 *
 * POST /api/lock-tempkey { action, ... }（只接受同源；不问账号会话，方案 3.3、定案第 6 条）
 * 鉴权：「看 = 进门，写 = 锁复验」。list 只要进门；create / revoke 要进门 + 有效 LockReauthTicket（sgx-space-reauth，
 * 只能由锁屏密码 / 锁屏通行密钥 / 进站凭证签出；临时钥匙或短链进门的会话本身不算复验）→ 没有回 401 reauth，前端先弹锁屏复验层再自动重试。
 * - list → { keys: [{ id, name, createdAt, expiresAt }] }（只列还有效的，新到旧）
 * - create { name?, hours? | days? } → { key, code }
 *     有效期：hours 1–24 的整数，或 days 3 / 7 / 15 / 30（二选一）；名字可空，最多 24 字
 *     code 是 XXXX-XXXX-XXXX，只在这次返回，服务端只存哈希
 *     同时有效的钥匙最多 20 把（409 full）
 * - revoke { id } → 作废（拿这把钥匙进门的人下一个请求就进不来）
 */
import { REALM_LOCK, LOCK_REAUTH_TICKET } from '../core/realms.js';
import { verifyTicket } from '../core/tickets.js';
import { isSameOrigin, originDenied, json, apiError } from '../lib/http.js';
import { tempkeyPepper, listTempkeys, createTempkey, revokeTempkey, durationMs, cleanName, isTempkeyId } from '../core/lock-tempkey.js';
import { lockSessionOf } from '../core/lock-session.js';

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
  const lockDb = env && env[REALM_LOCK.d1Binding]; /* D1_SPACE（纪元、临时钥匙都在这里）：没绑 → 500 config */
  if (!isSameOrigin(request)) return originDenied();
  /* 会话先用关口验过的结论（没有就自己验）：要进门（任何进门方式） */
  const sess = await lockSessionOf(context);
  if (!sess.ok) return apiError(401, 'session');
  if (!lockDb) return apiError(500, 'config');

  let body;
  try { body = await request.json(); } catch (e) {
    return apiError(400, 'body');
  }
  const action = (body && body.action) || '';

  /* 写操作（发放 / 作废）：先验锁侧复验票 */
  if (action === 'create' || action === 'revoke') {
    const tv = await verifyTicket(request, env, LOCK_REAUTH_TICKET);
    if (!tv.ok) return apiError(401, 'reauth');
  }

  if (action === 'list') {
    try {
      /* 分享短链自动签的钥匙（link，分享链接 core/link-keys.js 签发）不出现在这里，只在短链列表里管 */
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
    const pepper = tempkeyPepper(env);
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
