/**
 * @fileoverview 网关的访问关口（L1）：谁能进来、页面拿到什么会话标记。2026-11-02 Worker 骨架统一时由四个文件合成：
 * 原 functions/_middleware.js（主站关口）、src/subsites.js（图志关口）、functions/_kernel/html.js（HTML 会话标记）、
 * gate.js（公开页清单）。v5 S3（整站放开）起：页面一律公开，接口按一张访问表 ROUTE_ACCESS 决定要不要进站会话，
 * 主站和子站同一个放行函数 admit；不再 302 到锁屏、不再给锁屏态瘦身页面、没有路径白名单。
 *
 * 调用点（src/app.js）：
 * - 子站 styrigx.com/blog/ /curio/ /daymark/：handleSubsite(request, env, origin)（合并 PR3 起按路径前缀）
 * - 主站 styrigx.com 其余路径：onRequest(context)（域名、会话、访问表、no-store），放行后 context.next() 交给 router.js
 * - 分享链接（router.js routeShare）也查同一张表（accessOf）
 * 只 import core/、lib/，不 import router / app / api。
 */
import { verifyLockSession } from './core/lock-session.js';
import { withNoStore, json, apiError } from './lib/http.js';
import { resolveReturn } from './core/return.js';
import { anonLimit } from './core/anon-limit.js';
import { newSessionAdmits } from './core/identity-admit.js';

/* ================= HTML 会话标记（原 _kernel/html.js） ================= */

/**
 * 网关改写 HTML：进站会话标记（data-sgx-lock-session）的注入，以及旧标记（含账号首帧提示 account-session，命名 v2 起不再注入）的清理。
 * 主站和子站共用（admit → injectSessionState）。
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
 * 把 <html> 变成 <html data-sgx-lock-session="valid|locked">；页面内容两态相同（v5 S3 整站放开），前端只拿它决定要不要绑自动回锁。
 * 同时设置 Cache-Control: private, no-store（进站 / 回锁后切回标签页不拿到旧状态的页面）。
 * 非 HTML 响应原样返回。
 * @param {Response} res
 * @param {'valid'|'locked'} state
 */
