/**
 * /api/account/* 共用的请求处理：v6 结论、同源、读 body、客户端地址、兜底 500。
 *
 * v6 P4（定稿 v5.2 §十三）起旧进站会话的身份头（X-Styrigx-Space-*）删除，身份只看 v6 会话（context.auth.v6()）；网关只写客户端上下文头：
 * - X-Styrigx-Client-Address：审计 IP 前缀（没有 → 'unknown'）
 * 这些头只能由网关写：本 Worker 只经命名入口 AccountService 收请求（rpc/account-service.js），默认 fetch 一律 404。
 */
import { isSameOrigin, originDenied, apiError } from '../../lib/http.js';
import { dbReady } from '../../lib/db.js';
import { readClientContext } from '../../lib/gateway.js';
import { ROOT_UID } from '../../core/groups.js';

/** 客户端 IP（网关写的 X-Styrigx-Client-Address）；没有 → 'unknown' @param {any} request */
export function clientAddress(request) {
  return readClientContext(request && request.headers).address || 'unknown';
}

/**
 * 读 POST 请求：方法、同源、JSON。
 * @param {Request} request
 * @returns {Promise<{ok:true, body:any, action:string}|{ok:false, response:Response}>}
 */
export async function readPost(request) {
  if (request.method !== 'POST') return { ok: false, response: apiError(405, 'method') };
  if (!isSameOrigin(request)) return { ok: false, response: originDenied() };
  let body;
  try { body = await request.json(); } catch (e) { return { ok: false, response: apiError(400, 'body') }; }
  const action = body && typeof body.action === 'string' ? body.action : '';
  return { ok: true, body: body || {}, action };
}

/**
 * 包一层：处理函数抛错 → 500 server。
 * @param {(context:any) => Promise<Response>} fn
 */
export function guarded(fn) {
  return async function (context) {
    try {
      return await fn(context);
    } catch (e) {
      return apiError(500, 'server');
    }
  };
}

/**
 * 这个请求的 v6 结论：有 v6 会话且路由档够（auth.v6() 判过）→ 结论；否则 null（调用方 401）。
 * @param {any} context @returns {Promise<any|null>}
 */
export async function v6Admitted(context) {
  const a = context && context.auth;
  if (!a || !a.hasV6 || typeof a.v6 !== 'function') return null;
  const v = await a.v6();
  return v && v.allowed === true && Number.isInteger(v.uid) ? v : null;
}

/** v6 结论 → 审计里记谁（sudo 借来的 root 记真正执行的人） @param {any} v */
export function auditActor(v) {
  const sudo = v.sudo === true && Number.isInteger(v.sudoBy);
  return { uid: sudo ? v.sudoBy : (Number.isInteger(v.uid) ? v.uid : ROOT_UID), suffix: sudo ? ' via sudo' : '' };
}
