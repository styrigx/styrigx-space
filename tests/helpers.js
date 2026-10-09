/**
 * Hark：CI 测试共用 helper（tests/helpers.js）。
 * - blockExternalRequests(page)：拦截所有非 localhost 的外部请求
 *   （天气 API、Turnstile、Google favicon、外部字体/CDN），避免
 *   networkidle 永远等不到，也避免外部波动影响测试和截图。
 *   favicon 返回本地占位图，保证截图稳定。
 * - freezeTime(page)：冻结时间到 2026-10-09 12:00:00+08:00。
 *
 * 注意：/api/* 的 mock 由各测试自己在测试体内注册（注册顺序靠后，
 * Playwright 按注册倒序匹配，mock 会优先于本 helper 的通配拦截生效）。
 */
const { expect } = require('@playwright/test');

/* 1x1 透明 PNG（favicon 占位） */
const FAVICON_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

/**
 * 拦截外部请求：非 localhost 一律 abort；localhost 的 favicon
 * 返回本地占位图，其余放行。
 */
async function blockExternalRequests(page) {
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    try {
      const u = new URL(url);
      const host = u.hostname;
      if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') {
        /* favicon 返回本地占位图，保证截图稳定 */
        if (u.pathname.endsWith('.ico') || u.pathname.includes('favicon')) {
          await route.fulfill({ contentType: 'image/png', body: FAVICON_PNG });
          return;
        }
        await route.continue();
        return;
      }
    } catch (e) {
      /* URL 解析失败的一律 abort */
    }
    await route.abort();
  });
}

/** 冻结时间：2026-10-09 12:00:00+08:00 */
async function freezeTime(page) {
  await page.addInitScript(() => {
    const frozen = new Date('2026-10-09T12:00:00+08:00').getTime();
    const RealDate = Date;
    // @ts-ignore
    window.Date = class extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(frozen);
        else super(...args);
      }
      static now() { return frozen; }
    };
  });
}

module.exports = { blockExternalRequests, freezeTime, expect };
