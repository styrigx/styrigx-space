/**
 * POST /api/account/reauth（sudo root reauth）：在本机 session 上再验证一次，签 3 分钟的 reauth 票（带本机 deviceId）。
 *
 * { action }（同源）：
 * - passkey-challenge → { cid, challenge, rpId, allowCredentials }（challenge 用途 reauth，和登录的互不通用）
 * - passkey { cid, credential } → 签 reauth
 * - password { password } → 签 reauth（输错限速与 session 共用，kind = password）
 * - end → 只清 reauth（不要求进站会话；不碰 session、reset）
 * 除 end 外都要进站会话（401 session）+ 有效 session（401 account，带 reason）。成功 / 失败都写审计 reauth-<by>。
 * 不签 session（session 的 by / authAt 不变）。
 */
import { json, apiError } from '../../lib/http.js';
import { BY_PASSKEY, BY_PASSWORD, CHALLENGE_PURPOSE, rpConfig, rpConfigMissing } from '../../core/config.js';
import { signingReady, signingMissing, verifySession } from '../../core/session.js';
import { issueReauth, endReauth } from '../../core/reauth.js';
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
    endReauth(headers);
    return json(200, { ok: true }, headers);
  }

  const denied = lockDenial(request, env);
  if (denied) return denied;
  if (action !== 'passkey-challenge' && action !== 'passkey' && action !== 'password') return apiError(400, 'action');
  const acc = await verifySession(request, env);
  if (!acc.ok) return apiError(401, 'account', { reason: acc.reason });
  if (!signingReady(env)) return signingMissing();
  const ip = clientAddress(request);

  if (action === 'password') {
    const pc = await checkPasswordAttempt(env, ip, body.password);
    if (!pc.ok) {
      if (pc.response.status === 403) await writeAudit(env, ip, 'reauth-password', false);
      return pc.response;
    }
    return grant(BY_PASSWORD);
  }

  const rp = rpConfig(env);
  if (!rp) return rpConfigMissing();
  if (action === 'passkey-challenge') return assertionChallenge(env, rp, CHALLENGE_PURPOSE.reauth);

  /* action === 'passkey' */
  const pk = await checkAssertion(env, rp, CHALLENGE_PURPOSE.reauth, body);
  if (!pk.ok) {
    await writeAudit(env, ip, 'reauth-passkey', false);
    return pk.response;
  }
  return grant(BY_PASSKEY);

  /** @param {string} by */
  async function grant(by) {
    const headers = new Headers();
    const err = await issueReauth(env, headers, by, acc.deviceId || '');
    if (err) return json(err.status, err.body);
    await writeAudit(env, ip, 'reauth-' + by, true);
    return json(200, { ok: true }, headers);
  }
});
