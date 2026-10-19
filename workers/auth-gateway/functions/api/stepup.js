/**
 * 二次验证（step-up authentication）。
 *
 * 2.11 定稿：两扇门设计；账号体系（站长凭证升级为账号）后：
 * - 入口 1（root）：有效 lock 会话 + SGX_ROOT_KEY → stepup(by=root, scope=root)（/api/root-auth，不变）
 * - 入口 2（账号）：有效 lock 会话 + 近期（≤10 分钟）账号登录（sgx-account，独立验证，
 *   绝不拿 lock 会话当账号认证）→ stepup(by=account, scope=keys)，管理 lock/APP 组；
 *   进门后增删不再二次挑战。账号凭证本身（账号密码/通行密钥）只在账号页管理（/api/account）。
 * - 重置锁屏：scope=lockreset（by=owner+root，或恢复开关开启时 by=root），
 *   只能增删 lock 凭证、设置锁屏密码
 * - scope 不匹配一律 403；lockkey 不再能开验证
 *
 * POST /api/stepup
 * - { action: 'enter' } → 必须是已登录 owner 会话 + 有效 sgx-account 且 authAt 在 10 分钟内。
 *   无账号会话 → 401 account；账号登录超过 10 分钟 → 403 account-stale（前端跳账号登录重新验证）。
 *   通过后签发 sgx-stepup cookie：by.scope.epoch.iat.exp.Ed25519(SGX_STEPUP_PRIVATE)，
 *   by=account, scope=keys，约 3 分钟有效；HttpOnly、Secure、SameSite=Strict。
 *   （原 challenge / verify / verify-password 用站长凭证直接开门，已由账号登录取代。）
 * - { action: 'takeover-keys' } → 必须是已登录 owner 会话 + 有效的
 *   stepup(by=root, scope=root)，且 owner 层未配置 → 签发 stepup(by=root, scope=keys)。
 *   owner 层已配置（含 KV 读失败按已配置）→ 403。
 * - { action: 'status' } → 必须是已登录 owner 会话。返回当前 sgx-stepup 是否有效，
 *   有效时带 expiresAt（服务端签发的绝对过期时刻，毫秒；前端倒计时以它为准，不解析 Cookie）。
 *
 * 只接受 POST；校验 Origin；外层 try/catch 异常一律 { ok:false, error:'server' }。
 *
 * 环境变量：
 * - SGX_STEPUP_PRIVATE：Ed25519 私钥（PKCS8 PEM），缺失则拒绝签发（500 no-stepup-key）
 * - SGX_STEPUP_PUBLIC：Ed25519 公钥（SPKI PEM），缺失则验签 fail closed
 * - SGX_ACCOUNT_PUBLIC：验账号会话（缺失 → enter 返回 401 account，其余 action 不受影响）
 */
import { verifySessionDetailed, getCookie } from '../_middleware.js';
import { getSessionEpoch, ROLE_OWNER } from '../_kernel/session.js';
import { ed25519Sign, ed25519Verify } from '../_kernel/crypto.js';
import { verifyAccountCookie } from '../_kernel/account-session.js';
import { isLayerConfigured, LAYER_OWNER } from '../_kernel/layers.js';
import { isSameOrigin, originDenied } from '../_kernel/http.js';
import { REALM_STEPUP, realmPrivateKey, realmPublicKey, realmCookie, realmClearCookie } from '../_kernel/realms.js';

/* stepup cookie 定义（一处定义：_kernel/realms.js 的 REALM_STEPUP；这里保留原导出名） */
export const STEPUP_COOKIE = REALM_STEPUP.cookie; /* 'sgx-stepup' */
export const STEPUP_MAX_AGE = REALM_STEPUP.maxAge; /* A-1：3 分钟（v1.5 #11） */
export const STEPUP_COOKIE_ATTRS = REALM_STEPUP.cookieAttrs; /* 'Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Strict' */
/* 2.11 定稿：stepup 票字段 by/scope */
export const STEPUP_BY_ROOT = 'root';
/* 账号体系：入口 2 由近期账号登录签发（取代原 by=owner 的站长凭证直开） */
export const STEPUP_BY_ACCOUNT = 'account';
/* lockreset 双凭证通过时 by=owner+root；恢复开关单根时 by=root */
export const STEPUP_BY_OWNER_ROOT = 'owner+root';
export const STEPUP_SCOPE_ROOT = 'root';
export const STEPUP_SCOPE_KEYS = 'keys';
export const STEPUP_SCOPE_LOCKRESET = 'lockreset';

