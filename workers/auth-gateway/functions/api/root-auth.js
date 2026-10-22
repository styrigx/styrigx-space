/**
 * 认证入口修正：SGX_ROOT_KEY = 根凭证。
 *
 * 默认（锁屏凭证的门）：有效 lock 会话 + 根凭证 → 锁屏门票 sgx-door(door=lock, by=root)，
 * 3 分钟，SGX_LOCK_* 签名（_kernel/door.js）。锁屏未配置的引导模式（无会话）同样签这张票，
 * 前端随后调 /api/root-session 换 by=root 的会话。
 *
 * 访客假入口：访客会话（sgx-verified role=visitor）直接写死返回 401 auth：
 * 不读 D1、KV、环境变量里的任何凭证，不做任何比对；不计入 rootlimit；
 * 不写审计。状态码、响应体、响应头、固定最小延迟与真失败一致。
 * 缺 Origin 仍先 403。
 *
 * 引导：lock 层未配置时（KV 读失败按已配置处理），允许无会话直接校验根凭证。
 *
 * 本接口不直接签 lock 会话。
 *
 * 按用途签票（PR3：根凭证统一，比对只在 _kernel/root-check.js 一处）：
 * - purpose 'lock'（默认）：锁屏门票 sgx-door(door=lock, by=root)
 * - purpose 'account'：「重置登录」—— 根凭证不再是普通的账号登录入口，只用来重置账号登录方式：
 *   签账号会话 sgx-account(by=root) + 账号门票 sgx-door(door=account, by=root)，3 分钟，
 *   前端随即进 账号 → 安全与隐私 重设账号密码 / 通行密钥。不签锁屏门票。
 *   限速、审计（path=account）、访客假入口、真/假路径判断与 lock 完全相同，唯一区别：
 *   purpose=account 不走引导模式（无有效 owner lock 会话一律走假入口）。缺 SGX_ACCOUNT_PRIVATE/PUBLIC → 503 config。
 *
 * POST /api/root-auth { key, purpose? }
 * - 恒定时间比较 env.SGX_ROOT_KEY（防长度泄露）
 * - 限速：所有 root 路径共用一套（_kernel/rootlimit.js），仅真路径计数
 *   （单 IP 连错 5 次锁 15 分钟；全局每小时失败 20 次暂停 1 小时）
 * - 通过：签发锁屏门票 sgx-door(door=lock, by=root)
 * - 失败：401 auth（并计数）；超限：429
 * - 缺 SGX_ROOT_KEY → 500 config；缺 SGX_LOCK_PRIVATE/PUBLIC → 503 config
 *
 * 审计：真路径每次使用（成功/失败）在 KV 留一条记录（_kernel/rootlog.js）；
 * 假入口不写审计。写入失败则不签发（fail closed）。
 *
 * 只接受 POST；校验 Origin（缺失/解析失败 403）。
 * 旧 /api/owner-auth 不再可用。
 */
import { ed25519Verify } from '../_kernel/crypto.js';
import { checkRootCredential } from '../_kernel/root-check.js';
import { ROLE_OWNER, ROLE_VISITOR } from '../_kernel/session.js';
import { checkRootLimit, recordRootFail, getClientIp } from '../_kernel/rootlimit.js';
import { writeRootAudit } from '../_kernel/rootlog.js';
import { isLockEffectivelyConfigured } from '../_kernel/layers.js';
import { verifySessionDetailed } from '../_middleware.js';
import { isSameOrigin, originDenied } from '../_kernel/http.js';
import { REALM_LOCK, REALM_ROOT, realmPrivateKey, realmPublicKey } from '../_kernel/realms.js';
import { issueDoorCookie, DOOR_ACCOUNT, DOOR_LOCK } from '../_kernel/door.js';
import { issueAccountCookie, accountKeysReady, loginOpts, ACCOUNT_BY_ROOT } from '../_kernel/account-session.js';

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
 * 轻量会话检查（不读 KV）：解析 sgx-verified cookie、验 Ed25519 签名、检查 exp 与 role。
 * 只读 SGX_LOCK_PUBLIC（公钥，非凭证）。
 * - role=visitor：仅用于识别访客假入口
 * - role=owner：仅用于决定走真路径还是假入口（另要求 by=root|owner）；
 *   真路径内再做完整校验（含 KV epoch）
 * 原 lightVisitorSession / lightOwnerSession 两份逐行相同的代码合并（行为不变）。
 * @param {any} request
 * @param {any} env
 * @param {string} wantRole ROLE_VISITOR 或 ROLE_OWNER
 * @returns {Promise<boolean>} 是否看起来像该角色的有效会话
 */
