/**
 * 主站 middleware（SGX_SITE=space）：主站页面与 /api/* 的锁屏会话关口
 *
 * 1. 域名隔离：生产环境只允许 styrigx.com 访问
 * 2. 会话检查：锁屏会话 cookie（Ed25519 签名，见 _kernel/lock-session.js）
 *    - 有效 → next()
 *    - 无效 → 白名单放行，否则 302 到首页锁屏（?lock=1&return=原地址）
 * 3. verifyLockSession 每次拒绝都打 [sgx-verify] fail: <原因> 日志（只记原因，
 *    不记密钥和 cookie 值），用于线上排查会话未被识别的问题。
 */

import { verifyLockSession, ROLE_VISITOR } from './_kernel/lock-session.js';
import { verifyLockResetTicket } from './_kernel/tickets.js';
import { withNoStore, json, apiError } from './_kernel/http.js';
import { verifyAccountSession } from './_kernel/account-session.js';
import { isAdminOnlyPath, resolveReturn } from './_kernel/return.js';
import { injectSessionState, injectUpgradeState } from './_kernel/html.js';

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
const STATIC_RE = /\.(css|js|woff2|woff|ttf|png|svg|ico|json|xml|webmanifest)$/i;
/* 主站头像 /avatar/<尺寸>.webp（锁屏、首页、子站都用），公开放行；其他图片仍要先解锁。
   线上 /avatar/* 由账号 Worker styrigx-account 承接（同样的放行规则在 workers/account/src/gate.js）；
   这里留着给 passkey-e2e 预览（网关打包成 Pages 的 _worker.js，头像落到静态默认图）。 */
const AVATAR_FILE_RE = /^\/avatar\/(32|96|192|512)\.webp$/;
/* 首页由 L1 特殊处理（见下）：始终返回页面并注入 data-sgx-lock-session，不再走白名单 */

/* 2026-10-21：全站内容索引（博客标题、地址）不是静态资源，要先解锁。
   以前根目录文件不过网关（路由只登记了页面目录），后缀白名单里的 .json 也会把它放出去。 */
const GATED_DATA = new Set(['/files-index.json', '/en/files-index.json']);
/* Hugo 给首页、分类、标签各生成一份 RSS（/index.xml、/en/index.xml、/tags/index.xml ……），
   里面是全站页面的标题和地址，和 files-index.json 一样要先解锁；后缀白名单里的 .xml 不能把它放出去。 */
const RSS_FEED_RE = /(^|\/)index\.xml$/i;

function isWhitelisted(pathname) {
  if (GATED_DATA.has(pathname)) return false;
  if (RSS_FEED_RE.test(pathname)) return false;
  if (pathname.startsWith('/api/')) {
    return API_WHITELIST.some(p => pathname === p || pathname.startsWith(p + '/'));
  }
  if (pathname.startsWith('/assets/')) return true;
  /* 标签页图标、分享卡片图（社交爬虫没有会话）：锁着也公开 */
  if (pathname === '/favicon.ico' || pathname === '/favicon.svg' || pathname === '/og.png' || pathname === '/robots.txt' || pathname === '/sitemap.xml') return true;
  if (AVATAR_FILE_RE.test(pathname)) return true;
  if (STATIC_RE.test(pathname)) return true;
  return false;
}

/** 首页前缀（/ 或 /en/） */
function homeOf(pathname) {
  return pathname === '/en' || pathname.startsWith('/en/') ? '/en/' : '/';
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
      return apiError(500, 'config');
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
        return apiError(403, 'role');
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
      return json(401, { ok: false });
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
