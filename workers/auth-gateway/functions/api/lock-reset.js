/**
 * 重置锁屏（丢了锁屏凭证时）。
 *
 * 前端「重置登录」（auth/reset-flow.js，锁屏弹层里的「无法登录？」）先交根凭证，服务端决定下一步。
 *
 * 流程（根凭证优先）：
 * 1. 先输入根凭证，与环境变量比对（不读 KV）。错误按现有认证失败处理。
 * 2. 根凭证正确后才读重置开关（_kernel/lock-reset-switch.js：KV 开关 + D1 计时/单次）。
 *    开关有效 → 签发 LockResetTicket（by=root）（审计 via=switch），并原子标记已用。
 * 3. 开关无效 → 继续要求账号凭证（AccountKey），通过后签发 LockResetTicket（by=account：RootKey + AccountKey 双验，by 只记 account）。
 *
 * 前端不提示开关存在；两种情况响应形态一致，由服务端决定下一步。
 * 只在重置锁屏路径、且根凭证正确后读开关，其他请求一律不读。
 *
 * LockResetTicket（sgx-lock-reset，SGX_LOCK_* 签，3 分钟）只能增删锁屏凭证、设置锁屏密码；
 * 不签锁屏会话、不进主页面、不管会话。完成后推进 lock-epoch，用新锁屏凭证正常解锁。
 *
 * 账号未配置时锁屏重置不可用（重置开关除外）。
 *
 * POST /api/lock-reset
 * - { action: 'status' } → { ok:true, available }（无需会话；不读开关）
 * - { action: 'challenge' } → 下发 AccountKey 断言 challenge（purpose=lock-reset）
 * - { action: 'verify', rootKey, accountProof? } →
 *     根凭证错 → 401 auth；
 *     根凭证对 + 开关有效 → LockResetTicket（by=root, via=switch）；
 *     根凭证对 + 开关无效 + 无 accountProof → { ok:true, needAccount:true, passkey, password }；
 *     根凭证对 + 开关无效 + accountProof 有效 → LockResetTicket（by=account）
 *
 * 根凭证失败、账号凭证失败都计入根凭证共用限速；审计标记 via=switch（不对前端暴露）。
 * 只接受 POST；校验 Origin。
 */
import { checkRootCredential } from '../_kernel/root-check.js';
import { issueTicket } from '../_kernel/tickets.js';
import { LOCK_RESET_TICKET, BY_ACCOUNT } from '../_kernel/realms.js';
import { randB64, verifyAssertion, rpIdHashOf, consumeChallenge, findStoredKey } from '../_kernel/passkey-verify.js';
import { getPasskeys, PASSKEY_ACCOUNT } from '../_kernel/passkey-store.js';
import { getPepper, verifyRealmPassword } from '../_kernel/password.js';
import { recordRootFail } from '../_kernel/root-limit.js';
import { writeRootAudit } from '../_kernel/root-audit.js';
import { isLayerConfigured, LAYER_ACCOUNT } from '../_kernel/layers.js';
import { checkLockResetSwitch, claimLockResetSwitch } from '../_kernel/lock-reset-switch.js';
import { isSameOrigin, json, apiError, clientIp } from '../_kernel/http.js';
import { looksVisitor } from '../_kernel/lock-session.js';
import { REALM_LOCK, REALM_ACCOUNT, REALM_ROOT, realmPrivateKey, realmPublicKey, rpConfig, rpConfigMissing } from '../_kernel/realms.js';