async function lightSession(request, env, wantRole) {
  try {
    const h = request.headers.get('Cookie') || '';
    const pubKey = realmPublicKey(env, REALM_LOCK); /* SGX_LOCK_PUBLIC */
    if (!pubKey) return false;
    for (const part of h.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k !== REALM_LOCK.cookie) continue; /* sgx-verified */
      const val = v.join('=');
      const parts = val.split('.');
      if (parts.length !== 5) continue;
      const [by, role, epochStr, expStr, sig] = parts;
      if (role !== wantRole) continue;
      if (wantRole === ROLE_OWNER && by !== 'root' && by !== 'owner') continue;
      const exp = parseInt(expStr, 10);
      if (!Number.isFinite(exp) || exp <= Date.now()) continue;
      const payload = by + '.' + role + '.' + epochStr + '.' + expStr;
      if (await ed25519Verify(pubKey, payload, sig)) return true;
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

  const kv = env && env.OWNER_KV;
  const ip = getClientIp(request);

  /* body 只读一次（target 决定签发什么；key 在限流检查之后才比对） */
  let body = null;
  try { body = await request.json(); } catch (e) {}
  /* 用途：purpose='account'（重置登录：账号）；其余一律按锁屏（purpose='lock' 或不传） */
  const toAccount = !!(body && body.purpose === 'account');
  const auditPath = toAccount ? 'account' : 'root-auth';

  /* 非访客路径：计算 lockCfg（供真/假路径判断用） */
  let lockCfg = true;
  try {
    lockCfg = await isLockEffectivelyConfigured(kv);
  } catch (e) {
    lockCfg = true;
  }

  /* 真路径还是无会话假入口：
     - 有疑似有效 owner 会话 → 真路径
     - 无会话但 lock 层未配置 → 真路径（引导）
     - 无会话且 lock 已配置（或读取失败按已配置）→ 假入口 */
  const looksOwner = await lightSession(request, env, ROLE_OWNER);
  /* 重置登录（purpose=account）不走引导：必须先有 owner lock 会话 */
  const realPath = looksOwner || (!lockCfg && !toAccount);

  if (!realPath) {
    /* ===== 无会话假入口：写死 401，与真失败逐字节相同 =====
       不检查环境变量（缺 SGX_ROOT_KEY 等时也返回 401，不泄露 500 config）。
       保留限速检查（KV 出错时 fail closed）；不写审计（防刷接口触发全局暂停）。
       KV 缺失时无法限速，直接返回 401（不泄露配置状态）。 */
    if (kv) {
      try {
        const lim = await checkRootLimit(kv, ip);
        if (lim.limited) {
          return Response.json({ ok: false, error: 'locked' }, { status: 429 });
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
     缺关键配置 → 直接拒绝（fail closed）。注意：假入口路径在上面已返回，
     这里只处理真路径，避免无会话时因缺环境变量泄露 500 config。 */
  const rootKey = (env && env[REALM_ROOT.secret]) || ''; /* SGX_ROOT_KEY */
  if (toAccount) {
    /* 账号钥匙缺失 → 503 config（只影响账号登录）；先于根凭证比对，不浪费限流次数 */
    if (!accountKeysReady(env)) {
      return Response.json({ ok: false, error: 'config' }, { status: 503 });
    }
    if (!rootKey || !kv) {
      return Response.json({ ok: false, error: 'config' }, { status: 500 });
    }
  } else {
    /* 锁屏钥匙缺失 → 503 config；先于根凭证比对，不浪费限流次数 */
    if (!realmPrivateKey(env, REALM_LOCK) || !realmPublicKey(env, REALM_LOCK)) {
      return Response.json({ ok: false, error: 'config' }, { status: 503 });
    }
    if (!rootKey || !kv) {
      return Response.json({ ok: false, error: 'config' }, { status: 500 });
    }
  }

  if (lockCfg || toAccount) {
    /* 正常运行：入口 1 要求有效 lock 会话。
       完整会话校验（含 KV epoch）；轻量检查通过但完整校验失败（如 epoch 已推进）→ 401 */
    const sess = await verifySessionDetailed(request, env);
    if (!sess.ok || sess.role !== ROLE_OWNER) {
      return Response.json({ ok: false, error: 'session' }, { status: 401 });
    }
  }
  /* 引导模式（lock 未配置）：无需会话，直接校验根凭证 */

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

  /* 账号登录：签发 sgx-account(by=root)，不签锁屏门票、不签 lock 会话 */
  if (toAccount) {
    const accErr = await issueAccountCookie(env, headers, ACCOUNT_BY_ROOT, await loginOpts(request, env, body));
    if (accErr) {
      await writeRootAudit(kv, ip, false, { path: auditPath });
      return Response.json(accErr.body, { status: accErr.status });
    }
    /* 重置登录：总是另签账号门票（3 分钟），前端直接进账号 → 安全与隐私重设账号密码 / 通行密钥 */
    const dErr = await issueDoorCookie(env, headers, DOOR_ACCOUNT, ACCOUNT_BY_ROOT);
    if (dErr) {
      await writeRootAudit(kv, ip, false, { path: auditPath });
      return Response.json(dErr.body, { status: dErr.status });
    }
    if (!(await writeRootAudit(kv, ip, true, { path: auditPath }))) {
      return Response.json({ ok: false, error: 'server' }, { status: 503 });
    }
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  /* 只签发锁屏门票（door=lock, by=root），不签发会话 */
  const dErr = await issueDoorCookie(env, headers, DOOR_LOCK, 'root');
  if (dErr) {
    await writeRootAudit(kv, ip, false, { path: auditPath });
    return Response.json(dErr.body, { status: dErr.status });
  }

  /* 审计写入失败则不签发（fail closed） */
  if (!(await writeRootAudit(kv, ip, true, { path: auditPath }))) {
    return Response.json({ ok: false, error: 'server' }, { status: 503 });
  }
  return new Response(JSON.stringify({ ok: true }), { headers });
}
