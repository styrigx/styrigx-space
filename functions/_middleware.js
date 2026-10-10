/**
 * 2.4.1 三站真实锁屏 - 主站 middleware（SGX_SITE=space）
 *
 * 1. 域名隔离：生产环境只允许 styrigx.com 访问（保留 P0-3 逻辑）
 * 2. 会话检查：sgx-verified cookie（Ed25519 签名，epoch.exp.sig）
 *    - 有效 → next()
 *    - 无效 → 白名单放行，否则 302 到首页锁屏（?lock=1&return=原地址）
 * 3. verifySession 每次拒绝都打 [sgx-verify] fail: <原因> 日志（只记原因，
 *    不记密钥和 cookie 值），用于线上排查会话未被识别的问题。
 */

import { ed25519Verify } from './_lib/crypto.js';

/* 白名单路径（验证必需 + 锁屏自身 + 静态资源） */
const API_WHITELIST = [
  '/api/owner-auth',
  '/api/owner-password',
  '/api/owner-passkey',
  '/api/owner-status',
  '/api/session-epoch',
  '/api/verify',
  '/api/geo',
];
const PAGE_WHITELIST = ['/', '/en/', '/en'];
const STATIC_RE = /\.(css|js|woff2|woff|ttf|png|svg|ico|json|xml|webmanifest)$/i;

function isWhitelisted(pathname) {
  if (PAGE_WHITELIST.includes(pathname)) return true;
  if (pathname.startsWith('/?lock=1') || pathname.startsWith('/en/?lock=1')) return true;
  if (pathname.startsWith('/api/')) {
    return API_WHITELIST.some(p => pathname === p || pathname.startsWith(p + '/') || pathname.startsWith(p + '?'));
  }
  if (pathname.startsWith('/assets/')) return true;
  if (pathname === '/favicon.ico' || pathname === '/robots.txt' || pathname === '/sitemap.xml') return true;
  if (STATIC_RE.test(pathname)) return true;
  return false;
}

function getCookie(request, name) {
  const h = request.headers.get('Cookie') || '';
  for (const part of h.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

/**
 * 验证 sgx-verified cookie：epoch.exp.sig
 * @returns {Promise<boolean>}
 */
async function verifySession(request, env) {
  const val = getCookie(request, 'sgx-verified');
  if (!val) { console.log('[sgx-verify] fail: no-cookie'); return false; }
  const parts = val.split('.');
  if (parts.length !== 3) { console.log('[sgx-verify] fail: bad-format'); return false; }
  const [epochStr, expStr, sig] = parts;
  const exp = parseInt(expStr, 10);
  if (!exp || exp < Date.now()) { console.log('[sgx-verify] fail: expired'); return false; }

  const pubKey = env && env.SGX_ED25519_PUBLIC;
  if (!pubKey) { console.log('[sgx-verify] fail: no-pubkey'); return false; } /* 未配公钥：fail closed */
  const payload = epochStr + '.' + expStr;
  if (!(await ed25519Verify(pubKey, payload, sig))) { console.log('[sgx-verify] fail: bad-sig'); return false; }

  /* epoch 检查：cookie 的 epoch 必须 >= KV 中的 session-epoch */
  try {
    if (env && env.OWNER_KV) {
      const cur = parseInt(await env.OWNER_KV.get('session-epoch') || '0', 10) || 0;
      const ep = parseInt(epochStr, 10) || 0;
      if (ep < cur) { console.log('[sgx-verify] fail: epoch-low'); return false; }
    }
  } catch (e) {
    console.log('[sgx-verify] fail: kv-error');
    return false;
  }
  return true;
}

/** @param {any} context */
export async function onRequest(context) {
  const { request, next, env } = context;
  const url = new URL(request.url);
  const host = url.hostname;
  const pathname = url.pathname;

  /* 只在生产环境启用 */
  const isProd = (env && env.SGX_ENV === 'production') || host === 'styrigx.com' || host === 'www.styrigx.com';

  if (isProd) {
    if (host === 'www.styrigx.com') {
      url.hostname = 'styrigx.com';
      return Response.redirect(url.toString(), 301);
    }
    if (host !== 'styrigx.com') {
      if (pathname.startsWith('/api/')) {
        return new Response('Forbidden', { status: 403 });
      }
      url.protocol = 'https:';
      url.hostname = 'styrigx.com';
      return Response.redirect(url.toString(), 301);
    }
  }

  /* 2.4.1：会话检查（生产环境 space 站点一律执行；缺 SGX_ED25519_PUBLIC 时
     verifySession 直接返回 false → fail closed，只放白名单路径。
     没有「未配置就放行」开关。） */
  const site = env && env.SGX_SITE;
  if (isProd && (!site || site === 'space')) {
    /* 处理 ?return= 参数（从 blog/book 跳转回来验证通过后）：
       只允许 https 协议，主机名必须是 styrigx.com 或 *.styrigx.com */
    const returnUrl = url.searchParams.get('return');
    if (returnUrl && pathname === '/') {
      try {
        const r = new URL(returnUrl);
        if (
          r.protocol === 'https:' &&
          (r.hostname === 'styrigx.com' || r.hostname.endsWith('.styrigx.com'))
        ) {
          /* return 合法，但仍需有效会话才放行 */
          if (await verifySession(request, env)) {
            return Response.redirect(returnUrl, 302);
          }
        }
      } catch (e) {}
    }

    if (await verifySession(request, env)) {
      return next();
    }
    if (isWhitelisted(pathname)) {
      return next();
    }
    /* 未验证：302 到首页锁屏，带 return 回跳（设计文档 §2.3）。
       首页有完整锁屏 UI（密码/通行密钥/Turnstile），解锁后跳回原内页。
       no-store：绝不缓存这个跳转。 */
    const dest = 'https://styrigx.com/?lock=1&return=' + encodeURIComponent(url.toString());
    return new Response(null, {
      status: 302,
      headers: {
        'Location': dest,
        'Cache-Control': 'no-store',
      },
    });
  }

  return next();
}
