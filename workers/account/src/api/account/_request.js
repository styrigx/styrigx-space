/**
 * /api/account/* 共用的请求处理：进站会话、同源、读 body、客户端地址、兜底 500。
 *
 * 身份只看网关写的规范身份头（lib/gateway.js，白名单校验），不验进站会话：
 * - 进站会话 = X-Styrigx-Lock-Session: 1（没有 → 401 session；各接口的 end 不要求进站会话）
 * - X-Styrigx-Client-Address：输错限速分桶、审计 IP 前缀（没有 → 'unknown'）
 * 这些头只能由网关写：本 Worker 只经命名入口 AccountService 收请求（rpc/account-service.js），默认 fetch 一律 404。
 */
import { isSameOrigin, originDenied, apiError } from '../../lib/http.js';
import { dbReady } from '../../lib/db.js';
import { passedGateway as passedGatewayHeaders, readClientContext } from '../../lib/gateway.js';

/** 有没有进站会话（网关写的结论头） @param {any} request */
export function passedGateway(request) {
  return passedGatewayHeaders(request && request.headers);
}

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
 * 进站会话 + 账号库：通过 → null；否则 401 session / 500 config。
 * @param {Request} request @param {any} env
 */
export function lockDenial(request, env) {
  if (!passedGateway(request)) return apiError(401, 'session');
  if (!dbReady(env)) return apiError(500, 'config');
  return null;
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
