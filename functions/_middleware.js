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

import { ed25519Verify } from './_kernel/crypto.js';
import { SESSION_COOKIE, ROLE_OWNER, ROLE_VISITOR } from './_kernel/session.js';
import { isPublicPage } from './_kernel/public-pages.js';

/* 2.8.0 会话角色分离：主人专属路径（visitor 访问 → 302 到锁屏） */
const OWNER_ONLY_PATHS = [
  '/settings/',
  '/en/settings/',
  '/files/',
  '/en/files/',
];
/* 2.8.0：主人专属 API（visitor 调用 → 403） */
const OWNER_ONLY_APIS = [
  '/api/owner-password',
  '/api/owner-passkey',
  '/api/lock-all-devices',
];
/* 认证类 action（visitor 可调用，用于升级为 owner） */
const AUTH_ACTIONS = new Set(['verify', 'challenge', 'register', 'auth']);

function isOwnerOnlyPath(pathname) {
  return OWNER_ONLY_PATHS.some(p => pathname === p || pathname.startsWith(p));
}

function isOwnerOnlyApi(pathname) {
  return OWNER_ONLY_APIS.some(p => pathname === p || pathname.startsWith(p + '/'));
}

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
const PAGE_WHITELIST = [];
const STATIC_RE = /\.(css|js|woff2|woff|ttf|png|svg|ico|json|xml|webmanifest)$/i;
/* 锁屏头像：Hugo 把 images/avatar.png 转成 /images/avatar_hu_<hash>_*.webp/avif。
   只放行 avatar_ 开头的 webp/avif（锁屏用），其他图片仍要先解锁。 */
const AVATAR_RE = /^\/images\/avatar_.*\.(webp|avif)$/i;
/* 首页由 L1 特殊处理（见下）：始终返回页面并注入 data-sgx-session，不再走白名单 */

