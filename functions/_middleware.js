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
import { SESSION_COOKIE } from './_lib/session.js';

/* 读取方 cookie 名（diag 接口用它与写入方对账；必须与 SESSION_COOKIE 一致） */
export const READER_COOKIE_NAME = SESSION_COOKIE;

/* 白名单路径（验证必需 + 锁屏自身 + 静态资源） */
const API_WHITELIST = [
  '/api/owner-auth',
  '/api/owner-password',
  '/api/owner-passkey',
  '/api/owner-status',
  '/api/session-check',
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
 * 取出 Cookie 头里**所有**同名 cookie 的值（2.4.1 dedup：旧版无 Domain 的
 * 主机绑定 sgx-verified 可能和新版带 Domain 的并存，浏览器会把两个都发过来）。
 * @returns {string[]}
 */
function getAllCookies(request, name) {
  const out = [];
  const h = request.headers.get('Cookie') || '';
  for (const part of h.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) out.push(v.join('='));
  }
  return out;
}

/**
 * 站内路径校验（?return= 只收这个）：
 * 必须以 / 开头，且不能是 // 或 /\（防协议相对 URL 和反斜杠 trick）。
 */
export function isSafeReturnPath(ret) {
  return typeof ret === 'string' && ret.length > 0 &&
    ret.charAt(0) === '/' && ret.charAt(1) !== '/' && ret.charAt(1) !== '\\';
}

/**
 * 跨站回跳白名单（?return= 允许的完整 URL）：
 * 只认 https://*.styrigx.com/*（含 apex）。用于 blog/book（含预览子域）
 * 解锁后跳回原站。非 https、一级域名不符、带 @ 或 \\ 的一律不认。
 */
export function isSafeReturnUrl(ret) {
  if (typeof ret !== 'string' || !ret.startsWith('https://')) return false;
  let u;
  try {
    u = new URL(ret);
  } catch (e) {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (host !== 'styrigx.com' && !host.endsWith('.styrigx.com')) return false;
  if (ret.includes('\\')) return false;
  return true;
}

/**
 * ?return= 综合校验：站内路径或白名单跨站 URL。
 */
export function isSafeReturn(ret) {
  return isSafeReturnPath(ret) || isSafeReturnUrl(ret);
}

/**
 * 验证 sgx-verified cookie：epoch.exp.sig
 * 返回 'ok' 或失败原因（no-cookie/bad-format/expired/no-pubkey/bad-sig/
 * kv-error/epoch-low）。
 * 2.4.1 dedup：遍历 Cookie 头里所有同名值，任一验签通过即有效（旧版无
 * Domain 的主机绑定 cookie 可能和新版并存）。
 * @returns {Promise<string>}
 */
export async function verifySessionReason(request, env) {
  const vals = getAllCookies(request, READER_COOKIE_NAME);
  if (!vals.length) return 'no-cookie';
  let reason = 'bad-format';
  for (const val of vals) {
    const r = await verifyOneCookie(val, env);
    if (r === 'ok') return 'ok';
    /* 记录最有信息量的失败原因：优先 bad-sig/expired，其次 bad-format */
    if (reason === 'bad-format' || r !== 'bad-format') reason = r;
  }
  return reason;
}

/**
 * 验签单个 cookie 值。
 * @returns {Promise<string>} 'ok' 或失败原因
 */
async function verifyOneCookie(val, env) {
  const parts = val.split('.');
  if (parts.length !== 3) return 'bad-format';
  const [epochStr, expStr, sig] = parts;
  const exp = parseInt(expStr, 10);
  if (!exp || exp < Date.now()) return 'expired';

  const pubKey = env && env.SGX_ED25519_PUBLIC;
  if (!pubKey) return 'no-pubkey'; /* 未配公钥：fail closed */
  const payload = epochStr + '.' + expStr;
  if (!(await ed25519Verify(pubKey, payload, sig))) return 'bad-sig';

  /* epoch 检查：cookie 的 epoch 必须 >= KV 中的 session-epoch */
  try {
    if (env && env.OWNER_KV) {
      const cur = parseInt(await env.OWNER_KV.get('session-epoch') || '0', 10) || 0;
      const ep = parseInt(epochStr, 10) || 0;
      if (ep < cur) return 'epoch-low';
    }
  } catch (e) {
    return 'kv-error';
  }
  return 'ok';
}

/**
 * 验证会话（布尔版）。每次拒绝都打 [sgx-verify] fail: <原因>
 * （只记原因 + 公钥长度/前缀诊断，绝不记密钥本身和 cookie 值）。
 * @returns {Promise<boolean>}
 */
export async function verifySession(request, env) {
  const reason = await verifySessionReason(request, env);
  if (reason === 'ok') return true;
  const pubKey = (env && env.SGX_ED25519_PUBLIC) || '';
  if (reason === 'no-pubkey') {
    console.log('[sgx-verify] fail: no-pubkey pubkey_len=0');
  } else if (reason === 'bad-sig') {
    /* 只打长度和前缀（能看出是不是 -----BEGIN PUBLIC KEY-----），绝不打密钥本身 */
    console.log('[sgx-verify] fail: bad-sig pubkey_len=' + pubKey.length +
      ' pubkey_prefix=' + JSON.stringify(pubKey.slice(0, 27)));
  } else {
    console.log('[sgx-verify] fail: ' + reason);
  }
  return false;
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
    /* ?return= 回跳：站内路径（isSafeReturnPath）或 *.styrigx.com 白名单 URL
       （isSafeReturnUrl，供 blog/book 及预览子域跨站回跳）。非法 → 一律回首页 /。 */
    const returnPath = url.searchParams.get('return');
    if (returnPath && pathname === '/') {
      if (await verifySession(request, env)) {
        /* 手动构造 302（不用 Response.redirect：Node/undici 不接受相对路径，
           Workers 可以；手动写兼容两边） */
        const loc = isSafeReturn(returnPath) ? returnPath : '/';
        return new Response(null, {
          status: 302,
          headers: { 'Location': loc },
        });
      }
    }

    if (await verifySession(request, env)) {
      const res = await next();
      /* 2.4.1：受保护 HTML 页面防浏览器缓存绕过锁屏。
         只改 text/html，静态资源保持原缓存策略。 */
      const ct = res.headers.get('Content-Type') || '';
      if (ct.includes('text/html')) {
        const headers = new Headers(res.headers);
        headers.set('Cache-Control', 'private, no-store');
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers,
        });
      }
      return res;
    }
    if (isWhitelisted(pathname)) {
      return next();
    }
    /* 未验证的 /api/* 请求：返回 401 JSON，不 302（前端按 API 约定处理） */
    if (pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ ok: false }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
    /* 未验证：302 到首页锁屏，return 带站内路径（设计文档 §2.3）。
       首页有完整锁屏 UI（密码/通行密钥/Turnstile），解锁后跳回原内页。
       no-store：绝不缓存这个跳转。 */
    const dest = 'https://styrigx.com/?lock=1&return=' + encodeURIComponent(url.pathname + url.search);
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