/* 重置锁屏（本接口）的账号通行密钥 challenge（与锁屏、账号登录的 challenge 隔离） */
const CHALLENGE_PREFIX = REALM_LOCK.kv.resetChallengePrefix;
/* challenge 记录的用途标记 + 审计 path */
const PURPOSE = 'lock-reset';
const CHALLENGE_TTL = 300; /* 5 分钟 */


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
  const kv = env && env.KV_LOCK_DOOR;
  if (request.method !== 'POST') {
    return json(405, { ok: false });
  }
  if (!isSameOrigin(request)) {
    return apiError(403, 'origin');
  }
  if (!kv) {
    return apiError(500, 'config');
  }

  let body;
  try { body = await request.json(); } catch (e) {
    return apiError(400, 'body');
  }
  const action = (body && body.action) || '';
  let accountCfg = true;
  try { accountCfg = await isLayerConfigured(kv, LAYER_ACCOUNT); } catch (e) { accountCfg = true; }

  /* ============ status：始终允许进入第一步（不暴露账号凭证是否配置；
     不读开关；开关只在 verify 根凭证正确后读） ============ */
  if (action === 'status') {
    return json(200, {
      ok: true,
      available: true,
    });
  }

  const rp = rpConfig(env);
  const lockKeysReady = !!(realmPrivateKey(env, REALM_LOCK) && realmPublicKey(env, REALM_LOCK)); /* SGX_LOCK_* */
  const rootKey = (env && env[REALM_ROOT.secret]) || ''; /* SGX_ROOT_KEY */
  if (!rp) return rpConfigMissing();
  const RP_ID = rp.rpId;
  const EXPECT_ORIGIN = rp.origin;
  if (!lockKeysReady || !rootKey) {
    return apiError(500, 'config');
  }

  /* ============ challenge：下发 AccountKey 断言 challenge ============ */
  if (action === 'challenge') {
    if (!accountCfg) {
      return apiError(403, 'not-set');
    }
    const accountPks = await getPasskeys(kv, PASSKEY_ACCOUNT);
    if (accountPks.length === 0) {
      return apiError(403, 'not-set');
    }
    const challenge = randB64(32);
    const cid = randB64(16);
    try {
      await kv.put(
        CHALLENGE_PREFIX + cid,
        JSON.stringify({ challenge: challenge, purpose: PURPOSE, exp: Date.now() + CHALLENGE_TTL * 1000 }),
        { expirationTtl: CHALLENGE_TTL }
      );
    } catch (e) {
      return apiError(500, 'server');
    }
    return json(200, {
      ok: true,
      cid: cid,
      challenge: challenge,
      rpId: RP_ID,
      allowCredentials: accountPks.map(function (k) { return { id: k.credId, type: 'public-key' }; }),
    });
  }

  /* ============ verify：根凭证优先 → 开关 → 账号凭证 ============ */
  if (action === 'verify') {
    const ip = clientIp(request);

    /* fail()：账号凭证错误时记失败计数（与根凭证共用一套限速）；写 KV 出错时返回 503 响应对象 */
    const fail = async function () {
      try {
        await recordRootFail(kv, ip);
      } catch (e) {
        await writeRootAudit(kv, ip, false, { path: PURPOSE });
        return apiError(503, 'server');
      }
      await writeRootAudit(kv, ip, false, { path: PURPOSE });
      return null;
    };

    /* --- 步骤 1：根凭证（共用实现 _kernel/root-check.js：限速 → 比对 → 计数 / 审计；不读 KV 开关） --- */
    const rc = await checkRootCredential({
      env: env,
      kv: kv,
      ip: ip,
      key: (body && typeof body.rootKey === 'string' && body.rootKey) || '',
      auditPath: PURPOSE,
    });
    if (!rc.ok) return rc.response;

    /* --- 步骤 2：根凭证正确后才读重置开关 --- */
    const db = env && env.D1_LOCK_RESET;
    const sw = await checkLockResetSwitch(kv, db);
    if (sw.valid) {
      /* 开关路径：原子标记已用（抢不到则视为已用，走账号凭证路径） */
      const claimed = await claimLockResetSwitch(db, sw.hash);
      if (claimed) {
        return await issueLockResetTicket(ip, 'root', { via: 'switch' });
      }
      /* 被并发抢走 → 按开关无效处理 */
    }

    /* --- 步骤 3：开关无效 → 需要账号凭证 ---
       账号凭证未配置时返回通用 401 auth（不泄露 not-set，避免暴露配置状态）。 */
    if (!accountCfg) {
      const failResp = await fail();
      if (failResp) return failResp;
      return apiError(401, 'auth');
    }
    const proof = (body && body.accountProof) || null;
    if (!proof) {
      /* 响应形态与开关有效时一致（都是 200 ok），由服务端决定下一步；
         前端据此展示账号凭证步骤，不提示开关存在。
         needAccount 带 passkey/password 布尔，前端按配置显示按钮，不总显示两个。 */
      let hasAccountPw = false;
      let hasAccountPk = false;
      try {
        const r = await kv.get(REALM_ACCOUNT.kv.password, 'json');
        hasAccountPw = !!(r && r.hash);
      } catch (e) {}
      try {
        hasAccountPk = (await getPasskeys(kv, PASSKEY_ACCOUNT)).length > 0;
      } catch (e) {}
      return json(200, { ok: true, needAccount: true, passkey: hasAccountPk, password: hasAccountPw });
    }
    let accountOk = false;
    if (proof.type === 'password') {
      const pepper = getPepper(env);
      if (!pepper) {
        const failResp = await fail();
        if (failResp) return failResp;
        return apiError(503, 'config');
      }
      try {
        const vr = await verifyRealmPassword(kv, REALM_ACCOUNT, pepper, String(proof.password || ''));
        accountOk = vr.set && vr.ok;
      } catch (e) {
        const failResp = await fail();
        if (failResp) return failResp;
        return apiError(503, 'server');
      }
    } else if (proof.type === 'passkey') {
      accountOk = await verifyAccountPasskeyProof(kv, proof, RP_ID, EXPECT_ORIGIN);
    }
    if (!accountOk) {
      const failResp = await fail();
      if (failResp) return failResp;
      return apiError(401, 'auth');
    }
    return await issueLockResetTicket(ip, BY_ACCOUNT, null);

    /* 签发 LockResetTicket（sgx-lock-reset，SGX_LOCK_* 签，3 分钟；内部函数） */
    async function issueLockResetTicket(ipAddr, by, auditExtra) {
      const headers = new Headers();
      const dErr = await issueTicket(env, headers, LOCK_RESET_TICKET, by);
      if (dErr) {
        await writeRootAudit(kv, ipAddr, false, { path: PURPOSE });
        return json(dErr.status, dErr.body);
      }
      const auditOk = await writeRootAudit(
        kv, ipAddr, true,
        auditExtra && auditExtra.via === 'switch' ? { path: PURPOSE, via: 'switch' } : { path: PURPOSE }
      );
      if (!auditOk) {
        return apiError(503, 'server');
      }
      return json(200, { ok: true }, headers);
    }

    /* 验证账号通行密钥 断言（内部函数） */
    async function verifyAccountPasskeyProof(kvStore, proofObj, rpId, expectOrigin) {
      const cid = proofObj.cid || '';
      const cred = proofObj.credential || {};
      const chRec = await consumeChallenge(kvStore, CHALLENGE_PREFIX + cid);
      if (!chRec || chRec.purpose !== PURPOSE || chRec.exp < Date.now()) return false;
      const accountPks = await getPasskeys(kvStore, PASSKEY_ACCOUNT);
      const stored = findStoredKey(accountPks, cred.rawId || '');
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
        stored.signCount = checked.signCount;
        stored.lastUsedAt = Date.now();
        return true;
      } catch (e) {
        return false;
      }
    }
  }

  return apiError(400, 'action');
}
