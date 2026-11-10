/**
 * @fileoverview styrigx-space-core（站点核心 Worker，原 styrigx-auth-gateway；进站 v3 L2 起并入分享链接 styrigx-share）的默认 handler（src/index.js 的 default）：请求的总流程。
 *
 * 承接 styrigx.com 整站（路由见 wrangler.toml）：/api/*、全部页面。旧图志域名的 301 已于 P4-3 PR-1 删除（路由不再登记）。
 * fetch 第一步剥掉入站请求里所有 x-styrigx-* 和 x-sgx-*（主站、子站回源、静态直通都剥；方案第 3 节第一道保险）。
 * 客户端上下文（IP、cf 国家城市）从原请求取（core/forward.js clientContextOf），放进关口 context.data.clientContext。
 * 静态资源目录（MAIN_STATIC_PREFIXES）和根目录几张公开图第一行就原样回源（isMainStaticPassthrough），不验会话、不改响应。
 * 顺序（合并 PR3，2026-11-03；P4-3 PR-1 删掉旧图志域名的 301 一步）：
 *   1. 主站静态直通（isMainStaticPassthrough）
 *   2. 子站前缀（styrigx.com/blog/ /curio/ /daymark/，gate.js subsiteOf）的静态后缀 → 原样回源（只补 HSTS、nosniff）；旧 /<站>/en/… 除外（交给子站关口判 404）
 * 主站的后端代码只在本 Worker，Pages 只放静态文件：
 *   2b. POST /api/csp-report（core/csp-report.js）：Report-Only CSP 的违规报告，只记日志、204，不经关口、不存东西
 *   3. Secrets Store 的私密值换成字符串（secrets.js）
 *   3b. 分享链接 /s/<码>、/api/share（router.js routeShare；原 styrigx-share Worker 的门和接口，进站 v3 L2 并入）
 *   4. 子站前缀的页面：gate.js handleSubsite（子站关口），Pages 不持钥匙
 *   5. 主站其余路径：先跑 gate.js onRequest（主站关口：域名、会话、访问表 ROUTE_ACCESS、no-store），放行后交给 router.js route：
 *      转发表（账号路径经服务绑定 ACCOUNT 转给 styrigx-account，写全套身份头；账号的响应保留 X-SGX-Runtime: account）
 *      → /api/* 路由表（api/<名字>.js；不在表里 404、方法不支持 405）→ 其他（页面）回源取静态文件
 *
 * 回源：生产上发子请求到同一地址（Worker 发往自己路由的子请求不会再进 Worker，直接到 Pages）；
 * passkey-e2e 预览把网关打包进 Pages 的 _worker.js，这时有 env.ASSETS，直接读静态文件（router.js fromOrigin）。
 *
 * 安全响应头（lib/security-headers.js，2026-10-25 PR D）：
 *   - 主站经过网关的每个响应（页面、锁屏首页、所有 302/301、/api/*、500）→ applyMainSiteHeaders
 *     （HSTS、nosniff、X-Frame-Options、Referrer-Policy、Permissions-Policy、只含非脚本指令的强制 CSP、完整的 Report-Only CSP）
 *   - 子站经过网关的响应（页面、302 到锁屏、401）→ applySubsiteHeaders（HSTS + 低风险的几项，没有才补；完整 CSP 各自审计后再加）
 *   - 子站静态资源直通 → applySubsiteStaticHeaders（只补 HSTS、nosniff）
 *   - 原样回源的静态资源不改（不打 X-SGX-Runtime 也不加头），由 Pages 的 _headers 加同一套
 */
import { onRequest as middleware, subsiteOf, handleSubsite, isStaticAsset as isSubsiteStaticAsset, isRetiredEnPath, normPath } from './gate.js';
import { route, fromOrigin, makeContext, isSharePath, routeShare } from './router.js';
import { resolveSecrets } from './secrets.js';
import { applyMainSiteHeaders, applySubsiteHeaders, applySubsiteStaticHeaders } from './lib/security-headers.js';
import { apiError } from './lib/http.js';
import { stripRequest, clientContextOf } from './core/forward.js';
import { isCspReportPath, handleCspReport } from './core/csp-report.js';

/* 主站静态资源目录：内容带指纹或公开（css/js/字体/收藏图标），不含任何正文。
   2026-10-21 路由改成整站通配前这些路径不过 Worker；现在进来也原样回源，行为不变。 */
export const MAIN_STATIC_PREFIXES = ['/css/', '/js/', '/fonts/', '/fav/', '/images/'];

