/**
 * 2.11 定稿 + 补充：重置锁屏（丢了 lock 凭证时）。
 *
 * 流程（根凭证优先）：
 * 1. 先输入根凭证，与环境变量比对（不读 KV）。错误按现有认证失败处理。
 * 2. 根凭证正确后才读恢复开关（KV `recovery-switch` + D1 计时/单次）。
 *    开关有效 → 签发 by=root, via=switch, scope=lockreset，并原子标记已用。
 * 3. 开关无效 → 继续要求站长凭证，通过后签发 scope=lockreset（by=owner+root）。
 *
 * 前端不提示开关存在；两种情况响应形态一致，由服务端决定下一步。
 * 只在重置锁屏路径、且根凭证正确后读开关，其他请求一律不读。
 *
 * lockreset 票只能增删 lock 凭证、设置锁屏密码；不签 sgx-verified、不进主页面、
 * 不管 APP/会话/入口 1/入口 2。完成后推进 session-epoch，用新 lock 正常解锁。
 *
 * owner 未配置时锁屏重置不可用（恢复开关除外）。
 *
 * POST /api/lockreset
 * - { action: 'status' } → { ok:true, available }（无需会话；不读开关）
 * - { action: 'challenge' } → 下发 ownerkey 断言 challenge（purpose=lockreset）
 * - { action: 'verify', rootKey, ownerProof? } →
 *     根凭证错 → 401 auth；
 *     根凭证对 + 开关有效 → lockreset（by=root, via=switch）；
 *     根凭证对 + 开关无效 + 无 ownerProof → { ok:true, needOwner:true }；
 *     根凭证对 + 开关无效 + ownerProof 有效 → lockreset（by=owner+root）
 *
 * 根凭证失败计入共用限速；审计标记 via=switch（不对前端暴露）。
 * 只接受 POST；校验 Origin。
 */
import { timingSafeEqual, normalizeRootKey } from '../_kernel/crypto.js';
import { getSessionEpoch } from '../_kernel/session.js';
import {
  signStepupCookie,
  setStepupCookie,
  STEPUP_BY_ROOT,
  STEPUP_BY_OWNER_ROOT,
  STEPUP_SCOPE_LOCKRESET,
} from './stepup.js';
import { randB64, verifyAssertion, rpIdHashOf, consumeChallenge, findStoredKey } from '../_kernel/passkey-verify.js';
import { getPasskeys, PK_CLASS_OWNER } from './owner-passkey.js';
import { verifyOwnerPassword, getPepper } from './owner-password.js';
import { checkRootLimit, recordRootFail, clearRootFail, getClientIp } from '../_kernel/rootlimit.js';
import { writeRootAudit } from '../_kernel/rootlog.js';
import { isLayerConfigured, LAYER_OWNER } from '../_kernel/layers.js';
import { checkRecoverySwitch, claimSwitchUsed } from '../_kernel/recswitch.js';
import { isSameOrigin } from '../_kernel/http.js';
import { REALM_LOCK, REALM_OWNER, REALM_STEPUP, REALM_ROOT, realmPrivateKey, rpConfig, rpConfigMissing } from '../_kernel/realms.js';

const CHALLENGE_PREFIX = REALM_STEPUP.kv.lockresetChallengePrefix; /* 'lockreset-challenge:' */
const CHALLENGE_TTL = 300; /* 5 分钟 */


/** @param {any} context */
export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return Response.json({ ok: false, error: 'server' }, { status: 500 });
  }
}

