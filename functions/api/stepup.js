/**
 * 二次验证（step-up authentication）。
 *
 * 高敏操作（上传、删除、替换封面）前要求 owner 再次用 Passkey 验证。
 * 安全逻辑与登录共用 ../_kernel/passkey-verify.js（只有一套）。
 *
 * POST /api/stepup
 * - { action: 'challenge' } → 必须是已登录 owner 会话（visitor 一律拒绝）。
 *   下发 purpose=stepup 的 challenge，存 KV `stepup-challenge:<cid>`（与登录的
 *   `pk-challenge:` 前缀隔离，login challenge 不能用于 stepup，反之亦然）。
 * - { action: 'verify', cid, credential } → 必须是已登录 owner 会话。
 *   只认 `stepup-challenge:` 下的 challenge（单次使用，用后删除）；
 *   断言验证强制 userVerification=required 并校验 UV 标志位。
 *   通过后签发 sgx-stepup cookie：Ed25519(SGX_STEPUP_KEY) 签名，约 10 分钟有效，
 *   含 role/epoch/签发时间；HttpOnly、Secure、SameSite=Strict。
 * - { action: 'status' } → 必须是已登录 owner 会话。返回当前 sgx-stepup 是否有效。
 *
 * 只接受 POST；校验 Origin；外层 try/catch 异常一律 { ok:false, error:'server' }。
 *
 * 环境变量：
 * - SGX_STEPUP_KEY：Ed25519 私钥（PKCS8 PEM），缺失则拒绝签发（500 no-stepup-key）
 * - SGX_STEPUP_PUBLIC：Ed25519 公钥（SPKI PEM），缺失则验签 fail closed
 * - SGX_RP_ID / SGX_ORIGIN：与 owner-passkey 一致，不回落
 */
import { verifySessionDetailed } from '../_middleware.js';
import { getSessionEpoch, ROLE_OWNER } from '../_kernel/session.js';
import { ed25519Sign, ed25519Verify, b64urlEnc } from '../_kernel/crypto.js';
import { randB64, verifyAssertion } from '../_kernel/passkey-verify.js';
import { getPasskeys } from './owner-passkey.js';

/* stepup cookie 定义（一处定义） */
export const STEPUP_COOKIE = 'sgx-stepup';
export const STEPUP_MAX_AGE = 600; /* 10 分钟 */
export const STEPUP_COOKIE_ATTRS = 'Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Strict';
/* challenge KV 前缀：与登录的 pk-challenge: 隔离 */
export const STEPUP_CHALLENGE_PREFIX = 'stepup-challenge:';
const STEPUP_CHALLENGE_TTL = 300; /* 5 分钟 */

/**
 * 签发 stepup cookie 值：owner.epoch.iat.exp.Ed25519(SGX_STEPUP_KEY, "owner.epoch.iat.exp")。
 * @param {string} privatePem Ed25519 私钥（PKCS8 PEM）
 * @param {number} epoch 当前 session epoch
 */
export async function signStepupCookie(privatePem, epoch) {
  const iat = Date.now();
  const exp = iat + STEPUP_MAX_AGE * 1000;
  const payload = 'owner.' + epoch + '.' + iat + '.' + exp;
  const sig = await ed25519Sign(privatePem, payload);
  return payload + '.' + sig;
}

/**
 * 解析 stepup cookie 值。
 * @param {string} val
 * @returns {{role:string, epoch:number, iat:number, exp:number, sig:string}|null}
 */
export function parseStepupCookie(val) {
  if (!val || typeof val !== 'string') return null;
  const parts = val.split('.');
  if (parts.length !== 5) return null;
  if (parts[0] !== ROLE_OWNER) return null;
  const epoch = parseInt(parts[1], 10);
  const iat = parseInt(parts[2], 10);
  const exp = parseInt(parts[3], 10);
  if (!Number.isFinite(epoch) || !Number.isFinite(iat) || !Number.isFinite(exp)) return null;
  return { role: parts[0], epoch, iat, exp, sig: parts[4] };
}

