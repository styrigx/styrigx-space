/**
 * 锁屏密码（LockKey 的密码）：解锁验证、进锁屏凭证的门、设置 / 修改 / 删除。
 *
 * 只管锁屏密码（账号密码在账号 Worker 的 POST /api/account password-change，网关不碰）。
 * 请求体不再带 kind（路径就是域）。
 *
 * POST /api/lock-password
 * Body: { action: "verify"|"set"|"change"|"remove", ... }
 * - verify { password, reauth? }：锁屏密码解锁（IP 限速：每连错 5 次冷却一轮，30 秒起逐轮翻倍、封顶 1 小时，429 cooldown；全局只减速）；
 *   reauth:true（有 admin 锁屏会话）不签会话，改签 3 分钟 LockReauthTicket（安全与隐私 → 锁屏凭证）
 * - set / change { password }：需 LockReauthTicket + admin 锁屏会话，或 LockResetTicket
 * - remove：只认 LockReauthTicket（重置锁屏不能删）
 * - 哈希：PBKDF2-SHA256 + 随机 salt + SGX_PW_PEPPER（workers/auth-gateway/functions/_kernel/lib/password.js）；旧 hash 下次成功登录时重哈希；缺 pepper fail closed
 *
 * 会话可吊销：改密码 / 删密码时 lock-epoch +1，旧 cookie 失效；纪元推进后重签 reauth / reset 票 + 当前设备会话。
 * 锁定所有设备走 /api/lock-all-devices。读存储出错时 → 503，绝不继续写入。
 * 存储：密码记录、纪元、输错计数都在 D1（_kernel/d1-state.js / password-limit.js，强一致：改完下一个请求就认新密码、拒旧密码）。
 * 只接受 POST；校验 Origin；未设置密码时 verify 一律拒绝。
 * 外层 try/catch：任何未捕获异常都返回 JSON { ok:false, error:'server' }，不返回 500 HTML。
 */
import { getPepper, makePasswordRecord, verifyRealmPassword, getPassword, hasPassword, savePassword, deletePassword } from '../_kernel/lib/password.js';
import { REALM_LOCK } from '../_kernel/realms.js';
import {
  issueLockSession,
  bumpLockEpoch,
  reissueLockSessionWithEpoch,
  ROLE_ADMIN,
} from '../_kernel/lock-session.js';
import { checkLockManage } from '../_kernel/lock-manage.js';
import { issueTicket, reissueTicketWithEpoch } from '../_kernel/tickets.js';
import { LOCK_REAUTH_TICKET, BY_PASSWORD } from '../_kernel/realms.js';
import { verifyLockSession, looksVisitor } from '../_kernel/lock-session.js';
import { getPasskeys, PASSKEY_LOCK } from '../_kernel/passkey-store.js';
import { isSameOrigin, originDenied, json, apiError, clientIp } from '../_kernel/lib/http.js';
import { passwordLimiter } from '../_kernel/lib/password-limit.js';
import { clearAllAttempts } from '../_kernel/lib/attempt-limit.js';


/** @param {any} context */
export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    /* 任何未捕获异常 → JSON 500，前端可区分「服务器错误」与「网络错误」 */
    return apiError(500, 'server');
  }
}

