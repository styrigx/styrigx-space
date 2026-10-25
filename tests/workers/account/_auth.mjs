/**
 * 测试用：给账号 Worker 的处理函数配上「问网关」的 context.auth。
 * 网关这一侧用真实的 verifier.js（checkLockSession / checkAccountSession，同 AuthVerifier RPC 里跑的代码），
 * 所以这里测到的会话判断和线上经服务绑定得到的结论是同一套逻辑。
 */
import { authFor } from '../../../workers/account/src/auth.js';
import { checkLockSession, checkAccountSession } from '../../../workers/auth-gateway/src/verifier.js';

/** 网关 AuthVerifier 的替身：同样的函数、同样的 env（钥匙 + 认证库） @param {any} gwEnv */
export function gatewayVerifier(gwEnv) {
  return {
    lockSession: (cookie) => checkLockSession(cookie, gwEnv),
    accountSession: (cookie, meta) => checkAccountSession(cookie, gwEnv, meta),
  };
}

/**
 * 包一层：ctx.env 同时当网关的 env 用（测试里钥匙、认证库、账号库放在一个对象里）。
 * @param {Function} handler onRequestGet / onRequestPost …
 */
export function wrap(handler) {
  return (ctx) => handler({ ...ctx, auth: authFor(ctx.request, { AUTH: gatewayVerifier(ctx.env) }) });
}