/** @param {any} request @param {string} name */
function getCookie(request, name) {
  const h = request.headers.get('Cookie') || '';
  for (const part of h.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

/**
 * 验证请求中的 sgx-stepup cookie（供高敏操作 API 复用）。
 * fail closed：任何异常都返回无效。
 * @param {any} request
 * @param {any} env
 * @returns {Promise<{ok:boolean, reason:string}>}
 *   reason: ok / no-cookie / bad-format / expired / not-yet / no-pubkey /
 *           bad-sig / epoch-changed / kv-error
 */
export async function verifyStepupCookie(request, env) {
  const val = getCookie(request, STEPUP_COOKIE);
  if (!val) return { ok: false, reason: 'no-cookie' };
  const p = parseStepupCookie(val);
  if (!p) return { ok: false, reason: 'bad-format' };
  const now = Date.now();
  if (p.exp <= now) return { ok: false, reason: 'expired' };
  if (p.iat > now + 60000) return { ok: false, reason: 'not-yet' }; /* 允许 60 秒时钟 skew */
  const pubKey = (env && env.SGX_STEPUP_PUBLIC) || '';
  if (!pubKey) return { ok: false, reason: 'no-pubkey' };
  /* epoch 必须等于当前 KV epoch：lock-all-devices 后旧 stepup 立即失效 */
  let curEpoch;
  try {
    curEpoch = await getSessionEpoch(env && env.OWNER_KV);
  } catch (e) {
    return { ok: false, reason: 'kv-error' };
  }
  if (p.epoch !== curEpoch) return { ok: false, reason: 'epoch-changed' };
  /* 最后验签（先做便宜检查，签名最贵放最后） */
  const payload = p.role + '.' + p.epoch + '.' + p.iat + '.' + p.exp;
  const ok = await ed25519Verify(pubKey, payload, p.sig);
  if (!ok) return { ok: false, reason: 'bad-sig' };
  return { ok: true, reason: 'ok' };
}

/** @param {Headers} headers @param {string} value */
function setStepupCookie(headers, value) {
  headers.append(
    'Set-Cookie',
    STEPUP_COOKIE + '=' + value + '; ' + STEPUP_COOKIE_ATTRS + '; Max-Age=' + STEPUP_MAX_AGE
  );
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
    return Response.json({ ok: false, error: 'method' }, { status: 405 });
  }
  try {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);
    if (origin && new URL(origin).host !== url.host) {
      return Response.json({ ok: false, error: 'origin' }, { status: 403 });
    }
  } catch (e) {}
  if (!kv) return Response.json({ ok: false, error: 'config' }, { status: 500 });

  let body;
  try { body = await request.json(); } catch (e) {
    return Response.json({ ok: false, error: 'body' }, { status: 400 });
  }
  const action = (body && body.action) || '';

  /* 所有 action 都要求已登录 owner 会话（visitor 一律拒绝）。
     L1 middleware 已按 OWNER_ONLY_APIS 拒绝 visitor（403），这里再验一次（纵深防御）。 */
  const sess = await verifySessionDetailed(request, env);
  if (!sess.ok) {
    return Response.json({ ok: false, error: 'session' }, { status: 401 });
  }
  if (sess.role !== ROLE_OWNER) {
    return Response.json({ ok: false, error: 'role' }, { status: 403 });
  }

  /* RP_ID / 期望 origin：必须设置环境变量，不回落 */
  const RP_ID = env && env.SGX_RP_ID;
  const EXPECT_ORIGIN = env && env.SGX_ORIGIN;
  if (!RP_ID || !EXPECT_ORIGIN) {
    return Response.json(
      { ok: false, error: 'config', message: 'SGX_RP_ID / SGX_ORIGIN 未配置' },
      { status: 503 }
    );
  }
  const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(RP_ID)));

  /* ============ challenge ============ */
  if (action === 'challenge') {
    const keys = await getPasskeys(kv);
    if (keys.length === 0) {
      return Response.json({ ok: false, error: 'not-set' }, { status: 403 });
    }
    const challenge = randB64(32);
    const cid = randB64(16);
    try {
      await kv.put(
        STEPUP_CHALLENGE_PREFIX + cid,
        JSON.stringify({ challenge: challenge, purpose: 'stepup', exp: Date.now() + STEPUP_CHALLENGE_TTL * 1000 }),
        { expirationTtl: STEPUP_CHALLENGE_TTL }
      );
    } catch (e) {
      return Response.json({ ok: false, error: 'server' }, { status: 500 });
    }
    return Response.json({
      ok: true,
      cid: cid,
      challenge: challenge,
      rpId: RP_ID,
      allowCredentials: keys.map(function (k) { return { id: k.credId, type: 'public-key' }; }),
    });
  }

  /* ============ verify ============ */
  if (action === 'verify') {
    const cred = (body && body.credential) || {};
    const cid = (body && body.cid) || '';
    /* 只认 stepup-challenge: 前缀 —— login 的 pk-challenge: 在这里查不到，
       用途隔离（login challenge 不能用于 stepup）。单次使用：取后即删。 */
    let chRec = null;
    try {
      chRec = await kv.get(STEPUP_CHALLENGE_PREFIX + cid, 'json');
      await kv.delete(STEPUP_CHALLENGE_PREFIX + cid);
    } catch (e) {}
    if (!chRec || chRec.purpose !== 'stepup' || chRec.exp < Date.now()) {
      return Response.json({ ok: false, error: 'challenge' }, { status: 403 });
    }
    const keys = await getPasskeys(kv);
    if (keys.length === 0) {
      return Response.json({ ok: false, error: 'not-set' }, { status: 403 });
    }
    const rawIdB64 = cred.rawId || '';
    let stored = null;
    for (let i = 0; i < keys.length; i++) {
      if (keys[i].credId === rawIdB64) { stored = keys[i]; break; }
    }
    if (!stored || !stored.publicKey) {
      return Response.json({ ok: false, error: 'unknown-key' }, { status: 403 });
    }
    try {
      /* 共享断言验证，强制 userVerification=required 并校验 UV 标志位 */
      const checked = await verifyAssertion({
        credential: cred,
        challenge: chRec.challenge,
        rpIdHash: rpIdHash,
        expectOrigin: EXPECT_ORIGIN,
        storedPublicKey: stored.publicKey,
        storedSignCount: stored.signCount,
        requireUV: true,
      });
      /* 更新 signCount（防克隆） */
      stored.signCount = checked.signCount;
      stored.lastUsedAt = Date.now();
      try {
        /* 更新 signCount（防克隆）：直接写 KV，不走 owner-passkey 的 savePasskey
          （避免循环 import；字段顺序与 owner-passkey.savePasskey 一致） */
        const keyName = 'owner-passkey:' + String(stored.credId).slice(0, 12);
        const ordered = {
          name: stored.name || '通行密钥',
          provider: stored.provider || '',
          aaguid: stored.aaguid || '',
          createdAt: stored.createdAt || Date.now(),
          lastUsedAt: stored.lastUsedAt,
          credId: stored.credId,
          publicKey: stored.publicKey,
          signCount: stored.signCount || 0,
          uv: stored.uv ? 1 : 0,
        };
        await kv.put(keyName, JSON.stringify(ordered));
      } catch (e2) {}
      /* 签发 sgx-stepup cookie：缺 SGX_STEPUP_KEY 则拒绝（fail closed） */
      const stepupKey = (env && env.SGX_STEPUP_KEY) || '';
      if (!stepupKey) {
        console.error('[stepup] SGX_STEPUP_KEY 未配置，拒绝签发');
        return Response.json({ ok: false, error: 'no-stepup-key' }, { status: 500 });
      }
      let epoch;
      try {
        epoch = await getSessionEpoch(kv);
      } catch (e) {
        return Response.json({ ok: false, error: 'server' }, { status: 503 });
      }
      const headers = new Headers({ 'Content-Type': 'application/json' });
      let cv;
      try {
        cv = await signStepupCookie(stepupKey, epoch);
      } catch (e) {
        console.error('[stepup] sign failed', e && e.message ? e.message : e);
        return Response.json({ ok: false, error: 'sign-failed' }, { status: 500 });
      }
      setStepupCookie(headers, cv);
      return new Response(JSON.stringify({ ok: true }), { headers });
    } catch (e) {
      console.error('[stepup-verify]', e && e.message ? e.message : e);
      const code = (e && e.message === 'uv-required') ? 'uv-required' : 'verify';
      return Response.json({ ok: false, error: code }, { status: 403 });
    }
  }

  /* ============ status ============ */
  if (action === 'status') {
    const r = await verifyStepupCookie(request, env);
    return Response.json({ ok: true, valid: r.ok, reason: r.ok ? undefined : r.reason });
  }

  return Response.json({ ok: false, error: 'params' }, { status: 400 });
}
