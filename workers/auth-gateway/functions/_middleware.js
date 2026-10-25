/**
 * 2.4.1 三站真实锁屏 - 主站 middleware（SGX_SITE=space）
 *
 * 1. 域名隔离：生产环境只允许 styrigx.com 访问（保留 P0-3 逻辑）
 * 2. 会话检查：锁屏会话 cookie（Ed25519 签名，见 _kernel/lock-session.js）
 *    - 有效 → next()
 *    - 无效 → 白名单放行，否则 302 到首页锁屏（?lock=1&return=原地址）
 * 3. verifyLockSession 每次拒绝都打 [sgx-verify] fail: <原因> 日志（只记原因，
 *    不记密钥和 cookie 值），用于线上排查会话未被识别的问题。
 */

import { verifyLockSession, ROLE_ADMIN, ROLE_VISITOR } from './_kernel/lock-session.js';
import { isPublicPage } from './_kernel/public-pages.js';
import { verifyLockResetTicket } from './_kernel/tickets.js';
import { withNoStore } from './_kernel/http.js';
import { verifyAccountSession } from './_kernel/account-session.js';

/* 定稿 #13/#14/R3：访客可进安全与隐私总览页（/settings/security/），结构与管理员一致；
   锁屏凭证页（门内）需admin 会话，visitor 访问 → 302 到锁屏（只一次，首页不再二次 302）。 */
const ADMIN_ONLY_PATHS = [
  '/settings/security/lock/',
  '/en/settings/security/lock/',
];
/* 重置锁屏票（LockResetTicket，sgx-lock-reset）只开锁屏凭证页（重置锁屏流程），不开安全总览。 */
const LOCK_RESET_PATHS = [
  '/settings/security/lock/',
  '/en/settings/security/lock/',
];
/* 2.8.0：管理员专属 API（visitor 调用 → 403）。
   云同步 /api/prefs 2026-10-24 搬到账号 Worker styrigx-account，同样的访客 403 在 workers/account/src/gate.js。 */
const ADMIN_ONLY_APIS = [
  '/api/account',
  '/api/lock-password',
  '/api/lock-passkey',
  '/api/lock-all-devices',
  '/api/lock-reauth',
  '/api/lock-tempkey', /* 临时钥匙管理：还要账号会话（接口里验） */
];
/* 认证类 action（visitor 可调用，用于就地升级为管理员：锁屏密码 verify、锁屏通行密钥 challenge / auth） */
const AUTH_ACTIONS = new Set(['verify', 'challenge', 'register', 'auth']);

function isAdminOnlyPath(pathname) {
  return ADMIN_ONLY_PATHS.some(p => pathname === p || pathname.startsWith(p));
}

/* 重置锁屏票可开的路径（仅锁屏凭证管理页） */
function isLockResetPath(pathname) {
  return LOCK_RESET_PATHS.some(p => pathname === p || pathname.startsWith(p));
}

function isAdminOnlyApi(pathname) {
  return ADMIN_ONLY_APIS.some(p => pathname === p || pathname.startsWith(p + '/'));
}

/* 白名单路径（验证必需 + 锁屏自身 + 静态资源） */
const API_WHITELIST = [
  '/api/root-auth',
  '/api/lock-reset',
  '/api/layer-status',
  '/api/root-audit',
  '/api/lock-password',
  '/api/lock-passkey',
  '/api/lock-credentials',
  '/api/lock-entry',
  '/api/lock-reauth',
  '/api/lock-session-check',
  '/api/lock-tempkey-unlock', /* 临时钥匙进门 */
  '/api/geo',
];
const PAGE_WHITELIST = [];
const STATIC_RE = /\.(css|js|woff2|woff|ttf|png|svg|ico|json|xml|webmanifest)$/i;
/* 主站头像 /avatar/<尺寸>.webp（锁屏、首页、子站都用），公开放行；其他图片仍要先解锁。
   线上 /avatar/* 由账号 Worker styrigx-account 承接（同样的放行规则在 workers/account/src/gate.js）；
   这里留着给 passkey-e2e 预览（网关打包成 Pages 的 _worker.js，头像落到静态默认图）。 */
const AVATAR_FILE_RE = /^\/avatar\/(32|96|192|512)\.webp$/;
/* 首页由 L1 特殊处理（见下）：始终返回页面并注入 data-sgx-lock-session，不再走白名单 */

/* 2026-10-21：全站内容索引（博客标题、地址）不是静态资源，要先解锁。
   以前根目录文件不过网关（路由只登记了页面目录），后缀白名单里的 .json 也会把它放出去。 */
