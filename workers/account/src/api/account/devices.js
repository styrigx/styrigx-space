/**
 * POST /api/account/devices：已登录设备。要进站会话 + 有效 session（401 account）。
 *
 * { action }（同源）：
 * - list → { ok, devices }（本机排最上面，标 current）
 * - revoke { deviceId } → 单独退出一台（不能是本机：400 current）
 * - revoke-all → 再要 reauth 票（403 reauth）：session 纪元 +1、本机 session / reauth 重签、其他设备行全部删除
 * 审计：devices-revoke、devices-revoke-all。
 *
 * v6（P2，Gray 2026-11-11 定 user）：请求带有效的 v6 新会话（sgx-session，permits 判过 user 档）时，「设备」= 自己（栈底用户）的
 * v6 会话（account_sessions WHERE uid = 会话的 uid；uid 只取服务端会话，请求里的 uid 一概不认）：
 * - list → { ok, devices:[{ n, path, since, expiresAt, current }] }
 * - revoke { n } → 删自己的第 n 个会话（不能是本会话：400 current）
 * - revoke-all → 删自己的其他全部会话（v6 不再要复验，同 lock-all-devices 定稿）
 */
import { json, apiError } from '../../lib/http.js';
import { verifySession, rotateSessions } from '../../core/session.js';
import { verifyReauth, reissueReauth } from '../../core/reauth.js';
import { listDevices, revokeDevice, deviceView, getDevice, isDeviceId } from '../../core/devices.js';
import { writeAudit } from '../../core/audit.js';
import { readPost, lockDenial, clientAddress, guarded } from './_request.js';
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
  if (context.auth && context.auth.hasV6) {
    const v = await context.auth.v6();
    if (v && v.allowed === true && Number.isInteger(v.uid)) {
      if (action !== 'list' && action !== 'revoke' && action !== 'revoke-all') return apiError(400, 'action');
      return v6Devices(env, request, body, action, clientAddress(request));
    }
  }
  const denied = lockDenial(request, env);
  if (denied) return denied;
  if (action !== 'list' && action !== 'revoke' && action !== 'revoke-all') return apiError(400, 'action');
  const acc = await verifySession(request, env);
  if (!acc.ok) return apiError(401, 'account', { reason: acc.reason });
  const ip = clientAddress(request);
  const cur = acc.deviceId || '';

  if (action === 'list') {
    let all;
    try { all = await listDevices(env); } catch (e) { return apiError(503, 'server'); }
    if (cur && !all.some((d) => d.deviceId === cur)) {
      let me = null;
      try { me = await getDevice(env, cur); } catch (e) { return apiError(503, 'server'); }
      if (me && me.deviceId) all = [me].concat(all);
    }
    const views = all.map((d) => deviceView(d, cur));
    views.sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0));
    return json(200, { ok: true, devices: views });
  }

  if (action === 'revoke') {
    const deviceId = body.deviceId;
    if (!isDeviceId(deviceId)) return apiError(400, 'params');
    if (deviceId === cur) return apiError(400, 'current');
    let rec = null;
    try { rec = await getDevice(env, deviceId); } catch (e) { return apiError(503, 'server'); }
    if (!rec) return apiError(404, 'not-found');
    try { await revokeDevice(env, deviceId); } catch (e) { return apiError(503, 'server'); }
    await writeAudit(env, ip, 'devices-revoke');
    return json(200, { ok: true });
  }

  /* action === 'revoke-all' */
  const rv = await verifyReauth(request, env, acc);
  if (!rv.ok) return apiError(403, 'reauth', { reason: rv.reason });
  const headers = new Headers();
  try {
    const ne = await rotateSessions(env, headers, acc);
    await reissueReauth(env, headers, rv, cur, ne);
  } catch (e) {
    return apiError(503, 'epoch');
  }
  await writeAudit(env, ip, 'devices-revoke-all');
  return json(200, { ok: true }, headers);
});
