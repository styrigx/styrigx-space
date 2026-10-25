/**
 * 根凭证（RootKey，SGX_ROOT_KEY）入口：比对通过后按用途签一张 reset / reauth 票（by=root）。
 *
 * RootKey 不拥有会话：只用于比对（_kernel/root-check.js），不签名；本接口从不签锁屏会话或账号会话。
 *
 * POST /api/root-auth { key, purpose }，purpose 只有四个值（缺失 / 其它值 → 400 purpose，不比对、不计数）：
 * - 'lock-reauth'    → LockReauthTicket（sgx-lock-reauth）：安全与隐私 → 锁屏凭证；要 admin 锁屏会话
 * - 'lock-reset'     → LockResetTicket（sgx-lock-reset）：只在锁屏未设置时可用（从零设置第一把 LockKey，
 *                      无需会话）；锁屏已设置时走 /api/lock-reset（RootKey + 重置开关 / AccountKey），这里按假入口处理
 * - 'account-reauth' → AccountReauthTicket（sgx-account-reauth）：账号 → 账号安全；要 admin 锁屏会话 + 有效账号会话
 * - 'account-reset'  → AccountResetTicket（sgx-account-reset）：重置账号登录方式；要 admin 锁屏会话，不要账号会话。
 *                      重置页只认这张票，设好新 AccountKey 后正常登录（不顺带签账号会话）
 * 三张票都是 3 分钟、各自独立 cookie（见 realms.js TICKETS）。
 *
 * 访客假入口：访客会话（sgx-lock-session role=visitor）直接写死返回 401：
 * 不读 D1、KV、环境变量里的任何凭证，不做任何比对；不计入根凭证限速；
 * 不写审计。状态码、响应体、响应头、固定最小延迟与真失败一致。
 * 缺 Origin 仍先 403。
 * 无会话假入口：不满足上面各用途的前置条件（无 admin 会话，且不是锁屏未设置时的 lock-reset）→ 写死 401 auth，
 * 与真失败逐字节相同；计入限速，不写审计。
 *
 * - 恒定时间比较 env.SGX_ROOT_KEY（防长度泄露）
 * - 限速：所有 root 路径共用一套（_kernel/root-limit.js），仅真路径计数
 *   （单 IP 连错 5 次锁 15 分钟；全局每小时失败 20 次暂停 1 小时）
 * - 失败：401 auth（并计数）；超限：429
 * - 缺 SGX_ROOT_KEY → 500 config；缺该票的签名钥匙 → 503 config
 *
 * 审计：真路径每次使用（成功/失败）在 KV 留一条记录（_kernel/root-audit.js，path = purpose）；
 * 假入口不写审计。写入失败则不签发（fail closed）。
 *
 * 只接受 POST；校验 Origin（缺失/解析失败 403）。
 */
import { ed25519Verify } from '../_kernel/crypto.js';
import { checkRootCredential } from '../_kernel/root-check.js';
import { ROLE_ADMIN, ROLE_VISITOR, verifyLockSession } from '../_kernel/lock-session.js';
import { checkRootLimit, recordRootFail, getClientIp } from '../_kernel/root-limit.js';
import { writeRootAudit } from '../_kernel/root-audit.js';
import { isLockEffectivelyConfigured } from '../_kernel/layers.js';
import { isSameOrigin, originDenied } from '../_kernel/http.js';
import {
  REALM_LOCK,
  REALM_ROOT,
  TICKETS,
  BY_ROOT,
  LOCK_REAUTH_TICKET,
  LOCK_RESET_TICKET,
  ACCOUNT_REAUTH_TICKET,
  ACCOUNT_RESET_TICKET,
  realmPublicKey,
} from '../_kernel/realms.js';
import { issueTicket } from '../_kernel/tickets.js';
import { verifyAccountSession } from '../_kernel/account-session.js';

