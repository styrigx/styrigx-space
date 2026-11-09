/**
 * 重置进站凭证（锁屏 `sudo styrigx reset`，进站 v3 L1，SPACE-V3 §2.0 L2 / L3 / L4 / L8、§6 L1）。
 *
 * 恢复钥匙（SGX_LOCK_SPACE_KEY；界面叫 recovery key）一把就签 reset 票（Gray B）：不再要第二次验证（原 needLock + lockProof），
 * 也不再读重置开关（lock_reset_switch，L2 删了以后没有意义；模块和表在 L3 删）。有没有进站凭证都走这一个入口（原锁屏没设置时的
 * /api/space-auth { purpose:'lock-reset' } 前端不再用）。限速照旧（core/space-check.js：单 IP 5 次锁 15 分钟 + 全局减速）。
 *
 * reset 票（sgx-lock-reset，SGX_LOCK_* 签，3 分钟）只开 reset 终端里的写：设解锁密码（/api/lock-password set / change）、
 * 通行密钥 list / 加 / 删（/api/lock-passkey）。这些写在 reset 票下**不推纪元**（L8：不碰会话；第一次配置进站凭证那一次照旧推，见那两个接口）；
 * 其他设备怎么办由 finish 决定（Q1 两选：all 全部回锁屏 / none 不动）。不签进站会话。
 * L2 会把这些写搬进 /api/space/reset 本身、reset 用自己的纪元；L1 先用旧接口，所以 signOut:'none' 时 reset 票只清 cookie、不推纪元。
 *
 * POST /api/lock-reset
 * - { action: 'status' } → { ok:true, available:true }（无需会话）
 * - { action: 'verify', spaceKey } → 恢复钥匙对 → 签 reset 票（by=space）200 { ok:true }；错 → 401 auth；限速 → 429 cooldown
 * - { action: 'finish', signOut: 'all'|'none' } → 要有效 reset 票（否则 401 reset）。all：Lock 纪元 +1（所有设备回锁屏，
 *   reset 票也随之失效）；none：什么都不推。两种都清 reset cookie。200 { ok:true, signOut }
 * - { action: 'end' } → 清 reset cookie（幂等，不要求票）
 *
 * 只接受 POST；校验 Origin。不看进站会话（锁屏上的人本来就没有会话）。不调账号 Worker。
 */
import { checkSpaceCredential } from '../core/space-check.js';
import { issueTicket, verifyTicket, clearTicket } from '../core/tickets.js';
import { bumpLockEpoch } from '../core/lock-session.js';
import { LOCK_RESET_TICKET, BY_SPACE } from '../core/realms.js';
import { writeSpaceAudit } from '../core/space-audit.js';
import { isSameOrigin, json, apiError, clientIp } from '../lib/http.js';
import { REALM_LOCK, realmPrivateKey, realmPublicKey } from '../core/realms.js';

/* 审计 path */
const PURPOSE = 'lock-reset';
/** finish 的两种选择（Q1：锁屏上这台设备本来就没有会话，原稿「除本机以外」和「全部」结果相同，合成一项） */
export const SIGN_OUT = Object.freeze(['all', 'none']);

/** @param {any} context */
export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return apiError(500, 'server');
  }
}

/** @param {any} context */
async function handlePost(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return json(405, { ok: false });
  }
  if (!isSameOrigin(request)) {
    return apiError(403, 'origin');
  }
  if (!(env && env[REALM_LOCK.d1Binding])) {
    return apiError(500, 'config');
  }

  let body;
  try { body = await request.json(); } catch (e) {
    return apiError(400, 'body');
  }
  const action = (body && body.action) || '';

  if (action === 'status') {
    return json(200, { ok: true, available: true });
  }

  /* end：只清 reset cookie（离开 reset 终端、没改过东西；幂等） */
  if (action === 'end') {
    const headers = new Headers();
    clearTicket(headers, LOCK_RESET_TICKET);
    return json(200, { ok: true }, headers);
  }

  /* finish：第一次改动后选「其他设备怎么办」 */
  if (action === 'finish') {
    const signOut = body && body.signOut;
    if (SIGN_OUT.indexOf(signOut) === -1) return apiError(400, 'params');
    const tv = await verifyTicket(request, env, LOCK_RESET_TICKET);
    if (!tv.ok) return apiError(401, 'reset');
    if (signOut === 'all') {
      try {
        await bumpLockEpoch(env);
      } catch (e) {
        return apiError(503, 'server');
      }
    }
    await writeSpaceAudit(env, clientIp(request), true, { path: PURPOSE, via: 'finish-' + signOut });
    const headers = new Headers();
    clearTicket(headers, LOCK_RESET_TICKET);
    return json(200, { ok: true, signOut: signOut }, headers);
  }

  if (action === 'verify') {
    const lockKeysReady = !!(realmPrivateKey(env, REALM_LOCK) && realmPublicKey(env, REALM_LOCK)); /* SGX_LOCK_* */
    const spaceKey = (env && env[REALM_LOCK.spaceKey]) || ''; /* SGX_LOCK_SPACE_KEY */
    if (!lockKeysReady || !spaceKey) {
      return apiError(500, 'config');
    }
    const ip = clientIp(request);
    /* 恢复钥匙（core/space-check.js：限速 → 比对 → 计数 / 审计） */
    const rc = await checkSpaceCredential({
      env: env,
      ip: ip,
      key: (body && typeof body.spaceKey === 'string' && body.spaceKey) || '',
      auditPath: PURPOSE,
    });
    if (!rc.ok) return rc.response;
    const headers = new Headers();
    const dErr = await issueTicket(env, headers, LOCK_RESET_TICKET, BY_SPACE);
    if (dErr) {
      await writeSpaceAudit(env, ip, false, { path: PURPOSE });
      return json(dErr.status, dErr.body);
    }
    /* 成功路径写不进审计就不签（fail closed，同原来） */
    if (!(await writeSpaceAudit(env, ip, true, { path: PURPOSE }))) {
      return apiError(503, 'server');
    }
    return json(200, { ok: true }, headers);
  }

  return apiError(400, 'action');
}
