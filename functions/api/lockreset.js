/**
 * 2.11 定稿：重置锁屏（丢了 lock 凭证时）。
 *
 * 锁屏上「重置锁屏」入口：依次验证「站长凭证」再验证「根凭证」，两步都过
 * → stepup(by=owner+root, scope=lockreset)。
 * 恢复开关开启时可只用根凭证（by=root, via=switch），权限完全相同；
 * 开启时单用站长凭证仍不能重置。
 *
 * lockreset 票只能增删 lock 凭证、设置锁屏密码；不签 sgx-verified、不进主页面、
 * 不管 APP/会话/入口 1/入口 2。完成后推进 session-epoch，用新 lock 正常解锁。
 *
 * owner 未配置时锁屏重置不可用（恢复开关除外）。
 *
 * POST /api/lockreset
 * - { action: 'status' } → { ok:true, available, skippable }（无需会话）
 * - { action: 'challenge' } → 下发 owner passkey 断言 challenge（purpose=lockreset）
 * - { action: 'verify', ownerProof, rootKey } →
 *     ownerProof: { type:'passkey', cid, credential } | { type:'password', password }
 *     成功 → stepup(scope=lockreset) cookie
 *
 * 根凭证失败计入共用限速；审计标记 via=switch（不对前端暴露）。
 * 只接受 POST；校验 Origin。
 */
import { timingSafeEqual } from '../_kernel/crypto.js';
import { getSessionEpoch } from '../_kernel/session.js';
import {
  signStepupCookie,
  STEPUP_COOKIE,
  STEPUP_COOKIE_ATTRS,
  STEPUP_MAX_AGE,
  STEPUP_BY_ROOT,
  STEPUP_BY_OWNER_ROOT,
  STEPUP_SCOPE_LOCKRESET,
} from './stepup.js';
import { randB64, verifyAssertion } from '../_kernel/passkey-verify.js';
import { getPasskeys, PK_CLASS_OWNER } from './owner-passkey.js';
import { verifyOwnerPassword, getPepper } from './owner-password.js';
import { checkRootLimit, recordRootFail, clearRootFail, getClientIp } from '../_kernel/rootlimit.js';
import { writeRootAudit } from '../_kernel/rootlog.js';
import { isLayerConfigured, LAYER_OWNER } from '../_kernel/layers.js';
import { isRecoveryEnabled } from '../_kernel/recovery.js';

const CHALLENGE_PREFIX = 'lockreset-challenge:';
const CHALLENGE_TTL = 300; /* 5 分钟 */

