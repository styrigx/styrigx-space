/**
 * APP 通行证签发（sgx-app）。
 *
 * 子站敏感操作（book 上传/删除/换封面）前，owner 在主站完成 stepup 复验后，
 * 由此接口签发短时 sgx-app 通行证，子站用 SGX_APP_PUBLIC 验签。
 *
 * 【book 获取通行证的方式：不开 CORS，用页面跳转】
 * 1. book 跳转到主站复验页：https://styrigx.com/app-verify/?aud=book&scope=upload&return=<book-url>
 * 2. 主站校验 return 白名单（只允许 https://book.styrigx.com/ 开头），不通过则拒绝
 * 3. 用户在主站完成通行密钥（passkey）复验 → 持有有效 sgx-stepup
 * 4. 主站设置 sgx-app cookie：Domain=.styrigx.com; HttpOnly; Secure; SameSite=Lax; Max-Age=600
 * 5. 跳回 book 的 return URL；book 后端从请求 cookie 中验签
 *
 * POST /api/app-token
 * - { action: 'issue', aud, scope, return } → 必须持有有效 sgx-stepup。
 *   签发后设置 sgx-app cookie 并返回 { ok: true }（不再在 body 里返回 token，
 *   避免 book 前端需要跨域读取）。
 *
 * 安全要求：
 * - 必须已登录 owner 会话
 * - 必须持有有效 sgx-stepup（通行密钥复验；密码不能用于复验）
 * - aud 白名单：仅 'book'；scope 白名单：仅 'upload'
 * - return 白名单：仅 https://book.styrigx.com/ 开头
 * - 缺 stepup 时不设 cookie
 *
 * 环境变量：
 * - SGX_APP_PRIVATE：Ed25519 私钥（PKCS8 PEM），缺失则拒绝签发（500 no-app-key）
 *   由 Gray 在 Cloudflare Pages space 项目里配成 Secret，本仓库不生成、不提交、不打印
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
/* return URL 白名单：origin 必须严格等于 https://book.styrigx.com */
const ALLOWED_RETURN_ORIGIN = 'https://book.styrigx.com';
/* 缺 return 时的默认跳转 */
const DEFAULT_RETURN = 'https://book.styrigx.com/';

/**
 * 校验 return URL：用 new URL 解析，要求 origin 严格等于白名单。
 * @param {string} returnUrl
 * @returns {string|null} 合法的 return URL，或 null（不合法）
 */
export function validateReturnUrl(returnUrl) {
  if (!returnUrl) return DEFAULT_RETURN;
  try {
    const u = new URL(returnUrl);
    if (u.origin !== ALLOWED_RETURN_ORIGIN) return null;
    return returnUrl;
  } catch (e) {
    return null;
  }
}

/* sgx-app cookie 定义 */
export const APP_COOKIE = 'sgx-app';
export const APP_COOKIE_ATTRS = 'Domain=.styrigx.com; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600';

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
    // 0. CSRF 防护：Origin 必须为 https://styrigx.com，且 Content-Type 为 application/json
    const origin = request.headers.get('Origin');
    const contentType = request.headers.get('Content-Type') || '';
    if (origin !== 'https://styrigx.com') {
      return new Response(JSON.stringify({ ok: false, error: 'origin' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
      });
    }
    if (!contentType.includes('application/json')) {
      return new Response(JSON.stringify({ ok: false, error: 'content-type' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
      });
    }

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
    
    const { action, aud, scope, return: returnUrl } = body;
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

    // 5. 校验 return（origin 严格等于 https://book.styrigx.com；缺省跳默认页）
    const validReturn = validateReturnUrl(returnUrl);
    if (!validReturn) {
      return new Response(JSON.stringify({ ok: false, error: 'return' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
      });
    }

    // 6. 签发 token（SGX_APP_PRIVATE 由 Gray 在 Cloudflare 后台配成本仓库不接触）
    const privatePem = env.SGX_APP_PRIVATE;
    if (!privatePem) {
      return new Response(JSON.stringify({ ok: false, error: 'no-app-key' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
      });
    }

    const epoch = await getSessionEpoch(env);
    const token = await signAppToken(privatePem, epoch, aud, scope);

    // 7. 设置 sgx-app cookie（Domain=.styrigx.com，book 后端可读），不再在 body 返回 token
    return new Response(JSON.stringify({ ok: true, return: validReturn }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'private, no-store',
        'Set-Cookie': `${APP_COOKIE}=${token}; ${APP_COOKIE_ATTRS}`,
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: 'server' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
    });
  }
}
