/**
 * POST /api/account/reset（sudo root reset）：钥匙都丢了时，用恢复密钥换 3 分钟的 reset 票，重设账号密码 / 增删通行密钥，最后决定登出。
 *
 * { action }（同源）：
 * - recovery-key { key } → 签 reset 票（core/reset.js openReset；限速 / 审计见 core/recovery-key.js）
 * - 拿到 reset 票以后只认 reset 票（没有 / 失效 → 401 reset）：
 *   - password-set { password } → { ok, changed }
 *   - passkey-list → { ok, userHandle, userName, displayName, keys }
 *   - passkey-add-challenge → 注册 challenge（用途 reset-add）；passkey-add { cid, credential, name? } → { ok, credId }
 *   - passkey-delete { credId }
 *   - finish { signOut: all | others | none } → { ok, signOut, signedOut }（core/reset.js finishReset；票用完即废）
 * - end → 只清 reset 票（不要求进门）
 * reset 下的写操作都不碰会话（只有 finish 决定登出），也没有改名（改名在 /api/account/keys）。
 * 除 end 外都要进门（401 session）。审计：reset-recovery-key、reset-password-set、reset-passkey-add、reset-passkey-delete、reset-finish-<值>。
 */
import { json, apiError } from '../../lib/http.js';
import { CHALLENGE_PURPOSE, rpConfig, rpConfigMissing } from '../../core/config.js';
import { openReset, verifyReset, endReset, finishReset } from '../../core/reset.js';
import { setPassword } from '../../core/password.js';
import { getPasskeys, deletePasskey, findStoredKey, registrationChallenge, addPasskey, passkeyView, peekUserHandles, KEY_ACCOUNT_PASSKEY, PASSKEY_DISPLAY_NAME } from '../../core/passkey.js';
import { writeAudit } from '../../core/audit.js';
import { readPost, lockDenial, clientAddress, guarded } from './_request.js';

const TICKET_ACTIONS = ['password-set', 'passkey-list', 'passkey-add-challenge', 'passkey-add', 'passkey-delete', 'finish'];

export const onRequestPost = guarded(async function (context) {
  const { request, env } = context;
  const rp0 = await readPost(request);
  if (!rp0.ok) return rp0.response;
  const { body, action } = rp0;

  if (action === 'end') {
    const headers = new Headers();
    endReset(headers);
    return json(200, { ok: true }, headers);
  }

  const denied = lockDenial(request, env);
  if (denied) return denied;
  const ip = clientAddress(request);

  if (action === 'recovery-key') return openReset({ env, ip, key: body.key });
  if (TICKET_ACTIONS.indexOf(action) === -1) return apiError(400, 'action');

  const xv = await verifyReset(request, env);
  if (!xv.ok) return apiError(401, 'reset', { reason: xv.reason });

  if (action === 'finish') return finishReset(env, request, ip, body.signOut);

  if (action === 'password-set') {
    const r = await setPassword(env, body.password);
    if (!r.ok) return r.response;
    await writeAudit(env, ip, 'reset-password-set');
    return json(200, { ok: true, changed: r.changed });
  }

  if (action === 'passkey-list') {
    const keys = await getPasskeys(env);
    const h = await peekUserHandles(env);
    return json(200, { ok: true, userHandle: h.handle, userName: KEY_ACCOUNT_PASSKEY, displayName: PASSKEY_DISPLAY_NAME, keys: keys.map(passkeyView) });
  }

  if (action === 'passkey-delete') {
    const credId = body.credId;
    if (!credId || typeof credId !== 'string') return apiError(400, 'params');
    if (!findStoredKey(await getPasskeys(env), credId)) return apiError(404, 'not-found');
    try { await deletePasskey(env, credId); } catch (e) { return apiError(503, 'server'); }
    await writeAudit(env, ip, 'reset-passkey-delete');
    return json(200, { ok: true });
  }

  const rp = rpConfig(env);
  if (!rp) return rpConfigMissing();
  if (action === 'passkey-add-challenge') return registrationChallenge(env, rp, CHALLENGE_PURPOSE.resetAdd);

  /* action === 'passkey-add' */
  const r = await addPasskey(env, rp, CHALLENGE_PURPOSE.resetAdd, body);
  if (!r.ok) return r.response;
  await writeAudit(env, ip, 'reset-passkey-add');
  return json(200, { ok: true, credId: r.credId });
});
