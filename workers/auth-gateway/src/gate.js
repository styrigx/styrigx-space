/**
 * @fileoverview 网关的访问关口（L1）：谁能进来、页面拿到什么会话标记。2026-11-02 Worker 骨架统一时由四个文件合成：
 * 原 functions/_middleware.js（主站关口）、src/subsites.js（图志关口）、functions/_kernel/html.js（HTML 会话标记）、
 * gate.js（公开页清单）。
 *
 * 两个调用点（src/app.js）：
 * - 主站 styrigx.com：onRequest(context)（会话、角色、白名单、no-store、锁屏瘦身），放行后 context.next() 交给 router.js
 * - 图志 atlas.styrigx.com（/blog/ /curio/ /daymark/）：handleSubsite(request, env, origin)
 * 只 import api/（图志的 /api/search 和主站同一个处理函数）、core/、lib/，不 import router / app。
 */
import { verifyLockSession, ROLE_ADMIN, ROLE_VISITOR } from './core/lock-session.js';
import { verifyLockResetTicket } from './core/tickets.js';
import { withNoStore, json, apiError, NO_STORE } from './lib/http.js';
import { askAccountSessionFor } from './core/account-rpc.js';
import { isAdminOnlyPath, resolveReturn } from './core/return.js';
import { anonLimit } from './core/anon-limit.js';
import * as searchApi from './api/search.js';

/* ================= HTML 会话标记（原 _kernel/html.js） ================= */

