/**
 * 二次验证（step-up authentication）。
 *
 * 2.11 定稿：两扇门设计。
 * - 入口 1（root）：有效 lock 会话 + SGX_ROOT_KEY → stepup(by=root, scope=root)，
 *   只能管理站长凭证（ownerkey）
 * - 入口 2（owner）：有效 lock 会话 + 站长凭证（ownerkey）
 *   → stepup(by=owner, scope=keys)，管理 lock/APP 组；进门后增删不再二次挑战
 * - 重置锁屏：scope=lockreset（by=owner+root，或恢复开关开启时 by=root），
 *   只能增删 lock 凭证、设置锁屏密码
 * - scope 不匹配一律 403；lockkey 不再能开验证
 *
 * POST /api/stepup
 * - { action: 'challenge' } → 必须是已登录 owner 会话（visitor 一律拒绝）。
 *   下发 purpose=stepup 的 challenge，存 KV `stepup-challenge:<cid>`。
 * - { action: 'verify', cid, credential } → 必须是已登录 owner 会话。
 *   只认 owner class 通行密钥（2.11 起 lock 不再能开 stepup）。
 *   通过后签发 sgx-stepup cookie：by.scope.epoch.iat.exp.Ed25519(SGX_STEPUP_PRIVATE)，
 *   约 3 分钟有效；HttpOnly、Secure、SameSite=Strict。
 * - { action: 'verify-password', password } → 必须是已登录 owner 会话。
 *   校验 owner 密码（加 pepper），通过后签发 stepup(by=owner, scope=keys)。
 * - { action: 'takeover-keys' } → 必须是已登录 owner 会话 + 有效的
 *   stepup(by=root, scope=root)，且 owner 层未配置 → 签发 stepup(by=root, scope=keys)。
 *   owner 层已配置（含 KV 读失败按已配置）→ 403。
 * - { action: 'status' } → 必须是已登录 owner 会话。返回当前 sgx-stepup 是否有效，
 *   以及 expiresAt（绝对时间戳，供门内页倒计时用；前端不解析 HttpOnly Cookie）。
 *
 * 只接受 POST；校验 Origin；外层 try/catch 异常一律 { ok:false, error:'server' }。
 *
 * 环境变量：
 * - SGX_STEPUP_PRIVATE：Ed25519 私钥（PKCS8 PEM），缺失则拒绝签发（500 no-stepup-key）
 * - SGX_STEPUP_PUBLIC：Ed25519 公钥（SPKI PEM），缺失则验签 fail closed
 * - SGX_RP_ID / SGX_ORIGIN：与 owner-passkey 一致，不回落
 */
import { verifySessionDetailed, getCookie } from '../_middleware.js';
import { getSessionEpoch, ROLE_OWNER } from '../_kernel/session.js';
import { ed25519Sign, ed25519Verify, b64urlEnc } from '../_kernel/crypto.js';
import { randB64, verifyAssertion } from '../_kernel/passkey-verify.js';
import { getPasskeys, PK_CLASS_OWNER } from './owner-passkey.js';
import { ownerPasskeyKey } from '../_kernel/key-names.js';
import { verifyOwnerPassword, getPepper } from './owner-password.js';
import { isLayerConfigured, LAYER_OWNER } from '../_kernel/layers.js';

/* stepup cookie 定义（一处定义） */
export const STEPUP_COOKIE = 'sgx-stepup';
export const STEPUP_MAX_AGE = 180; /* 3 分钟（批次 B #11：由 600 秒缩短） */
export const STEPUP_COOKIE_ATTRS = 'Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Strict';
/* challenge KV 前缀：与登录的 pk-challenge: 隔离 */
export const STEPUP_CHALLENGE_PREFIX = 'stepup-challenge:';
const STEPUP_CHALLENGE_TTL = 300; /* 5 分钟 */
/* 2.11 定稿：stepup 票字段 by/scope */
export const STEPUP_BY_ROOT = 'root';
export const STEPUP_BY_OWNER = 'owner';
/* lockreset 双凭证通过时 by=owner+root；恢复开关单根时 by=root */
export const STEPUP_BY_OWNER_ROOT = 'owner+root';
export const STEPUP_SCOPE_ROOT = 'root';
export const STEPUP_SCOPE_KEYS = 'keys';
export const STEPUP_SCOPE_LOCKRESET = 'lockreset';

