/**
 * APP 通行证签发（sgx-app）。
 *
 * 子站敏感操作（book 上传/删除/换封面）前，owner 在主站完成 stepup 复验后，
 * 由此接口签发短时 sgx-app 通行证，子站用 SGX_APP_PUBLIC 验签。
 *
 * POST /api/app-token
 * - { action: 'issue', aud, scope } → 必须持有有效 sgx-stepup（已完成通行密钥复验）。
 *   签发 sgx-app token：Ed25519(SGX_APP_PRIVATE) 签名，10 分钟有效，
 *   格式：owner.epoch.iat.exp.aud.scope.signature
 *   返回 { ok: true, token }
 *
 * 安全要求：
 * - 必须已登录 owner 会话（verifySessionDetailed）
 * - 必须持有有效 sgx-stepup（verifyStepup from ./stepup.js）
 * - aud 只允许 'book'（白名单）
 * - scope 只允许 'upload'（白名单）
 * - 密码不能用于复验：只认 sgx-stepup，不认密码
 *
 * 环境变量：
 * - SGX_APP_PRIVATE：Ed25519 私钥（PKCS8 PEM），缺失则拒绝签发（500 no-app-key）
 */
import { verifySessionDetailed } from '../_middleware.js';
import { getSessionEpoch, ROLE_OWNER } from '../_kernel/session.js';
import { ed25519Sign } from '../_kernel/crypto.js';
import { verifyStepupCookie as verifyStepup } from './stepup.js';

/* sgx-app token 有效期：10 分钟 */
export const APP_TOKEN_MAX_AGE = 600;

/* 允许的 aud 白名单 */
const ALLOWED_AUD = ['book'];
/* 允许的 scope 白名单 */
const ALLOWED_SCOPE = ['upload'];

/**
 * 签发 sgx-app token。
 * 格式：owner.epoch.iat.exp.aud.scope.Ed25519(SGX_APP_PRIVATE, "owner.epoch.iat.exp.aud.scope")
 * @param {string} privatePem Ed25519 私钥（PKCS8 PEM）
 * @param {number} epoch 当前 session epoch
 * @param {string} aud 目标子站（如 book）
 * @param {string} scope 权限范围（如 upload）
 */
export async function signAppToken(privatePem, epoch, aud, scope) {
  const iat = Date.now();
  const exp = iat + APP_TOKEN_MAX_AGE * 1000;
  const payload = ['owner', epoch, iat, exp, aud, scope].join('.');
  const sig = await ed25519Sign(privatePem, payload);
  return payload + '.' + sig;
}

/**
 * 解析 sgx-app token。
 * @param {string} val
 * @returns {{role:string, epoch:number, iat:number, exp:number, aud:string, scope:string, sig:string}|null}
 */
export function parseAppToken(val) {
  if (!val || typeof val !== 'string') return null;
  const parts = val.split('.');
  if (parts.length !== 7) return null;
  if (parts[0] !== ROLE_OWNER) return null;
  const epoch = parseInt(parts[1], 10);
  const iat = parseInt(parts[2], 10);
  const exp = parseInt(parts[3], 10);
  if (!Number.isFinite(epoch) || !Number.isFinite(iat) || !Number.isFinite(exp)) return null;
  return { role: parts[0], epoch, iat, exp, aud: parts[4], scope: parts[5], sig: parts[6] };
}

export async function onRequest(context) {
  const { request, env } = context;
  
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'method' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
    });
  }

  try {
    // 1. 必须是已登录 owner 会话
    const session = await verifySessionDetailed(request, env.SGX_LOCK_PUBLIC);
    if (!session || session.role !== ROLE_OWNER) {
      return new Response(JSON.stringify({ ok: false, error: 'forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
      });
    }

    // 2. 必须持有有效 sgx-stepup（通行密钥复验，密码不能用于复验）
    const stepup = await verifyStepup(request, env);
    if (!stepup) {
      return new Response(JSON.stringify({ ok: false, error: 'stepup-required' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
      });
    }

    // 3. 解析请求参数
    let body;
    try {
      body = await request.json();
    } catch (e) {
      body = {};
    }
    
    const { action, aud, scope } = body;
    if (action !== 'issue') {
      return new Response(JSON.stringify({ ok: false, error: 'action' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
      });
    }

    // 4. 校验 aud 和 scope 白名单
    if (!ALLOWED_AUD.includes(aud)) {
      return new Response(JSON.stringify({ ok: false, error: 'aud' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
      });
    }
    if (!ALLOWED_SCOPE.includes(scope)) {
      return new Response(JSON.stringify({ ok: false, error: 'scope' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
      });
    }

    // 5. 签发 token
    const privatePem = env.SGX_APP_PRIVATE;
    if (!privatePem) {
      return new Response(JSON.stringify({ ok: false, error: 'no-app-key' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
      });
    }

    const epoch = await getSessionEpoch(env);
    const token = await signAppToken(privatePem, epoch, aud, scope);

    return new Response(JSON.stringify({ ok: true, token }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: 'server' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
    });
  }
}