/**
 * 网关改写 HTML：会话标记（data-sgx-lock-session / role / account-session / upgrade）的清理与注入。
 * 主站 middleware（injectSessionState / injectUpgradeState）和子站（下面图志关口的 markSubsiteRole）共用。

 */
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
export async function injectUpgradeState(res, role, returnPath) {
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

/* ================= 公开页（原 _kernel/public-pages.js） ================= */

/**
 * 公开页面路径（搜索收录）
 *
 * 未登录也能返回 200 的页面。sitemap 只收录这些。
 * 与 web/atlas/data/public-pages.yaml 保持同步（tests/workers/auth-gateway/sitemap.test.mjs 验证）。
 * L3 共享库：不含鉴权逻辑，只定义路径常量。

 */
export const PUBLIC_PAGE_PATHS = ['/', '/en/'];

/**
 * 判断路径是否为公开页（忽略末尾斜杠差异）。
 * @param {string} pathname
 * @returns {boolean}
 */
export function isPublicPage(pathname) {
  const p = pathname === '/en' ? '/en/' : pathname;
  return PUBLIC_PAGE_PATHS.includes(p);
}

/* ================= 主站关口（原 functions/_middleware.js） ================= */

/**
 * 主站 middleware（SGX_SITE=space）：主站页面与 /api/* 的锁屏会话关口
 *
 * 1. 域名隔离：生产环境只允许 styrigx.com 访问
 * 2. 会话检查：锁屏会话 cookie（Ed25519 签名，见 core/lock-session.js）
 *    - 有效 → next()
 *    - 无效 → 白名单放行，否则 302 到首页锁屏（?lock=1&return=原地址）
 * 3. verifyLockSession 每次拒绝都打 [sgx-verify] fail: <原因> 日志（只记原因，
 *    不记密钥和 cookie 值），用于线上排查会话未被识别的问题。

 */
/* 重置锁屏票（LockResetTicket，sgx-lock-reset）只开锁屏凭证页（重置锁屏流程），不开安全总览。 */
const LOCK_RESET_PATHS = [
  '/settings/security/lock/',
  '/en/settings/security/lock/',
];
/* 2.8.0：管理员专属 API（visitor 调用 → 403）。
   账号拆分 PR3：/api/account、/api/prefs 经转发表（router.js FORWARDING）转给账号 Worker，门在这里（/api/prefs 从账号 Worker 的 gate.js 收回）。 */
const ADMIN_ONLY_APIS = [
  '/api/account',
  '/api/prefs',
  '/api/lock-password',
  '/api/lock-passkey',
  '/api/lock-all-devices',
  '/api/lock-reauth',
  '/api/lock-tempkey', /* 临时钥匙管理：只认管理员锁屏会话（接口里再验一次 admin） */
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
   放行后由网关转发给账号 Worker（router.js 转发表的 /avatar/，gate='public'）。 */
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
    /* 验过的结论交给转发（router.js forward）：写身份头不再重验 */
    if (context.data) context.data.lockSession = sess;
    const sessionValid = sess.ok;
    const role = sess.role; /* 'admin'|'visitor'|null */
    const isVisitor = role === ROLE_VISITOR;

    /* 无会话写接口的按 IP 总限流（防刷 D1 写入额度；超了 429 cooldown，不进端点）：见 core/anon-limit.js */
    const limited = await anonLimit(request, env, sessionValid);
    if (limited) return limited;

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

    /* 访客直接打开管理员专属路径（锁屏凭证页、临时钥匙页、服务状态页）→ 302 到首页的「管理员验证」（?return=，不带 lock=1）：
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
          /* 首帧提示：经 ACCOUNT_VERIFIER 问账号 Worker（方案第 2 节）；读不到（没绑定 / RPC 出错）→ 不给提示，前端停在中性态等 /api/account */
          try {
            const a = await askAccountSessionFor(request, env);
            account = a.ok ? 'in' : (a.reason === 'no-verifier' || a.reason === 'rpc-error' ? null : 'out');
          } catch (e) {
            account = null;
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

/* ================= 图志关口（原 src/subsites.js） ================= */

/**
 * @fileoverview 子站门禁：图志 atlas.styrigx.com（/blog/、/curio/、/daymark/ 三站同一个 Pages）的会话检查由网关统一做。
 *
 * 子站 Pages 不再持有任何公钥、不再带验票代码。网关接管整个 atlas.styrigx.com（路由见 wrangler.toml）；
 * /curio/api/*、/daymark/api/* 是更具体的路由，归两个接口 Worker（styrigx-atlas 仓库），不进网关：
 *   - 会话有效（admin 或 visitor，与主站同一套 verifyLockSession：验签 + exp + epoch）→ 回源取页面，
 *     HTML 加 private, no-store（防锁定后切回标签页看到缓存的旧页面）
 *   - 会话无效：页面 302 到主站锁屏（?lock=1&why=…&return=原地址），/api/* 回 401 JSON（fetch 不跟跳转）
 *   - /api/search：全站搜索（三站共用，在图志根上），和主站同一个处理（路由表 router.js 里的 /api/search）
 *   - /api/lock-session-check：三站前端切回标签页时问的（在图志根上），网关直接回答：有效 204，失效 401 {ok:false, why}
 *     （blog 认 204；curio、daymark 只认 401，其他状态什么都不做）
 *   - 静态资源后缀（被页面路由顺带覆盖到的 js/css/字体/图片）直接回源，不验会话，与原子站白名单一致
 *
 * 子站不做角色区分：admin、visitor 都能看页面（与原子站 middleware 一致）；
 * 管理员专属的操作（daymark 记句子、curio 改收藏 / 导入）由子站自己的接口 Worker 再问网关（服务绑定 AuthVerifier）。

 */
const MAIN_ORIGIN = 'https://styrigx.com';

/** 图志：三个子站共用的唯一主机 */
export const ATLAS_HOST = 'atlas.styrigx.com';

/**
 * 图志里的子站：第一段路径 → 配置。新增子站在这里加一项（图志 Pages 和 styrigx-atlas 仓库同步加目录）。
 */
export const SUBSITES = Object.freeze({
  blog: { site: 'blog' },
  curio: { site: 'curio' },
  daymark: { site: 'daymark' },
});

/* 不验会话的静态资源后缀（不含正文内容）。和原子站 middleware 白名单一致。 */
const STATIC_EXT = new Set([
  'css', 'js', 'mjs', 'map',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico',
]);

/* 不带正文的公开文件（以前子站只登记页面目录，这些都不过网关；改成整站通配后照旧放行）。
   manifest 由浏览器不带 cookie 去取，挡了就是坏图标。robots.txt、favicon.ico 在图志根上，manifest 只有博客有。 */
const PUBLIC_FILES = new Set(['/robots.txt', '/favicon.ico', '/blog/manifest.json']);

/** @param {string} pathname */
export function isStaticAsset(pathname) {
  if (PUBLIC_FILES.has(pathname)) return true;
  const dot = pathname.lastIndexOf('.');
  const slash = pathname.lastIndexOf('/');
  if (dot <= slash || dot < 0) return false;
  return STATIC_EXT.has(pathname.slice(dot + 1).toLowerCase());
}

/**
 * 网关要不要按子站处理这个主机：只有图志。
 * @param {string} hostname
 */
export function subsiteFor(hostname) {
  return hostname === ATLAS_HOST ? { host: ATLAS_HOST } : null;
}

/**
 * 路径属于哪个子站（第一段）：/curio/xxx → curio。根上的文件和不认识的目录返回 null（照样要会话，只是日志里记 atlas）。
 * @param {string} pathname
 */
export function siteOf(pathname) {
  const seg = pathname.split('/')[1] || '';
  return Object.prototype.hasOwnProperty.call(SUBSITES, seg) ? SUBSITES[seg].site : null;
}


/**
 * 302 到主站锁屏。why 让主站知道是子站踢回来的（主站见到 why 不再自动回跳，防两站之间死循环）。
 * @param {URL} url
 * @param {string} why
 */
export function lockRedirect(url, why) {
  const target = MAIN_ORIGIN + '/?lock=1&why=' + encodeURIComponent(why) +
    '&return=' + encodeURIComponent(url.origin + url.pathname + url.search);
  return new Response(null, {
    status: 302,
    headers: { 'Location': target, 'Cache-Control': NO_STORE, 'X-Robots-Tag': 'noindex' },
  });
}

/* 抽屉头的头像（三个子站模板都是 <a class="sgx-drawer-me" href="…主站账号页"><img …></a>） */
const DRAWER_ME_RE = /<a\b([^>]*\bclass="sgx-drawer-me"[^>]*)>([\s\S]*?)<\/a>/gi;

/**
 * 访客打开子站：和主站一样，抽屉头的头像只是装饰，点了不跳主站账号页（用户 2026-10-24）。
 * 主站靠 data-sgx-role + head-buttons.js 去链接；子站不读角色，所以网关直接在 HTML 里把它换成不可点的 <span>：
 * 去掉 href / aria-label，读屏跳过，键盘聚焦不到，子站抽屉的点击代理（只认 a.sgx-drawer-me）也不再命中。
 * 同时和主站一样给 <html> 标上 data-sgx-role（只是展示提示，UI 不做鉴权）。
 * @param {string} html
 * @param {string|null} role
 */
export function markSubsiteRole(html, role) {
  let out = stripSessionAttrs(html);
  if (role === 'admin' || role === 'visitor') {
    out = out.replace(/<html(\s|>)/i, '<html data-sgx-role="' + role + '"$1');
  }
  if (role === 'visitor') {
    out = out.replace(DRAWER_ME_RE, (_m, _attrs, inner) =>
      '<span class="sgx-drawer-me" aria-hidden="true" style="pointer-events:none;cursor:default">' + inner + '</span>');
  }
  return out;
}

/** 会话有效的子站页面：HTML 按角色处理 + no-store；其他原样返回 */
async function subsitePage(res, role) {
  const ct = res.headers.get('Content-Type') || '';
  if (!ct.includes('text/html')) return res;
  const html = markSubsiteRole(await res.text(), role);
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', NO_STORE);
  headers.delete('Content-Length');
  return new Response(html, { status: res.status, statusText: res.statusText, headers });
}

/**
 * 子站请求处理（只在 hostname 命中 SUBSITES 时调用）。
 * @param {Request} request
 * @param {Record<string, any>} env  已换好密钥字符串的 env
 * @param {(req: Request) => Promise<Response>} origin  回源函数
 */
export async function handleSubsite(request, env, origin) {
  const url = new URL(request.url);
  const conf = subsiteFor(url.hostname);
  if (!conf) return apiError(404, 'not-found');
  const path = url.pathname;

  if (path === '/api/lock-session-check') {
    if (request.method !== 'GET' && request.method !== 'HEAD') return apiError(405, 'method');
    const sess = await verifyLockSession(request, env);
    if (sess.ok) return new Response(null, { status: 204, headers: { 'Cache-Control': NO_STORE } });
    return json(401, { ok: false, why: sess.reason === 'no-cookie' ? 'no-cookie' : 'invalid-session' });
  }

  /* 全站搜索：子站也问网关（api/search.js 自己验会话，再转 styrigx-search-index；和主站路由表里的 /api/search 是同一个处理函数） */
  if (path === '/api/search') {
    if (request.method !== 'GET') return apiError(405, 'method');
    return searchApi.onRequestGet({ request, env });
  }

  if (isStaticAsset(path)) return origin(request);

  const sess = await verifyLockSession(request, env);
  if (sess.ok) return subsitePage(await origin(request), sess.role);

  const why = sess.reason === 'no-cookie' ? 'no-cookie' : 'invalid-session';
  console.log('[sgx-subsite] deny site=' + (siteOf(path) || 'atlas') + ' reason=' + sess.reason);
  /* 根上的 /api/* 和各站的 /<站>/api/*（正常归接口 Worker，漏到网关时）都回 401 JSON，fetch 不跟跳转 */
  if (path.startsWith('/api/') || /^\/[^/]+\/api\//.test(path)) return apiError(401, 'unauthorized');
  return lockRedirect(url, why);
}