function isWhitelisted(pathname) {
  if (PAGE_WHITELIST.includes(pathname)) return true;
  if (pathname.startsWith('/?lock=1') || pathname.startsWith('/en/?lock=1')) return true;
  if (pathname.startsWith('/api/')) {
    return API_WHITELIST.some(p => pathname === p || pathname.startsWith(p + '/') || pathname.startsWith(p + '?'));
  }
  if (pathname.startsWith('/assets/')) return true;
  if (pathname === '/favicon.ico' || pathname === '/robots.txt' || pathname === '/sitemap.xml') return true;
  if (AVATAR_RE.test(pathname)) return true;
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
  if (typeof ret !== 'string' || ret.length === 0) return false;
  if (ret.charAt(0) !== '/' || ret.charAt(1) === '/' || ret.charAt(1) === '\\') return false;
  /* 2.8.0：/lock/ 登录后无页面，解锁后回跳一律回首页（防 404） */
  if (ret === '/lock/' || ret.startsWith('/lock/?') || ret.startsWith('/lock/#')) return false;
  return true;
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
 * L1 向 HTML 注入会话状态（2.4.1 分层规范）。
 * 把 <html> 变成 <html data-sgx-session="valid|locked" data-sgx-role="owner|visitor">，
 * 前端只读这个，不自己猜。
 * 同时设置 Cache-Control: private, no-store（防浏览器缓存绕过锁屏）。
 * 非 HTML 响应原样返回。
 * @param {Response} res
 * @param {'valid'|'locked'} state
 * @param {string|null} role 'owner'|'visitor'|null
 */
export async function injectSessionState(res, state, role) {
  const ct = res.headers.get('Content-Type') || '';
  if (!ct.includes('text/html')) return res;
  let html = await res.text();
  /* 2.8.0 锁屏瘦身：锁屏态不下发桌面内容（书单、歌单、小组件等），
     只保留锁屏需要的部分（导航、头像、脚本）。 */
  if (state === 'locked') {
    html = html.replace(/<!-- SGX-DESKTOP-START -->[\s\S]*?<!-- SGX-DESKTOP-END -->/g, '');
  }
  let injected = html.replace(/<html(\s|>)/i, '<html data-sgx-session="' + state + '"$1');
  /* 2.8.0：注入角色供 UI 展示（UI 不做鉴权） */
  if (role === ROLE_OWNER || role === ROLE_VISITOR) {
    injected = injected.replace(/<html(\s|>)/i, '<html data-sgx-role="' + role + '"$1');
  }
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'private, no-store');
  /* 2.8.0 搜索收录：锁屏态页面不被搜索引擎收录 */
  if (state === 'locked') {
    headers.set('X-Robots-Tag', 'noindex');
  }
  return new Response(injected, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/**
 * 验证 sgx-verified cookie（2.8.0：四段式 role.epoch.exp.sig）。
 * 返回 {ok, role, reason}。
 * 2.4.1 dedup：遍历 Cookie 头里所有同名值，任一验签通过即有效。
 * @returns {Promise<{ok:boolean, role:string|null, reason:string}>}
 */
export async function verifySessionDetailed(request, env) {
  const vals = getAllCookies(request, READER_COOKIE_NAME);
  if (!vals.length) return { ok: false, role: null, reason: 'no-cookie' };
  let reason = 'bad-format';
  let role = null;
  for (const val of vals) {
    const r = await verifyOneCookie(val, env);
    if (r.status === 'ok') return { ok: true, role: r.role, reason: 'ok' };
    /* 记录最有信息量的失败原因：优先 bad-sig/expired，其次 bad-format */
    if (reason === 'bad-format' || r.status !== 'bad-format') {
      reason = r.status;
      role = r.role;
    }
  }
  const pubKey = (env && env.SGX_ED25519_PUBLIC) || '';
  if (reason === 'no-pubkey') {
    console.log('[sgx-verify] fail: no-pubkey pubkey_len=0');
  } else if (reason === 'bad-sig') {
    console.log('[sgx-verify] fail: bad-sig pubkey_len=' + pubKey.length +
      ' pubkey_prefix=' + JSON.stringify(pubKey.slice(0, 27)));
  } else {
    console.log('[sgx-verify] fail: ' + reason);
  }
  return { ok: false, role: null, reason };
}

/**
 * 验证会话（布尔版，保持向后兼容）。
 * @returns {Promise<boolean>}
 */
export async function verifySession(request, env) {
  const r = await verifySessionDetailed(request, env);
  return r.ok;
}

/**
 * 验证会话并返回原因字符串（兼容旧测试）。
 * @returns {Promise<string>}
 */
export async function verifySessionReason(request, env) {
  const r = await verifySessionDetailed(request, env);
  return r.reason;
}

/**
 * 验签单个 cookie 值（2.8.0：四段式 role.epoch.exp.sig）。
 * @returns {Promise<{status:string, role:string|null}>}
 *   status: 'ok' 或失败原因（no-cookie/bad-format/expired/no-pubkey/bad-sig/
 *   kv-error/epoch-low/bad-role）；role: 'owner'|'visitor'|null
 */
async function verifyOneCookie(val, env) {
  const parts = val.split('.');
  /* 2.8.0：旧三段式（无 role）一律视为无效，不留兼容层 */
  if (parts.length !== 4) return { status: 'bad-format', role: null };
  const [role, epochStr, expStr, sig] = parts;
  if (role !== ROLE_OWNER && role !== ROLE_VISITOR) return { status: 'bad-role', role: null };
  const exp = parseInt(expStr, 10);
  if (!exp || exp < Date.now()) return { status: 'expired', role: null };

  const pubKey = env && env.SGX_ED25519_PUBLIC;
  if (!pubKey) return { status: 'no-pubkey', role: null }; /* 未配公钥：fail closed */
  const payload = role + '.' + epochStr + '.' + expStr;
  if (!(await ed25519Verify(pubKey, payload, sig))) return { status: 'bad-sig', role: null };

  /* epoch 检查：cookie 的 epoch 必须 >= KV 中的 session-epoch */
  try {
    if (env && env.OWNER_KV) {
      const cur = parseInt(await env.OWNER_KV.get('session-epoch') || '0', 10) || 0;
      const ep = parseInt(epochStr, 10) || 0;
      if (ep < cur) return { status: 'epoch-low', role: null };
    }
  } catch (e) {
    return { status: 'kv-error', role: null };
  }
  return { status: 'ok', role };
}

/** @param {any} context */
export async function onRequest(context) {
  const { request, next, env } = context;
  const url = new URL(request.url);
  const host = url.hostname;
  const pathname = url.pathname;

  /* L1 链首：pages.dev 生产别名 301 到正式域名。
     只精确匹配 styrigx-space.pages.dev；hash/分支预览别名
     （如 xxx.styrigx-space.pages.dev）放行，不跳转。
     Cache-Control: no-store：绝不缓存这个跳转。 */
  if (host === 'styrigx-space.pages.dev') {
    return new Response(null, {
      status: 301,
      headers: {
        'Location': 'https://styrigx.com' + url.pathname + url.search,
        'Cache-Control': 'no-store',
      },
    });
  }

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
     没有「未配置就放行」开关。）
     2.8.0 会话角色分离：L1 是唯一按角色放行的地方。
     分层规范 L1：middleware 是唯一决定是否已解锁的地方。 */
  const site = env && env.SGX_SITE;
  if (isProd && (!site || site === 'space')) {
    const isHomepage = pathname === '/' || pathname === '/en' || pathname === '/en/';
    const sess = await verifySessionDetailed(request, env);
    const sessionValid = sess.ok;
    const role = sess.role; /* 'owner'|'visitor'|null */
    const isOwner = role === ROLE_OWNER;
    const isVisitor = role === ROLE_VISITOR;

    /* 2.8.0：访客调用主人 API → 403（改密码、通行密钥管理等）。
       认证类 action（verify/challenge/auth/register）由端点自身的 token 机制保护，
       middleware 层按路径统一拒绝 visitor。 */
    if (isVisitor && isOwnerOnlyApi(pathname)) {
      return new Response(JSON.stringify({ ok: false, error: 'role' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    /* L1：首页不再无条件白名单。照常返回页面，但把会话状态注入 HTML
       （<html data-sgx-session="valid|locked" data-sgx-role="owner|visitor">），
       前端只读这个，不自己猜。 */
    if (isHomepage) {
      /* ?return= 回跳：会话有效时 302 到目标（站内路径或 *.styrigx.com 白名单） */
      const returnPath = url.searchParams.get('return');
      if (returnPath && sessionValid) {
        /* 手动构造 302（不用 Response.redirect：Node/undici 不接受相对路径，
           Workers 可以；手动写兼容两边）。
           no-store：绝不缓存这个跳转（2.4.1 锁屏原则）。 */
        const loc = isSafeReturn(returnPath) ? returnPath : '/';
        return new Response(null, {
          status: 302,
          headers: { 'Location': loc, 'Cache-Control': 'private, no-store' },
        });
      }
      const res = await next();
      return injectSessionState(res, sessionValid ? 'valid' : 'locked', role);
    }

    /* 2.8.0：访客访问主人专属路径（设置、我的文件）→ 302 到锁屏，让用户选密码/通行密钥 */
    if (isVisitor && isOwnerOnlyPath(pathname)) {
      const dest = 'https://styrigx.com/?lock=1&return=' + encodeURIComponent(url.pathname + url.search);
      return new Response(null, {
        status: 302,
        headers: {
          'Location': dest,
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex',
        },
      });
    }

    if (sessionValid) {
      const res = await next();
      /* 受保护 HTML 页面：注入 valid 状态 + 防浏览器缓存绕过锁屏。
         只改 text/html，静态资源保持原缓存策略。 */
      const ct = res.headers.get('Content-Type') || '';
      if (ct.includes('text/html')) {
        return injectSessionState(res, 'valid', role);
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
       no-store：绝不缓存这个跳转。X-Robots-Tag: noindex：不被搜索引擎收录。 */
    const dest = 'https://styrigx.com/?lock=1&return=' + encodeURIComponent(url.pathname + url.search);
    return new Response(null, {
      status: 302,
      headers: {
        'Location': dest,
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex',
      },
    });
  }

  return next();
}