const GATED_DATA = new Set(['/files-index.json', '/en/files-index.json']);

function isWhitelisted(pathname) {
  if (GATED_DATA.has(pathname)) return false;
  if (PAGE_WHITELIST.includes(pathname)) return true;
  if (pathname.startsWith('/?lock=1') || pathname.startsWith('/en/?lock=1')) return true;
  if (pathname.startsWith('/api/')) {
    return API_WHITELIST.some(p => pathname === p || pathname.startsWith(p + '/') || pathname.startsWith(p + '?'));
  }
  if (pathname.startsWith('/assets/')) return true;
  /* 标签页图标、分享卡片图（社交爬虫没有会话）：锁着也公开 */
  if (pathname === '/favicon.ico' || pathname === '/favicon.svg' || pathname === '/og.png' || pathname === '/robots.txt' || pathname === '/sitemap.xml') return true;
  if (AVATAR_FILE_RE.test(pathname)) return true;
  if (STATIC_RE.test(pathname)) return true;
  return false;
}

const MAIN_ORIGIN = 'https://styrigx.com';
/* 已下线的子站：不再作为回跳目标 */
const RETIRED_RETURN_HOSTS = new Set(['book.styrigx.com', 'book-preview.styrigx.com']);
const UNSAFE_RETURN_RE = /[\u0000-\u001f\u007f\\]/;

/**
 * ?return= 回跳目标的唯一校验（首页 302 和 /api/lock-session-check 共用，经 resolveReturn）：
 * 先再解码一层，原值与解码值里有控制字符（含 Tab/CR/LF）或反斜杠一律不认（浏览器会丢掉
 * Tab/换行、把 \ 当 /，/%09/evil.com 这类会变成协议相对地址跳出本站）。
 * - 站内路径：必须以单个 / 开头（不是 //，解码后也不是），按 https://styrigx.com 解析后仍同源，
 *   返回规范化的 pathname+search+hash；/lock/ 登录后无页面，不认（回首页）
 * - 跨站：只认 https://*.styrigx.com（含 apex），不带用户名密码，已下线的子站不认；返回规范化的 href
 * 不合法返回 null（调用方回首页）。
 * @param {unknown} ret 已经过一次 URL 解码的 return 参数
 * @returns {string|null}
 */
export function safeReturn(ret) {
  if (typeof ret !== 'string' || ret.length === 0) return null;
  let dec;
  try {
    dec = decodeURIComponent(ret);
  } catch (e) {
    return null;
  }
  if (UNSAFE_RETURN_RE.test(ret) || UNSAFE_RETURN_RE.test(dec)) return null;
  let u;
  if (ret.startsWith('https://')) {
    try {
      u = new URL(ret);
    } catch (e) {
      return null;
    }
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    const host = u.hostname.toLowerCase();
    if (host !== 'styrigx.com' && !host.endsWith('.styrigx.com')) return null;
    if (RETIRED_RETURN_HOSTS.has(host)) return null;
    return u.href;
  }
  if (ret.charAt(0) !== '/' || ret.charAt(1) === '/' || dec.charAt(1) === '/') return null;
  try {
    u = new URL(ret, MAIN_ORIGIN);
  } catch (e) {
    return null;
  }
  if (u.origin !== MAIN_ORIGIN) return null;
  if (u.pathname === '/lock/') return null;
  return u.pathname + u.search + u.hash;
}

/* 网关自己注入的会话标记（只有这些会被先清掉再重新写）。
   2026-10-21：以前清的是 <html> 上所有 data-sgx-*，把 baseof.html 写的构建标记 data-sgx-build 也一起删了；
   现在只清网关会写的这几种：lock-session / role / account-session / upgrade / upgrade-return。 */
const SESSION_ATTR_RE = /\s+data-sgx-(?:lock-session|role|account-session|upgrade|upgrade-return)="[^"]*"/gi;

/**
 * 去掉 <html> 标签上已有的会话标记（SESSION_ATTR_RE），再由下面重新注入。
 * 页面经网关回源时，Pages 也会注入一次；不去掉就会出现重复属性。
 * 也防止页面源码里混进伪造的会话标记。其他 data-sgx-*（如构建标记 data-sgx-build）原样保留。
 * @param {string} html
 */
export function stripSessionAttrs(html) {
  return html.replace(/<html\b[^>]*>/i, (tag) => tag.replace(SESSION_ATTR_RE, ''));
}

