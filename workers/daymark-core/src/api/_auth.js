// workers/daymark-core/src/api/_auth.js
// 接口鉴权（方案 3.4 R14、4.6；P2-2）：本 Worker 不持任何钥匙，把浏览器带来的 Cookie 头交给主站鉴权网关，
// 问一次结论（服务绑定 env.SPACE → styrigx-space-core 的 RPC 入口 SpaceVerifier 的 conclusion()）：
//   { space: { ok, by, linkId, reason }, account: { ok, deviceId, scopes, reauth, reason } }
// 网关先验门（进站会话），进了门再问账号 Worker（账号会话、作用域、要的话再看账号复验票），只回结论。
// 本文件只认结论：
//   - 两档守卫（v5 S3，GUARDS；index.js 按 routes.js ROUTE_ACCESS 套用）：publicRead（不拒绝）· requireEntry（space.ok，否则 401 unauthorized）
//   - 读私密：account.ok（canReadPrivate）
//   - 写：account.ok + 作用域 daymark.write（can / requireScope）；日刻没有要账号复验的接口（方案 4.2）
// 错误码（方案 4.6）：没进门 401 unauthorized；没账号会话 401 account；没作用域 403 scope（带 scope 字段）；
// 要复验没复验 401 reauth；非同源 403 origin（_write.js / 各接口自己查）。
// 割接（v6）：旧会话不够时再问 v6 新会话（文件末尾 v6Of / readAccess / auditRootOp；判断在账号 Worker，经网关 SpaceVerifier.admit）。
// fail closed：回答格式不对一律当未通过。绑定缺失或网关出错直接抛错（调用方回 500），
// 不回 401——401 会让前端当成「已锁定」去刷新页面，网关临时故障不该把人踢去锁屏。
import { err, json } from './_lib.js';

/** 本站的写作用域（账号作用域表在账号 Worker，这里只认字符串） */
export const SCOPE_WRITE = 'daymark.write';

const SCOPE_RE = /^[a-z]+\.[a-z]+$/;
const MAX_UA = 512;

function gateway(env) {
  const a = env && env.SPACE;
  return a && typeof a.conclusion === 'function' ? a : null;
}

/** 转给网关的客户端上下文（账号设备 lastSeen / 地点用）：User-Agent、cf 国家城市 */
function clientContextOf(request) {
  const m = {};
  const ua = request.headers.get('User-Agent');
  if (ua) m.ua = ua.slice(0, MAX_UA);
  const cf = request.cf || {};
  if (typeof cf.country === 'string' && cf.country) m.country = cf.country;
  if (typeof cf.city === 'string' && cf.city) m.city = cf.city;
  return m;
}

/** 没有任何权限的结论 */
export const DENIED = Object.freeze({
  space: Object.freeze({ ok: false }),
  account: Object.freeze({ ok: false, scopes: Object.freeze([]), reauth: false }),
});

/**
 * 网关回答 → 本 Worker 用的结论（白名单）：space.ok / account.ok / account.reauth 只认 true；
 * scopes 只留合格式的字符串；space.ok 不是 true 时账号部分一律当没有（进门是前置）。
 * @param {any} r
 * @returns {{space:{ok:boolean}, account:{ok:boolean, scopes:string[], reauth:boolean}}}
 */
export function normalizeConclusion(r) {
  const lockOk = !!(r && r.space && r.space.ok === true);
  if (!lockOk) return DENIED;
  const a = r.account;
  const accOk = !!(a && a.ok === true && Array.isArray(a.scopes));
  if (!accOk) return { space: { ok: true }, account: DENIED.account };
  const scopes = a.scopes.filter((s) => typeof s === 'string' && SCOPE_RE.test(s));
  return { space: { ok: true }, account: { ok: true, scopes, reauth: a.reauth === true } };
}

/**
 * 问网关要结论；绑定缺失或网关出错抛错。
 * @param {Request} request
 * @param {Record<string, any>} env
 * @param {{reauth?: boolean}} [opts] 只有要账号复验结论的接口才传 reauth: true
 */
export async function askConclusion(request, env, opts) {
  const auth = gateway(env);
  if (!auth) {
    console.error('[daymark-auth] SPACE binding missing');
    throw new Error('auth-binding-missing');
  }
  const want = { reauth: !!(opts && opts.reauth === true) };
  const r = await auth.conclusion(request.headers.get('Cookie') || '', clientContextOf(request), want);
  return normalizeConclusion(r);
}