/** purpose → 签哪张票 */
export const ROOT_PURPOSES = Object.freeze({
  'lock-reauth': LOCK_REAUTH_TICKET,
  'lock-reset': LOCK_RESET_TICKET,
  'account-reauth': ACCOUNT_REAUTH_TICKET,
  'account-reset': ACCOUNT_RESET_TICKET,
});

/* 假入口与真失败的统一固定最小延迟（毫秒）：防时序区分。
   真失败路径的审计写入放在 padTo 之前，padTo 把总耗时对齐到此时长，
   使真失败与假入口的响应耗时一致（审计为单次 KV 写，通常远小于此时长）。 */
const MIN_DELAY_MS = 200;

/** @param {number} t0 起始时间戳 */
async function padTo(t0) {
  const wait = t0 + MIN_DELAY_MS - Date.now();
  if (wait > 0) {
    await new Promise(function (r) { setTimeout(r, wait); });
  }
}

/** 与真失败逐字节相同的 401 响应 */
function decoyAuth() {
  return Response.json({ ok: false, error: 'auth' }, { status: 401 });
}

/**
 * 轻量会话检查（不读 KV）：解析 sgx-lock-session、验 Ed25519 签名、检查 exp 与 role。
 * 只读 SGX_LOCK_PUBLIC（公钥，非凭证）。
 * - role=visitor：仅用于识别访客假入口
 * - role=admin：仅用于决定走真路径还是假入口；真路径内再做完整校验（含 KV 纪元）
 * @param {any} request
 * @param {any} env
 * @param {string} wantRole ROLE_VISITOR 或 ROLE_ADMIN
 * @returns {Promise<boolean>} 是否看起来像该角色的有效会话
 */