/**
 * 签发 stepup cookie 值：by.scope.epoch.iat.exp.Ed25519(SGX_STEPUP_PRIVATE, "by.scope.epoch.iat.exp")。
 * 2.11 定稿：
 * - scope=root → by 必须为 root
 * - scope=keys → by 为 owner（站长凭证）或 root（owner 未配置时代管）
 * - scope=lockreset → by 为 owner+root（双凭证）或 root（恢复开关）
 * @param {string} privatePem Ed25519 私钥（PKCS8 PEM）
 * @param {string} by 'root' | 'owner' | 'owner+root'
 * @param {string} scope 'root' | 'keys' | 'lockreset'
 * @param {number} epoch 当前 session epoch
 */
export async function signStepupCookie(privatePem, by, scope, epoch) {
  const byOk = by === STEPUP_BY_ROOT || by === STEPUP_BY_OWNER || by === STEPUP_BY_OWNER_ROOT;
  if (!byOk) {
    throw new Error('signStepupCookie: bad by ' + JSON.stringify(by));
  }
  if (scope === STEPUP_SCOPE_ROOT) {
    if (by !== STEPUP_BY_ROOT) throw new Error('signStepupCookie: scope=root requires by=root');
  } else if (scope === STEPUP_SCOPE_KEYS) {
    if (by !== STEPUP_BY_OWNER && by !== STEPUP_BY_ROOT) {
      throw new Error('signStepupCookie: scope=keys requires by=owner|root');
    }
  } else if (scope === STEPUP_SCOPE_LOCKRESET) {
    if (by !== STEPUP_BY_OWNER_ROOT && by !== STEPUP_BY_ROOT) {
      throw new Error('signStepupCookie: scope=lockreset requires by=owner+root|root');
    }
  } else {
    throw new Error('signStepupCookie: bad scope ' + JSON.stringify(scope));
  }
  const iat = Date.now();
  const exp = iat + STEPUP_MAX_AGE * 1000;
  const payload = by + '.' + scope + '.' + epoch + '.' + iat + '.' + exp;
  const sig = await ed25519Sign(privatePem, payload);
  return payload + '.' + sig;
}

/**
 * 用新 epoch 重签当前 stepup 票据（D2：epoch 推进后保持门内连续操作不中断）。
 * - sv：verifyStepupCookie 返回的 {ok, by, scope}（必须 ok）
 * - newEpoch：bump 后的新 epoch
 * - 失败时静默（调用方已返回业务成功）；lockreset 等场景 sv 不 ok 时不做任何事。
 * - 必修安全项 1：by=root, scope=keys 的票一律不重签（首次配 owner 的 bump 就是为了废止它，
 *   重签回来等于 epoch +1 白做）。此检查写在 helper 里，所有调用点都生效。
 * @param {any} env
 * @param {Headers} headers
 * @param {{ok:boolean, by:string, scope:string}|null} sv
 * @param {number} newEpoch
 */
export async function reissueStepupWithEpoch(env, headers, sv, newEpoch) {
  if (!sv || !sv.ok || !sv.by || !sv.scope) return;
  /* 必修安全项 1：by=root, scope=keys 票不重签，随 epoch 失效。 */
  if (sv.by === STEPUP_BY_ROOT && sv.scope === STEPUP_SCOPE_KEYS) return;
  const stepupKey = env && env.SGX_STEPUP_PRIVATE;
  if (!stepupKey) return;
  try {
    const cv = await signStepupCookie(stepupKey, sv.by, sv.scope, newEpoch);
    headers.append(
      'Set-Cookie',
      STEPUP_COOKIE + '=' + cv + '; ' + STEPUP_COOKIE_ATTRS + '; Max-Age=' + STEPUP_MAX_AGE
    );
  } catch (e) {}
}

