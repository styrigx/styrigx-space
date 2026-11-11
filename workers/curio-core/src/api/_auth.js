// workers/curio-core/src/api/_auth.js
// 接口鉴权（v6 P4，定稿 v5.3 §十二）：本 Worker 不持任何钥匙，只认 v6 会话（sgx-session）。
// 经网关 SpaceVerifier.admit 问账号 Worker「这个会话能不能走这条路由」（路由表 ROUTE_ACCESS + permits 只在账号 Worker），本文件只认结论：
//   - 三档守卫（v5 S3，GUARDS；app.js 按 routes.js ROUTE_ACCESS 套用，每个请求只套一次）：
//     publicRead（不拒绝）· requireEntry · requireMusic（都按路由表的档问 admit）
//   - 读私密 / canWrite 提示：readAccess（action 'private' 的档）
// 错误码：没有 v6 身份 401 unauthorized；有身份但档不够 403 forbidden；非同源 403 origin（_write.js / 各接口自己查）。
// 旧的进站 / 账号结论（SpaceVerifier.conclusion）随应用授权删除（定稿 v5.3 §十二）。
// fail closed：绑定没有 admit / 出错 → 当没有 v6 身份。
import { err } from './_lib.js';

/**
 * 要求这条路由的档（写接口：本站写组；导入 / 导出：root，见账号 Worker 路由表）：通过 → { response: null }；否则 { response: 错误 }。
 * 没有 v6 身份 401 unauthorized；有身份但档不够 403 forbidden。
 * @param {any} context
 */
export async function requireScope(context) {
  const v = await v6Of(context);
  if (v.allowed) { context.data.via = 'v6'; return { response: null }; }
  return { response: v.signedIn ? err('forbidden', 403) : err('unauthorized', 401) };
}

/**
 * 要求账号会话（导出含私密的书签，路由档 root）：同 requireScope。
 * @param {any} context
 */
export async function requireAccount(context) {
  return requireScope(context);
}

/* ---------- 三档守卫（v5 S3；routes.js ROUTE_ACCESS 的 public / entry / music，app.js handle 套用） ---------- */

/** public：谁都能调，不拒绝、不问网关（要私密行 / canWrite 的 handler 自己 readAccess） @returns {Promise<null>} */
export async function publicRead() {
  return null;
}

/** entry：按路由表的档问 v6（没有身份 401 unauthorized，档不够 403 forbidden） @param {any} context */
export async function requireEntry(context) {
  return (await requireScope(context)).response;
}

/** music：写组档（同 requireEntry） @param {any} context */
export async function requireMusic(context) {
  return (await requireScope(context)).response;
}

/** 档名 → 守卫 */
export const GUARDS = Object.freeze({ public: publicRead, entry: requireEntry, music: requireMusic });

/* ---------- v6 会话（ADR-0006） ----------
 * 浏览器带了 sgx-session 时，经网关 SpaceVerifier.admit 问账号 Worker「这个新会话能不能走这条路由」
 * （路由表 ROUTE_ACCESS + permits 只在账号 Worker，本 Worker 只传方法、公开地址的路径和 action，不自己比组）。
 * 结论放在 context.data.v6[action]，每个请求每个 action 最多问一次。绑定没有 admit / 出错 → 当没有 v6（fail closed，不抛错）。 */

const V6_COOKIE_RE = /(?:^|;\s*)sgx-session=[^;]+/;
const V6_ACTION_RE = /^[a-z0-9.-]{1,32}$/;

/** 没有 v6 身份 */
export const V6_DENIED = Object.freeze({ allowed: false, signedIn: false, uid: null, root: false });

/**
 * 网关回答 → 四项（白名单；同 space-core core/identity-admit.js normalizeAdmit）：allowed 要 allowed === true 且有 uid，
 * 问了 action 的还要回答里带回同一个 action（旧版本不认 action 时回的是路由档，不能当 action 的结论）；root = 非救援的 root。
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
 * 这个请求的 v6 结论（给了 action 就按那个 action 的档：album.del、private …）。
 * @param {{request: Request, env: Record<string, any>, data?: Record<string, any>}} context @param {string} [action]
 */
export function v6Of(context, action) {
  const d = context.data || (context.data = {});
  const cache = d.v6 || (d.v6 = {});
  const k = action || '-';
  if (!cache[k]) cache[k] = askV6(context.request, context.env, action);
  return cache[k];
}

/** @param {Request} request @param {Record<string, any>} env @param {string} [action] */
async function askV6(request, env, action) {
  const cookie = (request.headers.get('Cookie') || '').slice(0, 8192);
  if (!V6_COOKIE_RE.test(cookie)) return V6_DENIED;
  if (action !== undefined && !V6_ACTION_RE.test(action)) return V6_DENIED;
  const g = env && env.SPACE;
  if (!g || typeof g.admit !== 'function') return V6_DENIED;
  try {
    const path = new URL(request.url).pathname;
    const method = String(request.method || 'GET').toUpperCase();
    return normalizeAdmit(await (action ? g.admit(cookie, method, path, { action }) : g.admit(cookie, method, path)), action);
  } catch (e) {
    console.error('[curio-auth] v6 admit failed: ' + (e && e.name ? e.name : 'error'));
    return V6_DENIED;
  }
}

/** 这次请求是经 v6 新会话放进来的吗（requireEntry / requireScope 放行时记下） @param {any} context */
export function viaV6(context) {
  return !!(context && context.data && context.data.via === 'v6');
}

/**
 * root 的特权内容操作留痕（批量 / 结构删除 rm-bulk、导入 / 导出）：只对经 v6 放进来的 root 记，经网关 SpaceVerifier.auditRoot
 * 写进账号侧身份审计（会话在账号 Worker 重新判）。尽力而为，从不抛错。
 * @param {any} context @param {string} command
 */
export async function auditRootOp(context, command) {
  if (!viaV6(context)) return false;
  const v = await v6Of(context);
  if (!v.root) return false;
  const g = context.env && context.env.SPACE;
  if (!g || typeof g.auditRoot !== 'function') return false;
  try {
    return (await g.auditRoot((context.request.headers.get('Cookie') || '').slice(0, 8192), command, context.request.headers.get('CF-Connecting-IP') || '')) === true;
  } catch (e) {
    return false;
  }
}

/**
 * 公开读接口的两个布尔（私密行 / canWrite 提示）：v6 会话按 action 'private' 的档（路由表：= 本站写组）判，够就两样都给。
 * @param {any} context
 * @returns {Promise<{canWrite: boolean, showPrivate: boolean}>}
 */
export async function readAccess(context) {
  const v = await v6Of(context, 'private');
  return { canWrite: v.allowed, showPrivate: v.allowed };
}
