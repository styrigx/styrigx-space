/**
 * 2.11 定稿 + 补充：重置锁屏（丢了 lock 凭证时）。
 *
 * 前端「重置登录」（lib/reset-flow.js，锁屏弹层里的「无法登录？」）先交根凭证，服务端决定下一步。
 *
 * 流程（根凭证优先）：
 * 1. 先输入根凭证，与环境变量比对（不读 KV）。错误按现有认证失败处理。
 * 2. 根凭证正确后才读恢复开关（KV `recovery-switch` + D1 计时/单次）。
 *    开关有效 → 签发重置锁屏门票 by=root（审计 via=switch），并原子标记已用。
 * 3. 开关无效 → 继续要求账号凭证（原账号凭证），通过后签发重置锁屏门票（by=account+root）。
 *
 * 前端不提示开关存在；两种情况响应形态一致，由服务端决定下一步。
 * 只在重置锁屏路径、且根凭证正确后读开关，其他请求一律不读。
 *
 * 重置锁屏门票（sgx-door，door=lockreset，SGX_LOCK_* 签，3 分钟）只能增删 lock 凭证、设置锁屏密码；
 * 不签 sgx-verified、不进主页面、不管会话。完成后推进 session-epoch，用新 lock 正常解锁。
 *
 * owner 未配置时锁屏重置不可用（恢复开关除外）。
 *
 * POST /api/lockreset
 * - { action: 'status' } → { ok:true, available }（无需会话；不读开关）
 * - { action: 'challenge' } → 下发 AccountKey 断言 challenge（purpose=lockreset）
 * - { action: 'verify', rootKey, ownerProof? } →
 *     根凭证错 → 401 auth；
 *     根凭证对 + 开关有效 → lockreset（by=root, via=switch）；
 *     根凭证对 + 开关无效 + 无 ownerProof → { ok:true, needOwner:true }；
 *     根凭证对 + 开关无效 + ownerProof 有效 → lockreset（by=account+root）
 *
 * 根凭证失败计入共用限速；审计标记 via=switch（不对前端暴露）。
 * 只接受 POST；校验 Origin。
 */
import { checkRootCredential } from '../_kernel/root-check.js';
import { issueDoorCookie, DOOR_LOCKRESET, DOOR_BY_ACCOUNT_ROOT } from '../_kernel/door.js';
import { randB64, verifyAssertion, rpIdHashOf, consumeChallenge, findStoredKey } from '../_kernel/passkey-verify.js';
import { getPasskeys, PK_CLASS_ACCOUNT } from './owner-passkey.js';
import { verifyAccountPassword, getPepper } from './owner-password.js';
import { recordRootFail, getClientIp } from '../_kernel/rootlimit.js';
import { writeRootAudit } from '../_kernel/rootlog.js';
import { isLayerConfigured, LAYER_OWNER } from '../_kernel/layers.js';
import { checkRecoverySwitch, claimSwitchUsed } from '../_kernel/recswitch.js';
import { isSameOrigin } from '../_kernel/http.js';
import { REALM_LOCK, REALM_ACCOUNT, REALM_ROOT, realmPrivateKey, realmPublicKey, rpConfig, rpConfigMissing } from '../_kernel/realms.js';

