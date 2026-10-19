/**
 * 2.4.0 E：视觉回归测试。
 * 5 视口 × 中英 × 深浅色 × 主要页面（/、/browser/、/settings/ 等；B2-2 删除 /store/，2026-10-19 删除 /files/）
 * + F 的两张基准（弹层打开、引擎菜单打开）。
 * 首次运行：npx playwright test --update-snapshots 生成基准；
 * 后续运行自动对比，不一致即失败。
 *
 * Hark：goto 用 domcontentloaded + 等具体元素，不用 networkidle
 * （CI 里外部请求会让 networkidle 永远等不到）；删掉全部 waitForTimeout。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('./helpers');

const VIEWPORTS = {
  mobile: { width: 412, height: 915 },
  landscape: { width: 915, height: 412 },
  tabletPortrait: { width: 800, height: 1280 },
  tabletLandscape: { width: 1280, height: 800 },
  desktop: { width: 1920, height: 1080 },
};
/* 安全与隐私：新页面加入视觉回归（先只报告，基线未生成前不阻塞） */
const PAGES = ['/', '/browser/', '/settings/', '/settings/security/', '/settings/security/lock/', '/settings/security/owner/'];
const LANGS = [
  { prefix: '', name: 'zh' },
  { prefix: '/en', name: 'en' },
];
const THEMES = [
  { name: 'light', setup: null },
  { name: 'dark', setup: 'dark' },
];

/* 页面主容器：等它出现即认为页面主体已渲染 */
const MAIN = 'main, #app-grid';

/** 等页面就绪：主容器可见 + 字体加载完成 */
async function waitPageReady(pg) {
  await expect(pg.locator(MAIN).first()).toBeVisible({ timeout: 15000 });
  await pg.evaluate(() => document.fonts.ready);
}