/**
 * 解析 stepup cookie 值。
 * 2.11 定稿：六段式 by.scope.epoch.iat.exp.sig；
 * by=root|owner|owner+root，scope=root|keys|lockreset。
 * @param {string} val
 * @returns {{by:string, scope:string, epoch:number, iat:number, exp:number, sig:string}|null}
 */
export function parseStepupCookie(val) {
  if (!val || typeof val !== 'string') return null;
  const parts = val.split('.');
  if (parts.length !== 6) return null;
  const by = parts[0];
  const scope = parts[1];
  if (by !== STEPUP_BY_ROOT && by !== STEPUP_BY_OWNER && by !== STEPUP_BY_OWNER_ROOT) return null;
  if (scope !== STEPUP_SCOPE_ROOT && scope !== STEPUP_SCOPE_KEYS && scope !== STEPUP_SCOPE_LOCKRESET) return null;
  const epoch = parseInt(parts[2], 10);
  const iat = parseInt(parts[3], 10);
  const exp = parseInt(parts[4], 10);
  if (!Number.isFinite(epoch) || !Number.isFinite(iat) || !Number.isFinite(exp)) return null;
  return { by, scope, epoch, iat, exp, sig: parts[5] };
}

/**
 * stepup scope 门禁（供管理 API 复用）。
 * @param {{ok:boolean, by:string|null, scope:string|null, reason:string}} st verifyStepupCookie 的结果
 * @param {string[]} allowedScopes 允许的 scope 列表
 * @returns {{status:number, body:object}|null} 通过返回 null，否则返回待发送的错误响应描述
 */
export function stepupScopeError(st, allowedScopes) {
  if (!st.ok) {
    return { status: 403, body: { ok: false, error: 'stepup-required', reason: st.reason } };
  }
  if (!allowedScopes.includes(st.scope)) {
    return { status: 403, body: { ok: false, error: 'scope' } };
  }
  return null;
}

/**
 * 验证请求中的 sgx-stepup cookie（供高敏操作 API 复用）。
 * fail closed：任何异常都返回无效。
 * 2.11：返回 by 和 scope，调用方做 scope 检查。
 * @param {any} request
 * @param {any} env
 * @returns {Promise<{ok:boolean, by:string|null, scope:string|null, reason:string, exp:number|null}>}
 *   reason: ok / no-cookie / bad-format / expired / not-yet / no-pubkey /
 *           bad-sig / epoch-changed / kv-error；
 *   exp：票据到期绝对时间戳（毫秒；无效时为 null，供 status 回 expiresAt 用）
 */
