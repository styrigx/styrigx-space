/**
 * @fileoverview 网关的访问关口（L1）：谁能进来、页面拿到什么会话标记。2026-11-02 Worker 骨架统一时由四个文件合成：
 * 原 functions/_middleware.js（主站关口）、src/subsites.js（图志关口）、functions/_kernel/html.js（HTML 会话标记）、
 * gate.js（公开页清单）。
 *
 * 调用点（src/app.js）：
 * - 子站 styrigx.com/blog/ /curio/ /daymark/：handleSubsite(request, env, origin)（合并 PR3 起按路径前缀）
 * - 主站 styrigx.com 其余路径：onRequest(context)（会话、白名单、no-store、锁屏瘦身），放行后 context.next() 交给 router.js
 * 只 import core/、lib/，不 import router / app / api。
 */
import { verifyLockSession } from './core/lock-session.js';
import { verifyLockResetTicket } from './core/tickets.js';
import { withNoStore, json, apiError, NO_STORE } from './lib/http.js';
import { askAccountSessionFor } from './core/account-rpc.js';
import { resolveReturn } from './core/return.js';
import { anonLimit } from './core/anon-limit.js';

/* ================= HTML 会话标记（原 _kernel/html.js） ================= */

/**
 * 网关改写 HTML：会话标记（data-sgx-lock-session / account-session）的注入，以及旧标记的清理。
 * 主站 middleware（injectSessionState）和子站（下面图志关口的 subsitePage）共用。

 */
/* 网关注入的会话标记（只有这些会被先清掉再重新写）。
   2026-10-21：以前清的是 <html> 上所有 data-sgx-*，把 baseof.html 写的构建标记 data-sgx-build 也一起删了；
   现在只清网关会写的 lock-session / account-session，外加 P2-3 退役的旧标记（等级标记、升级验证标记），
   防止页面源码或旧缓存里混进伪造 / 过时的标记（方案 3.2）。 */
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
 * 把 <html> 变成 <html data-sgx-lock-session="valid|locked|lock-reset">，前端只读这个，不自己猜。进门二值：没有等级标记。
 * 同时设置 Cache-Control: private, no-store（防浏览器缓存绕过锁屏）。
 * 非 HTML 响应原样返回。
 * @param {Response} res
 * @param {'valid'|'locked'|'lock-reset'} state
 * @param {'in'|'out'|null} [account] 账号页首帧提示
 */
