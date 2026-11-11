/**
 * v6 身份统一（P1）：网关 admit 的新路径——请求带新会话 cookie（sgx-session）、旧进站会话又不成立时，经服务绑定
 * ACCOUNT_VERIFIER.admit() 问账号 Worker「这个新会话能不能走这条路由」，只认 allowed === true。
 *
 * - 分步割接：旧进站会话（sgx-space-session）的判定原样不动、先判；这里只是并存的第二条路，不做新旧格式互转。
 * - 没有 sgx-session cookie → 不问（生产上 P1 没有任何签发入口，所以线上请求一律走不到 RPC，行为不变）。
 * - 判断不在网关：路由要哪一档、身份够不够，都在账号 Worker（core/route-access.js + core/groups.js permits）；网关只传方法和路径。
 * - 绑定没配 / RPC 抛错 / 回了看不懂的东西 → 不放行（fail closed）。
 *
 * 不 import 任何账号代码（规则 14）；只用字符串。切 Cookie 头只用 lib/cookies.js。
 */
import { readCookie, MAX_COOKIE_HEADER } from '../lib/cookies.js';

/** 新会话 cookie 名（同账号 Worker core/identity-session.js SESSION_COOKIE；单测核对两边一致） */
export const NEW_SESSION_COOKIE = 'sgx-session';

/**
 * 新会话能不能走这条路由。没 cookie → false（不问）。
 * @param {Record<string, any>} env @param {Request} request
 * @returns {Promise<boolean>}
 */
export async function newSessionAdmits(env, request) {
  if (!request || !readCookie(request, NEW_SESSION_COOKIE)) return false;
  const cookie = (request.headers.get('Cookie') || '').slice(0, MAX_COOKIE_HEADER);
  const v = env && env.ACCOUNT_VERIFIER;
  if (!v || typeof v.admit !== 'function') return false;
  try {
    const r = await v.admit(cookie, String(request.method || 'GET').toUpperCase(), new URL(request.url).pathname);
    return !!(r && typeof r === 'object' && r.allowed === true);
  } catch (e) {
    console.error('[sgx-auth] account admit rpc failed: ' + (e && /** @type {any} */ (e).name ? /** @type {any} */ (e).name : 'error'));
    return false;
  }
}

/* ---------------- 割接（v6 cutover）：网关自己的接口与子站接口 Worker 也认新会话 ---------------- */

/** RPC 里 action 的写法（同账号 Worker rpc/account-verifier.js ACTION_RE） */
const ACTION_RE = /^[a-z0-9.-]{1,32}$/;

/** 没有 v6 身份的结论（normalizeAdmit 的 fail-closed 默认） */
export const V6_DENIED = Object.freeze({ allowed: false, signedIn: false, uid: null, root: false });

/**
 * 账号 Worker 回的放行结论 → 网关 / 子站用的四项（白名单）：
 * - allowed：allowed === true 且有 uid（坏 cookie 走 public 档不算进门）；问了 action 的还要回答里带回同一个 action
 *   （账号 Worker 旧版本不认 action 时回的是路由档，不能当 action 的结论）
 * - signedIn：有一个 v6 身份（档不够时回 403 而不是 401 用）
 * - root：当前身份是 root（非救援），给审计用
 * @param {any} r @param {string} [action]
 */
export function normalizeAdmit(r, action) {
  if (!r || typeof r !== 'object') return V6_DENIED;
  const uid = Number.isInteger(r.uid) ? r.uid : null;
  const same = action ? r.action === action : !r.action;
  const allowed = r.allowed === true && uid !== null && same;
  return Object.freeze({ allowed, signedIn: uid !== null, uid, root: allowed && r.root === true && r.rescue !== true });
}

/**
 * 问账号 Worker：这个新会话能不能走这条路由（给了 action 就按那个 action 的档）。原样回账号 Worker 的结论；没绑定 / 出错 → null。
 * 子站接口 Worker 经 SpaceVerifier.admit 转来，网关自己的接口（/api/space-audit）经 newSessionConclusion。
 * @param {Record<string, any>} env @param {string} cookieHeader @param {string} method @param {string} pathname @param {string} [action]
 */
export async function askAdmit(env, cookieHeader, method, pathname, action) {
  const v = env && env.ACCOUNT_VERIFIER;
  if (!v || typeof v.admit !== 'function') return null;
  if (action !== undefined && (typeof action !== 'string' || !ACTION_RE.test(action))) return null;
  const cookie = typeof cookieHeader === 'string' ? cookieHeader.slice(0, MAX_COOKIE_HEADER) : '';
  if (!/(?:^|;\s*)sgx-session=[^;]+/.test(cookie)) return null;
  try {
    const m = typeof method === 'string' ? method.toUpperCase().slice(0, 10) : '';
    const p = typeof pathname === 'string' ? pathname.slice(0, 2048) : '';
    return await (action ? v.admit(cookie, m, p, { action }) : v.admit(cookie, m, p));
  } catch (e) {
    console.error('[sgx-auth] account admit rpc failed: ' + (e && /** @type {any} */ (e).name ? /** @type {any} */ (e).name : 'error'));
    return null;
  }
}

/**
 * 网关自己的接口用：这个请求的新会话结论（normalizeAdmit 的四项）。没 cookie → V6_DENIED（不问）。
 * @param {Record<string, any>} env @param {Request} request @param {string} [action]
 */
