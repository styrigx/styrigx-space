// workers/daymark-core/src/api/_auth.js
// 接口鉴权（v6 P4，定稿 v5.3 §十二）：本 Worker 不持任何钥匙，只认 v6 会话（sgx-session）。
// 经网关 SpaceVerifier.admit 问账号 Worker「这个会话能不能走这条路由」（路由表 ROUTE_ACCESS + permits 只在账号 Worker），本文件只认结论：
//   - 两档守卫（v5 S3，GUARDS；index.js 按 routes.js ROUTE_ACCESS 套用）：publicRead（不拒绝）· requireEntry（按路由表的档问 admit）
//   - 写：requireScope（同上）；读私密：readAccess（action 'private' 的档）
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

/* ---------- 两档守卫（v5 S3；routes.js ROUTE_ACCESS 的 public / entry，index.js handle 套用） ---------- */

/** public：谁都能调，不拒绝、不问网关（要私密行 / canWrite 的 handler 自己 readAccess） @returns {Promise<null>} */
export async function publicRead() {
  return null;
}

/** entry：按路由表的档问 v6（没有身份 401 unauthorized，档不够 403 forbidden） @param {any} context */
export async function requireEntry(context) {
  return (await requireScope(context)).response;
}

/** 档名 → 守卫 */
export const GUARDS = Object.freeze({ public: publicRead, entry: requireEntry });

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
  /* D-3 a′：带 X-Sgx-Sudo 头的请求只按这张一次性票判（每个请求只核销一次；票对不上就拒，不退回会话本身的档） */
  if (context.request && context.request.headers && context.request.headers.has(SUDO_HEADER)) {
    if (!d.sudo) d.sudo = askSudo(context.request, context.env);
    return d.sudo.then((s) => (!action || action === 'private' || action === s.action ? s.v : s.denied));
  }
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
    console.error('[daymark-auth] v6 admit failed: ' + (e && e.name ? e.name : 'error'));
    return V6_DENIED;
  }
}

/* ---------- D-3 a′：一次性 sudo 票（偏离稿 v3.12 第 9 节） ----------
 * root 档的接口（导出 / 导入 / 删专辑 / 删专题），sudoers 先在账号 Worker 验自己的凭据领票（POST /api/identity sudo-grant），
 * 再带 X-Sgx-Sudo: <票> 发这一次真请求；这里经网关 SpaceVerifier.sudoAdmit 交账号 Worker 核销（绑会话 + 方法 + 路径 + action，只能用一次）。
 * 本 Worker 不见凭据；票不进日志（出错只记错误名）。 */

/** 票的请求头 */
export const SUDO_HEADER = 'X-Sgx-Sudo';
const SUDO_TICKET_RE = /^[A-Za-z0-9_-]{43}$/;

/** @param {Request} _request @param {string} _key 日刻的票不绑 body 里的 action */
async function sudoActionOf(_request, _key) {
  return '';
}

/**
 * 核销这张票 → { v: 结论, action: 票绑的 action, denied: 别的 action 的结论 }。票对得上 → root（uid 0，sudo）；否则拒
 * （有会话 cookie 的回 403，没有的 401）。
 * @param {Request} request @param {Record<string, any>} env
 */
async function askSudo(request, env) {
  const cookie = (request.headers.get('Cookie') || '').slice(0, 8192);
  const signed = V6_COOKIE_RE.test(cookie);
  const no = signed ? Object.freeze({ allowed: false, signedIn: true, uid: null, root: false }) : V6_DENIED;
  const fail = (/** @type {string} */ action) => ({ v: no, action, denied: no });
  const ticket = request.headers.get(SUDO_HEADER) || '';
  if (!signed || !SUDO_TICKET_RE.test(ticket)) return fail('');
  const path = new URL(request.url).pathname;
  const method = String(request.method || 'GET').toUpperCase();
  const action = await sudoActionOf(request, method + ' ' + path);
  if (action === null) return fail('');
  const g = env && env.SPACE;
  if (!g || typeof g.sudoAdmit !== 'function') return fail(action);
  try {
    const r = await g.sudoAdmit(cookie, ticket, method, path, action ? { action } : {});
    const ok = !!(r && typeof r === 'object' && r.allowed === true && r.root === true && r.sudo === true && r.uid === 0 && r.action === action);
    if (!ok) return fail(action);
    return { v: Object.freeze({ allowed: true, signedIn: true, uid: 0, root: true, sudo: true }), action, denied: no };
  } catch (e) {
    console.error('[daymark-auth] sudo admit failed: ' + (e && e.name ? e.name : 'error'));
    return fail(action);
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
  if (v.sudo === true) return false; /* D-3 a′：经票进来的，发票时账号 Worker 已记 sudo <方法> <路径> [action] */
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
