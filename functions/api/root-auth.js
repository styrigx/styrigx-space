/**
 * 认证入口修正：SGX_ROOT_KEY = 根凭证。
 *
 * 入口 1（站长凭证）：有效 lock 会话 + 根凭证 → sgx-stepup(by=root, scope=root)
 * （约 10 分钟，带当前 epoch），只能管理站长凭证（ownerkey：站长密码/站长通行密钥）。
 *
 * 访客假入口：访客会话（sgx-verified role=visitor）直接写死返回 401 auth：
 * 不读 D1、KV、环境变量里的任何凭证，不做任何比对；不计入 rootlimit；
 * 不写审计。状态码、响应体、响应头、固定最小延迟与真失败一致。
 * 缺 Origin 仍先 403。
 *
 * 引导：lock 层未配置时（KV 读失败按已配置处理），允许无会话直接校验根凭证。
 *
 * 不能签 sgx-app，不能签会话。
 *
 * POST /api/root-auth { key }
 * - 恒定时间比较 env.SGX_ROOT_KEY（防长度泄露）
 * - 限速：所有 root 路径共用一套（_kernel/rootlimit.js），仅真路径计数
 *   （单 IP 连错 5 次锁 15 分钟；全局每小时失败 20 次暂停 1 小时）
 * - 通过：签发 sgx-stepup(by=root, scope=root) cookie
 * - 失败：401 auth（并计数）；超限：429
 * - 缺 SGX_ROOT_KEY / SGX_STEPUP_PRIVATE → 拒绝（500/503）
 *
 * 审计：真路径每次使用（成功/失败）在 KV 留一条记录（_kernel/rootlog.js）；
 * 假入口不写审计。写入失败则不签发（fail closed）。
 *
 * 只接受 POST；校验 Origin（缺失/解析失败 403）。
 * 旧 /api/owner-auth 不再可用。
 */
import { timingSafeEqual, ed25519Verify, normalizeRootKey } from '../_kernel/crypto.js';
import { getSessionEpoch, ROLE_OWNER, ROLE_VISITOR } from '../_kernel/session.js';
import { signStepupCookie, STEPUP_COOKIE, STEPUP_COOKIE_ATTRS, STEPUP_MAX_AGE, STEPUP_BY_ROOT, STEPUP_SCOPE_ROOT } from './stepup.js';
import { checkRootLimit, recordRootFail, clearRootFail, getClientIp } from '../_kernel/rootlimit.js';
import { writeRootAudit } from '../_kernel/rootlog.js';
import { isLockEffectivelyConfigured } from '../_kernel/layers.js';
import { verifySessionDetailed } from '../_middleware.js';

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
 * 轻量访客会话检查（不读 KV）：解析 cookie、验 Ed25519 签名、检查 exp 与 role。
 * 仅用于识别访客假入口；只读 SGX_LOCK_PUBLIC（公钥，非凭证）。
 * @param {any} request
 * @param {any} env
 * @returns {Promise<boolean>} 是否看起来像有效的访客会话
 */
async function lightVisitorSession(request, env) {
  try {
    const h = request.headers.get('Cookie') || '';
    const pubKey = (env && env.SGX_LOCK_PUBLIC) || '';
    if (!pubKey) return false;
    for (const part of h.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k !== 'sgx-verified') continue;
      const val = v.join('=');
      const parts = val.split('.');
      if (parts.length !== 5) continue;
      const [by, role, epochStr, expStr, sig] = parts;
      if (role !== ROLE_VISITOR) continue;
      const exp = parseInt(expStr, 10);
      if (!Number.isFinite(exp) || exp <= Date.now()) continue;
      const payload = by + '.' + role + '.' + epochStr + '.' + expStr;
      if (await ed25519Verify(pubKey, payload, sig)) return true;
    }
  } catch (e) {}
  return false;
}

/**
 * 轻量会话检查（不读 KV）：解析 cookie、验 Ed25519 签名、检查 exp 与 role。
 * 仅用于决定走真路径还是假入口；真路径内再做完整校验（含 KV epoch）。
 * @param {any} request
 * @param {any} env
 * @returns {Promise<boolean>} 是否看起来像有效的 owner 会话
 */