/** 所有组合：视口 × 语言 × 主题 × 页面 */
for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  for (const lang of LANGS) {
    for (const theme of THEMES) {
      for (const page of PAGES) {
        const name = `${vpName}-${lang.name}-${theme.name}${page.replace(/\//g, '_')}`;
        test(name, async ({ page: pg }) => {
          await pg.setViewportSize(vp);
          await blockExternalRequests(pg);
          /* 2.8.0：files 页面 mock（page.route 后注册优先于 blockExternalRequests 的通配拦截）；B2-2 删除书单条目 */
          if (page === '/files/') {
            /* Hark：拦截 filesindex.json，取真实响应，文章换成固定 fixture（日期在冻结时间 10-09 的 30 天窗口内），站点等保留 */
            await pg.route('**/files-index.json**', async (route) => {
              const res = await route.fetch();
              const data = await res.json();
              const kept = data.items || [];
              /* 固定文章 fixture（rss 被锁屏 302，真数据拿不到；用固定 2 篇保证"最近添加"稳定） */
              const posts = [
                { id: 'post-fixture-a', type: 'post', lang: 'zh', title: 'Fixture Post A', url: 'https://blog.styrigx.com/post/fixture-a/', addedAt: '2026-10-07' },
                { id: 'post-fixture-b', type: 'post', lang: 'zh', title: 'Fixture Post B', url: 'https://blog.styrigx.com/post/fixture-b/', addedAt: '2026-10-03' },
                { id: 'post-fixture-a-en', type: 'post', lang: 'en', title: 'Fixture Post A', url: 'https://blog.styrigx.com/en/post/fixture-a/', addedAt: '2026-10-07' },
                { id: 'post-fixture-b-en', type: 'post', lang: 'en', title: 'Fixture Post B', url: 'https://blog.styrigx.com/en/post/fixture-b/', addedAt: '2026-10-03' },
              ];
              /* 去掉原有的 post 条目（可能为 0 或不稳定），换成固定 fixture */
              const noPosts = kept.filter((it) => it.type !== 'post');
              data.items = noPosts.concat(posts);
              await route.fulfill({ response: res, json: data });
            });
          }
          /* 关掉动画，保证截图稳定（goto 之前设置，context 级生效） */
          await pg.emulateMedia({ reducedMotion: 'reduce' });
          /* 定稿 #1：门内页探针需会话+票据都有效。视觉测试 mock 两者通过，
             避免探针失败弹 toast 导致截图不稳定。 */
          if (page === '/settings/security/owner/' || page === '/settings/security/lock/') {
            const statusBody = page.includes('/owner/')
              ? { ok: true, password: false, passkey: false }
              : { ok: true, password: false, passkey: false };
            await pg.route('**/api/owner-status', async (route) => {
              await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(statusBody),
              });
            });
            await pg.route('**/api/lock-status', async (route) => {
              await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ ok: true, password: false, passkey: false }),
              });
            });
            await pg.route('**/api/stepup', async (route) => {
              await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ ok: true, valid: true }),
              });
            });
            /* 门内列表 API：返回空列表，保证截图稳定 */
            await pg.route('**/api/owner-passkey', async (route) => {
              await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ ok: true, keys: [], scope: 'root' }),
              });
            });
          }
          /* 预置主题 + 冻结时间，避免动态内容导致截图不稳定
             （锁屏由构建期 SGX_TEST_NO_LOCK=1 禁用，见 deploy.yml） */
          /* 2.8.0：固定音乐索引，避免按日期漂移导致基线不稳定 */
          if (page === '/' || page === '/en/') {
            await pg.addInitScript(() => {
              try { localStorage.setItem('sgx-np-idx', '0'); } catch (e) {}
            });
          }
          await pg.addInitScript((t) => {
            if (t === 'dark') {
              try { localStorage.setItem('sgx-theme-mode', 'dark'); } catch (e) {}
            }
          }, theme.setup);
          /* 2.8.0：语言跟随系统（2.7.0 起）会按浏览器 locale 跳转 /en/，
             Playwright 默认 en-US 会导致中文截图拍到英文页。
             按测试语言显式钉住 sgx-lang，保证截图语言确定、基线可复现；
             跟随行为本身由 lang-follow.spec.js 单独覆盖。 */
          await pg.addInitScript((ln) => {
            try { localStorage.setItem('sgx-lang', ln); } catch (e) {}
          }, lang.name);
          /* 2.8.0：中文走系统字体回退，不同机器默认中文字体不同会导致截图漂移。
             在默认栈尾部显式指定 Noto Sans CJK SC（CI 已安装，见 deploy.yml），
             拉丁文仍走原栈（Inter/webfont），保证截图跨环境一致。 */
          await pg.addStyleTag({
            content: 'html{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans CJK SC","Noto Sans CJK",sans-serif !important}',
          });
          await freezeTime(pg);
          await pg.goto(lang.prefix + page, { waitUntil: 'domcontentloaded' });
          await waitPageReady(pg);
          /* #1 诊断：构建标记小字只给真机看，视觉回归里隐藏，
             现有基线继续通过；诊断结束后删小字也不用再动基线。
             必须在 goto 之后注入（导航会丢掉之前 addStyleTag/addInitScript 加的样式，
             且 addInitScript 运行时 documentElement 还不存在）。 */
          await pg.addStyleTag({
            content: '.sgx-build-tag,.sgx-build-tag-wrap{display:none !important}',
          });
          /* 浏览器页：快捷访问 favicon 走外部请求（测试拦截 abort），失败兜底
             异步把 img 换成首字母 span；截图前等可视区图标全部落定，
             否则截图会抓到"破图图标 vs 字母占位"的中间态导致抖动 */
          if (page.includes('/browser')) {
            try {
              await pg.waitForFunction(() => {
                const vh = window.innerHeight || 800;
                const imgs = document.querySelectorAll('img[data-favname]');
                for (const img of imgs) {
                  const r = img.getBoundingClientRect();
                  if (r.bottom > 0 && r.top < vh && !img.complete) return false;
                }
                return true;
              }, { timeout: 20000 });
            } catch (e) { /* 超时也不卡死：继续截图 */ }
          }
          await expect(pg).toHaveScreenshot(`${name}.png`, {
            fullPage: false,
            animations: 'disabled',
            /* 遮罩动态区域：时钟、天气 */
            mask: [pg.locator('#dual-clock'), pg.locator('#weather')],
          });
        });
      }
    }
  }
}

/* F 基准 1：弹层打开（2.6.0 起日期时间行在 /settings/manage/ 子页） */
test('baseline-sheet-open', async ({ page: pg }) => {
  await pg.setViewportSize(VIEWPORTS.mobile);
  await blockExternalRequests(pg);
  await pg.emulateMedia({ reducedMotion: 'reduce' });
  /* 2.8.0：钉住中文，避免语言跟随跳转到 /en/ 导致基线语言漂移 */
  await pg.addInitScript(() => {
    try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
  });
  /* 2.8.0：中文回退字体显式化（见主循环注释），保证跨环境一致 */
  await pg.addStyleTag({
    content: 'html{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans CJK SC","Noto Sans CJK",sans-serif !important}',
  });
  await freezeTime(pg);
  await pg.goto('/settings/manage/', { waitUntil: 'domcontentloaded' });
  await waitPageReady(pg);
  /* 2.8.0：等目标行就绪（可能在折叠区下方） */
  await pg.locator('#row-datetime').waitFor({ state: 'visible', timeout: 15000 });
  await pg.locator('#row-datetime').scrollIntoViewIfNeeded();
  await pg.click('#row-datetime');
  /* 等原生 dialog 弹层打开 */
  await expect(pg.locator('dialog[open]').first()).toBeVisible({ timeout: 10000 });
  await expect(pg).toHaveScreenshot('baseline-sheet-open.png', { animations: 'disabled' });
});