function checkOrigin(request) {
  const origin = request.headers.get('Origin') || '';
  try {
    const url = new URL(request.url);
    return !!origin && new URL(origin).host === url.host;
  } catch (e) {
    return false;
  }
}

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
  const kv = env && env.OWNER_KV;
  if (request.method !== 'POST') {
    return Response.json({ ok: false }, { status: 405 });
  }
  if (!checkOrigin(request)) {
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
  const recovery = isRecoveryEnabled(env);
  let ownerCfg = true;
  try { ownerCfg = await isLayerConfigured(kv, LAYER_OWNER); } catch (e) { ownerCfg = true; }

  /* ============ status：重置是否可用、站长凭证步骤可否跳过 ============ */
  if (action === 'status') {
    return Response.json({
      ok: true,
      available: ownerCfg || recovery,
      skippable: recovery,
    });
  }

  const RP_ID = env && env.SGX_RP_ID;
  const EXPECT_ORIGIN = env && env.SGX_ORIGIN;
  const stepupKey = (env && env.SGX_STEPUP_PRIVATE) || '';
  const rootKey = (env && env.SGX_ROOT_KEY) || '';
  if (!RP_ID || !EXPECT_ORIGIN) {
    return Response.json({ ok: false, error: 'config', message: 'SGX_RP_ID / SGX_ORIGIN 未配置' }, { status: 503 });
  }
  if (!stepupKey || !rootKey) {
    return Response.json({ ok: false, error: 'config' }, { status: 500 });
  }

  /* ============ challenge：下发 owner passkey 断言 challenge ============ */
  if (action === 'challenge') {
    if (!ownerCfg && !recovery) {
      return Response.json({ ok: false, error: 'not-set' }, { status: 403 });
    }
    const keys = await getPasskeys(kv);
    const ownerKeys = keys.filter(function (k) { return (k.class || 'lock') === PK_CLASS_OWNER; });
    if (ownerKeys.length === 0 && !recovery) {
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

  /* ============ verify：双凭证验证 → lockreset 票 ============ */
  if (action === 'verify') {
    const ip = getClientIp(request);
    if (!ownerCfg && !recovery) {
      return Response.json({ ok: false, error: 'not-set' }, { status: 403 });
    }
    /* 限流（共用） */
    try {
      const lim = await checkRootLimit(kv, ip);
      if (lim.limited) {
        await writeRootAudit(kv, ip, false, { path: 'lockreset' });
        return Response.json({ ok: false, error: 'locked' }, { status: 429 });
      }
    } catch (e) {
      return Response.json({ ok: false, error: 'server' }, { status: 503 });
    }

    const fail = async function () {
      try { await recordRootFail(kv, ip); } catch (e) {}
      await writeRootAudit(kv, ip, false, { path: 'lockreset' });
    };

    /* --- 验证根凭证 --- */
    const rk = (body && body.rootKey) || '';
    const rootOk = rk && (await timingSafeEqual(String(rk), String(rootKey)));

    /* --- 验证站长凭证（恢复开关开启时可跳过） --- */
    let ownerOk = false;
    let viaSwitch = false;
    if (recovery && rootOk && !body.ownerProof) {
      /* 开关路径：只用根凭证 */
      ownerOk = true;
      viaSwitch = true;
    } else {
      const proof = (body && body.ownerProof) || {};
      if (proof.type === 'password') {
        const pepper = getPepper(env);
        if (!pepper) {
          await fail();
          return Response.json({ ok: false, error: 'config' }, { status: 503 });
        }
        try {
          const vr = await verifyOwnerPassword(kv, pepper, String(proof.password || ''));
          ownerOk = vr.set && vr.ok;
        } catch (e) {
          await fail();
          return Response.json({ ok: false, error: 'server' }, { status: 503 });
        }
      } else if (proof.type === 'passkey') {
        const cid = proof.cid || '';
        const cred = proof.credential || {};
        let chRec = null;
        try {
          chRec = await kv.get(CHALLENGE_PREFIX + cid, 'json');
          await kv.delete(CHALLENGE_PREFIX + cid);
        } catch (e) {}
        if (chRec && chRec.purpose === 'lockreset' && chRec.exp >= Date.now()) {
          const keys = await getPasskeys(kv);
          const ownerKeys = keys.filter(function (k) { return (k.class || 'lock') === PK_CLASS_OWNER; });
          const rawIdB64 = cred.rawId || '';
          let stored = null;
          for (let i = 0; i < ownerKeys.length; i++) {
            if (ownerKeys[i].credId === rawIdB64) { stored = ownerKeys[i]; break; }
          }
          if (stored && stored.publicKey && stored.class === PK_CLASS_OWNER) {
            try {
              const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(RP_ID)));
              const checked = await verifyAssertion({
                credential: cred,
                challenge: chRec.challenge,
                rpIdHash: rpIdHash,
                expectOrigin: EXPECT_ORIGIN,
                storedPublicKey: stored.publicKey,
                storedSignCount: stored.signCount,
                requireUV: true,
              });
              stored.signCount = checked.signCount;
              stored.lastUsedAt = Date.now();
              ownerOk = true;
            } catch (e) {}
          }
        }
      }
    }

    if (!rootOk || !ownerOk) {
      await fail();
      /* 根凭证错误与站长凭证错误统一返回 401 auth，不区分 */
      return Response.json({ ok: false, error: 'auth' }, { status: 401 });
    }

    await clearRootFail(kv, ip);
    let epoch;
    try {
      epoch = await getSessionEpoch(kv);
    } catch (e) {
      await writeRootAudit(kv, ip, false, { path: 'lockreset' });
      return Response.json({ ok: false, error: 'server' }, { status: 503 });
    }
    const headers = new Headers({ 'Content-Type': 'application/json' });
    try {
      const cv = await signStepupCookie(
        stepupKey,
        viaSwitch ? STEPUP_BY_ROOT : STEPUP_BY_OWNER_ROOT,
        STEPUP_SCOPE_LOCKRESET,
        epoch
      );
      headers.append(
        'Set-Cookie',
        STEPUP_COOKIE + '=' + cv + '; ' + STEPUP_COOKIE_ATTRS + '; Max-Age=' + STEPUP_MAX_AGE
      );
    } catch (e) {
      await writeRootAudit(kv, ip, false, { path: 'lockreset' });
      return Response.json({ ok: false, error: 'sign-failed' }, { status: 500 });
    }
    if (!(await writeRootAudit(kv, ip, true, viaSwitch ? { path: 'lockreset', via: 'switch' } : { path: 'lockreset' }))) {
      return Response.json({ ok: false, error: 'server' }, { status: 503 });
    }
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  return Response.json({ ok: false, error: 'action' }, { status: 400 });
}