/* 根目录公开文件：路由改成整站通配后它们也进了 Worker（#159），这里同样原样回源、不打标记。
   只放这些：内容公开且固定（robots、标签页图标 ico / svg、分享卡片图 og.png，2026-10-21）；
   sitemap.xml / files-index.json 列出页面地址，仍走网关。 */
export const MAIN_PUBLIC_ROOT_FILES = new Set(['/robots.txt', '/favicon.ico', '/favicon.svg', '/og.png']);

/**
 * 合并 PR3 起只认「本来就规整」的路径：带百分号编码、反斜杠、多斜杠、. / .. 段的不直通（回源时 Pages 自己解码，
 * /css/..%2Fsettings/ 这类解码后指向哪里说不准），交给主站关口照常验（fail closed）。静态文件名都是 ASCII，不受影响。
 * @param {URL} url
 */
export function isMainStaticPassthrough(url) {
  if (url.hostname !== 'styrigx.com') return false;
  if (/[%\\]/.test(url.pathname) || normPath(url.pathname) !== url.pathname.toLowerCase()) return false;
  if (MAIN_PUBLIC_ROOT_FILES.has(url.pathname)) return true;
  return MAIN_STATIC_PREFIXES.some((p) => url.pathname.startsWith(p));
}

/** 账号 Worker 写的运行时标记：转发回来的响应保留，不覆盖成 worker（部署冒烟据此确认请求真的进了账号 Worker） */
const ACCOUNT_RUNTIME = 'account';

/** 每个响应都打上 X-SGX-Runtime: worker，切流后能从外部确认请求真的走了 Worker（不含任何敏感信息）；账号转发的响应保留 account */
export function tagRuntime(res) {
  const out = new Response(res.body, res);
  if (out.headers.get('X-SGX-Runtime') !== ACCOUNT_RUNTIME) out.headers.set('X-SGX-Runtime', 'worker');
  return out;
}

export default {
  /**
   * @param {Request} request
   * @param {Record<string, any>} rawEnv
   * @param {{ waitUntil(p: Promise<any>): void }} ctx
   */
  async fetch(rawRequest, rawEnv, ctx) {
    /* 第一道保险：客户端上下文先从原请求取，再剥掉所有外来的 x-styrigx-* / x-sgx-*（下游只认网关写的） */
    const clientContext = clientContextOf(rawRequest);
    const request = stripRequest(rawRequest);
    const url0 = new URL(request.url);
    /* 子站前缀先判（按归一后的路径：编码 / 大小写 / 多斜杠 / .. 绕法都算子站，不会落到主站的静态直通或公开后缀白名单） */
    const sub = subsiteOf(url0);
    /* 主站静态资源：原样回源，不验会话、不打 X-SGX-Runtime（与以前不登记路由时一致；CI 冒烟据此确认静态资源不验会话） */
    if (!sub && isMainStaticPassthrough(url0)) return fromOrigin(request, rawEnv);
    /* 旧 /<站>/en/… 的静态后缀也不直通：交给子站关口判 404（四站同一条规则，gate.js retiredEnSitePrefix） */
    if (sub && isSubsiteStaticAsset(url0.pathname) && !isRetiredEnPath(url0.pathname)) {
      return applySubsiteStaticHeaders(await fromOrigin(request, rawEnv));
    }
    /* Report-Only CSP 的违规报告（core/csp-report.js）：只记日志、回 204、不存东西；不经主站关口（锁屏页也会报），不用密钥 */
    if (!sub && isCspReportPath(url0)) return applyMainSiteHeaders(tagRuntime(await handleCspReport(request)));
    const env = await resolveSecrets(rawEnv);
    /* 分享链接 /s/<码>、/api/share（原 styrigx-share Worker，进站 v3 L2 并入）：不走主站关口，安全头同主站 */
    if (!sub && isSharePath(url0.pathname)) return applyMainSiteHeaders(tagRuntime(await routeShare(request, env, ctx)));
    const isSub = !!sub;
    const secure = isSub ? applySubsiteHeaders : applyMainSiteHeaders;
    try {
      if (isSub) {
        return secure(tagRuntime(await handleSubsite(request, env, (req) => fromOrigin(req, env))));
      }
      const data = { clientContext };
      const next = (req) => route(req, env, ctx, data);
      return secure(tagRuntime(await middleware(makeContext(request, env, ctx, '/', next, data))));
    } catch (e) {
      console.error('[sgx-auth] unhandled: ' + (e && e.name ? e.name : 'error'));
      return secure(tagRuntime(apiError(500, 'internal')));
    }
  },
};
