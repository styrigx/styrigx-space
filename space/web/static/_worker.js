/**
 * Pages 生产部署的 _worker.js：只做这两件事 ——
 *   1. 不是 styrigx.com 的访问一律 301 到 styrigx.com（保留路径和查询串）；
 *   2. 奇趣、日刻（/curio/、/daymark/，合并 PR2 起拼在同一棵树里）一张图片都不出：路径后缀或回答的 Content-Type 像图片的，
 *      一律 404（no-store、不带图片字节）。Sloan 2026-10-29「一律都得过验证」：Pages 不验会话，网关对子站图片后缀
 *      不验会话直接回源（gate.js 的 STATIC_EXT），所以树里只要有一张图没会话也能拿到；奇趣、日刻的图片只从各自接口 Worker 的
 *      /<站>/api/*（先问网关会话）出。规则搬自 styrigx-atlas 的 root/_worker.js，只是 host 判断是 styrigx.com
 *      （网关回源的就是 styrigx.com，换成别的主机会把回源请求弹走）。主站（/images/、/avatar/、/og.png、收藏图标）
 *      和博客（/blog/og.png 社交预览图）不受影响。跳转（3xx）不带正文，原样放行。
 *   （合并 PR2 的过渡规则「三站 .xml 一律 404」在 PR3 删掉：网关按子站前缀验会话，xml / json 不在子站的免会话后缀里，
 *    博客全文 RSS、站点地图没有会话一律 302 到锁屏，见 workers/auth-gateway/src/gate.js 子站关口。）
 *
 * 主站的会话检查和接口全在鉴权网关（workers/auth-gateway），它挂在 styrigx.com 的路由上；
 * Pages 本身只放静态文件，没有任何密钥和数据绑定。
 * 但 Pages 还有 styrigx-space.pages.dev 和每次部署的 <hash>.styrigx-space.pages.dev 地址，
 * 这些地址不经过网关，必须跳回正式域名，否则页面能绕过锁屏直接打开。
 *
 * 其余请求原样交给静态文件（_headers、_redirects 照常生效，安全头也由 _headers 加）。
 * 这里自己发的 301 / 404 不经过 _headers，带上不依赖内容的那几个安全头（本文件是原样上传的单文件，不能 import；
 * 值抄自 workers/auth-gateway/src/lib/security-headers.js，tests/workers/auth-gateway/security-headers.test.mjs 核对一致）。
 * passkey-e2e 预览部署时，CI 用网关打包出来的 _worker.js 覆盖本文件。
 */
const HOST = 'styrigx.com';
const REDIRECT_SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
};

/** 不出图片的子站前缀（图片只从接口 Worker 出）；主站和 /blog/ 不在这里 */
const NO_IMAGE_PREFIXES = ['/curio/', '/daymark/'];

/* 图片后缀（含少见的格式；大小写不敏感），和 styrigx-atlas root/_worker.js 同一张表 */
const IMAGE_EXT = /\.(png|apng|jpe?g|jfif|pjpeg|pjp|gif|webp|avif|svgz?|ico|cur|bmp|tiff?|heic|heif|jxl)$/i;

/** 路径归一：百分号解码、小写、连续斜杠并成一个（/%63urio/、/CURIO/、//curio/、a%2Epng 也照样认出来） */
function normPath(pathname) {
  let p = pathname;
  try { p = decodeURIComponent(p); } catch { /* 解不开就按原样比 */ }
  return p.toLowerCase().replace(/\/{2,}/g, '/');
}

/** 像不像图片：路径后缀或回答的 Content-Type（没有后缀的图片文件也拦） */
function imageLike(path, contentType) {
  if (IMAGE_EXT.test(path)) return true;
  return /^\s*image\//i.test(contentType || '');
}

export default {
  /**
   * @param {Request} request
   * @param {{ ASSETS: { fetch(req: Request): Promise<Response> } }} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname !== HOST) {
      return new Response(null, {
        status: 301,
        headers: { ...REDIRECT_SECURITY_HEADERS, 'Location': 'https://' + HOST + url.pathname + url.search, 'Cache-Control': 'no-store' },
      });
    }
    const res = await env.ASSETS.fetch(request);
    /* 跳转不带正文，放行；跳到的地址再来一次请求还会经过这里 */
    if (res.status >= 300 && res.status < 400) return res;
    const p = normPath(url.pathname);
    if (NO_IMAGE_PREFIXES.some((x) => p.startsWith(x)) && imageLike(p, res.headers.get('Content-Type'))) {
      if (res.body) res.body.cancel().catch(() => {});
      return new Response('not found', {
        status: 404,
        headers: { ...REDIRECT_SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    return res;
  },
};
