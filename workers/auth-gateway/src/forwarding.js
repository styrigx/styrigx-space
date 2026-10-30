/**
 * @fileoverview 网关转发表（账号拆分 PR3，方案第 4 节）：这些路径归网关（styrigx.com/* 整站路由），middleware 先验门，
 * 放行后经服务绑定原样转给账号 Worker styrigx-account（ACCOUNT = AccountService），网关路由表 src/routes.js 里不再有它们。
 *
 * | 路径            | 绑定    | 门（_middleware.js 先验）                                         |
 * |-----------------|---------|-------------------------------------------------------------------|
 * | /api/account    | ACCOUNT | ADMIN_ONLY_APIS；无会话 401                                         |
 * | /api/prefs*     | ACCOUNT | ADMIN_ONLY_APIS（从账号 Worker 的 gate.js 收回）                     |
 * | /api/avatar*    | ACCOUNT | 有会话；PUT / DELETE 在账号 Worker 里查 role=admin                  |
 * | /api/wellbeing* | ACCOUNT | 有会话（访客 POST 204，同现状）                                      |
 * | /avatar/*       | ACCOUNT | 公开（AVATAR_FILE_RE 已在白名单）                                    |
 *
 * 匹配：/api/* 条目 = 路径本身或其子路径（p 或 p + '/…'，与 _middleware.js isAdminOnlyApi 同一规则，门和转发永远对得上；
 * /api/prefsX 这类不转发，落到网关路由表 → 404）；/avatar/ = 前缀。
 * 转发时用浏览器的原请求构造（URL 仍是 styrigx.com、Origin / Cookie 原样，账号侧 isSameOrigin 成立），见 _kernel/forward.js forwardToService。
 * 表里的路径只转发：没绑定 ACCOUNT 或绑定出错 → 503 upstream（src/index.js forward），不落回网关路由表、不回源静态文件。
 * scripts/check-worker-routes.mjs 和单测都读这张表。
 */
/** @typedef {{path:string, binding:string, gate:'admin'|'session'|'public'}} ForwardRule */

/** @type {ReadonlyArray<Readonly<ForwardRule>>} */
export const FORWARDING = Object.freeze([
  Object.freeze({ path: '/api/account', binding: 'ACCOUNT', gate: 'admin' }),
  Object.freeze({ path: '/api/prefs', binding: 'ACCOUNT', gate: 'admin' }),
  Object.freeze({ path: '/api/avatar', binding: 'ACCOUNT', gate: 'session' }),
  Object.freeze({ path: '/api/wellbeing', binding: 'ACCOUNT', gate: 'session' }),
  Object.freeze({ path: '/avatar/', binding: 'ACCOUNT', gate: 'public' }),
]);

/**
 * 这个路径归哪条转发规则；不在表里 → null。
 * @param {string} pathname
 * @returns {Readonly<ForwardRule>|null}
 */
export function matchForwarding(pathname) {
  const p = String(pathname || '');
  for (const r of FORWARDING) {
    if (r.path.endsWith('/') ? p.startsWith(r.path) : (p === r.path || p.startsWith(r.path + '/'))) return r;
  }
  return null;
}

export { forwardToService, stripRequest, clientContextOf } from '../functions/_kernel/forward.js';
