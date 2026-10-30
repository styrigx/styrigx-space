/**
 * 重置锁屏（丢了锁屏凭证时；方案第 7 节）。
 *
 * 前端「重置登录」（auth/reset-flow.js，锁屏弹层里的「无法登录？」）先交锁屏根密钥，服务端决定下一步。
 *
 * verify 步骤：
 * 1. 验 SGX_ADMIN_KEY（_kernel/root-check.js：限速 → 比对 → 计数 / 审计）。错 → 401 auth。
 * 2. 根密钥正确后才读重置开关（_kernel/lock-reset-switch.js：D1 lock_reset_switch 表，开关 + 计时 / 单次都在 D1）。
 *    开关有效 → 原子 claim → 签 LockResetTicket（by=root，审计 via=switch）。claim 被并发抢走 → 按开关无效处理。
 * 3. 开关无效 → 验锁屏凭据（锁屏密码或锁屏通行密钥）：
 *    - 无 lockProof → 200 { ok:true, needLock:true, passkey, password }（布尔值 = 锁屏有没有对应凭据；
 *      响应形态与开关有效时一致，前端不提示开关存在）
 *    - 锁屏凭据一项都没有 → 计失败，401 auth（不泄露 not-set）
 *    - lockProof { type:'password', password } → verifyRealmPassword(REALM_LOCK, SGX_PW_PEPPER)
 *    - lockProof { type:'passkey', cid, credential } → 消费下面 challenge 下发的那次，按锁屏通行密钥验断言（UV 必需）
 *    - 通过 → LockResetTicket（by=password 或 passkey）；失败 → 计入锁屏根密钥的失败计数 + 审计，401 auth
 *
 * LockResetTicket（sgx-lock-reset，SGX_LOCK_* 签，3 分钟）只能增删锁屏凭证、设置锁屏密码；不签会话；完成后 Lock 纪元 +1。
 * 本接口不调账号 Worker、不读账号的任何东西（方案第 2 节）。前置检查只要 D1_LOCK_AUTH、SGX_LOCK_*、SGX_ADMIN_KEY、SGX_PW_PEPPER。
 *
 * POST /api/lock-reset
 * - { action: 'status' } → { ok:true, available:true }（无需会话；不读开关）
 * - { action: 'challenge' } → 锁屏通行密钥断言 challenge（realm='lock'，purpose=reset，5 分钟、单次）；
 *   allowCredentials = 锁屏通行密钥列表；没有锁屏通行密钥 → 403 not-set
 * - { action: 'verify', rootKey, lockProof? } → 见上
 *
 * 只接受 POST；校验 Origin；访客会话直接 401 denied（B1-9 假入口）。
 */
import { checkRootCredential } from '../_kernel/root-check.js';
import { issueTicket } from '../_kernel/tickets.js';
import { LOCK_RESET_TICKET, BY_ROOT, BY_PASSWORD, BY_PASSKEY } from '../_kernel/realms.js';
import { randB64, verifyAssertion, rpIdHashOf, consumeChallenge, issueChallenge, findStoredKey } from '../_kernel/lib/passkey-verify.js';
import { getPasskeys, getUserHandle, updatePasskey, PASSKEY_LOCK } from '../_kernel/passkey-store.js';
import { getPepper, verifyRealmPassword, hasPassword } from '../_kernel/lib/password.js';
import { recordRootFail } from '../_kernel/root-limit.js';
import { writeRootAudit } from '../_kernel/root-audit.js';
import { checkLockResetSwitch, claimLockResetSwitch } from '../_kernel/lock-reset-switch.js';
import { isSameOrigin, json, apiError, clientIp } from '../_kernel/lib/http.js';
import { looksVisitor } from '../_kernel/lock-session.js';
import { REALM_LOCK, realmPrivateKey, realmPublicKey, rpConfig, rpConfigMissing } from '../_kernel/realms.js';

