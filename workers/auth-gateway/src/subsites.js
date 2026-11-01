/**
 * @fileoverview 子站门禁：图志 atlas.styrigx.com（/blog/、/curio/、/daymark/ 三站同一个 Pages）的会话检查由网关统一做。
 *
 * 子站 Pages 不再持有任何公钥、不再带验票代码。网关接管整个 atlas.styrigx.com（路由见 wrangler.toml）；
 * /curio/api/*、/daymark/api/* 是更具体的路由，归两个接口 Worker（styrigx-atlas 仓库），不进网关：
 *   - 会话有效（admin 或 visitor，与主站同一套 verifyLockSession：验签 + exp + epoch）→ 回源取页面，
 *     HTML 加 private, no-store（防锁定后切回标签页看到缓存的旧页面）
 *   - 会话无效：页面 302 到主站锁屏（?lock=1&why=…&return=原地址），/api/* 回 401 JSON（fetch 不跟跳转）
 *   - /api/search：全站搜索（三站共用，在图志根上），和主站同一个处理（路由表 routes.js 里的 /api/search）
 *   - /api/lock-session-check：三站前端切回标签页时问的（在图志根上），网关直接回答：有效 204，失效 401 {ok:false, why}
 *     （blog 认 204；curio、daymark 只认 401，其他状态什么都不做）
 *   - 静态资源后缀（被页面路由顺带覆盖到的 js/css/字体/图片）直接回源，不验会话，与原子站白名单一致
 *
 * 子站不做角色区分：admin、visitor 都能看页面（与原子站 middleware 一致）；
 * 管理员专属的操作（daymark 记句子、curio 改收藏 / 导入）由子站自己的接口 Worker 再问网关（服务绑定 AuthVerifier）。
 */
import { verifyLockSession } from '../functions/_kernel/lock-session.js';
import { stripSessionAttrs } from '../functions/_kernel/html.js';
import { API_ROUTES } from './routes.js';
import { json, apiError, NO_STORE } from '../functions/_kernel/lib/http.js';

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

  /* 全站搜索：子站也问网关（functions/api/search.js 自己验会话，再转 styrigx-search-index） */
  if (path === '/api/search') {
    if (request.method !== 'GET') return apiError(405, 'method');
    return API_ROUTES.get('/api/search').onRequestGet({ request, env });
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
