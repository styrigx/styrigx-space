/**
 * POST /api/account/keys（账号安全）：管理账号的钥匙。要进站会话 + 有效 session（401 account）；
 * 除 passkey-list 外还要挂在本机 session 上的 reauth 票（403 reauth，带 reason）。reset 票在这里不算数。
 *
 * { action }（同源）：
 * - passkey-list → { ok, userHandle, userName, displayName, keys }（只要 session）
 * - password-set { password } → { ok, changed }；原来有密码时整体轮换（见下）
 * - passkey-add-challenge → 注册 challenge（用途 keys-add）；passkey-add { cid, credential, name? } → { ok, credId }
 * - passkey-delete { credId } → 先轮换再删（fail closed：纪元推不动则钥匙仍在）
 * - passkey-rename { credId, name }
 * 轮换（改了钥匙）：session 纪元 +1 → 本机 session、reauth 按原样重签 → 删其他设备的行（core/session.js rotateSessions）。
 * 审计：keys-password-set、keys-passkey-add、keys-passkey-delete、keys-passkey-rename。
 */
import { json, apiError } from '../../lib/http.js';
import { CHALLENGE_PURPOSE, rpConfig, rpConfigMissing } from '../../core/config.js';
import { verifySession, rotateSessions } from '../../core/session.js';
import { verifyReauth, reissueReauth } from '../../core/reauth.js';
import { setPassword } from '../../core/password.js';
import {
  getPasskeys, deletePasskey, updatePasskey, findStoredKey, registrationChallenge, addPasskey, passkeyView, peekUserHandles, cleanPasskeyName,
  KEY_ACCOUNT_PASSKEY, PASSKEY_DISPLAY_NAME,
} from '../../core/passkey.js';
import { writeAudit } from '../../core/audit.js';
import { readPost, lockDenial, clientAddress, guarded } from './_request.js';

const ACTIONS = ['passkey-list', 'password-set', 'passkey-add-challenge', 'passkey-add', 'passkey-delete', 'passkey-rename'];

export const onRequestPost = guarded(async function (context) {
  const { request, env } = context;
  const rp0 = await readPost(request);
  if (!rp0.ok) return rp0.response;
  const { body, action } = rp0;
  const denied = lockDenial(request, env);
  if (denied) return denied;
  if (ACTIONS.indexOf(action) === -1) return apiError(400, 'action');
  const acc = await verifySession(request, env);
  if (!acc.ok) return apiError(401, 'account', { reason: acc.reason });
  const ip = clientAddress(request);

  if (action === 'passkey-list') {
    const keys = await getPasskeys(env);
    const h = await peekUserHandles(env);
    return json(200, { ok: true, userHandle: h.handle, userName: KEY_ACCOUNT_PASSKEY, displayName: PASSKEY_DISPLAY_NAME, keys: keys.map(passkeyView) });
  }

  const rv = await verifyReauth(request, env, acc);
  if (!rv.ok) return apiError(403, 'reauth', { reason: rv.reason });

  /** 改了钥匙：轮换会话，本机 reauth 按新纪元重签 @param {Headers} headers */
  async function rotate(headers) {
    const ne = await rotateSessions(env, headers, acc);
    await reissueReauth(env, headers, rv, acc.deviceId || '', ne);
  }

  if (action === 'password-set') {
    const r = await setPassword(env, body.password);
    if (!r.ok) return r.response;
    const headers = new Headers();
    if (r.changed) {
      try { await rotate(headers); } catch (e) { return apiError(503, 'server'); }
    }
    await writeAudit(env, ip, 'keys-password-set');
    return json(200, { ok: true, changed: r.changed }, headers);
  }

  if (action === 'passkey-delete') {
    const credId = body.credId;
    if (!credId || typeof credId !== 'string') return apiError(400, 'params');
    if (!findStoredKey(await getPasskeys(env), credId)) return apiError(404, 'not-found');
    const headers = new Headers();
    try { await rotate(headers); } catch (e) { return apiError(503, 'epoch'); }
    try { await deletePasskey(env, credId); } catch (e) { return apiError(503, 'server'); }
    await writeAudit(env, ip, 'keys-passkey-delete');
    return json(200, { ok: true }, headers);
  }

  if (action === 'passkey-rename') {
    const credId = body.credId;
    if (!credId || typeof credId !== 'string') return apiError(400, 'params');
    const name = cleanPasskeyName(body.name);
    if (!name) return apiError(400, 'params');
    const found = findStoredKey(await getPasskeys(env), credId);
    if (!found) return apiError(404, 'not-found');
    found.name = name;
    try {
      if (!(await updatePasskey(env, found))) return apiError(404, 'not-found');
    } catch (e) { return apiError(503, 'server'); }
    await writeAudit(env, ip, 'keys-passkey-rename');
    return json(200, { ok: true, name: name });
  }

  const rp = rpConfig(env);
  if (!rp) return rpConfigMissing();
  if (action === 'passkey-add-challenge') return registrationChallenge(env, rp, CHALLENGE_PURPOSE.keysAdd);

  /* action === 'passkey-add' */
  const r = await addPasskey(env, rp, CHALLENGE_PURPOSE.keysAdd, body);
  if (!r.ok) return r.response;
  await writeAudit(env, ip, 'keys-passkey-add');
  return json(200, { ok: true, credId: r.credId });
});
