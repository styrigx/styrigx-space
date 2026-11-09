// workers/daymark-core/src/api/_auth.js
// 接口鉴权（方案 3.4 R14、4.6；P2-2）：本 Worker 不持任何钥匙，把浏览器带来的 Cookie 头交给主站鉴权网关，
// 问一次结论（服务绑定 env.SPACE → styrigx-space-core 的 RPC 入口 SpaceVerifier 的 conclusion()）：
//   { space: { ok, by, tempkeyId, reason }, account: { ok, deviceId, scopes, reauth, reason } }
// 网关先验门（进站会话），进了门再问账号 Worker（账号会话、作用域、要的话再看账号复验票），只回结论。
// 本文件只认结论：
//   - 进门：space.ok（没进门 401 unauthorized，index.js 统一挡）
//   - 读私密：account.ok（canReadPrivate）
//   - 写：account.ok + 作用域 daymark.write（can / requireScope）；日刻没有要账号复验的接口（方案 4.2）
// 错误码（方案 4.6）：没进门 401 unauthorized；没账号会话 401 account；没作用域 403 scope（带 scope 字段）；
// 要复验没复验 401 reauth；非同源 403 origin（_write.js / 各接口自己查）。
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
