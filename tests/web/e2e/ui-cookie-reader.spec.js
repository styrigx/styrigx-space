/**
 * 2026-10-22 sgx-ui 读端端到端：主站真写端写出的 cookie → 一个最小「子站」页（只内联共享外壳的 ui-cookie-read.js + tokens.css + shell.css，
 * 抽屉头放 nav.json 的字标），首帧前 <html> 的状态、--sgx-primary、字标圆点颜色、SVG 标签页图标都要和主站一模一样。
 * 子站页由 page.route 现拼（同源 localhost，cookie 也设在 localhost；线上是 Domain=styrigx.com，这里只验读写两端的格式）。
 */
const { test } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { blockExternalRequests, freezeTime, expect } = require('./helpers');

test.use({ viewport: { width: 412, height: 915 } });

const SHELL = path.join(__dirname, '../../../web/shared/shell');
const shell = (f) => fs.readFileSync(path.join(SHELL, f), 'utf8');
const SUB = '/__ui-cookie-subsite/';

/** 子站页：<head> 里样式 → 读端原文 → 一行 apply（没缓存时异步加载外壳引擎算自定义色）→ 记下首帧前的状态 */
function subsiteHtml() {
  const nav = JSON.parse(shell('nav.json'));
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<link rel="icon" href="/favicon.ico" sizes="32x32"><link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>${shell('tokens.css')}\n${shell('shell.css')}</style>
<script>${shell('ui-cookie-read.js')}</script>
<script>SgxUI.apply(document.documentElement, { onMiss: function (seed) {
  import('${SUB}palette-scheme.js').then(function (m) { SgxUI.setRoles(seed, m.rolesCss(seed)); window.__sgxRoles = seed; });
} });</script>
<script>window.__pre = { cls: document.documentElement.className, style: document.documentElement.getAttribute('style') };</script>
</head><body><div class="sgx-drawer-brand" style="--sgx-drawer-brand-size:26px">${nav.wordmark}</div>
<script type="module">${shell('favicon.js')}\ninitFavicon();</script>
</body></html>`;
}

/** 两边量同一组东西 */
const measure = () => {
  const d = document.documentElement;
  const probe = document.createElement('i');
  probe.style.cssText = 'position:absolute;color:var(--sgx-primary);background:var(--sgx-text-primary)';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const dot = document.querySelector('.sgx-wordmark .wm-dot');
  const out = {
    dark: d.classList.contains('dark'),
    reducedMotion: d.classList.contains('reduced-motion'),
    attrs: Object.fromEntries(['data-theme-mode', 'data-dark', 'data-palette', 'data-font-size', 'data-reduced-motion'].map((k) => [k, d.getAttribute(k)])),
    fontSize: d.style.fontSize,
    seed: d.style.getPropertyValue('--sgx-seed'),
    hasRoles: !!document.getElementById('sgx-accent-roles'),
    primary: cs.color,
    text: cs.backgroundColor,
    dot: dot ? getComputedStyle(dot).fill : null,
    ink: dot ? getComputedStyle(document.querySelector('.sgx-wordmark .wm-letters')).fill : null,
  };
  probe.remove();
  return out;
};

const CASES = [
  { name: 'lake 深色', page: '/', local: { 'sgx-theme-mode': 'dark' }, want: { pal: null, dark: true } },
  { name: '撞色 xforest 亮色', page: '/', local: { 'sgx-theme-mode': 'light', 'sgx-palette': 'xforest' }, want: { pal: 'xforest', dark: false } },
  { name: '撞色 xforest 深色', page: '/', local: { 'sgx-theme-mode': 'dark', 'sgx-palette': 'xforest' }, want: { pal: 'xforest', dark: true } },
  /* 自定义色：设置页加载时 syncAccent 才算角色，所以主站这边量设置页 */
  { name: '自定义主题色 #1f8a70 跟随系统（系统深色）', page: '/settings/', local: { 'sgx-accent': '#1f8a70' }, scheme: 'dark', want: { pal: null, dark: true, seed: '#1f8a70' } },
];

test.describe('子站读端 = 主站外观（真写端 cookie → 共享外壳 ui-cookie-read.js）', () => {
  for (const c of CASES) {
    test(c.name, async ({ page, context }) => {
      if (c.scheme) await page.emulateMedia({ colorScheme: c.scheme });
      await blockExternalRequests(page);
      await page.route('**/favicon.svg', (r) => r.continue());
      await freezeTime(page);
      /* 主站：按 localStorage 起页，拦下写端写的 sgx-ui（localhost 上 Domain=styrigx.com + Secure 的 cookie 会被浏览器拒掉） */
      await page.addInitScript((local) => {
        try {
          localStorage.setItem('sgx-lang', 'zh');
          for (const [k, v] of Object.entries(local)) localStorage.setItem(k, v);
        } catch (e) {}
        const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
        Object.defineProperty(document, 'cookie', {
          configurable: true,
          get() { return desc.get.call(document); },
          set(v) {
            const m = /^sgx-ui=([^;]*)/.exec(String(v));
            if (m) window.__sgxUi = m[1];
            desc.set.call(document, v);
          },
        });
      }, c.local);
      await page.goto(c.page, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
      await expect.poll(() => page.evaluate(() => window.__sgxUi || '')).not.toBe('');
      const cookie = await page.evaluate(() => window.__sgxUi);
      if (c.local['sgx-accent']) await expect.poll(() => page.evaluate(() => !!document.getElementById('sgx-accent-roles'))).toBe(true);
      await page.locator('.sgx-tb-nav').click();
      await expect(page.locator('#sgx-drawer')).toHaveAttribute('data-state', 'open');
      const main = await page.evaluate(measure);
      const mainIcon = await page.locator('link[rel="icon"][type="image/svg+xml"]').getAttribute('href');

      /* 子站：只有 cookie，没有主站 localStorage（子站页面另起一个干净的上下文） */
      const sub = await context.browser().newContext({ viewport: { width: 412, height: 915 }, colorScheme: c.scheme || 'light' });
      const sp = await sub.newPage();
      await blockExternalRequests(sp);
      await sp.route('**/favicon.svg', (r) => r.continue());
      await sp.route('**' + SUB, (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: subsiteHtml() }));
      await sp.route('**' + SUB + 'palette-scheme.js', (r) => r.fulfill({ contentType: 'text/javascript', body: shell('palette-scheme.js') }));
      await sub.addCookies([{ name: 'sgx-ui', value: cookie, url: new URL(page.url()).origin }]);
      await sp.goto(SUB, { waitUntil: 'load' });
      if (c.local['sgx-accent']) await expect.poll(() => sp.evaluate(() => window.__sgxRoles || '')).toBe(c.local['sgx-accent']);
      const s = await sp.evaluate(measure);
      const pre = await sp.evaluate(() => window.__pre);

      /* 主站自己先对（不然两边一起错也会相等） */
      expect(main.attrs['data-palette']).toBe(c.want.pal);
      expect(main.dark).toBe(c.want.dark);
      expect(main.seed).toBe(c.want.seed || '');
      expect(main.hasRoles).toBe(!!c.want.seed);
      expect(s).toEqual(main);
      expect(s.dot).toBe(s.primary);
      expect(s.ink).toBe(s.text);
      /* 首帧前就落好了（不是之后的脚本补的）：class / style 和最终一致 */
      expect(pre.cls.split(/\s+/).includes('dark')).toBe(main.dark);
      if (!c.local['sgx-accent']) expect(pre.style || '').toBe(await sp.evaluate(() => document.documentElement.getAttribute('style') || ''));
      /* SVG 标签页图标：同一份 favicon.js + favicon.svg → 同一个 data: 地址 */
      await expect.poll(() => sp.locator('link[rel="icon"][type="image/svg+xml"]').getAttribute('href')).toBe(mainIcon);
      /* 读端从不写 cookie：子站页上 sgx-ui 还是原值 */
      expect((await sub.cookies()).find((k) => k.name === 'sgx-ui').value).toBe(cookie);
      await sub.close();
    });
  }

  test('坏 cookie / 未知版本：子站按 lake + 跟随系统，不报错', async ({ browser, baseURL }) => {
    for (const value of ['%%%garbage', 'eyJ2IjozLCJtb2RlIjoiZGFyayJ9' /* {"v":3,"mode":"dark"} */]) {
      const sub = await browser.newContext({ colorScheme: 'dark' });
      const sp = await sub.newPage();
      const errors = [];
      sp.on('pageerror', (e) => errors.push(String(e)));
      await blockExternalRequests(sp);
      await sp.route('**' + SUB, (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: subsiteHtml() }));
      await sub.addCookies([{ name: 'sgx-ui', value, url: baseURL }]);
      await sp.goto(SUB, { waitUntil: 'load' });
      const s = await sp.evaluate(measure);
      expect(s.attrs).toEqual({ 'data-theme-mode': 'system', 'data-dark': '1', 'data-palette': null, 'data-font-size': 'standard', 'data-reduced-motion': '0' });
      expect(s.dark).toBe(true);
      expect(s.dot).toBe(s.primary);
      expect(errors).toEqual([]);
      await sub.close();
    }
  });
});
