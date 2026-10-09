/**
 * 域名隔离：生产环境只允许 styrigx.com 访问。
 * - Host 不是 styrigx.com → 301 到 https://styrigx.com 同一路径
 * - /api/* 一律 403（不透露接口存在）
 *
 * 注意：这是在 Pages Functions 层做的，_middleware.js 会在所有 /api/* 之前运行。
 * 静态资源也需要保护，所以用 _middleware.js 而不是只在 api 下。
 */

/** @param {any} context */
export async function onRequest(context) {
  const { request, next, env } = context;
  const url = new URL(request.url);
  const host = url.hostname;

  /* 只在生产环境启用（通过环境变量判断） */
  const isProd = (env && env.SGX_ENV === 'production') || host === 'styrigx.com' || host === 'www.styrigx.com';

  if (isProd) {
    /* www 跳转到 apex（已有 _redirects，这里兜底） */
    if (host === 'www.styrigx.com') {
      url.hostname = 'styrigx.com';
      return Response.redirect(url.toString(), 301);
    }
    /* 非 styrigx.com 的 host：API 直接 403，其他 301 */
    if (host !== 'styrigx.com') {
      if (url.pathname.startsWith('/api/')) {
        return new Response('Forbidden', { status: 403 });
      }
      url.protocol = 'https:';
      url.hostname = 'styrigx.com';
      return Response.redirect(url.toString(), 301);
    }
  }

  return next();
}