/** @param {any} context */
async function handlePost(context) {
  const { request, env } = context;
  /* B1-9 访客假入口统一 401：访客会话直接返回，不读任何存储。 */
  try {
    const h = request.headers.get('Cookie') || '';
    for (const part of h.split(';')) {
      const kv2 = part.trim().split('=');
      if (kv2[0] === REALM_LOCK.cookie && kv2[1]) { /* sgx-verified */
        const parts = kv2.slice(1).join('=').split('.');
        if (parts.length === 5 && parts[1] === 'visitor') {
          return Response.json({ ok: false, error: 'denied' }, { status: 401 });
        }
      }
    }
  } catch (e) {}
  const kv = env && env.OWNER_KV;
  if (request.method !== 'POST') {
    return Response.json({ ok: false }, { status: 405 });
  }
  if (!isSameOrigin(request)) {
    return Response.json({ ok: false, error: 'origin' }, { status: 403 });
  }
  if (!kv) {
    return Response.json({ ok: false, error: 'config' }, { status: 500 });
  }

  let body;
  try { body = await request.json(); } catch (e) {
    return Response.json({ ok: false, error: 'body' }, { status: 400 });
  }
  const action = (body && body.action) || '';
  let ownerCfg = true;
  try { ownerCfg = await isLayerConfigured(kv, LAYER_OWNER); } catch (e) { ownerCfg = true; }

  /* ============ status：始终允许进入第一步（不暴露站长凭证是否配置；
     不读开关；开关只在 verify 根凭证正确后读） ============ */
  if (action === 'status') {
    return Response.json({
      ok: true,
      available: true,
    });
  }

  const rp = rpConfig(env);
  const stepupKey = realmPrivateKey(env, REALM_STEPUP); /* SGX_STEPUP_PRIVATE */
  const rootKey = (env && env[REALM_ROOT.secret]) || ''; /* SGX_ROOT_KEY */
  if (!rp) return rpConfigMissing();
  const RP_ID = rp.rpId;
  const EXPECT_ORIGIN = rp.origin;
  if (!stepupKey || !rootKey) {
    return Response.json({ ok: false, error: 'config' }, { status: 500 });
  }

  /* ============ challenge：下发 ownerkey 断言 challenge ============ */
  if (action === 'challenge') {
    if (!ownerCfg) {
      return Response.json({ ok: false, error: 'not-set' }, { status: 403 });
    }
    const keys = await getPasskeys(kv);
    const ownerKeys = keys.filter(function (k) { return (k.class || 'lock') === PK_CLASS_OWNER; });
    if (ownerKeys.length === 0) {
      return Response.json({ ok: false, error: 'not-set' }, { status: 403 });
    }
    const challenge = randB64(32);
    const cid = randB64(16);
    try {
      await kv.put(
        CHALLENGE_PREFIX + cid,
        JSON.stringify({ challenge: challenge, purpose: 'lockreset', exp: Date.now() + CHALLENGE_TTL * 1000 }),
        { expirationTtl: CHALLENGE_TTL }
      );
    } catch (e) {
      return Response.json({ ok: false, error: 'server' }, { status: 500 });
    }
    return Response.json({
      ok: true,
      cid: cid,
      challenge: challenge,
      rpId: RP_ID,
      allowCredentials: ownerKeys.map(function (k) { return { id: k.credId, type: 'public-key' }; }),
    });
  }

  /* ============ verify：根凭证优先 → 开关 → 站长凭证 ============ */
  if (action === 'verify') {
    const ip = getClientIp(request);
    /* 限流（共用）：先检查，不读开关 */
    try {
      const lim = await checkRootLimit(kv, ip);
      if (lim.limited) {
        await writeRootAudit(kv, ip, false, { path: 'lockreset' });
        return Response.json({ ok: false, error: 'locked' }, { status: 429 });
      }
    } catch (e) {
      return Response.json({ ok: false, error: 'server' }, { status: 503 });
    }

    /* fail()：记失败计数；写 KV 出错时返回 503 响应对象（调用方直接返回），
       与 root-auth 一致，不吞掉。 */
    const fail = async function () {
      try {
        await recordRootFail(kv, ip);
      } catch (e) {
        await writeRootAudit(kv, ip, false, { path: 'lockreset' });
        return Response.json({ ok: false, error: 'server' }, { status: 503 });
      }
      await writeRootAudit(kv, ip, false, { path: 'lockreset' });
      return null;
    };

    /* --- 步骤 1：根凭证与环境变量比对（不读 KV 开关） --- */
    /* 批次 A 收尾 B2：两边都去掉空白字符后再比对；去空白后为空一律拒绝 */
    const rk = (body && body.rootKey) || '';
    const rootOk = rk && normalizeRootKey(rk) && (await timingSafeEqual(normalizeRootKey(rk), normalizeRootKey(rootKey)));
    if (!rootOk) {
      const failResp = await fail();
      if (failResp) return failResp;
      return Response.json({ ok: false, error: 'auth' }, { status: 401 });
    }
    await clearRootFail(kv, ip);

    /* --- 步骤 2：根凭证正确后才读恢复开关 --- */
    const db = env && env.SGX_D1;
    const sw = await checkRecoverySwitch(kv, db);
    if (sw.valid) {
      /* 开关路径：原子标记已用（抢不到则视为已用，走站长凭证路径） */
      const claimed = await claimSwitchUsed(db, sw.hash);
      if (claimed) {
        return await issueLockreset(ip, STEPUP_BY_ROOT, { via: 'switch' });
      }
      /* 被并发抢走 → 按开关无效处理 */
    }

    /* --- 步骤 3：开关无效 → 需要站长凭证 ---
       站长凭证未配置时返回通用 401 auth（不泄露 not-set，避免暴露配置状态）。 */
    if (!ownerCfg) {
      const failResp = await fail();
      if (failResp) return failResp;
      return Response.json({ ok: false, error: 'auth' }, { status: 401 });
    }
    const proof = (body && body.ownerProof) || null;
    if (!proof) {
      /* 响应形态与开关有效时一致（都是 200 ok），由服务端决定下一步；
         前端据此展示站长凭证步骤，不提示开关存在。
         needOwner 带 passkey/password 布尔，前端按配置显示按钮，不总显示两个。 */
      let hasOwnerPw = false;
      let hasOwnerPk = false;
      try {
        const r = await kv.get(REALM_OWNER.kv.password, 'json');
        hasOwnerPw = !!(r && r.hash);
      } catch (e) {}
      try {
        const keys = await getPasskeys(kv);
        hasOwnerPk = keys.some(function (k) { return (k.class || 'lock') === PK_CLASS_OWNER; });
      } catch (e) {}
      return Response.json({ ok: true, needOwner: true, passkey: hasOwnerPk, password: hasOwnerPw });
    }
    let ownerOk = false;
    if (proof.type === 'password') {
      const pepper = getPepper(env);
      if (!pepper) {
        const failResp = await fail();
        if (failResp) return failResp;
        return Response.json({ ok: false, error: 'config' }, { status: 503 });
      }
      try {
        const vr = await verifyOwnerPassword(kv, pepper, String(proof.password || ''));
        ownerOk = vr.set && vr.ok;
      } catch (e) {
        const failResp = await fail();
        if (failResp) return failResp;
        return Response.json({ ok: false, error: 'server' }, { status: 503 });
      }
    } else if (proof.type === 'passkey') {
      ownerOk = await verifyOwnerPasskeyProof(kv, proof, RP_ID, EXPECT_ORIGIN);
    }
    if (!ownerOk) {
      const failResp = await fail();
      if (failResp) return failResp;
      return Response.json({ ok: false, error: 'auth' }, { status: 401 });
    }
    return await issueLockreset(ip, STEPUP_BY_OWNER_ROOT, null);

    /* 签发 lockreset 票（内部函数） */
    async function issueLockreset(ipAddr, by, auditExtra) {
      let epoch;
      try {
        epoch = await getSessionEpoch(kv);
      } catch (e) {
        await writeRootAudit(kv, ipAddr, false, { path: 'lockreset' });
        return Response.json({ ok: false, error: 'server' }, { status: 503 });
      }
      const headers = new Headers({ 'Content-Type': 'application/json' });
      try {
        const cv = await signStepupCookie(stepupKey, by, STEPUP_SCOPE_LOCKRESET, epoch);
        setStepupCookie(headers, cv);
      } catch (e) {
        await writeRootAudit(kv, ipAddr, false, { path: 'lockreset' });
        return Response.json({ ok: false, error: 'sign-failed' }, { status: 500 });
      }
      const auditOk = await writeRootAudit(
        kv, ipAddr, true,
        auditExtra && auditExtra.via === 'switch' ? { path: 'lockreset', via: 'switch' } : { path: 'lockreset' }
      );
      if (!auditOk) {
        return Response.json({ ok: false, error: 'server' }, { status: 503 });
      }
      return new Response(JSON.stringify({ ok: true }), { headers });
    }

    /* 验证站长 passkey 断言（内部函数） */
    async function verifyOwnerPasskeyProof(kvStore, proofObj, rpId, expectOrigin) {
      const cid = proofObj.cid || '';
      const cred = proofObj.credential || {};
      const chRec = await consumeChallenge(kvStore, CHALLENGE_PREFIX + cid);
      if (!chRec || chRec.purpose !== 'lockreset' || chRec.exp < Date.now()) return false;
      const keys = await getPasskeys(kvStore);
      const ownerKeys = keys.filter(function (k) { return (k.class || 'lock') === PK_CLASS_OWNER; });
      const stored = findStoredKey(ownerKeys, cred.rawId || '');
      if (!stored || !stored.publicKey || stored.class !== PK_CLASS_OWNER) return false;
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

  return Response.json({ ok: false, error: 'action' }, { status: 400 });
}