async function lightOwnerSession(request, env) {
  try {
    const h = request.headers.get('Cookie') || '';
    const pubKey = (env && env.SGX_LOCK_PUBLIC) || '';
    if (!pubKey) return false;
    for (const part of h.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k !== 'sgx-verified') continue;
      const val = v.join('=');
      const parts = val.split('.');
      if (parts.length !== 5) continue;
      const [by, role, epochStr, expStr, sig] = parts;
      if (role !== ROLE_OWNER) continue;
      if (by !== 'root' && by !== 'owner') continue;
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
  /* Origin 必须存在、可解析且 host 一致（CSRF 防护）；缺失或解析失败一律 403 */
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

  const kv = env && env.OWNER_KV;
  const ip = getClientIp(request);

  /* 锁屏层是否有效已配置（标记或真实凭证任一存在、或读取失败都算已配置）。
     先算出来，供假入口判断用。 */
  let lockCfg = true;
  try {
    lockCfg = await isLockEffectivelyConfigured(kv);
  } catch (e) {
    lockCfg = true;
  }

  /* ===== 访客假入口（优先）：访客会话直接写死 401 =====
     不读 D1、KV、环境变量里的任何凭证，不做任何比对；
     不计入 rootlimit；不写审计。
     状态码、响应体、固定最小延迟与真失败一致。
     例外：锁屏未配置的引导场景下，有访客 cookie 也不走假入口，
     必须走真路径校验根凭证（否则锁屏根凭证入口永远进不去）。
     已知风险：访客假入口不检查 rootlimit，永远不返回 429，
     访客会话可无限次试探而不触发限速；真路径与无会话假入口仍受限速保护。 */
  if (lockCfg && await lightVisitorSession(request, env)) {
    await padTo(t0);
    return decoyAuth();
  }

  /* 真路径还是无会话假入口：
     - 有疑似有效 owner 会话 → 真路径
     - 无会话但 lock 层未配置 → 真路径（引导）
     - 无会话且 lock 已配置（或读取失败按已配置）→ 假入口 */
  const looksOwner = await lightOwnerSession(request, env);
  const realPath = looksOwner || !lockCfg;

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
  const rootKey = (env && env.SGX_ROOT_KEY) || '';
  const stepupKey = (env && env.SGX_STEPUP_PRIVATE) || '';
  if (!rootKey || !stepupKey || !kv) {
    const errCode = !stepupKey ? 'no-stepup-key' : 'config';
    return Response.json({ ok: false, error: errCode }, { status: 500 });
  }

  if (lockCfg) {
    /* 正常运行：入口 1 要求有效 lock 会话。
       完整会话校验（含 KV epoch）；轻量检查通过但完整校验失败（如 epoch 已推进）→ 401 */
    const sess = await verifySessionDetailed(request, env);
    if (!sess.ok || sess.role !== ROLE_OWNER) {
      return Response.json({ ok: false, error: 'session' }, { status: 401 });
    }
  }
  /* 引导模式（lock 未配置）：无需会话，直接校验根凭证 */

  /* 限流检查：KV 出错一律拒绝（fail closed） */
  try {
    const lim = await checkRootLimit(kv, ip);
    if (lim.limited) {
      await writeRootAudit(kv, ip, false, { path: 'root-auth' });
      return Response.json({ ok: false, error: 'locked' }, { status: 429 });
    }
  } catch (e) {
    return Response.json({ ok: false, error: 'server' }, { status: 503 });
  }

  let key = '';
  try {
    const body = await request.json();
    key = (body && body.key) || '';
  } catch (e) {}

  /* 批次 A 收尾 B2：两边都去掉空白字符后再比对；去空白后为空一律拒绝 */
  const ok = key && normalizeRootKey(key) && (await timingSafeEqual(normalizeRootKey(key), normalizeRootKey(rootKey)));
  if (!ok) {
    try {
      await recordRootFail(kv, ip);
    } catch (e) {
      await writeRootAudit(kv, ip, false, { path: 'root-auth' });
      return Response.json({ ok: false, error: 'server' }, { status: 503 });
    }
    /* 审计写入放在 padTo 之前：padTo 把总耗时对齐到 MIN_DELAY，
       真失败与假入口的响应耗时一致，无法通过耗时区分。 */
    await writeRootAudit(kv, ip, false, { path: 'root-auth' });
    await padTo(t0);
    return decoyAuth(); /* 与假入口逐字节相同 */
  }

  /* 成功：清掉该 IP 的失败计数（失败不影响主流程） */
  await clearRootFail(kv, ip);

  /* 只签发 sgx-stepup(by=root, scope=root)，不签发会话 */
  const headers = new Headers({ 'Content-Type': 'application/json' });
  let epoch;
  try {
    epoch = await getSessionEpoch(kv);
  } catch (e) {
    await writeRootAudit(kv, ip, false, { path: 'root-auth' });
    return Response.json({ ok: false, error: 'server' }, { status: 503 });
  }
  let stepupVal;
  try {
    stepupVal = await signStepupCookie(stepupKey, STEPUP_BY_ROOT, STEPUP_SCOPE_ROOT, epoch);
  } catch (e) {
    await writeRootAudit(kv, ip, false, { path: 'root-auth' });
    return Response.json({ ok: false, error: 'sign-failed' }, { status: 500 });
  }
  headers.append(
    'Set-Cookie',
    STEPUP_COOKIE + '=' + stepupVal + '; ' + STEPUP_COOKIE_ATTRS + '; Max-Age=' + STEPUP_MAX_AGE
  );

  /* 审计写入失败则不签发（fail closed） */
  if (!(await writeRootAudit(kv, ip, true, { path: 'root-auth' }))) {
    return Response.json({ ok: false, error: 'server' }, { status: 503 });
  }
  return new Response(JSON.stringify({ ok: true }), { headers });
}
