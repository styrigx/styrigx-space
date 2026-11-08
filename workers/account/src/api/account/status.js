/**
 * GET /api/account：账号状态（只读）。要进站会话。
 *
 * → { ok, configured:{ password, passkey }, signing, session, reauth, reset }
 * - configured：账号密码 / 账号通行密钥各有没有设置（两个都没有就只能 sudo root reset 设第一把）
 * - signing：签名钥匙齐不齐（不齐 = 登录会 503 config）
 * - session：{ by, authAt, expiresAt, device } | null（device = 本机设备名）
 * - reauth：{ by, expiresAt } | null（只在 session 有效、且 reauth 挂在本机 session 上时）
 * - reset：{ by, expiresAt } | null（by 只会是 recovery-key）
 */
import { json, apiError } from '../../lib/http.js';
import { hasPassword } from '../../core/password.js';
import { listPasskeys } from '../../core/passkey.js';
import { signingReady, verifySession } from '../../core/session.js';
import { verifyReauth } from '../../core/reauth.js';
import { verifyReset } from '../../core/reset.js';
import { getDevice, deviceView } from '../../core/devices.js';
import { lockDenial, guarded } from './_request.js';

export const onRequestGet = guarded(async function (context) {
  const { request, env } = context;
  const denied = lockDenial(request, env);
  if (denied) return denied;
  let password = false;
  let passkey = false;
  try {
    password = await hasPassword(env);
    passkey = (await listPasskeys(env)).length > 0;
  } catch (e) {
    return apiError(503, 'server');
  }
  const acc = await verifySession(request, env);
  const rv = await verifyReauth(request, env, acc);
  const xv = await verifyReset(request, env);
  let devName = '';
  if (acc.ok && acc.deviceId) {
    try {
      const d = await getDevice(env, acc.deviceId);
      if (d) devName = deviceView(d, acc.deviceId).name;
    } catch (e) {}
  }
  return json(200, {
    ok: true,
    configured: { password: password, passkey: passkey },
    signing: signingReady(env),
    session: acc.ok ? { by: acc.by, authAt: acc.authAt, expiresAt: acc.exp, device: devName } : null,
    reauth: rv.ok ? { by: rv.by, expiresAt: rv.exp } : null,
    reset: xv.ok ? { by: xv.by, expiresAt: xv.exp } : null,
  });
});