export async function newSessionConclusion(env, request, action) {
  if (!request || !readCookie(request, NEW_SESSION_COOKIE)) return V6_DENIED;
  const r = await askAdmit(env, request.headers.get('Cookie') || '', String(request.method || 'GET'), new URL(request.url).pathname, action);
  return normalizeAdmit(r, action);
}

/**
 * 网关自己的接口用（/api/status、/api/ai）：这个请求的 v6 结论（路由档）。关口（gate.js admit）问过就放在 context.data.v6，直接用；
 * 没有（非生产关口不验、单测直接调接口）就自己问一次。
 * @param {{ request: Request, env: any, data?: any }} context
 */
export async function v6ConclusionOf(context) {
  const d = context && context.data;
  if (d && d.v6 && typeof d.v6 === 'object' && typeof d.v6.allowed === 'boolean') return d.v6;
  const v = await newSessionConclusion(context.env, context.request);
  if (d) d.v6 = v;
  return v;
}

/**
 * 网关自己的接口的门（v6 P4 起只认 v6 会话）：v6 会话的路由档够 → 'ok'；有 v6 身份但档不够 → 'forbidden'；没有 → 'unauthorized'。
 * 判断不在网关（账号 Worker 的 ROUTE_ACCESS + permits），这里只认结论。
 * @param {{ request: Request, env: any, data?: any }} context
 * @returns {Promise<'ok'|'forbidden'|'unauthorized'>}
 */
export async function v6Gate(context) {
  const v = await v6ConclusionOf(context);
  if (v.allowed) return 'ok';
  return v.signedIn ? 'forbidden' : 'unauthorized';
}

/* ---------------- 2c：AI 回答的私密范围按 v6 身份 ---------------- */

/**
 * AI 私密范围问的路由 + action（ROUTE_ACCESS POST /api/ai 的 actions.private）。GET /api/ai（模型列表的 canChoose）也问这一条：
 * styrigx-ai 用同一个结论头决定私密召回和能不能切模型，两边得一致。判断只在账号 Worker 的 ROUTE_ACCESS + permits()。
 */
export const AI_PRIVATE = Object.freeze({ method: 'POST', path: '/api/ai', action: 'private' });

/**
 * 这个请求的 v6 身份能不能看 AI 的私密召回（AI_PRIVATE 放行，回答带回同一个 action）。没 sgx-session 不问；出错 / 看不懂 → false。
 * @param {Record<string, any>} env @param {Request} request
 * @returns {Promise<boolean>}
 */
export async function v6AiPrivate(env, request) {
  if (!request || !readCookie(request, NEW_SESSION_COOKIE)) return false;
  const r = await askAdmit(env, request.headers.get('Cookie') || '', AI_PRIVATE.method, AI_PRIVATE.path, AI_PRIVATE.action);
  return normalizeAdmit(r, AI_PRIVATE.action).allowed;
}

/* ---------------- 2b：页面状态（data-sgx-lock-session）也认 v6 新会话 ---------------- */

/**
 * 页面状态判 v6 时问的路由：user 档的代表（ROUTE_ACCESS 里 GET /api/prefs = user：任一已登录身份；不在救援白名单 → 救援会话不算）。
 * 用一条真实路由而不是另立一档：判断仍只在账号 Worker 的 ROUTE_ACCESS + permits()（precedence 不动），网关只传方法和路径。
 * 单测核对它在账号路由表里是 user 档、不是救援可用。
 */
export const PAGE_PROBE = Object.freeze({ method: 'GET', path: '/api/prefs' });

/**
 * 这个请求有没有一个有效的 v6 身份（页面该画 valid）：带 sgx-session、账号 Worker 判 PAGE_PROBE 放行（有 uid）。
 * 过期 / epoch 不等 / 用户禁用 / 坏令牌 → 账号 Worker 回没有 uid → false；救援会话 → user 档拒 → false。没 cookie 不问；出错 → false。
 * @param {Record<string, any>} env @param {Request} request
 * @returns {Promise<boolean>}
 */
export async function newSessionSignedIn(env, request) {
  if (!request || !readCookie(request, NEW_SESSION_COOKIE)) return false;
  const r = await askAdmit(env, request.headers.get('Cookie') || '', PAGE_PROBE.method, PAGE_PROBE.path);
  return normalizeAdmit(r).allowed;
}

/** 别的 Worker 能记的 root 特权操作命令字（同账号 Worker REMOTE_AUDIT_COMMANDS） */
const AUDIT_RE = /^(?:rm-bulk|import|export|share)(?:\s[\x20-\x7e]{0,190})?$/;

/**
 * root 的特权内容操作留痕：经 ACCOUNT_VERIFIER.auditRoot 写账号侧身份审计（账号 Worker 重新判会话，只认真 root）。尽力而为，从不抛错。
 * @param {Record<string, any>} env @param {string} cookieHeader @param {string} command @param {string} address 客户端 IP
 * @returns {Promise<boolean>}
 */
export async function auditRoot(env, cookieHeader, command, address) {
  const v = env && env.ACCOUNT_VERIFIER;
  if (!v || typeof v.auditRoot !== 'function') return false;
  if (typeof command !== 'string' || !AUDIT_RE.test(command)) return false;
  try {
    const cookie = typeof cookieHeader === 'string' ? cookieHeader.slice(0, MAX_COOKIE_HEADER) : '';
    return (await v.auditRoot(cookie, command, typeof address === 'string' ? address.slice(0, 64) : '')) === true;
  } catch (e) {
    return false;
  }
}