/* 重置锁屏（本接口）的锁屏通行密钥 challenge：D1 challenge 表 realm='lock'、purpose='reset'（与锁屏解锁、注册的 challenge 隔离） */
const CH_PURPOSE = REALM_LOCK.challenge.reset;
const CHALLENGE_TTL = REALM_LOCK.challenge.ttl; /* 5 分钟 */
/* 审计 path */
const PURPOSE = 'lock-reset';


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
  /* B1-9 访客假入口统一 401：访客会话直接返回，不读任何存储，也到不了根凭证比对。
     判断与 lock-password / lock-passkey 共用 _kernel/lock-session.js looksVisitor（六段票）。 */
  if (looksVisitor(request)) {
    return apiError(401, 'denied');
  }
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

  /* ============ status：始终允许进入第一步（不暴露锁屏凭证是否配置；
     不读开关；开关只在 verify 根密钥正确后读） ============ */
  if (action === 'status') {
    return json(200, {
      ok: true,
      available: true,
    });
  }

  const rp = rpConfig(env);
  const lockKeysReady = !!(realmPrivateKey(env, REALM_LOCK) && realmPublicKey(env, REALM_LOCK)); /* SGX_LOCK_* */
  const rootKey = (env && env[REALM_LOCK.rootKey]) || ''; /* SGX_ADMIN_KEY */
  if (!rp) return rpConfigMissing();
  const RP_ID = rp.rpId;
  const EXPECT_ORIGIN = rp.origin;
  if (!lockKeysReady || !rootKey) {
    return apiError(500, 'config');
  }

  /* ============ challenge：下发锁屏通行密钥断言 challenge ============ */
  if (action === 'challenge') {
    let lockPks = [];
    try {
      lockPks = await getPasskeys(env, PASSKEY_LOCK);
    } catch (e) {
      return apiError(503, 'server');
    }
    if (lockPks.length === 0) {
      return apiError(403, 'not-set');
    }
    const challenge = randB64(32);
    let cid;
    try {
      cid = await issueChallenge(env, REALM_LOCK, CH_PURPOSE, challenge, CHALLENGE_TTL);
    } catch (e) {
      return apiError(500, 'server');
    }
    return json(200, {
      ok: true,
      cid: cid,
      challenge: challenge,
      rpId: RP_ID,
      allowCredentials: lockPks.map(function (k) { return { id: k.credId, type: 'public-key' }; }),
    });
  }

  /* ============ verify：锁屏根密钥 → 开关 → 锁屏凭据 ============ */
  if (action === 'verify') {
    const ip = clientIp(request);

    /* fail()：锁屏凭据错误时记失败计数（计入锁屏根密钥那一套限速）；写 D1 出错时返回 503 响应对象 */
    const fail = async function () {
      try {
        await recordRootFail(env, ip);
      } catch (e) {
        await writeRootAudit(env, ip, false, { path: PURPOSE });
        return apiError(503, 'server');
      }
      await writeRootAudit(env, ip, false, { path: PURPOSE });
      return null;
    };

    /* --- 步骤 1：锁屏根密钥（_kernel/root-check.js：限速 → 比对 → 计数 / 审计；不读开关） --- */
    const rc = await checkRootCredential({
      env: env,
      ip: ip,
      key: (body && typeof body.rootKey === 'string' && body.rootKey) || '',
      auditPath: PURPOSE,
    });
    if (!rc.ok) return rc.response;

    /* --- 步骤 2：根密钥正确后才读重置开关 --- */
    const db = env && env[REALM_LOCK.d1Binding]; /* lock_reset_switch 经 D1_LOCK_AUTH */
    const sw = await checkLockResetSwitch(db);
    if (sw.valid) {
      /* 开关路径：原子标记已用（抢不到则视为已用，走锁屏凭据路径） */
      const claimed = await claimLockResetSwitch(db, sw.hash);
      if (claimed) {
        return await issueLockResetTicket(ip, BY_ROOT, { via: 'switch' });
      }
      /* 被并发抢走 → 按开关无效处理 */
    }

    /* --- 步骤 3：开关无效 → 验锁屏凭据 --- */
    let hasLockPw = false;
    let lockPks = [];
    try {
      hasLockPw = await hasPassword(env, REALM_LOCK);
      lockPks = await getPasskeys(env, PASSKEY_LOCK);
    } catch (e) {
      return apiError(503, 'server');
    }
    /* 锁屏凭据一项都没有：计失败、通用 401 auth（不泄露 not-set） */
    if (!hasLockPw && lockPks.length === 0) {
      const failResp = await fail();
      if (failResp) return failResp;
      return apiError(401, 'auth');
    }
    const proof = (body && body.lockProof) || null;
    if (!proof) {
      /* 响应形态与开关有效时一致（都是 200 ok），前端据此展示锁屏凭据步骤，不提示开关存在；
         needLock 带 passkey / password 布尔，前端按配置显示按钮。 */
      return json(200, { ok: true, needLock: true, passkey: lockPks.length > 0, password: hasLockPw });
    }
    let by = '';
    if (proof.type === 'password') {
      const pepper = getPepper(env);
      if (!pepper) {
        const failResp = await fail();
        if (failResp) return failResp;
        return apiError(503, 'config');
      }
      try {
        const vr = await verifyRealmPassword(env, REALM_LOCK, pepper, String(proof.password || ''));
        if (vr.set && vr.ok) by = BY_PASSWORD;
      } catch (e) {
        const failResp = await fail();
        if (failResp) return failResp;
        return apiError(503, 'server');
      }
    } else if (proof.type === 'passkey') {
      if (await verifyLockPasskeyProof(proof, lockPks, RP_ID, EXPECT_ORIGIN)) by = BY_PASSKEY;
    }
    if (!by) {
      const failResp = await fail();
      if (failResp) return failResp;
      return apiError(401, 'auth');
    }
    return await issueLockResetTicket(ip, by, null);

    /* 签发 LockResetTicket（sgx-lock-reset，SGX_LOCK_* 签，3 分钟；内部函数） */
    async function issueLockResetTicket(ipAddr, ticketBy, auditExtra) {
      const headers = new Headers();
      const dErr = await issueTicket(env, headers, LOCK_RESET_TICKET, ticketBy);
      if (dErr) {
        await writeRootAudit(env, ipAddr, false, { path: PURPOSE });
        return json(dErr.status, dErr.body);
      }
      const auditOk = await writeRootAudit(
        env, ipAddr, true,
        auditExtra && auditExtra.via === 'switch' ? { path: PURPOSE, via: 'switch' } : { path: PURPOSE }
      );
      if (!auditOk) {
        return apiError(503, 'server');
      }
      return json(200, { ok: true }, headers);
    }

    /* 验锁屏通行密钥断言（内部函数）：单次 challenge（realm='lock'、purpose='reset'）、UV 必需、userHandle 有就核对 */
    async function verifyLockPasskeyProof(proofObj, keys, rpId, expectOrigin) {
      const cid = proofObj.cid || '';
      const cred = proofObj.credential || {};
      /* 单次使用：一条 DELETE ... RETURNING（realm='lock'、purpose='reset'、未过期） */
      const chRec = await consumeChallenge(env, REALM_LOCK, CH_PURPOSE, cid);
      if (!chRec) return false;
      const stored = findStoredKey(keys, cred.rawId || '');
      if (!stored || !stored.publicKey) return false;
      try {
        const rpIdHash = await rpIdHashOf(rpId);
        const checked = await verifyAssertion({
          credential: cred,
          challenge: chRec.challenge,
          rpIdHash: rpIdHash,
          expectOrigin: expectOrigin,
          storedPublicKey: stored.publicKey,
          storedSignCount: stored.signCount,
          requireUV: true,
        });
        const gotUh = cred.response && cred.response.userHandle;
        if (gotUh) {
          const expectUh = await getUserHandle(env, PASSKEY_LOCK);
          if (expectUh && gotUh !== expectUh) return false;
        }
        stored.signCount = checked.signCount;
        stored.lastUsedAt = Date.now();
        try { await updatePasskey(env, PASSKEY_LOCK, stored); } catch (e2) {}
        return true;
      } catch (e) {
        return false;
      }
    }
  }

  return apiError(400, 'action');
}
