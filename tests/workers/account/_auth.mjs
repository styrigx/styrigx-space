/**
 * 测试用：模拟「浏览器 → 网关 → 账号 Worker」这一跳（账号拆分 PR3）。
 *
 * 线上账号 Worker 只信网关写的身份头：网关验进站会话（verifyLockSession）后剥外部 x-styrigx-* 头、写 X-Styrigx-Lock-* /
 * X-Styrigx-Client-*（writeLockIdentity）。这里用网关真实的这两段代码把测试请求里的锁屏 cookie 换成身份头，
 * 再交给账号 Worker 真实的 headerAuth / serviceFetch——测到的就是线上同一套结论。账号会话只在账号 Worker 自己验。
 * - gatewayHop(request, env)：返回带身份头的新请求（锁屏 cookie 验不过 → 不带身份头）
 * - wrap(handler)：给账号处理函数配上 context.auth（headerAuth），请求先过 gatewayHop
 * - serviceCall(request, env)：gatewayHop + 账号 Worker 的 AccountService（serviceFetch）
 * - testAccountSession / testAccountSessionCookie / testReauthCookie / testResetCookie：用账号 Worker 的签名函数签账号三张票
 */
import './_cf-workers.mjs';
import { verifyLockSession } from '../../../workers/auth-gateway/src/core/lock-session.js';
import { writeLockIdentity } from '../../../workers/auth-gateway/src/core/lock-identity.js';
import { clientContextOf } from '../../../workers/auth-gateway/src/core/forward.js';
import { signSessionTicket } from '../../../workers/account/src/core/session.js';
import { signReauthTicket } from '../../../workers/account/src/core/reauth.js';
import { signResetTicket } from '../../../workers/account/src/core/reset.js';
import { TICKET } from '../../../workers/account/src/core/config.js';
import { TEST_DEVICE_ID } from '../auth-gateway/_tickets.mjs';

/* rpc/*.js 静态 import 了 cloudflare:workers：替身（_cf-workers.mjs）注册好之后再动态 import */
const { headerAuth } = await import('../../../workers/account/src/gate.js');
const { serviceFetch } = await import('../../../workers/account/src/rpc/account-service.js');

/**
 * 网关这一跳：验锁屏 cookie → 写身份头（其余原样）。
 * @param {Request} request @param {any} env 测试 env（锁屏公钥 + 锁屏库放在同一个对象里）
 */
export async function gatewayHop(request, env) {
  const sess = await verifyLockSession(request, env);
  const headers = writeLockIdentity(new Headers(request.headers), sess, clientContextOf(request));
  const out = new Request(request, { headers });
  const cf = /** @type {any} */ (request).cf;
  if (cf) Object.defineProperty(out, 'cf', { value: cf });
  return out;
}

/** @param {Function} handler onRequestGet / onRequestPost … */
export function wrap(handler) {
  return async (ctx) => {
    const request = await gatewayHop(ctx.request, ctx.env);
    return handler({ ...ctx, request, auth: headerAuth(request, ctx.env) });
  };
}

/** @param {Request} request @param {any} env @param {any} [ctx] */
export async function serviceCall(request, env, ctx) {
  return serviceFetch(await gatewayHop(request, env), env, ctx || { waitUntil() {} });
}

/**
 * @param {string} priv SGX_ACCOUNT_PRIVATE @param {string} by password | passkey @param {number} epoch session 纪元 @param {number} authAt
 * @param {number} [now] @param {string} [deviceId]
 */
export function testAccountSession(priv, by, epoch, authAt, now, deviceId) {
  return signSessionTicket(priv, { by, epoch, authAt, now, deviceId: deviceId || TEST_DEVICE_ID });
}
/** @param {string} priv @param {string} by @param {number} epoch @param {number} authAt @param {number} [now] @param {string} [deviceId] */
export async function testAccountSessionCookie(priv, by, epoch, authAt, now, deviceId) {
  return TICKET.session.cookie + '=' + (await testAccountSession(priv, by, epoch, authAt, now, deviceId));
}
/** reauth 票（挂在 deviceId 那个会话上） @param {string} priv @param {string} by @param {number} epoch session 纪元 @param {string} [deviceId] @param {number} [iat] */
export async function testReauthCookie(priv, by, epoch, deviceId, iat) {
  return TICKET.reauth.cookie + '=' + (await signReauthTicket(priv, { by, epoch, deviceId: deviceId || TEST_DEVICE_ID, iat }));
}
/** reset 票 @param {string} priv @param {number} epoch reset 纪元 @param {number} [iat] */
export async function testResetCookie(priv, epoch, iat) {
  return TICKET.reset.cookie + '=' + (await signResetTicket(priv, { epoch, iat }));
}
