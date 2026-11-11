/**
 * POST /api/account/devices：已登录设备。v6 P4（定稿 v5.2 §十三）起只认 v6 会话（没有 → 401 session）；
 * 旧进站会话 + 账号 session 的设备（account_device、devices-revoke 审计、revoke-all 的 reauth 票）删除。
 *
 * v6（P2，Gray 2026-11-11 定 user）：请求带有效的 v6 会话（sgx-session，permits 判过 user 档）时，「设备」= 自己（栈底用户）的
 * v6 会话（account_sessions WHERE uid = 会话的 uid；uid 只取服务端会话，请求里的 uid 一概不认）：
 * - list → { ok, devices:[{ n, path, since, expiresAt, current }] }
 * - revoke { n } → 删自己的第 n 个会话（不能是本会话：400 current）
 * - revoke-all → 删自己的其他全部会话（v6 不再要复验，同 lock-all-devices 定稿）
 */
import { json, apiError } from '../../lib/http.js';
import { readPost, clientAddress, guarded, v6Admitted } from './_request.js';
import { admitRequest } from '../../core/identity-session.js';
import { whoList } from '../../core/user-admin.js';
import { onDb } from '../../lib/db.js';
import { writeUserAudit } from '../../core/user-audit.js';

/**
 * v6 新会话的设备管理（自己的会话）。
 * @param {any} env @param {Request} request @param {any} body @param {string} action @param {string} ip
 */
async function v6Devices(env, request, body, action, ip) {
  const adm = await admitRequest(env, request);
  if (!adm.ok) return apiError(401, 'unauthorized');
  const owner = adm.via ? adm.via.uid : adm.identity.uid;
  const list = await whoList(env, { onlyUid: owner, current: adm.sessionId });
  if (action === 'list') return json(200, { ok: true, devices: list });
  const ids = await onDb(env, async (d) => ((await d.prepare('SELECT id FROM account_sessions WHERE uid = ? AND expires_at > ? ORDER BY created_at').bind(owner, Date.now()).all()).results || []).map((r) => String(r.id)));
  if (action === 'revoke') {
    const n = Number(body.n);
    const id = Number.isInteger(n) && n >= 1 ? ids[n - 1] : undefined;
    if (!id) return apiError(404, 'not-found');
    if (id === adm.sessionId) return apiError(400, 'current');
    await onDb(env, (d) => d.batch([
      d.prepare('DELETE FROM account_session_stack WHERE session_id = ?').bind(id),
      d.prepare('DELETE FROM account_sessions WHERE id = ? AND uid = ?').bind(id, owner),
    ]));
    await writeUserAudit(env, { uid: adm.identity.uid, command: 'lock device ' + n, ok: true, ip });
    return json(200, { ok: true });
  }
  await onDb(env, (d) => d.batch([
    d.prepare('DELETE FROM account_session_stack WHERE session_id IN (SELECT id FROM account_sessions WHERE uid = ? AND id <> ?)').bind(owner, adm.sessionId),
    d.prepare('DELETE FROM account_sessions WHERE uid = ? AND id <> ?').bind(owner, adm.sessionId),
  ]));
  await writeUserAudit(env, { uid: adm.identity.uid, command: 'lock devices --all', ok: true, ip });
  return json(200, { ok: true });
}

export const onRequestPost = guarded(async function (context) {
  const { request, env } = context;
  const rp0 = await readPost(request);
  if (!rp0.ok) return rp0.response;
  const { body, action } = rp0;
  /* v6 P4（定稿 v5.2 §十三）：只认 v6 会话（user 档）；旧进站会话 + 账号 session 的设备（account_device）分支删除 */
  const v = await v6Admitted(context);
  if (!v) return apiError(401, 'session');
  if (action !== 'list' && action !== 'revoke' && action !== 'revoke-all') return apiError(400, 'action');
  return v6Devices(env, request, body, action, clientAddress(request));
});