/**
 * L1 向 HTML 注入会话状态（2.4.1 分层规范）。
 * 把 <html> 变成 <html data-sgx-lock-session="valid|locked|lock-reset" data-sgx-role="admin|visitor">，
 * 前端只读这个，不自己猜。
 * 同时设置 Cache-Control: private, no-store（防浏览器缓存绕过锁屏）。
 * 非 HTML 响应原样返回。
 * @param {Response} res
 * @param {'valid'|'locked'|'lock-reset'} state
 * @param {string|null} role 'admin'|'visitor'|null
 */
export async function injectSessionState(res, state, role, account) {
  const ct = res.headers.get('Content-Type') || '';
  if (!ct.includes('text/html')) return res;
  let html = stripSessionAttrs(await res.text());
  /* 2.8.0 锁屏瘦身：锁屏态不下发桌面内容（书单、歌单、小组件等），
     只保留锁屏需要的部分（导航、头像、脚本）。
     重置锁屏票页同样受限（只能管理锁屏凭证），同样瘦身。 */
  if (state === 'locked' || state === 'lock-reset') {
    html = html.replace(/<!-- SGX-DESKTOP-START -->[\s\S]*?<!-- SGX-DESKTOP-END -->/g, '');
  }
  let injected = html.replace(/<html(\s|>)/i, '<html data-sgx-lock-session="' + state + '"$1');
  /* 2026-10-21：账号页首帧就按服务端的账号会话画（in / out），不先画「欢迎回来」再换。
     只是展示提示：账号页的数据和所有操作仍由 /api/account 验签。 */
  if (account === 'in' || account === 'out') {
    injected = injected.replace(/<html(\s|>)/i, '<html data-sgx-account-session="' + account + '"$1');
    if (account === 'in') {
      /* 已登录：登录区（欢迎回来 / 通行密钥登录 / 密码登录）整段不下发，总览首帧就可见 */
      injected = injected.replace(/<!-- SGX-ACCT-LOGIN-START -->[\s\S]*?<!-- SGX-ACCT-LOGIN-END -->/g, '');
      injected = injected.replace(/<div id="acct-main" hidden>/, '<div id="acct-main">');
    } else {
      injected = injected.replace(/<div id="acct-login" class="acct-login" hidden>/, '<div id="acct-login" class="acct-login">');
    }
  }
  /* 2.8.0：注入角色供 UI 展示（UI 不做鉴权） */
  if (role === ROLE_ADMIN || role === ROLE_VISITOR) {
    injected = injected.replace(/<html(\s|>)/i, '<html data-sgx-role="' + role + '"$1');
  }
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'private, no-store');
  /* 2.8.0 搜索收录：锁屏态页面不被搜索引擎收录。重置锁屏票页同样不收录。 */
  if (state === 'locked' || state === 'lock-reset') {
    headers.set('X-Robots-Tag', 'noindex');
  }
  return new Response(injected, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/* 2.9.3：访客 + 管理员专属 return 时，首页返回 200 并标记升级验证。
   前端读 data-sgx-upgrade="1" 和 data-sgx-upgrade-return 打开验证层
   （只显示通行密钥+密码，不显示访客入口，带「需要管理员验证」提示）。
   验证通过后前端跳回 return。绝不 302。 */
async function injectUpgradeState(res, role, returnPath) {
  const ct = res.headers.get('Content-Type') || '';
  if (!ct.includes('text/html')) return res;
  const html = stripSessionAttrs(await res.text());
  let injected = html.replace(/<html(\s|>)/i, '<html data-sgx-lock-session="valid"$1');
  if (role === ROLE_ADMIN || role === ROLE_VISITOR) {
    injected = injected.replace(/<html(\s|>)/i, '<html data-sgx-role="' + role + '"$1');
  }
  /* 升级标记：前端据此打开验证层 */
  injected = injected.replace(/<html(\s|>)/i,
    '<html data-sgx-upgrade="1" data-sgx-upgrade-return="' + returnPath.replace(/"/g, '&quot;') + '"$1');
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'private, no-store');
  return new Response(injected, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/** 首页前缀（/ 或 /en/） */
function homeOf(pathname) {
  return pathname === '/en' || pathname.startsWith('/en/') ? '/en/' : '/';
}

/**
 * 解锁后去哪（唯一实现；首页 302 和 /api/lock-session-check?return= 共用，前端不做白名单）。
 * - return 不合法 → 首页
 * - 已登录用户 return 指向门内页（锁屏凭证页）→ 安全与隐私总览（定稿 #1）
 * - 访客 + 管理员专属 return → upgrade（不跳；就地管理员验证）
 * @param {string} ret 原始 return 参数
 * @param {string|null} role 'admin'|'visitor'
 * @returns {{location:string, upgrade:boolean}}
 */
export function resolveReturn(ret, role) {
  const isVisitor = role === ROLE_VISITOR;
  let safeLoc = safeReturn(ret) || '/';
  let locPath = '';
  try {
    const u = new URL(safeLoc, 'https://styrigx.com');
    locPath = u.hostname === 'styrigx.com' ? u.pathname : '';
  } catch (e) {
    locPath = '';
  }
  if (locPath && isAdminOnlyPath(locPath) && !isVisitor) {
    safeLoc = locPath.startsWith('/en/') ? '/en/settings/security/' : '/settings/security/';
    locPath = safeLoc;
  }
  const isAdminReturn = locPath ? isAdminOnlyPath(locPath) : false;
  return { location: safeLoc, upgrade: isVisitor && isAdminReturn };
}

/** 账号区（账号页及其子页，中英）：访客一律不给看 */
function isAccountArea(pathname) {
  return pathname === '/account' || pathname.startsWith('/account/') ||
    pathname === '/en/account' || pathname.startsWith('/en/account/');
}

/** 账号页（顶栏右圆头像进入）：注入账号会话提示，首帧不闪登录区 */
function isAccountPage(pathname) {
  return pathname === '/account/' || pathname === '/en/account/';
}

/* 跳过会话检查的环境名（本地开发 / 单测 / passkey-e2e 预览）。其余值和缺失都按生产 */
const NON_PROD_ENVS = new Set(['preview', 'development', 'test']);

/** @param {any} context */
export async function onRequest(context) {
  const res = await handleRequest(context);
  /* /api/* 默认不缓存（各接口自己设过 Cache-Control 的不动） */
  try {
    if (new URL(context.request.url).pathname.startsWith('/api/')) return withNoStore(res);
  } catch (e) {}
  return res;
}

/** @param {any} context */
async function handleRequest(context) {
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

  /* 会话检查默认启用（fail closed）：只有 SGX_ENV 显式写成非生产值（NON_PROD_ENVS）且不是正式域名时才跳过；
     缺 SGX_ENV 或写错一律按生产处理 */
  const nonProd = !!(env && NON_PROD_ENVS.has(env.SGX_ENV));
  const isProd = !nonProd || host === 'styrigx.com' || host === 'www.styrigx.com';

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
      url.port = '';
      return Response.redirect(url.toString(), 301);
    }
  }

  /* 2.4.1：会话检查（生产环境 space 站点一律执行；缺 SGX_LOCK_PUBLIC 时
     verifyLockSession 返回 ok:false → fail closed，只放白名单路径。
     没有「未配置就放行」开关。）
     2.8.0 会话角色分离：L1 是唯一按角色放行的地方。
     分层规范 L1：middleware 是唯一决定是否已解锁的地方。
     2.10.2：SGX_SITE 不是 'space' 一律拒绝（fail closed，与子站一致；
     配错站点名不再静默放行）。 */
  const site = env && env.SGX_SITE;
  if (isProd && site !== 'space') {
    console.error('[sgx-mw] SGX_SITE misconfigured: ' + JSON.stringify(site));
    if (pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ ok: false, error: 'config' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
    return new Response('Server misconfigured', { status: 500 });
  }
  if (isProd && site === 'space') {
    const isHomepage = pathname === '/' || pathname === '/en' || pathname === '/en/';
    const sess = await verifyLockSession(request, env);
    const sessionValid = sess.ok;
    const role = sess.role; /* 'admin'|'visitor'|null */
    const isVisitor = role === ROLE_VISITOR;

    /* 2.8.0：访客调用管理员专属 API → 403（改密码、通行密钥管理等）。
       2.10.1：访客就地升级——认证类 action（AUTH_ACTIONS：verify/challenge/auth/register）
       放行，由端点自身的会话/reauth 票机制保护（纵深防御），middleware 不再一律拒绝。 */
    if (isVisitor && isAdminOnlyApi(pathname)) {
      let isAuthAction = false;
      if (request.method === 'POST') {
        try {
          const body = await request.clone().json();
          isAuthAction = body && AUTH_ACTIONS.has(body.action);
        } catch (e) {}
      }
      if (!isAuthAction) {
        return new Response(JSON.stringify({ ok: false, error: 'role' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }
    }

    /* L1：首页不再无条件白名单。照常返回页面，但把会话状态注入 HTML
       （<html data-sgx-lock-session="valid|locked" data-sgx-role="admin|visitor">），
       前端只读这个，不自己猜。 */
    if (isHomepage) {
      /* ?return= 回跳：会话有效时 302 到目标（站内路径或 *.styrigx.com 白名单）。
         2.9.3 防死循环：如果 return 指向管理员专属路径而当前只是访客，不 302，
         直接返回 200 首页，前端打开升级验证层（只显示通行密钥+密码）。
         防死循环失效修复：子站踢回时带 ?why=（子站验签失败），此时也不 302，
         返回 200 首页让 lock.js 显示失败原因；否则 JS 没机会跑，
         浏览器会在主站↔子站之间无限 302。 */
      const returnPath = url.searchParams.get('return');
      if (returnPath && sessionValid && !url.searchParams.get('why')) {
        const dest = resolveReturn(returnPath, role);
        if (!dest.upgrade) {
          /* 手动构造 302（Node/undici 的 Response.redirect 不接受相对路径）。no-store：绝不缓存这个跳转。 */
          return new Response(null, {
            status: 302,
            headers: { 'Location': dest.location, 'Cache-Control': 'private, no-store' },
          });
        }
        /* 访客 + 管理员专属 return：不跳转，200 返回首页并标记升级验证。
           前端读 data-sgx-upgrade="1" 打开管理员验证层（不出锁屏）。 */
        const res = await next();
        return injectUpgradeState(res, role, dest.location);
      }
      const res = await next();
      return injectSessionState(res, sessionValid ? 'valid' : 'locked', role);
    }

    /* 访客直接打开管理员专属路径（锁屏凭证页）→ 302 到首页的「管理员验证」（?return=，不带 lock=1）：
       首页按 访客 + 管理员专属 return 返回 upgrade 态，前端只弹管理员验证层，不出锁屏、不动访客会话。
       （站内点「锁屏凭证」不走这里：security.js 对访客就地弹同一个验证层，不跳页。）
       以前带 lock=1，并且 styrigx.com/ 路由不认查询串 → 锁屏页从 Pages 直出、没有会话标记 → 整个锁屏闪一下。 */
    if (isVisitor && isAdminOnlyPath(pathname)) {
      const dest = 'https://styrigx.com' + homeOf(pathname) + '?return=' + encodeURIComponent(url.pathname + url.search);
      return new Response(null, {
        status: 302,
        headers: {
          'Location': dest,
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex',
        },
      });
    }

    /* 临时 LockKey：访客眼里没有账号——账号页（/account/ 及子页，中英）直接 302 回首页，不出页面。 */
    if (isVisitor && isAccountArea(pathname)) {
      return new Response(null, {
        status: 302,
        headers: { 'Location': 'https://styrigx.com' + homeOf(pathname), 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
      });
    }

    /* 重置锁屏票可打开锁屏凭证页（重置锁屏流程），但仍进不了主页。
       仅放行 /settings/security/lock/ 及其英文版（安全总览不放行）；
       主页仍需有效会话。
       注入专用状态 lock-reset（而非 locked），前端 initLock 跳过锁屏覆盖，
       落地页可操作；票据仍只能管理锁屏凭证。 */
    if (!sessionValid && isLockResetPath(pathname)) {
      const st = await verifyLockResetTicket(request, env);
      if (st.ok) {
        const res = await next();
        const ct = res.headers.get('Content-Type') || '';
        if (ct.includes('text/html')) {
          return injectSessionState(res, 'lock-reset', null);
        }
        return res;
      }
    }

    if (sessionValid) {
      const res = await next();
      /* 受保护 HTML 页面：注入 valid 状态 + 防浏览器缓存绕过锁屏。
         只改 text/html，静态资源保持原缓存策略。 */
      const ct = res.headers.get('Content-Type') || '';
      if (ct.includes('text/html')) {
        let account = null;
        if (isAccountPage(pathname)) {
          try {
            account = (await verifyAccountSession(request, env)).ok ? 'in' : 'out';
          } catch (e) {
            account = null; /* 读不到：不给提示，前端停在中性态等 /api/account */
          }
        }
        return injectSessionState(res, 'valid', role, account);
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
       首页有完整锁屏 UI（密码/通行密钥/临时钥匙），解锁后跳回原内页。
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