export async function injectSessionState(res, state, account) {
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

/* ================= 公开页（原 _kernel/public-pages.js） ================= */

/**
 * 公开页面路径（搜索收录）
 *
 * 未登录也能返回 200 的页面。sitemap 只收录这些。
 * 与 space/web/data/public-pages.yaml 保持同步（tests/workers/auth-gateway/sitemap.test.mjs 验证）。
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
/* 重置锁屏票可开的路径（仅锁屏凭证管理页） */
function isLockResetPath(pathname) {
  return LOCK_RESET_PATHS.some(p => pathname === p || pathname.startsWith(p));
}

/* 白名单路径（验证必需 + 锁屏自身 + 静态资源） */
const API_WHITELIST = [
  '/api/space-auth',
  '/api/lock-reset',
  '/api/space-audit',
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
     进门二值（P2-3）：/api/* 只分三类——白名单（无会话可调）、要进门、进门之后由各接口自己要锁侧复验或账号结论；
     页面只分「要进门 / 公开」。分层规范 L1：middleware 是唯一决定是否已解锁的地方。
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

    /* 无会话写接口的按 IP 总限流（防刷 D1 写入额度；超了 429 cooldown，不进端点）：见 core/anon-limit.js */
    const limited = await anonLimit(request, env, sessionValid);
    if (limited) return limited;

    /* L1：首页不再无条件白名单。照常返回页面，但把会话状态注入 HTML
       （<html data-sgx-lock-session="valid|locked">），前端只读这个，不自己猜。 */
    if (isHomepage) {
      /* ?return= 回跳：会话有效时 302 到目标（站内路径或 *.styrigx.com 白名单；resolveReturn 只做地址白名单）。
         防死循环：子站踢回时带 ?why=（子站验签失败），此时不 302，
         返回 200 首页让 lock.js 显示失败原因；否则 JS 没机会跑，
         浏览器会在主站↔子站之间无限 302。 */
      const returnPath = url.searchParams.get('return');
      if (returnPath && sessionValid && !url.searchParams.get('why')) {
        /* 手动构造 302（Node/undici 的 Response.redirect 不接受相对路径）。no-store：绝不缓存这个跳转。 */
        return new Response(null, {
          status: 302,
          headers: { 'Location': resolveReturn(returnPath), 'Cache-Control': 'private, no-store' },
        });
      }
      const res = await next();
      return injectSessionState(res, sessionValid ? 'valid' : 'locked');
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
          return injectSessionState(res, 'lock-reset');
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
        return injectSessionState(res, 'valid', account);
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

/* ================= 子站关口（原 src/subsites.js；合并 PR3 起按主域名路径前缀） ================= */

/**
 * @fileoverview 子站门禁：博客、奇趣、日刻在主域名 styrigx.com 的 /blog/、/curio/、/daymark/ 下（合并 PR2 起和主站拼成一棵树、同一个 Pages），
 * 会话检查由网关统一做（合并 PR3，2026-11-03）。
 *
 * 子站 Pages 不持有任何公钥、不带验票代码。网关整站通配 styrigx.com/*（路由见 wrangler.toml）；
 * styrigx.com/curio/api/*、styrigx.com/daymark/api/* 是更具体的路由，归两个接口 Worker（workers/curio-core、workers/daymark-core），不进网关：
 *   - 会话有效（进门，与主站同一套 verifyLockSession：验签 + exp + epoch）→ 回源取页面，
 *     HTML 加 private, no-store（防锁定后切回标签页看到缓存的旧页面）
 *   - 会话无效：页面 302 到主站锁屏（?lock=1&why=…&return=原地址），/<站>/api/*（正常归接口 Worker，漏到网关时）回 401 JSON
 *   - 静态资源后缀（js/css/字体/图片）直接回源，不验会话，与原子站白名单一致；/curio/、/daymark/ 下像图片的回答由 Pages 的 _worker.js 404
 *   - xml / json 不在静态后缀里：博客全文 RSS、站点地图、各站 index.json 一律要会话（合并 PR2 时 _worker.js 的过渡 404 规则随之删掉）
 * 子站前端问的 /api/lock-session-check 在主域名根上，由主站关口 + 路由表回答（同源；有效 200 {ok:true}、失效 401 {ok:false}：
 * blog 只对 401 跳锁屏、其余状态不动，curio / daymark 只认 401，见 tests/workers/auth-gateway/subsites.test.mjs）。
 *
 * 进门的人都能看子站页面；写操作和私密内容（daymark 记句子、curio 改收藏 / 导入）由子站自己的接口 Worker
 * 问网关要结论（服务绑定 AuthVerifier.conclusion：进门 + 账号会话 + 作用域）。
 */
const MAIN_ORIGIN = 'https://styrigx.com';
/** 子站所在的主机（主域名） */
const MAIN_HOST = 'styrigx.com';

/**
 * 主域名下的子站前缀：第一段路径 → 配置。新增子站加一项 + atlas/web/<站>/ 包（space/scripts/assemble.mjs 的 SITES 同步加）。
 */
export const SUBSITES = Object.freeze({
  blog: { site: 'blog' },
  curio: { site: 'curio' },
  daymark: { site: 'daymark' },
});

/* 不验会话的静态资源后缀（不含正文内容）。和原子站 middleware 白名单一致（图片后缀照旧，见代码方案待定 P3）。 */
const STATIC_EXT = new Set([
  'css', 'js', 'mjs', 'map',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico',
]);

/* 不带正文的公开文件：博客的 manifest（浏览器不带 cookie 去取，挡了就是坏图标）。robots.txt / favicon.ico 在主域名根上，归主站。 */
const BLOG_MANIFEST = '/blog/manifest.json';

/**
 * 路径归一（只用来判断，不改回源地址）：百分号解码一次、反斜杠当斜杠、小写、连续斜杠并成一个、解析 . / .. 段。
 * /%62log/rss.xml、//blog/rss.xml、/BLOG/rss.xml、/blog%2Frss.xml、/css/..%2Fblog/rss.xml 都认成 /blog/rss.xml，
 * 不会漏到主站关口的公开后缀白名单（它对 .xml / .json 放行）或主站静态直通去回源拿全文 RSS（回源时 Pages 自己会解码）。
 * @param {string} pathname
 */
export function normPath(pathname) {
  let p = String(pathname || '');
  try { p = decodeURIComponent(p); } catch (e) { /* 解不开就按原样比 */ }
  p = p.replace(/\\/g, '/').toLowerCase().replace(/\/{2,}/g, '/');
  const out = [];
  const segs = p.split('/');
  for (let i = 1; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '.') { if (i === segs.length - 1) out.push(''); continue; }
    if (seg === '..') { out.pop(); if (i === segs.length - 1) out.push(''); continue; }
    out.push(seg);
  }
  return '/' + out.join('/');
}

/**
 * 子站路径是不是免会话的静态文件。只认「本来就规整」的路径：带百分号编码、反斜杠、多斜杠、. / .. 段的一律不算
 * （回源时 Pages 自己会解码，解码后指向哪个文件说不准，比如 rss.xml%3F.css），交给会话检查（fail closed）。
 * @param {string} pathname
 */
export function isStaticAsset(pathname) {
  const raw = String(pathname || '');
  if (/[%\\]/.test(raw)) return false;
  const p = normPath(raw);
  if (p !== raw.toLowerCase()) return false;
  if (p === BLOG_MANIFEST) return true;
  const dot = p.lastIndexOf('.');
  const slash = p.lastIndexOf('/');
  if (dot <= slash || dot < 0) return false;
  return STATIC_EXT.has(p.slice(dot + 1));
}

/**
 * 路径属于哪个子站（归一后的第一段）：/curio/xxx → curio。根上的文件和不认识的目录返回 null。
 * @param {string} pathname
 */
export function siteOf(pathname) {
  const seg = normPath(pathname).split('/')[1] || '';
  return Object.prototype.hasOwnProperty.call(SUBSITES, seg) ? SUBSITES[seg].site : null;
}

/**
 * 这个请求是不是子站：主域名 styrigx.com 且第一段在 SUBSITES。返回 { site } 或 null。
 * @param {URL} url
 */
export function subsiteOf(url) {
  if (!url || url.hostname !== MAIN_HOST) return null;
  const site = siteOf(url.pathname);
  return site ? { site } : null;
}

/**
 * 302 到主站锁屏。why 让主站知道是子站踢回来的（主站见到 why 不再自动回跳，防死循环）；return 是子站的完整地址（同源）。
 * @param {URL} url
 * @param {string} why
 */
export function lockRedirect(url, why) {
  const target = MAIN_ORIGIN + '/?lock=1&why=' + encodeURIComponent(why) +
    '&return=' + encodeURIComponent(MAIN_ORIGIN + url.pathname + url.search);
  return new Response(null, {
    status: 302,
    headers: { 'Location': target, 'Cache-Control': NO_STORE, 'X-Robots-Tag': 'noindex' },
  });
}

/** 会话有效的子站页面：HTML 清掉旧会话标记 + no-store；其他原样返回 */
async function subsitePage(res) {
  const ct = res.headers.get('Content-Type') || '';
  if (!ct.includes('text/html')) return res;
  const html = stripSessionAttrs(await res.text());
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', NO_STORE);
  headers.delete('Content-Length');
  return new Response(html, { status: res.status, statusText: res.statusText, headers });
}

/**
 * 子站请求处理（只在 subsiteOf(url) 命中时调用；app.js 已先把静态后缀直通回源，这里再判一次兜底）。
 * @param {Request} request
 * @param {Record<string, any>} env  已换好密钥字符串的 env
 * @param {(req: Request) => Promise<Response>} origin  回源函数
 */
export async function handleSubsite(request, env, origin) {
  const url = new URL(request.url);
  const conf = subsiteOf(url);
  if (!conf) return apiError(404, 'not-found');
  const path = normPath(url.pathname);

  if (isStaticAsset(url.pathname)) return origin(request);

  const sess = await verifyLockSession(request, env);
  if (sess.ok) return subsitePage(await origin(request));

  const why = sess.reason === 'no-cookie' ? 'no-cookie' : 'invalid-session';
  console.log('[sgx-subsite] deny site=' + conf.site + ' reason=' + sess.reason);
  /* /<站>/api/*（正常归接口 Worker，漏到网关时）回 401 JSON，fetch 不跟跳转 */
  if (/^\/[^/]+\/api(\/|$)/.test(path)) return apiError(401, 'unauthorized');
  return lockRedirect(url, why);
}