/* 重置锁屏（本接口）的账号通行密钥 challenge（与 pk-challenge:、account-challenge: 隔离） */
const CHALLENGE_PREFIX = 'lockreset-challenge:';
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
  let accountCfg = true;
  try { accountCfg = await isLayerConfigured(kv, LAYER_OWNER); } catch (e) { accountCfg = true; }

  /* ============ status：始终允许进入第一步（不暴露账号凭证是否配置；
     不读开关；开关只在 verify 根凭证正确后读） ============ */
  if (action === 'status') {
    return Response.json({
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
    return Response.json({ ok: false, error: 'config' }, { status: 500 });
  }

  /* ============ challenge：下发 AccountKey 断言 challenge ============ */
  if (action === 'challenge') {
    if (!accountCfg) {
      return Response.json({ ok: false, error: 'not-set' }, { status: 403 });
    }
    const keys = await getPasskeys(kv);
    const accountPks = keys.filter(function (k) { return (k.class || 'lock') === PK_CLASS_ACCOUNT; });
    if (accountPks.length === 0) {
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
      allowCredentials: accountPks.map(function (k) { return { id: k.credId, type: 'public-key' }; }),
    });
  }

  /* ============ verify：根凭证优先 → 开关 → 账号凭证 ============ */
  if (action === 'verify') {
    const ip = getClientIp(request);

    /* fail()：账号凭证错误时记失败计数（与根凭证共用一套限速）；写 KV 出错时返回 503 响应对象 */
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

    /* --- 步骤 1：根凭证（共用实现 _kernel/root-check.js：限速 → 比对 → 计数 / 审计；不读 KV 开关） --- */
    const rc = await checkRootCredential({
      env: env,
      kv: kv,
      ip: ip,
      key: (body && typeof body.rootKey === 'string' && body.rootKey) || '',
      auditPath: 'lockreset',
    });
    if (!rc.ok) return rc.response;

    /* --- 步骤 2：根凭证正确后才读恢复开关 --- */
    const db = env && env.SGX_D1;
    const sw = await checkRecoverySwitch(kv, db);
    if (sw.valid) {
      /* 开关路径：原子标记已用（抢不到则视为已用，走账号凭证路径） */
      const claimed = await claimSwitchUsed(db, sw.hash);
      if (claimed) {
        return await issueLockreset(ip, 'root', { via: 'switch' });
      }
      /* 被并发抢走 → 按开关无效处理 */
    }

    /* --- 步骤 3：开关无效 → 需要账号凭证 ---
       账号凭证未配置时返回通用 401 auth（不泄露 not-set，避免暴露配置状态）。 */
    if (!accountCfg) {
      const failResp = await fail();
      if (failResp) return failResp;
      return Response.json({ ok: false, error: 'auth' }, { status: 401 });
    }
    const proof = (body && body.ownerProof) || null;
    if (!proof) {
      /* 响应形态与开关有效时一致（都是 200 ok），由服务端决定下一步；
         前端据此展示账号凭证步骤，不提示开关存在。
         needOwner 带 passkey/password 布尔，前端按配置显示按钮，不总显示两个。 */
      let hasAccountPw = false;
      let hasAccountPk = false;
      try {
        const r = await kv.get(REALM_ACCOUNT.kv.password, 'json');
        hasAccountPw = !!(r && r.hash);
      } catch (e) {}
      try {
        const keys = await getPasskeys(kv);
        hasAccountPk = keys.some(function (k) { return (k.class || 'lock') === PK_CLASS_ACCOUNT; });
      } catch (e) {}
      return Response.json({ ok: true, needOwner: true, passkey: hasAccountPk, password: hasAccountPw });
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
        const vr = await verifyAccountPassword(kv, pepper, String(proof.password || ''));
        ownerOk = vr.set && vr.ok;
      } catch (e) {
        const failResp = await fail();
        if (failResp) return failResp;
        return Response.json({ ok: false, error: 'server' }, { status: 503 });
      }
    } else if (proof.type === 'passkey') {
      ownerOk = await verifyAccountPasskeyProof(kv, proof, RP_ID, EXPECT_ORIGIN);
    }
    if (!ownerOk) {
      const failResp = await fail();
      if (failResp) return failResp;
      return Response.json({ ok: false, error: 'auth' }, { status: 401 });
    }
    return await issueLockreset(ip, DOOR_BY_ACCOUNT_ROOT, null);

    /* 签发重置锁屏门票（sgx-door，door=lockreset，SGX_LOCK_* 签，3 分钟；内部函数） */
    async function issueLockreset(ipAddr, by, auditExtra) {
      const headers = new Headers({ 'Content-Type': 'application/json' });
      const dErr = await issueDoorCookie(env, headers, DOOR_LOCKRESET, by);
      if (dErr) {
        await writeRootAudit(kv, ipAddr, false, { path: 'lockreset' });
        return Response.json(dErr.body, { status: dErr.status });
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

    /* 验证账号通行密钥 断言（内部函数） */
    async function verifyAccountPasskeyProof(kvStore, proofObj, rpId, expectOrigin) {
      const cid = proofObj.cid || '';
      const cred = proofObj.credential || {};
      const chRec = await consumeChallenge(kvStore, CHALLENGE_PREFIX + cid);
      if (!chRec || chRec.purpose !== 'lockreset' || chRec.exp < Date.now()) return false;
      const keys = await getPasskeys(kvStore);
      const accountPks = keys.filter(function (k) { return (k.class || 'lock') === PK_CLASS_ACCOUNT; });
      const stored = findStoredKey(accountPks, cred.rawId || '');
      if (!stored || !stored.publicKey || stored.class !== PK_CLASS_ACCOUNT) return false;
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