export async function injectSessionState(res, state) {
  const ct = res.headers.get('Content-Type') || '';
  if (!ct.includes('text/html')) return res;
  const html = stripSessionAttrs(await res.text()).replace(/<html(\s|>)/i, '<html data-sgx-lock-session="' + state + '"$1');
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.delete('Content-Length');
  return new Response(html, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/* ================= 访问表（v5 S3：整站放开，唯一决定「要不要进站会话」的地方） ================= */

/**
 * 访问档：public = 不要进站会话；entry = 要进站会话（password / passkey / link 任一种进门都算）。
 * 进门之后还要什么（锁侧复验、账号会话、作用域）由各接口自己查，不在这张表里。
 */
export const ACCESS = Object.freeze({ PUBLIC: 'public', ENTRY: 'entry' });

/**
 * 网关的访问表（v5 S3）。规则只有三条：
 * 1. 页面和静态文件（不在 /api/ 下、也不在 /<子站>/api/ 下的路径）一律 public：整站 HTML、RSS、files-index.json、子站 index.json / sitemap 都公开。
 * 2. /api/* 和 /<子站>/api/*：只有下表逐条写出的「方法 + 路径」是 public；其余（表里没有的路径、表里路径换了方法、
 *    路径后面多一段 /x）一律 entry（fail closed）。精确匹配，从不按前缀；只把结尾一个 / 当同一条（/api/geo/ = /api/geo）。
 * 3. 表里的路径参数只有一种：/s/:code，code = 分享码（core/share-links.js SHARE_PATH_RE 的那一段，不含 /）。
 * 子站接口（/curio/api/*、/daymark/api/*）归各自的接口 Worker，有它们自己的访问表；漏到网关时按第 2 条一律 entry。
 * /api/csp-report 在 app.js 里先于网关回答（只记日志、204），不过这张表。
 * 改这张表 = 改谁能不进站调接口：tests/workers/space-core/route-access.test.mjs 对整张表做快照，改动在评审里一眼可见。
 * @type {ReadonlyArray<Readonly<{method: string, path: string, access: 'public'|'entry', why: string}>>}
 */
export const ROUTE_ACCESS = Object.freeze([
  /* 进站本身（还没进站时要用到的） */
  { method: 'GET', path: '/api/lock-entry', access: 'public', why: '锁屏问设了哪些凭证（只回布尔）' },
  { method: 'GET', path: '/api/lock-session-check', access: 'public', why: '前端问「进站了吗 / by」；没进站 401' },
  { method: 'POST', path: '/api/lock-password', access: 'public', why: '密码进站（verify 公开 + 限流；改密码接口内要进站 + 复验）' },
  { method: 'POST', path: '/api/lock-passkey', access: 'public', why: '通行密钥进站（auth 公开；增删改接口内要进站 + 复验）' },
  { method: 'GET', path: '/api/lock-credentials', access: 'public', why: '重置票（不是进站会话）也要能列凭证；接口内要进站或重置票' },
  { method: 'POST', path: '/api/lock-reset', access: 'public', why: '恢复密钥换重置票' },
  { method: 'POST', path: '/api/space-auth', access: 'public', why: '恢复密钥校验' },
  { method: 'POST', path: '/api/identity', access: 'public', why: 'v6 身份命令（P2：whoami / su 登录要在进站前用；每个 action 的档在账号 Worker 判，permits）' },
  { method: 'GET', path: '/s/:code', access: 'public', why: '分享链接：码就是凭证，打开即进站（by=link）' },
  { method: 'HEAD', path: '/s/:code', access: 'public', why: '同上（链接预览探测）' },
  /* 公开的数据 */
  { method: 'GET', path: '/api/geo', access: 'public', why: '只回调用者自己的城市 / 时区' },
  { method: 'GET', path: '/api/wellbeing', access: 'public', why: '屏幕时间合计（明细接口内另要账号会话）' },
  { method: 'GET', path: '/api/profile', access: 'public', why: '站点名片（姓名 / 昵称 / 签名 / 对外邮箱 + 头像版本号），公开只读（v6 P2c，定稿 v5 §五）' },
  { method: 'GET', path: '/api/find', access: 'public', why: '关键词搜索（v5 S4）：只回公开页面元数据，接口内按 IP 限流（FIND_LIMITER）' },
].map((r) => Object.freeze(r)));

/** /s/:code 的码：一段，不含 /（同 SHARE_PATH_RE） */
const SHARE_CODE_SEG = /^\/s\/[^/]*$/;

/** 表的查找键：方法 + 规范路径（/s/<码> → /s/:code） */
const ACCESS_KEYS = new Map(ROUTE_ACCESS.map((r) => [r.method + ' ' + r.path, r.access]));

/** 结尾一个 / 当同一条；不解码、不合并斜杠（编码 / 多斜杠的路径对不上表 → entry） @param {string} p */
function trimSlash(p) {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

/** 接口路径：/api/… 或 /<子站>/api/…（按归一后的路径判断，编码 / 大小写绕不过去） @param {string} pathname */
export function isApiPath(pathname) {
  const p = normPath(pathname);
  return p === '/api' || p.startsWith('/api/') || /^\/[^/]+\/api(\/|$)/.test(p) && Object.prototype.hasOwnProperty.call(SUBSITES, p.split('/')[1]);
}

/**
 * 这个请求要哪一档（上面三条规则）。
 * @param {string} method
 * @param {string} pathname
 * @returns {'public'|'entry'}
 */
export function accessOf(method, pathname) {
  const m = String(method || 'GET').toUpperCase();
  const p = trimSlash(String(pathname || ''));
  const key = SHARE_CODE_SEG.test(p) ? '/s/:code' : p;
  const hit = ACCESS_KEYS.get(m + ' ' + key);
  if (hit) return hit;
  if (key === '/s/:code') return ACCESS.ENTRY;
  return isApiPath(pathname) ? ACCESS.ENTRY : ACCESS.PUBLIC;
}

/* ================= 主站关口（原 functions/_middleware.js） ================= */

/** 首页（?return= 回跳只在这里）：/、/zh、/zh/ */
function isHomepage(pathname) {
  return pathname === '/' || pathname === '/zh' || pathname === '/zh/';
}

/* 旧 /en/ 前缀：四站同一条规则（语言规则四站通用：英文是根路径上的源，中文 /zh/ 是翻译层，/en/ 不是任何东西）。
   主站 /en、/en/…；子站 /<站>/en、/<站>/en/…（站名取 SUBSITES，和子站关口同一张表）。
   按 normPath 归一后逐段比：/EN/、/%65n/、//en/、/BLOG/En/、//blog//en/ 都算；/enx/、/english/、/blog/english-post/、
   /zh/en/、/blog/zh/en/、/daymark/api/en/（第二段是 api，不是 en）都不算。 */

/**
 * 旧英文前缀命中时返回所在站的前缀（主站 ''，子站 '/blog'、'/curio'、'/daymark'），没命中返回 null。
 * @param {string} pathname
 * @returns {string|null}
 */
export function retiredEnSitePrefix(pathname) {
  const segs = normPath(pathname).split('/');
  if (segs[1] === 'en') return '';
  if (segs[2] === 'en' && Object.prototype.hasOwnProperty.call(SUBSITES, segs[1])) return '/' + SUBSITES[segs[1]].site;
  return null;
}

/**
 * 是不是已删除的旧英文前缀（四站：/en…、/blog/en…、/curio/en…、/daymark/en…；P4-3 PR-4c 起 /en/ 不该有任何产物或路由）。
 * @param {string} pathname
 * @returns {boolean}
 */
export function isRetiredEnPath(pathname) {
  return retiredEnSitePrefix(pathname) !== null;
}

/** 回源取 404 页用的地址（站内）：产物里必然没有（Pages 对不存在的路径回最近的 404.html，状态 404）。子站在前面加站前缀，取的是该站自己的 404 */
export const NOT_FOUND_PROBE_PATH = '/__sgx-not-found__/';

/**
 * 旧 /en/… 的回答（四站共用）：回源取「站前缀 + NOT_FOUND_PROBE_PATH」拿该站自己的 404 页，状态码一律 404、private no-store，绝不带 Location。
 * 回源拿到的不是 HTML（或是跳转、或回源失败）→ 纯文本 404。
 * @param {Request} request
 * @param {(input?: Request) => Promise<Response>} next 回源函数
 * @param {string} prefix 站前缀（主站 ''，子站 '/blog' 这类）
 * @param {'valid'|'locked'} state 注入 404 页的会话状态
 * @returns {Promise<Response>}
 */
async function retiredEnNotFound(request, next, prefix, state) {
  const plain = () => new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' } });
  let res;
  try {
    const probe = new URL(prefix + NOT_FOUND_PROBE_PATH, request.url);
    res = await next(new Request(probe.toString(), { method: 'GET', headers: request.headers }));
  } catch (e) {
    return plain();
  }
  const ct = (res && res.headers.get('Content-Type')) || '';
  if (!res || (res.status >= 300 && res.status < 400) || !ct.includes('text/html')) {
    if (res && res.body) res.body.cancel().catch(() => {});
    return plain();
  }
  const out = await injectSessionState(res, state);
  const headers = new Headers(out.headers);
  headers.delete('Location');
  headers.delete('Content-Length');
  headers.set('Cache-Control', 'private, no-store');
  return new Response(out.body, { status: 404, headers });
}

/**
 * 主站和子站共用的放行：
 * - 接口（isApiPath）：有进站会话或 accessOf = public → 交给 next；否则（v6 P1 新路径，并存）请求带新会话 cookie 时问账号 Worker
 *   这个新会话够不够这条路由的档（core/identity-admit.js，一次 D1 查询在账号侧）→ 够就交给 next；都不成立 401 {ok:false}（不 302，fetch 不跟跳转）
 * - 页面 / 静态文件：一律回源，HTML 注入会话状态（valid / locked）
 * @param {Request} request
 * @param {{ok:boolean}} sess
 * @param {(req?: Request) => Promise<Response>} next
 * @param {Record<string, any>} env
 */
async function admit(request, sess, next, env) {
  const pathname = new URL(request.url).pathname;
  if (isApiPath(pathname)) {
    if (!sess.ok && accessOf(request.method, pathname) !== ACCESS.PUBLIC && !(await newSessionAdmits(env, request))) return json(401, { ok: false });
    return next();
  }
  return injectSessionState(await next(), sess.ok ? 'valid' : 'locked');
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
  if (!isProd) return next();

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

  /* SGX_SITE 不是 'space' 一律拒绝（fail closed，与子站一致；配错站点名不再静默放行）。 */
  const site = env && env.SGX_SITE;
  if (site !== 'space') {
    console.error('[sgx-mw] SGX_SITE misconfigured: ' + JSON.stringify(site));
    if (pathname.startsWith('/api/')) {
      return apiError(500, 'config');
    }
    return new Response('Server misconfigured', { status: 500 });
  }

  /* 会话（缺 SGX_SPACE_PUBLIC 时 verifyLockSession 返回 ok:false → fail closed：只有 public 的接口能用）。
     L1：middleware 是唯一决定是否已进站的地方；能不能不进站就调，只看访问表（accessOf）。 */
  const sess = await verifyLockSession(request, env);
  /* 验过的结论交给转发（router.js forward）：写身份头不再重验 */
  if (context.data) context.data.lockSession = sess;

  /* 旧 /en/…（P4-3 PR-4c 起英文是根路径上的源、中文 /zh/ 是翻译层，/en/ 不是任何东西）：网关自己判 404，不回源取 /en/ 地址、不 301。
     线上曾出现解锁会话访问 /en/ 拿到 PR-4b（77ce4d6）时代的旧英文首页（回源链路上的旧副本），所以不能只靠产物里没有 en/：
     这里一律换成回源取一个必然不存在的地址（Pages 回最近的 404.html），状态码强制 404、no-store。 */
  const enPrefix = retiredEnSitePrefix(pathname);
  if (enPrefix !== null) return retiredEnNotFound(request, next, enPrefix, sess.ok ? 'valid' : 'locked');

  /* 无会话写接口的按 IP 总限流（防刷 D1 写入额度；超了 429 cooldown，不进端点）：见 core/anon-limit.js */
  const limited = await anonLimit(request, env, sess.ok);
  if (limited) return limited;

  /* 首页 ?return= 回跳（解锁后回原页）：会话有效时 302 到目标（站内路径或 *.styrigx.com 白名单；resolveReturn 只做地址白名单）。
     手动构造 302（Node/undici 的 Response.redirect 不接受相对路径）。no-store：绝不缓存这个跳转。 */
  const returnPath = isHomepage(pathname) ? url.searchParams.get('return') : null;
  if (returnPath && sess.ok) {
    return new Response(null, {
      status: 302,
      headers: { 'Location': resolveReturn(returnPath), 'Cache-Control': 'private, no-store' },
    });
  }

  return admit(request, sess, next, env);
}

/* ================= 子站关口（原 src/subsites.js；合并 PR3 起按主域名路径前缀） ================= */

/**
 * 子站：博客、奇趣、日刻在主域名 styrigx.com 的 /blog/、/curio/、/daymark/ 下（合并 PR2 起和主站拼成一棵树、同一个 Pages），
 * 会话检查由网关统一做（合并 PR3，2026-11-03）；v5 S3 起和主站同一套放行（admit + 访问表 accessOf）。
 *
 * 子站 Pages 不持有任何公钥、不带验票代码。网关整站通配 styrigx.com/*（路由见 wrangler.toml）；
 * styrigx.com/curio/api/*、styrigx.com/daymark/api/* 是更具体的路由，归两个接口 Worker（workers/curio-core、workers/daymark-core，各有自己的访问表），不进网关：
 *   - 页面、RSS、站点地图、index.json：公开，HTML 注入会话状态（valid / locked）+ private, no-store
 *   - /<站>/api/*（正常归接口 Worker，漏到网关时）：访问表默认 entry，没进站 401 JSON
 *   - 静态资源后缀（js/css/字体/图片）直接回源，不验会话；/curio/、/daymark/ 下像图片的回答由 Pages 的 _worker.js 404
 * 写操作和私密内容（daymark 记句子、curio 改收藏 / 导入）由子站自己的接口 Worker
 * 问网关要结论（服务绑定 SpaceVerifier.conclusion：进门 + 账号会话 + 作用域）。
 */
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
 * 子站请求处理（只在 subsiteOf(url) 命中时调用；app.js 已先把静态后缀直通回源，这里再判一次兜底）。
 * @param {Request} request
 * @param {Record<string, any>} env  已换好密钥字符串的 env
 * @param {(req: Request) => Promise<Response>} origin  回源函数
 */
export async function handleSubsite(request, env, origin) {
  const url = new URL(request.url);
  if (!subsiteOf(url)) return apiError(404, 'not-found');
  /* 旧 /<站>/en/…（静态后缀也算：/blog/en/x.js 不直通回源）：和主站 /en/… 同一条规则，404 页取该站自己的 */
  const enPrefix = retiredEnSitePrefix(url.pathname);
  if (enPrefix === null && isStaticAsset(url.pathname)) return origin(request);
  const sess = await verifyLockSession(request, env);
  if (enPrefix !== null) return retiredEnNotFound(request, origin, enPrefix, sess.ok ? 'valid' : 'locked');
  return admit(request, sess, () => origin(request), env);
}