/**
 * 本次请求的结论：index.js 已经问过网关（结果放在 context.data.conclusion）就直接用，每个请求只问一次；
 * 没有（单测直接调 handler 等），或这次要复验结论而之前没问复验，才自己问（并放回 context.data）。
 * @param {{request: Request, env: Record<string, any>, data?: Record<string, any>}} context
 * @param {{reauth?: boolean}} [opts]
 */
export async function conclusionOf(context, opts) {
  const d = context && context.data;
  const wantReauth = !!(opts && opts.reauth === true);
  if (d && d.conclusion && (!wantReauth || d.conclusionReauth === true)) return d.conclusion;
  const c = await askConclusion(context.request, context.env, { reauth: wantReauth });
  if (d) {
    d.conclusion = c;
    d.conclusionReauth = wantReauth;
  }
  return c;
}

/** 能看私密内容吗：账号会话有效 */
export function canReadPrivate(c) {
  return !!(c && c.space && c.space.ok === true && c.account && c.account.ok === true);
}

/** 有这个作用域吗：账号会话有效 + 已授权该作用域 */
export function can(c, scope) {
  return canReadPrivate(c) && Array.isArray(c.account.scopes) && c.account.scopes.includes(scope);
}

/**
 * 要求作用域（方案 4.6）：通过 → { response: null, conclusion }；否则 { response: 错误 }。
 * 顺序：没进门 401 unauthorized → 没账号会话 401 account → 没作用域 403 scope → 要复验没复验 401 reauth。
 * @param {any} context
 * @param {string} scope
 * @param {{reauth?: boolean}} [opts]
 */
export async function requireScope(context, scope, { reauth = false } = {}) {
  const c = await conclusionOf(context, { reauth });
  if (can(c, scope) && (!reauth || c.account.reauth === true)) return { response: null, conclusion: c };
  /* 割接：旧会话不够时，v6 新会话的路由档够（账号 Worker 判）就放行；有 v6 身份但档不够 → 403 forbidden */
  const v = await v6Of(context);
  if (v.allowed) { context.data.via = 'v6'; return { response: null, conclusion: c }; }
  if (v.signedIn) return { response: err('forbidden', 403) };
  if (!c.space.ok) return { response: err('unauthorized', 401) };
  if (!c.account.ok) return { response: err('account', 401) };
  if (!can(c, scope)) return { response: json({ ok: false, error: 'scope', scope }, 403) };
  if (reauth && c.account.reauth !== true) return { response: err('reauth', 401) };
  return { response: null, conclusion: c };
}

/** 响应里的两个布尔（方案 3.4 R14：代替旧的等级字段） */
export function visibility(c) {
  return { canWrite: can(c, SCOPE_WRITE), showPrivate: canReadPrivate(c) };
}

/* ---------- 两档守卫（v5 S3；routes.js ROUTE_ACCESS 的 public / entry，index.js handle 套用） ---------- */

/** public：谁都能调，不拒绝、不问网关（要私密行 / canWrite 的 handler 自己 conclusionOf） @returns {Promise<null>} */
export async function publicRead() {
  return null;
}

/** entry：要进站会话（password / passkey / link 任一种）；没进门 401 unauthorized @param {any} context */
export async function requireEntry(context) {
  const c = await conclusionOf(context);
  if (c.space.ok) return null;
  /* 割接：没有旧进站会话时，v6 新会话的路由档够（账号 Worker 判）就进；有 v6 身份但档不够 → 403 forbidden */
  const v = await v6Of(context);
  if (v.allowed) { context.data.via = 'v6'; return null; }
  return v.signedIn ? err('forbidden', 403) : err('unauthorized', 401);
}

/** 档名 → 守卫 */
export const GUARDS = Object.freeze({ public: publicRead, entry: requireEntry });

/* ---------- v6 新会话（割接，ADR-0006；新旧并存，旧会话的判定上面原样不动） ----------
 * 浏览器带了 sgx-session、旧会话又不够时，经网关 SpaceVerifier.admit 问账号 Worker「这个新会话能不能走这条路由」
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
    console.error('[daymark-auth] v6 admit failed: ' + (e && e.name ? e.name : 'error'));
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
 * 公开读接口的两个布尔（私密行 / canWrite 提示）：旧会话照旧（visibility）；旧会话看不到私密行时，v6 新会话按 action 'private'
 * 的档（路由表：= 本站写组）判，够就两样都给。
 * @param {any} context
 * @returns {Promise<{canWrite: boolean, showPrivate: boolean}>}
 */
export async function readAccess(context) {
  const vis = visibility(await conclusionOf(context));
  if (vis.canWrite && vis.showPrivate) return vis;
  const v = await v6Of(context, 'private');
  return v.allowed ? { canWrite: true, showPrivate: true } : vis;
}
