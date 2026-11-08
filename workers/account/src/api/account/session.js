/**
 * POST /api/account/session（sudo root）：账号登录会话。只签 / 清 session，不顺手签 reauth（要 reauth 去 /api/account/reauth）。
 *
 * { action }（同源）：
 * - passkey-challenge → { cid, challenge, rpId, allowCredentials }（challenge 用途 session）
 * - passkey { cid, credential, device? } → 签 session
 * - password { password, device? } → 签 session（输错限速与 reauth 共用，kind = password）
 * - end → 清 session 和挂在上面的 reauth，本机设备行记为已退出（不要求进门；不碰 reset 票）
 * 除 end 外都要进门（401 session）。登录成功 / 失败都写审计 session-<by>。
 */
import { json, apiError } from '../../lib/http.js';
import { BY_PASSKEY, BY_PASSWORD, CHALLENGE_PURPOSE, rpConfig, rpConfigMissing } from '../../core/config.js';
import { signingReady, signingMissing, verifySession, issueSession, endSession, sessionOpts } from '../../core/session.js';
import { revokeDevice } from '../../core/devices.js';
import { assertionChallenge, checkAssertion } from '../../core/passkey.js';
import { checkPasswordAttempt } from '../../core/password.js';
import { writeAudit } from '../../core/audit.js';
import { readPost, lockDenial, clientAddress, guarded } from './_request.js';

export const onRequestPost = guarded(async function (context) {
  const { request, env } = context;
  const rp0 = await readPost(request);
  if (!rp0.ok) return rp0.response;
  const { body, action } = rp0;

  if (action === 'end') {
    const headers = new Headers();
    try {
      const cur = await verifySession(request, env);
      if (cur.ok && cur.deviceId) await revokeDevice(env, cur.deviceId);
    } catch (e) {}
    endSession(headers);
    return json(200, { ok: true }, headers);
  }

  const denied = lockDenial(request, env);
  if (denied) return denied;
  if (action !== 'passkey-challenge' && action !== 'passkey' && action !== 'password') return apiError(400, 'action');
  if (!signingReady(env)) return signingMissing();
  const ip = clientAddress(request);

  if (action === 'password') {
    const pc = await checkPasswordAttempt(env, ip, body.password);
    if (!pc.ok) {
      if (pc.response.status === 403) await writeAudit(env, ip, 'session-password', false);
      return pc.response;
    }
    return signIn(BY_PASSWORD);
  }

  const rp = rpConfig(env);
  if (!rp) return rpConfigMissing();
  if (action === 'passkey-challenge') return assertionChallenge(env, rp, CHALLENGE_PURPOSE.session);

  /* action === 'passkey' */
  const pk = await checkAssertion(env, rp, CHALLENGE_PURPOSE.session, body);
  if (!pk.ok) {
    await writeAudit(env, ip, 'session-passkey', false);
    return pk.response;
  }
  return signIn(BY_PASSKEY);

  /** @param {string} by */
  async function signIn(by) {
    const headers = new Headers();
    const err = await issueSession(env, headers, by, await sessionOpts(request, env, body));
    if (err) return json(err.status, err.body);
    await writeAudit(env, ip, 'session-' + by, true);
    return json(200, { ok: true }, headers);
  }
});
