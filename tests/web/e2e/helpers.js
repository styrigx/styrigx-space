/**
 * Hark：CI 测试共用 helper（tests/helpers.js）。
 * - blockExternalRequests(page)：拦截所有非 localhost 的外部请求
 *   （天气 API、Turnstile、Google favicon、外部字体/CDN），避免
 *   networkidle 永远等不到，也避免外部波动影响测试和截图。
 *   favicon 返回本地占位图，保证截图稳定。
 * - freezeTime(page)：冻结时间到 2026-10-09 12:00:00+08:00。
 *
 * - setHomeCards(page, { weather, daymark })：模拟首页天气 / 日刻有没有数据（true = 显示，false = .hidden）。
 *   测试构建（SGX_TEST_NO_WEATHER=1）两张卡都不输出，缺的就在时钟后面补一张同 id 的占位卡（和真卡一样是 .widget，
 *   高度 160），再按参数切 .hidden —— 和 index.js / daymark-today.js 显隐真卡的方式一致。
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

/** 首页天气 / 日刻卡显隐（见文件头） */
async function setHomeCards(page, { weather, daymark }) {
  await page.evaluate(([wx, dm]) => {
    const grid = document.querySelector('#home-widgets');
    const clock = document.getElementById('dual-clock');
    let after = clock;
    for (const [id, tag, on] of [['weather', 'div', wx], ['w-daymark', 'a', dm]]) {
      let el = document.getElementById(id);
      if (!el) {
        el = document.createElement(tag);
        el.id = id;
        el.className = 'widget hidden';
        el.style.minHeight = '160px';
        after.after(el);
      }
      el.classList.toggle('hidden', !on);
      after = el;
    }
    void grid.offsetWidth;
  }, [!!weather, !!daymark]);
}

module.exports = { blockExternalRequests, freezeTime, setHomeCards, expect };