export async function verifyStepupCookie(request, env) {
  const val = getCookie(request, STEPUP_COOKIE);
  if (!val) return { ok: false, by: null, scope: null, reason: 'no-cookie', exp: null };
  const p = parseStepupCookie(val);
  if (!p) return { ok: false, by: null, scope: null, reason: 'bad-format', exp: null };
  const now = Date.now();
  if (p.exp <= now) return { ok: false, by: null, scope: null, reason: 'expired', exp: p.exp };
  if (p.iat > now + 60000) return { ok: false, by: null, scope: null, reason: 'not-yet', exp: p.exp }; /* 允许 60 秒时钟 skew */
  const pubKey = (env && env.SGX_STEPUP_PUBLIC) || '';
  if (!pubKey) return { ok: false, by: null, scope: null, reason: 'no-pubkey', exp: p.exp };
  /* epoch 必须等于当前 KV epoch：lock-all-devices 后旧 stepup 立即失效 */
  let curEpoch;
  try {
    curEpoch = await getSessionEpoch(env && env.OWNER_KV);
  } catch (e) {
    return { ok: false, by: null, scope: null, reason: 'kv-error', exp: p.exp };
  }
  if (p.epoch !== curEpoch) return { ok: false, by: null, scope: null, reason: 'epoch-changed', exp: p.exp };
  /* 最后验签（先做便宜检查，签名最贵放最后） */
  const payload = p.by + '.' + p.scope + '.' + p.epoch + '.' + p.iat + '.' + p.exp;
  const ok = await ed25519Verify(pubKey, payload, p.sig);
  if (!ok) return { ok: false, by: null, scope: null, reason: 'bad-sig', exp: p.exp };
  return { ok: true, by: p.by, scope: p.scope, reason: 'ok', exp: p.exp };
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
  /* 2.10.2：Origin 必须存在、可解析且 host 一致（CSRF 防护）；
     缺失或解析失败一律 403，不再放行。 */
  {
    const origin = request.headers.get('Origin') || '';
    let originOk = false;
    try {
      const url = new URL(request.url);
      originOk = !!origin && new URL(origin).host === url.host;
    } catch (e) {
      originOk = false;
    }
    if (!originOk) {
      return Response.json({ ok: false, error: 'origin' }, { status: 403 });
    }
  }
  if (!kv) return Response.json({ ok: false, error: 'config' }, { status: 500 });

  let body;
  try { body = await request.json(); } catch (e) {
    return Response.json({ ok: false, error: 'body' }, { status: 400 });
  }
  const action = (body && body.action) || '';

  /* ============ clear（前置：lockreset 无会话也能调） ============
     离开门入口页/完成重置时清票据。owner 会话或 lockreset 票据任一有效即可，
     幂等清除。只清 stepup，不动 sgx-verified。 */
  if (action === 'clear') {
    let allowed = false;
    try {
      const sess = await verifySessionDetailed(request, env);
      if (sess.ok && sess.role === ROLE_OWNER) allowed = true;
    } catch (e) {}
    if (!allowed) {
      try {
        const st = await verifyStepupCookie(request, env);
        if (st.ok) allowed = true; /* 任何有效票据（含 lockreset）都可清 */
      } catch (e) {}
    }
    if (!allowed) {
      return Response.json({ ok: false, error: 'session' }, { status: 401 });
    }
    const headers = new Headers({ 'Content-Type': 'application/json' });
    headers.append(
      'Set-Cookie',
      STEPUP_COOKIE + '=; ' + STEPUP_COOKIE_ATTRS + '; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
    );
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

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

  /* ============ challenge ============
     2.11：只接受 owner 类通行密钥（challenge 只列 owner 凭据；lock 不再能开 stepup）。 */
  if (action === 'challenge') {
    const keys = await getPasskeys(kv);
    const ownerKeys = keys.filter(function (k) { return k.class === PK_CLASS_OWNER; });
    if (ownerKeys.length === 0) {
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
      allowCredentials: ownerKeys.map(function (k) { return { id: k.credId, type: 'public-key' }; }),
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
    const ownerKeys = keys.filter(function (k) { return k.class === PK_CLASS_OWNER; });
    if (ownerKeys.length === 0) {
      return Response.json({ ok: false, error: 'not-set' }, { status: 403 });
    }
    const rawIdB64 = cred.rawId || '';
    let stored = null;
    for (let i = 0; i < ownerKeys.length; i++) {
      if (ownerKeys[i].credId === rawIdB64) { stored = ownerKeys[i]; break; }
    }
    if (!stored || !stored.publicKey) {
      return Response.json({ ok: false, error: 'unknown-key' }, { status: 403 });
    }
    /* 2.11：服务端再次校验分类（只有 owner 类能开 stepup；lock/app 一律拒绝） */
    if (stored.class !== PK_CLASS_OWNER) {
      return Response.json({ ok: false, error: 'class-mismatch' }, { status: 403 });
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
        const keyName = ownerPasskeyKey(stored.credId);
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
          class: stored.class || PK_CLASS_OWNER,
        };
        if (ordered.class === 'app' && stored.aud) ordered.aud = stored.aud;
        await kv.put(keyName, JSON.stringify(ordered));
      } catch (e2) {}
      /* 签发 sgx-stepup cookie：缺 SGX_STEPUP_PRIVATE 则拒绝（fail closed） */
      const stepupKey = (env && env.SGX_STEPUP_PRIVATE) || '';
      if (!stepupKey) {
        console.error('[stepup] SGX_STEPUP_PRIVATE 未配置，拒绝签发');
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
        /* 2.11：ownerkey 通行密钥 → stepup(by=owner, scope=keys) */
        cv = await signStepupCookie(stepupKey, STEPUP_BY_OWNER, STEPUP_SCOPE_KEYS, epoch);
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

  /* ============ verify-password ============
     2.11 定稿：入口 2 的密码路径。有效 lock 会话 + owner 密码
     → stepup(by=owner, scope=keys)。缺 pepper 时 fail closed。 */
  if (action === 'verify-password') {
    const password = (body && body.password) || '';
    if (!password || typeof password !== 'string') {
      return Response.json({ ok: false, error: 'params' }, { status: 400 });
    }
    const pepper = getPepper(env);
    if (!pepper) {
      return Response.json({ ok: false, error: 'config' }, { status: 503 });
    }
    let vr;
    try {
      vr = await verifyOwnerPassword(kv, pepper, password);
    } catch (e) {
      return Response.json({ ok: false, error: 'server' }, { status: 503 });
    }
    if (!vr.set) {
      return Response.json({ ok: false, error: 'not-set' }, { status: 403 });
    }
    if (!vr.ok) {
      return Response.json({ ok: false, error: 'wrong' }, { status: 403 });
    }
    const stepupKey = (env && env.SGX_STEPUP_PRIVATE) || '';
    if (!stepupKey) {
      console.error('[stepup] SGX_STEPUP_PRIVATE 未配置，拒绝签发');
      return Response.json({ ok: false, error: 'no-stepup-key' }, { status: 500 });
    }
    let epoch;
    try {
      epoch = await getSessionEpoch(kv);
    } catch (e) {
      return Response.json({ ok: false, error: 'server' }, { status: 503 });
    }
    const headers = new Headers({ 'Content-Type': 'application/json' });
    try {
      const cv = await signStepupCookie(stepupKey, STEPUP_BY_OWNER, STEPUP_SCOPE_KEYS, epoch);
      setStepupCookie(headers, cv);
    } catch (e) {
      console.error('[stepup] sign failed', e && e.message ? e.message : e);
      return Response.json({ ok: false, error: 'sign-failed' }, { status: 500 });
    }
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  /* ============ takeover-keys ============
     2.11 定稿：owner 层未配置时，root 代管入口 2。
     需要有效 lock 会话 + 有效的 stepup(by=root, scope=root)，
     且 owner 层未配置（KV 读失败按已配置处理 → 403）。
     签发 stepup(by=root, scope=keys)；owner 配置后 epoch 推进使其失效。 */
  if (action === 'takeover-keys') {
    const st = await verifyStepupCookie(request, env);
    if (!st.ok || st.by !== STEPUP_BY_ROOT || st.scope !== STEPUP_SCOPE_ROOT) {
      return Response.json({ ok: false, error: 'stepup-required' }, { status: 403 });
    }
    let ownerCfg = true;
    try {
      ownerCfg = await isLayerConfigured(kv, LAYER_OWNER);
    } catch (e) {
      ownerCfg = true;
    }
    if (ownerCfg) {
      return Response.json({ ok: false, error: 'scope' }, { status: 403 });
    }
    const stepupKey = (env && env.SGX_STEPUP_PRIVATE) || '';
    if (!stepupKey) {
      return Response.json({ ok: false, error: 'no-stepup-key' }, { status: 500 });
    }
    let epoch;
    try {
      epoch = await getSessionEpoch(kv);
    } catch (e) {
      return Response.json({ ok: false, error: 'server' }, { status: 503 });
    }
    const headers = new Headers({ 'Content-Type': 'application/json' });
    try {
      const cv = await signStepupCookie(stepupKey, STEPUP_BY_ROOT, STEPUP_SCOPE_KEYS, epoch);
      setStepupCookie(headers, cv);
    } catch (e) {
      return Response.json({ ok: false, error: 'sign-failed' }, { status: 500 });
    }
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  /* ============ status ============ */
  if (action === 'status') {
    const r = await verifyStepupCookie(request, env);
    /* 批次 B #12：有效时回 expiresAt（绝对时间戳），门内页据此渲染剩余时间倒计时 */
    return Response.json({ ok: true, valid: r.ok, reason: r.ok ? undefined : r.reason,
      expiresAt: r.ok ? r.exp : undefined });
  }

  return Response.json({ ok: false, error: 'params' }, { status: 400 });
}