/** @param {any} context */
async function handlePost(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return apiError(405, 'method');
  }
  /* Origin 必须与本站同 host（CSRF 防护），缺失或解析失败一律 403 */
  if (!isSameOrigin(request)) return originDenied();
  if (!(env && env[REALM_LOCK.d1Binding])) {
    return apiError(500, 'config');
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return apiError(400, 'body');
  }
  const action = (body && body.action) || '';

  /* 客户端 IP（限流用） */
  const ip = clientIp(request);
  const limiter = passwordLimiter(env, REALM_LOCK, ip);
  const inCooldown = limiter.inCooldown;
  const recordFail = limiter.recordFail;
  const clearFail = limiter.clearFail;

  /* ============ verify：解锁验证（锁屏密码） ============ */
  /* 只认锁屏密码；账号密码不能解锁（各层凭证不互相替代）。 */
  if (action === 'verify') {
    const toReauth = !!(body && body.reauth === true);
    /* 再验证：访客写死「密码错误」，不读任何存储；不是admin 会话 → 401 session */
    let reauthSess = null;
    if (toReauth) {
      if (looksVisitor(request)) {
        return apiError(403, 'wrong');
      }
      reauthSess = await verifyLockSession(request, env);
      if (!reauthSess.ok || reauthSess.role !== ROLE_ADMIN) {
        return apiError(401, 'session');
      }
    }
    let cooling = false;
    try {
      cooling = await inCooldown();
    } catch (e) {
      return apiError(503, 'server');
    }
    if (cooling) {
      return apiError(429, 'cooldown');
    }
    const password = (body && body.password) || '';
    if (!password || typeof password !== 'string') {
      return apiError(400, 'password');
    }
    /* 缺 pepper 时 fail closed（拒绝校验，不降级） */
    const pepper = getPepper(env);
    if (!pepper) {
      return apiError(503, 'config');
    }
    let vr;
    try {
      vr = await verifyRealmPassword(env, REALM_LOCK, pepper, password);
    } catch (e) {
      return apiError(503, 'server');
    }
    if (!vr.set) {
      return apiError(403, 'not-set');
    }
    if (!vr.ok) {
      let justCooled = false;
      try {
        justCooled = await recordFail();
      } catch (e) {
        return apiError(503, 'server');
      }
      return json(justCooled ? 429 : 403, { ok: false, error: justCooled ? 'cooldown' : 'wrong' });
    }
    await clearFail();
    /* 旧 hash 成功验证后重哈希（加 pepper），写回锁屏密码 */
    if (vr.needsRehash) {
      try {
        await savePassword(env, REALM_LOCK, await makePasswordRecord(password, pepper));
      } catch (e) {}
    }
    /* 通过：签发 Ed25519 会话 cookie（fail closed：无密钥/签发失败 → 5xx，
       绝不静默跳过然后返回 ok:true）。密码验证签admin 会话（12 小时） */
    const headers = new Headers();
    if (toReauth) {
      /* 再验证：只签 LockReauthTicket（3 分钟），会话不动 */
      const dErr = await issueTicket(env, headers, LOCK_REAUTH_TICKET, BY_PASSWORD);
      if (dErr) return json(dErr.status, dErr.body);
      return json(200, { ok: true }, headers);
    }
    const signErr = await issueLockSession(env, headers, { by: BY_PASSWORD, role: ROLE_ADMIN });
    if (signErr) {
      return json(signErr.status, signErr.body);
    }
    return json(200, { ok: true }, headers);
  }

  /* ============ set/change/remove ============
     需 LockReauthTicket（锁屏凭证或根凭证再验证）+ admin 锁屏会话；
     LockResetTicket 可 set/change（重置流程，无会话），不可 remove。 */
  if (action === 'set' || action === 'change' || action === 'remove') {
    /* 门禁。sess 保留到 remove/set/change，纪元推进后用它重签当前设备会话。 */
    const gate = await checkLockManage(request, env, { allowReset: action !== 'remove' });
    if (!gate.ok) {
      return json(gate.status, gate.body);
    }
    const sessP = gate.sess;

    /* 缺 pepper 时 fail closed（set/change；remove 不需要） */
    const pepper = getPepper(env);
    if (action !== 'remove' && !pepper) {
      return apiError(503, 'config');
    }

    /* remove：删除密码，同时清掉失败计数和锁定 */
    if (action === 'remove') {
      /* 锁屏凭证任何时候都不许删到 0（方案第 15 节 U3）：删后无锁屏通行密钥 → 403 last-key。
         读失败按「没有别的凭证」处理（fail closed）。检查在任何 mutation 之前。 */
      {
        let lockKeys = [];
        try {
          lockKeys = await getPasskeys(env, PASSKEY_LOCK);
        } catch (e) {}
        if (lockKeys.length === 0) {
          return apiError(403, 'last-key');
        }
      }
      try {
        await deletePassword(env, REALM_LOCK);
      } catch (e) {
        return apiError(503, 'server');
      }
      /* 清掉所有输错计数和冷却记录（IP 限速残留；全局窗口不动）。锁屏层是否还算已配置由真实凭证推出，不另存标记 */
      try { await clearAllAttempts(env, REALM_LOCK.id, 'password'); } catch (e) {}
      /* 会话吊销：lock-epoch +1（D1 出错→503，绝不继续）
         纪元推进后重签 reauth / reset 票 + 当前设备会话，保持门内连续操作、当前设备不掉线。 */
      let newEpoch = null;
      try {
        newEpoch = await bumpLockEpoch(env);
      } catch (e) {
        return apiError(503, 'server');
      }
      const headers = new Headers();
      if (newEpoch !== null) {
        await reissueTicketWithEpoch(env, headers, gate.ticket, gate.tv, newEpoch);
        await reissueLockSessionWithEpoch(env, headers, sessP, newEpoch);
      }
      return json(200, { ok: true }, headers);
    }

    const newPassword = (body && (body.password || body.newPassword)) || '';
    if (!newPassword || typeof newPassword !== 'string') {
      return apiError(400, 'params');
    }
    if (newPassword.length < 8) {
      return apiError(400, 'short');
    }

    /* set：未设置过才能设 */
    if (action === 'set') {
      let existing = null;
      try { existing = await getPassword(env, REALM_LOCK); } catch (e) {}
      if (existing && existing.hash) {
        return apiError(403, 'exists');
      }
    }


    /* 哈希并存储（peppered 标记） */
    try {
      await savePassword(env, REALM_LOCK, await makePasswordRecord(newPassword, pepper));
    } catch (e) {
      return apiError(503, 'server');
    }

    /* 改密码后：lock-epoch +1，旧会话 cookie 失效（D1 出错→503）
       纪元推进后重签 reauth / reset 票 + 当前设备会话，保持门内连续操作、当前设备不掉线。 */
    let newEpoch2 = null;
    try {
      newEpoch2 = await bumpLockEpoch(env);
    } catch (e) {
      return apiError(503, 'server');
    }
    const headers2 = new Headers();
    if (newEpoch2 !== null) {
      await reissueTicketWithEpoch(env, headers2, gate.ticket, gate.tv, newEpoch2);
      await reissueLockSessionWithEpoch(env, headers2, sessP, newEpoch2);
    }
    return json(200, { ok: true }, headers2);
  }

  return apiError(400, 'action');
}
