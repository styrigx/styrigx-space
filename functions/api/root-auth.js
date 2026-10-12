/**
 * 2.11 定稿：SGX_ROOT_KEY = 根凭证。
 *
 * 入口 1：有效 lock 会话 + 根凭证 → sgx-stepup(by=root, scope=root)（约 10 分钟，
 * 带当前 epoch），只能管理站长凭证（owner passkey/密码）。
 *
 * 访客假入口：无有效 lock 会话时（访客/未登录），服务端写死返回与真失败完全
 * 相同的 401 auth：不比对 SGX_ROOT_KEY；状态码、响应体、响应头、延迟一致
 * （统一固定最小延迟）。缺 Origin 仍先 403。
 *
 * 引导：lock 层未配置时（KV 读失败按已配置处理），允许无会话直接校验根凭证。
 *
 * 不能签 sgx-app，不能签会话。
 *
 * POST /api/root-auth { key }
 * - 恒定时间比较 env.SGX_ROOT_KEY（防长度泄露）
 * - 限速：所有 root 路径共用一套（_kernel/rootlimit.js）
 * - 通过：签发 sgx-stepup(by=root, scope=root) cookie
 * - 失败：401 auth（并计数）；超限：429
 * - 缺 SGX_ROOT_KEY / SGX_STEPUP_PRIVATE → 拒绝（500/503）
 *
 * 审计：每次使用（成功/失败/假入口）都在 KV 留一条记录（_kernel/rootlog.js），
 * 假入口标记 decoy:true。写入失败则不签发（fail closed）。
 *
 * 只接受 POST；校验 Origin（缺失/解析失败 403）。
 * 旧 /api/owner-auth 不再可用。
 */
import { timingSafeEqual, ed25519Verify } from '../_kernel/crypto.js';
import { getSessionEpoch, ROLE_OWNER } from '../_kernel/session.js';
import { signStepupCookie, STEPUP_COOKIE, STEPUP_COOKIE_ATTRS, STEPUP_MAX_AGE, STEPUP_BY_ROOT, STEPUP_SCOPE_ROOT } from './stepup.js';
import { checkRootLimit, recordRootFail, clearRootFail, getClientIp } from '../_kernel/rootlimit.js';
import { writeRootAudit } from '../_kernel/rootlog.js';
import { isLayerConfigured, LAYER_LOCK } from '../_kernel/layers.js';
import { verifySessionDetailed } from '../_middleware.js';

/* 假入口与真失败的统一固定最小延迟（毫秒）：防时序区分 */
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

  /* 缺关键配置 → 直接拒绝（fail closed） */
  const rootKey = (env && env.SGX_ROOT_KEY) || '';
  const stepupKey = (env && env.SGX_STEPUP_PRIVATE) || '';
  if (!rootKey || !stepupKey || !kv) {
    const errCode = !stepupKey ? 'no-stepup-key' : 'config';
    return Response.json({ ok: false, error: errCode }, { status: 500 });
  }

  /* 真路径还是假入口：
     - 有疑似有效 owner 会话 → 真路径
     - 无会话但 lock 层未配置 → 真路径（引导）
     - 无会话且 lock 已配置（或 KV 读失败按已配置）→ 假入口 */
  const looksOwner = await lightOwnerSession(request, env);
  let lockCfg = true;
  try {
    lockCfg = await isLayerConfigured(kv, LAYER_LOCK);
  } catch (e) {
    lockCfg = true;
  }
  const realPath = looksOwner || !lockCfg;

  if (!realPath) {
    /* ===== 访客假入口：写死 401，与真失败逐字节相同 ===== */
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
    await padTo(t0);
    await writeRootAudit(kv, ip, false, { decoy: true, path: 'root-auth' });
    return decoyAuth();
  }

  /* ===== 真路径 ===== */
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

  const ok = key && (await timingSafeEqual(String(key), String(rootKey)));
  if (!ok) {
    try {
      await recordRootFail(kv, ip);
    } catch (e) {
      await writeRootAudit(kv, ip, false, { path: 'root-auth' });
      return Response.json({ ok: false, error: 'server' }, { status: 503 });
    }
    await padTo(t0);
    await writeRootAudit(kv, ip, false, { path: 'root-auth' });
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
