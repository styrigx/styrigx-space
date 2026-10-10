/**
 * 2.4.1 三站真实锁屏 - 主站 middleware（SGX_SITE=space）
 *
 * 1. 域名隔离：生产环境只允许 styrigx.com 访问（保留 P0-3 逻辑）
 * 2. 会话检查：sgx-verified cookie（Ed25519 签名，epoch.exp.sig）
 *    - 有效 → next()
 *    - 无效 → 白名单放行，否则返回锁屏页 HTML（200，不 302）
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
  if (!val) return false;
  const parts = val.split('.');
  if (parts.length !== 3) return false;
  const [epochStr, expStr, sig] = parts;
  const exp = parseInt(expStr, 10);
  if (!exp || exp < Date.now()) return false;

  const pubKey = env && env.SGX_ED25519_PUBLIC;
  if (!pubKey) return false; /* 未配公钥：fail closed */
  const payload = epochStr + '.' + expStr;
  if (!(await ed25519Verify(pubKey, payload, sig))) return false;

  /* epoch 检查：cookie 的 epoch 必须 >= KV 中的 session-epoch */
  try {
    if (env && env.OWNER_KV) {
      const cur = parseInt(await env.OWNER_KV.get('session-epoch') || '0', 10) || 0;
      const ep = parseInt(epochStr, 10) || 0;
      if (ep < cur) return false;
    }
  } catch (e) {
    return false;
  }
  return true;
}

/** 锁屏页 HTML（不含正文） */
function lockScreenHtml(isEn) {
  const title = isEn ? 'Locked' : '已锁定';
  const msg = isEn ? 'Please verify to continue' : '请验证以继续';
  return `<!DOCTYPE html><html lang="${isEn ? 'en' : 'zh'}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${title}</title></head><body>` +
    `<div id="sgx-lock-screen" data-msg="${msg}"></div>` +
    `<script src="/assets/js/sgx/lock.js"></script>` +
    `</body></html>`;
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
    /* 未验证：只返回锁屏，不返回正文 */
    const isEn = pathname.startsWith('/en/');
    return new Response(lockScreenHtml(isEn), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  return next();
}
