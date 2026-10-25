/**
 * @fileoverview 子站门禁：blog.styrigx.com、daymark.styrigx.com、curio.styrigx.com 的会话检查由网关统一做。
 *
 * 子站 Pages 不再持有任何公钥、不再带验票代码。网关在子站的页面路径上（路由见 wrangler.toml）：
 *   - 会话有效（admin 或 visitor，与主站同一套 verifyLockSession：验签 + exp + epoch）→ 回源取页面，
 *     HTML 加 private, no-store（防锁定后切回标签页看到缓存的旧页面）
 *   - 会话无效：页面 302 到主站锁屏（?lock=1&why=…&return=原地址），/api/* 回 401 JSON（fetch 不跟跳转）
 *   - /api/search：全站搜索，和主站同一个处理（functions/api/search.js）
 *   - /api/lock-session-check：子站前端切回标签页时问的，网关直接回答（blog 认 204，daymark、curio 认 200 {ok:true}）
 *   - 静态资源后缀（被页面路由顺带覆盖到的 js/css/字体/图片）直接回源，不验会话，与原子站白名单一致
 *
 * 子站不做角色区分：admin、visitor 都能看页面（与原子站 middleware 一致）；
 * 管理员专属的操作（daymark 记句子、curio 改收藏 / 导入）由子站自己的接口 Worker 再问网关（服务绑定 AuthVerifier）。
 */
import { verifyLockSession } from '../functions/_kernel/lock-session.js';
import { stripSessionAttrs } from '../functions/_middleware.js';
import * as searchApi from '../functions/api/search.js';

const MAIN_ORIGIN = 'https://styrigx.com';

/**
 * 子站登记表：hostname → 配置。新增子站在这里加一项，并在 wrangler.toml 登记它要验的路径。
 * sessionCheckOk：会话有效时 /api/lock-session-check 的回答格式（沿用各子站前端已有的约定）。
 */
export const SUBSITES = Object.freeze({
  'blog.styrigx.com': { site: 'blog', sessionCheckOk: 'no-content' },
  'daymark.styrigx.com': { site: 'daymark', sessionCheckOk: 'json' },
  'curio.styrigx.com': { site: 'curio', sessionCheckOk: 'json' },
});

/* 不验会话的静态资源后缀（不含正文内容）。和原子站 middleware 白名单一致。 */
const STATIC_EXT = new Set([
  'css', 'js', 'mjs', 'map',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico',
]);

/* 不带正文的公开文件（以前子站只登记页面目录，这些都不过网关；改成整站通配后照旧放行）。
   manifest 由浏览器不带 cookie 去取，挡了就是坏图标。 */
const PUBLIC_FILES = new Set(['/manifest.json', '/site.webmanifest', '/robots.txt', '/favicon.ico']);

/** @param {string} pathname */
export function isStaticAsset(pathname) {
  if (PUBLIC_FILES.has(pathname)) return true;
  const dot = pathname.lastIndexOf('.');
  const slash = pathname.lastIndexOf('/');
  if (dot <= slash || dot < 0) return false;
  return STATIC_EXT.has(pathname.slice(dot + 1).toLowerCase());
}

/** @param {string} hostname */
export function subsiteFor(hostname) {
  return Object.prototype.hasOwnProperty.call(SUBSITES, hostname) ? SUBSITES[hostname] : null;
}

const NO_STORE = 'private, no-store';

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': NO_STORE },
  });
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
  if (!conf) return json(404, { ok: false, error: 'not-found' });
  const path = url.pathname;

  if (path === '/api/lock-session-check') {
    if (request.method !== 'GET' && request.method !== 'HEAD') return json(405, { ok: false, error: 'method' });
    const sess = await verifyLockSession(request, env);
    if (sess.ok) {
      if (conf.sessionCheckOk === 'no-content') {
        return new Response(null, { status: 204, headers: { 'Cache-Control': NO_STORE } });
      }
      return json(200, { ok: true });
    }
    return json(401, { ok: false, why: sess.reason === 'no-cookie' ? 'no-cookie' : 'invalid-session' });
  }

  /* 全站搜索：子站也问网关（functions/api/search.js 自己验会话，再转 styrigx-search-index） */
  if (path === '/api/search') {
    if (request.method !== 'GET') return json(405, { ok: false, error: 'method' });
    return searchApi.onRequestGet({ request, env });
  }

  if (isStaticAsset(path)) return origin(request);

  const sess = await verifyLockSession(request, env);
  if (sess.ok) return subsitePage(await origin(request), sess.role);

  const why = sess.reason === 'no-cookie' ? 'no-cookie' : 'invalid-session';
  console.log('[sgx-subsite] deny site=' + conf.site + ' reason=' + sess.reason);
  if (path.startsWith('/api/')) return json(401, { ok: false, error: 'unauthorized' });
  return lockRedirect(url, why);
}