/* ===== 两扇门验证弹层视觉基线（第七节验收） =====
 * 手机宽度 412×915 × 中英 × 深浅色 × 两扇门 × 四态（默认/展开/报错/键盘）。
 * 首次运行加 --update-snapshots 生成基准；无横向溢出、无文字截断。
 * Hark：等具体元素，不用 waitForTimeout/networkidle。
 */
const DOOR_VP = { width: 412, height: 915 };
const DOOR_LANGS = [
  { prefix: '', name: 'zh' },
  { prefix: '/en', name: 'en' },
];
const DOOR_THEMES = [
  { name: 'light', setup: null },
  { name: 'dark', setup: 'dark' },
];
/* keyboard 态在 headless 下无法触发真实键盘（与 expanded 基线完全相同），已删除；
   键盘避让逻辑由 followKeyboard 实现，真机行为不变。 */
const DOOR_STATES = ['default', 'expanded', 'error'];

for (const lang of DOOR_LANGS) {
  for (const theme of DOOR_THEMES) {
    for (const door of ['owner', 'mgmt']) {
      for (const state of DOOR_STATES) {
        const name = `mobile-door-${door}-${state}-${lang.name}-${theme.name}`;
        test(name, async ({ page: pg }) => {
          await pg.setViewportSize(DOOR_VP);
          await blockExternalRequests(pg);
          await pg.emulateMedia({ reducedMotion: 'reduce' });
          await pg.addInitScript((t) => {
            if (t === 'dark') {
              try { localStorage.setItem('sgx-theme-mode', 'dark'); } catch (e) {}
            }
          }, theme.setup);
          await pg.addInitScript((ln) => {
            try { localStorage.setItem('sgx-lang', ln); } catch (e) {}
          }, lang.name);
          await pg.addStyleTag({
            content: 'html{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans CJK SC","Noto Sans CJK",sans-serif !important}',
          });
          /* 管理凭证弹层：mock 站长凭证已配置（密码+通行密钥），显示两个行 */
          await pg.route('**/api/owner-status', async (route) => {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({ ok: true, password: true, passkey: true }),
            });
          });
          /* 报错态：密码/根凭证提交一律 401 */
          await pg.route('**/api/root-auth', async (route) => {
            await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'auth' }) });
          });
          await pg.route('**/api/stepup', async (route) => {
            await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'auth' }) });
          });
          await freezeTime(pg);
          await pg.goto(lang.prefix + '/settings/security/', { waitUntil: 'domcontentloaded' });
          await waitPageReady(pg);

          const rowId = door === 'owner' ? '#sec-owner-cred' : '#sec-mgmt-cred';
          await pg.locator(rowId).click();
          const dlg = pg.locator('#sec-verify-dlg');
          await expect(dlg).toBeVisible({ timeout: 10000 });

          if (state === 'default') {
            /* 默认态：方法列表 */
          } else {
            /* 展开态/报错态/键盘态：点开文本输入行（站长凭证门=根凭证行，管理凭证门=站长密码行） */
            const rowText = door === 'owner'
              ? (lang.name === 'en' ? 'Root credential' : '根凭证')
              : (lang.name === 'en' ? 'Owner password' : '站长密码');
            await pg.locator('.sgx-door-row').filter({ hasText: rowText }).click();
            const field = pg.locator('.sgx-door-expand input[type="password"]');
            await expect(field).toBeVisible({ timeout: 5000 });
            if (state === 'error') {
              await field.fill('wrong-value');
              await pg.locator('.sgx-door-btn-primary').click();
              await expect(pg.locator('.sgx-door-err:not([hidden])')).toBeVisible({ timeout: 8000 });
            }
          }
          /* 无横向溢出断言 */
          const overflow = await pg.evaluate(() => {
            const de = document.documentElement;
            return de.scrollWidth - de.clientWidth;
          });
          if (overflow > 1) throw new Error(`横向溢出 ${overflow}px on ${name}`);
          await expect(pg).toHaveScreenshot(`door-${door}-${state}-${lang.name}-${theme.name}.png`, { animations: 'disabled', caret: 'hide' });
        });
      }
    }
  }
}
