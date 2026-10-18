/**
 * Pages 生产部署的 _worker.js：只做一件事 —— 不是 styrigx.com 的访问一律 301 到 styrigx.com。
 *
 * 主站的会话检查和接口全在鉴权网关（workers/auth-gateway），它挂在 styrigx.com 的路由上；
 * Pages 本身只放静态文件，没有任何密钥和数据绑定。
 * 但 Pages 还有 styrigx-space.pages.dev 和每次部署的 <hash>.styrigx-space.pages.dev 地址，
 * 这些地址不经过网关，必须跳回正式域名，否则页面能绕过锁屏直接打开。
 *
 * 其余请求原样交给静态文件（_headers、_redirects 照常生效）。
 * passkey-e2e 预览部署时，CI 用网关打包出来的 _worker.js 覆盖本文件。
 */
const HOST = 'styrigx.com';

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
        headers: { 'Location': 'https://' + HOST + url.pathname + url.search, 'Cache-Control': 'no-store' },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