/**
 * 签发 stepup cookie 值：by.scope.epoch.iat.exp.Ed25519(SGX_STEPUP_PRIVATE, "by.scope.epoch.iat.exp")。
 * 2.11 定稿：
 * - scope=root → by 必须为 root
 * - scope=keys → by 为 account（近期账号登录）或 root（账号未配置时代管）
 * - scope=lockreset → by 为 owner+root（双凭证）或 root（恢复开关）
 * @param {string} privatePem Ed25519 私钥（PKCS8 PEM）
 * @param {string} by 'root' | 'account' | 'owner+root'
 * @param {string} scope 'root' | 'keys' | 'lockreset'
 * @param {number} epoch 当前 session epoch
 */
export async function signStepupCookie(privatePem, by, scope, epoch) {
  const byOk = by === STEPUP_BY_ROOT || by === STEPUP_BY_ACCOUNT || by === STEPUP_BY_OWNER_ROOT;
  if (!byOk) {
    throw new Error('signStepupCookie: bad by ' + JSON.stringify(by));
  }
  if (scope === STEPUP_SCOPE_ROOT) {
    if (by !== STEPUP_BY_ROOT) throw new Error('signStepupCookie: scope=root requires by=root');
  } else if (scope === STEPUP_SCOPE_KEYS) {
    if (by !== STEPUP_BY_ACCOUNT && by !== STEPUP_BY_ROOT) {
      throw new Error('signStepupCookie: scope=keys requires by=account|root');
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
  const stepupKey = realmPrivateKey(env, REALM_STEPUP); /* SGX_STEPUP_PRIVATE */
  if (!stepupKey) return;
  try {
    const cv = await signStepupCookie(stepupKey, sv.by, sv.scope, newEpoch);
    setStepupCookie(headers, cv);
  } catch (e) {}
}

/**
 * 解析 stepup cookie 值。
 * 2.11 定稿：六段式 by.scope.epoch.iat.exp.sig；
 * by=root|account|owner+root，scope=root|keys|lockreset（账号体系起不再有 by=owner 的票）。
 * @param {string} val
 * @returns {{by:string, scope:string, epoch:number, iat:number, exp:number, sig:string}|null}
 */
export function parseStepupCookie(val) {
  if (!val || typeof val !== 'string') return null;
  const parts = val.split('.');
  if (parts.length !== 6) return null;
  const by = parts[0];
  const scope = parts[1];
  if (by !== STEPUP_BY_ROOT && by !== STEPUP_BY_ACCOUNT && by !== STEPUP_BY_OWNER_ROOT) return null;
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
 * A-1：通过时另带 exp（票据绝对过期时刻，毫秒；status 转发为 expiresAt）。
 * @param {any} request
 * @param {any} env
 * @returns {Promise<{ok:boolean, by:string|null, scope:string|null, reason:string, exp?:number}>}
 *   reason: ok / no-cookie / bad-format / expired / not-yet / no-pubkey /
 *           bad-sig / epoch-changed / kv-error
 */
export async function verifyStepupCookie(request, env) {
  const val = getCookie(request, STEPUP_COOKIE);
  if (!val) return { ok: false, by: null, scope: null, reason: 'no-cookie' };
  const p = parseStepupCookie(val);
  if (!p) return { ok: false, by: null, scope: null, reason: 'bad-format' };
  const now = Date.now();
  if (p.exp <= now) return { ok: false, by: null, scope: null, reason: 'expired' };
  if (p.iat > now + 60000) return { ok: false, by: null, scope: null, reason: 'not-yet' }; /* 允许 60 秒时钟 skew */
  const pubKey = realmPublicKey(env, REALM_STEPUP); /* SGX_STEPUP_PUBLIC */
  if (!pubKey) return { ok: false, by: null, scope: null, reason: 'no-pubkey' };
  /* epoch 必须等于当前 KV epoch：lock-all-devices 后旧 stepup 立即失效 */
  let curEpoch;
  try {
    curEpoch = await getSessionEpoch(env && env.OWNER_KV);
  } catch (e) {
    return { ok: false, by: null, scope: null, reason: 'kv-error' };
  }
  if (p.epoch !== curEpoch) return { ok: false, by: null, scope: null, reason: 'epoch-changed' };
  /* 最后验签（先做便宜检查，签名最贵放最后） */
  const payload = p.by + '.' + p.scope + '.' + p.epoch + '.' + p.iat + '.' + p.exp;
  const ok = await ed25519Verify(pubKey, payload, p.sig);
  if (!ok) return { ok: false, by: null, scope: null, reason: 'bad-sig' };
  return { ok: true, by: p.by, scope: p.scope, reason: 'ok', exp: p.exp };
}

/**
 * 设置 sgx-stepup cookie（<cookie>=<value>; <attrs>; Max-Age=180）。
 * stepup / root-auth / lockreset 共用。
 * @param {Headers} headers @param {string} value
 */
export function setStepupCookie(headers, value) {
  headers.append('Set-Cookie', realmCookie(REALM_STEPUP, value));
}

/**
 * 签发 stepup 票据并写入 headers（fail closed，/api/stepup 两个签发分支共用）。
 * 成功返回 null；失败返回 { status, body }，调用方直接用它构造响应：
 * - SGX_STEPUP_PRIVATE 为空 → 500 no-stepup-key
 * - 读 session epoch 出错 → 503 server
 * - 签名出错 → 500 sign-failed
 * @param {any} env
 * @param {any} kv
 * @param {Headers} headers
 * @param {string} by
 * @param {string} scope
 * @param {boolean} log 是否打印失败日志（enter 打印，takeover-keys 不打印）
 * @returns {Promise<{status:number, body:object}|null>}
 */
async function issueStepupCookie(env, kv, headers, by, scope, log) {
  const stepupKey = realmPrivateKey(env, REALM_STEPUP); /* SGX_STEPUP_PRIVATE */
  if (!stepupKey) {
    if (log) console.error('[stepup] SGX_STEPUP_PRIVATE 未配置，拒绝签发');
    return { status: 500, body: { ok: false, error: 'no-stepup-key' } };
  }
  let epoch;
  try {
    epoch = await getSessionEpoch(kv);
  } catch (e) {
    return { status: 503, body: { ok: false, error: 'server' } };
  }
  try {
    const cv = await signStepupCookie(stepupKey, by, scope, epoch);
    setStepupCookie(headers, cv);
  } catch (e) {
    if (log) console.error('[stepup] sign failed', e && e.message ? e.message : e);
    return { status: 500, body: { ok: false, error: 'sign-failed' } };
  }
  return null;
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
  /* Origin 必须与本站同 host（CSRF 防护），缺失或解析失败一律 403 */
  if (!isSameOrigin(request)) return originDenied();
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
    headers.append('Set-Cookie', realmClearCookie(REALM_STEPUP));
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

  /* ============ enter ============
     账号体系：入口 2 —— 有效 lock 会话（上面已验）+ 独立验证的账号会话（sgx-account），
     且账号登录在 10 分钟内 → stepup(by=account, scope=keys)。
     lock 会话从不被当作账号认证；无账号会话 401 account，过旧 403 account-stale。 */
  if (action === 'enter') {
    const acc = await verifyAccountCookie(request, env);
    if (!acc.ok) {
      return Response.json({ ok: false, error: 'account', reason: acc.reason }, { status: 401 });
    }
    if (!acc.recent) {
      return Response.json({ ok: false, error: 'account-stale' }, { status: 403 });
    }
    const headers = new Headers({ 'Content-Type': 'application/json' });
    const issueErr = await issueStepupCookie(env, kv, headers, STEPUP_BY_ACCOUNT, STEPUP_SCOPE_KEYS, true);
    if (issueErr) return Response.json(issueErr.body, { status: issueErr.status });
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
    const headers = new Headers({ 'Content-Type': 'application/json' });
    const issueErr = await issueStepupCookie(env, kv, headers, STEPUP_BY_ROOT, STEPUP_SCOPE_KEYS, false);
    if (issueErr) return Response.json(issueErr.body, { status: issueErr.status });
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  /* ============ status ============ */
  if (action === 'status') {
    const r = await verifyStepupCookie(request, env);
    /* A-1：有效时带 expiresAt；无效时不带（前端不解析 Cookie） */
    return Response.json({
      ok: true,
      valid: r.ok,
      reason: r.ok ? undefined : r.reason,
      expiresAt: r.ok ? r.exp : undefined,
    });
  }

  return Response.json({ ok: false, error: 'params' }, { status: 400 });
}