async function lightSession(request, env, wantRole) {
  try {
    const h = request.headers.get('Cookie') || '';
    const pubKey = realmPublicKey(env, REALM_LOCK); /* SGX_LOCK_PUBLIC */
    if (!pubKey) return false;
    for (const part of h.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k !== REALM_LOCK.cookie) continue; /* sgx-lock-session */
      const parts = v.join('=').split('.');
      if (parts.length !== 6) continue;
      if (parts[1] !== wantRole) continue;
      const exp = parseInt(parts[3], 10);
      if (!Number.isFinite(exp) || exp <= Date.now()) continue;
      if (await ed25519Verify(pubKey, REALM_LOCK.cookie + '|' + parts.slice(0, 5).join('.'), parts[5])) return true;
    }
  } catch (e) {}
  return false;
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
  const t0 = Date.now();
  if (request.method !== 'POST') {
    return Response.json({ ok: false }, { status: 405 });
  }
  /* Origin 必须与本站同 host（CSRF 防护），缺失或解析失败一律 403 */
  if (!isSameOrigin(request)) return originDenied();

  /* B1-9 访客假入口统一 401（安全）：访客会话直接返回 401，
     不读任何存储（KV/D1），不区分新站旧站。放在所有 KV 读取之前。 */
  if (await lightSession(request, env, ROLE_VISITOR)) {
    await padTo(t0);
    return Response.json({ ok: false, error: 'denied' }, { status: 401 });
  }

  const kv = env && env.KV_LOCK_DOOR;
  const ip = getClientIp(request);

  /* body 只读一次（purpose 决定签哪张票；key 在限流检查之后才比对） */
  let body = null;
  try { body = await request.json(); } catch (e) {}
  const purpose = body && typeof body.purpose === 'string' ? body.purpose : '';
  if (!Object.prototype.hasOwnProperty.call(ROOT_PURPOSES, purpose)) {
    await padTo(t0);
    return Response.json({ ok: false, error: 'purpose' }, { status: 400 });
  }
  const ticket = ROOT_PURPOSES[purpose];
  const auditPath = purpose;

  /* 锁屏是否已设置（KV 读失败按已设置处理）：只决定 lock-reset 能不能走 */
  let lockCfg = true;
  try {
    lockCfg = await isLockEffectivelyConfigured(kv);
  } catch (e) {
    lockCfg = true;
  }

  /* 真路径还是无会话假入口：
     - lock-reset：只在锁屏未设置时走真路径（从零设置，无需会话）
     - 其余三个：有疑似有效的 admin 锁屏会话才走真路径 */
  const looksAdmin = await lightSession(request, env, ROLE_ADMIN);
  const realPath = ticket === LOCK_RESET_TICKET ? !lockCfg : looksAdmin;

  if (!realPath) {
    /* ===== 无会话假入口：写死 401，与真失败逐字节相同 =====
       不检查环境变量（缺 SGX_ROOT_KEY 等时也返回 401，不泄露 500 config）。
       保留限速检查（KV 出错时 fail closed）；不写审计（防刷接口触发全局暂停）。
       KV 缺失时无法限速，直接返回 401（不泄露配置状态）。 */
    if (kv) {
      try {
        const lim = await checkRootLimit(kv, ip);
        if (lim.limited) {
          return Response.json({ ok: false, error: 'cooldown' }, { status: 429 });
        }
      } catch (e) {
        return Response.json({ ok: false, error: 'server' }, { status: 503 });
      }
      try {
        await recordRootFail(kv, ip);
      } catch (e) {
        return Response.json({ ok: false, error: 'server' }, { status: 503 });
      }
    }
    await padTo(t0);
    return decoyAuth();
  }

  /* ===== 真路径 =====
     缺关键配置 → 直接拒绝（fail closed）。假入口在上面已返回，这里只处理真路径，
     避免无会话时因缺环境变量泄露 500 config。该票的签名钥匙缺失 → 503 config（先于比对，不浪费限流次数）。 */
  const rootKey = (env && env[REALM_ROOT.secret]) || ''; /* SGX_ROOT_KEY */
  const conf = TICKETS[ticket];
  if (!(env && env[conf.privateKey]) || !(env && env[conf.publicKey])) {
    return Response.json({ ok: false, error: 'config' }, { status: 503 });
  }
  if (!rootKey || !kv) {
    return Response.json({ ok: false, error: 'config' }, { status: 500 });
  }

  if (ticket !== LOCK_RESET_TICKET) {
    /* 完整会话校验（含 KV 纪元）；轻量检查通过但完整校验失败（如纪元已推进）→ 401 session */
    const sess = await verifyLockSession(request, env);
    if (!sess.ok || sess.role !== ROLE_ADMIN) {
      return Response.json({ ok: false, error: 'session' }, { status: 401 });
    }
    /* 账号再验证：本来就要已登录账号 */
    if (ticket === ACCOUNT_REAUTH_TICKET) {
      const acc = await verifyAccountSession(request, env);
      if (!acc.ok) return Response.json({ ok: false, error: 'account', reason: acc.reason }, { status: 401 });
    }
  }

  /* 根凭证比对（限速 / 恒定时间比较 / 失败计数 / 审计）：全站共用一份实现（_kernel/root-check.js） */
  const rc = await checkRootCredential({
    env: env,
    kv: kv,
    ip: ip,
    key: (body && typeof body.key === 'string' && body.key) || '',
    auditPath: auditPath,
    padTo: function () { return padTo(t0); },
  });
  if (!rc.ok) return rc.response;

  const headers = new Headers({ 'Content-Type': 'application/json' });
  const tErr = await issueTicket(env, headers, ticket, BY_ROOT);
  if (tErr) {
    await writeRootAudit(kv, ip, false, { path: auditPath });
    return Response.json(tErr.body, { status: tErr.status });
  }
  /* 审计写入失败则不签发（fail closed） */
  if (!(await writeRootAudit(kv, ip, true, { path: auditPath }))) {
    return Response.json({ ok: false, error: 'server' }, { status: 503 });
  }
  return new Response(JSON.stringify({ ok: true }), { headers });
}
