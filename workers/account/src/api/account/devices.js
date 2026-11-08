/**
 * POST /api/account/devices：已登录设备。要进站会话 + 有效 session（401 account）。
 *
 * { action }（同源）：
 * - list → { ok, devices }（本机排最上面，标 current）
 * - revoke { deviceId } → 单独退出一台（不能是本机：400 current）
 * - revoke-all → 再要 reauth 票（403 reauth）：session 纪元 +1、本机 session / reauth 重签、其他设备行全部删除
 * 审计：devices-revoke、devices-revoke-all。
 */
import { json, apiError } from '../../lib/http.js';
import { verifySession, rotateSessions } from '../../core/session.js';
import { verifyReauth, reissueReauth } from '../../core/reauth.js';
import { listDevices, revokeDevice, deviceView, getDevice, isDeviceId } from '../../core/devices.js';
import { writeAudit } from '../../core/audit.js';
import { readPost, lockDenial, clientAddress, guarded } from './_request.js';

export const onRequestPost = guarded(async function (context) {
  const { request, env } = context;
  const rp0 = await readPost(request);
  if (!rp0.ok) return rp0.response;
  const { body, action } = rp0;
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
