/**
 * 2.4.0 E：视觉回归测试。
 * 5 视口 × 中英 × 深浅色 × 主要页面（/、/settings/ 等；2026-10-22 /search/ 页删除（改成原地搜索层，见 baseline-search-open）；B2-2 删除 /store/，2026-10-19 删除 /files/，
 * 2026-10-20 /browser/ 拆成 /bookmarks/ + /search/，2026-10-21 主站书签下线（迁到 珍格 Curio），/bookmarks/ 截图删除）
 * + F 的基准（弹层打开）+ 导航抽屉打开（baseline-drawer-open）+ 快捷面板打开（baseline-quick-panel-open）。
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
/* 账号页（独立页 /account/，2026-10-22 从 /settings/account/ 挪出）三星式总览：/account/ 拍登录后的总览（登录区由下方 account-login-* 覆盖），
   新增安全与隐私子页 /account/security/（已过门；倒计时数字在截图里遮罩），
   账号信息子页 /account/profile/（已登录卡 + 退出账号） */
const PAGES = ['/', '/settings/', '/settings/security/', '/settings/security/lock/', '/account/', '/account/profile/', '/account/security/', '/account/reset/'];
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
          /* 关掉动画，保证截图稳定（goto 之前设置，context 级生效） */
          await pg.emulateMedia({ reducedMotion: 'reduce' });
          /* 定稿 #1：门内页探针需会话+票据都有效。视觉测试 mock 两者通过，
             避免探针失败弹 toast 导致截图不稳定。 */
          /* 安全页：GET /api/account 固定为「已设置、未登录账号」 */
          if (page === '/settings/security/') {
            await pg.route('**/api/account', async (route) => {
              await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ ok: true, password: true, passkey: true, ready: true, session: null }),
              });
            });
          }
          /* 账号总览 / 账号信息 / 安全与隐私子页：已登录账号（密码登录），已过门（倒计时数字遮罩），通行密钥列表固定一把 */
          if (page === '/account/' || page === '/account/profile/' || page === '/account/security/') {
            await pg.route('**/api/account', async (route) => {
              if (route.request().method() === 'GET') {
                await route.fulfill({
                  status: 200,
                  contentType: 'application/json',
                  body: JSON.stringify({ ok: true, password: true, passkey: true, ready: true, session: { by: 'password', authAt: 1760000000000, expiresAt: 4102444800000, recent: true }, door: { by: 'password', expiresAt: 4102444800000 } }),
                });
                return;
              }
              await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ ok: true, keys: [{ credId: 'k1', name: 'Galaxy S26 Ultra', provider: 'Samsung Pass', createdAt: 1760000000000, lastUsedAt: 1760000000000 }] }),
              });
            });
          }
          if (page === '/settings/security/lock/') {
            await pg.route('**/api/lock-status', async (route) => {
              await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ ok: true, password: false, passkey: false }),
              });
            });
            await pg.route('**/api/lock-door', async (route) => {
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
          /* 账号两页：等异步内容（总览 / 子页列表）落定再截图 */
          if (page === '/account/') await expect(pg.locator('#acct-main')).toBeVisible({ timeout: 10000 });
          if (page === '/account/profile/') await expect(pg.locator('#acct-profile')).toBeVisible({ timeout: 10000 });
          if (page === '/account/reset/') await expect(pg.locator('#sgx-reset-root')).toBeVisible({ timeout: 10000 });
          if (page === '/account/security/') {
            await expect(pg.locator('#lockmgr-pklist .lockmgr-pkitem')).toHaveCount(1, { timeout: 10000 });
            await expect(pg.locator('#sgx-door-countdown')).toBeVisible();
          }
          /* #1 诊断：构建标记小字只给真机看，视觉回归里隐藏，
             现有基线继续通过；诊断结束后删小字也不用再动基线。
             必须在 goto 之后注入（导航会丢掉之前 addStyleTag/addInitScript 加的样式，
             且 addInitScript 运行时 documentElement 还不存在）。 */
          await pg.addStyleTag({
            content: '.sgx-build-tag,.sgx-build-tag-wrap{display:none !important}',
          });
          await expect(pg).toHaveScreenshot(`${name}.png`, {
            fullPage: false,
            animations: 'disabled',
            /* 遮罩动态区域：时钟、天气、门内倒计时数字 */
            mask: [pg.locator('#dual-clock'), pg.locator('#weather'), pg.locator('#sgx-door-countdown .sgx-door-countdown-text')],
          });
        });
      }
    }
  }
}

/* F 基准 1：弹层打开（2.6.0 起日期时间行在子页；2026-10-23 PR-E 起在 /settings/advanced/） */
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
  await pg.goto('/settings/advanced/', { waitUntil: 'domcontentloaded' });
  await waitPageReady(pg);
  /* 2.8.0：等目标行就绪（可能在折叠区下方） */
  await pg.locator('#row-datetime').waitFor({ state: 'visible', timeout: 15000 });
  await pg.locator('#row-datetime').scrollIntoViewIfNeeded();
  await pg.click('#row-datetime');
  /* 等原生 dialog 弹层打开 */
  await expect(pg.locator('dialog[open]').first()).toBeVisible({ timeout: 10000 });
  await expect(pg).toHaveScreenshot('baseline-sheet-open.png', { animations: 'disabled' });
});

/* 导航抽屉打开（2026-10-20）：设置子页上点九宫格，抽屉滑入、设置项药丸高亮 */
test('baseline-drawer-open', async ({ page: pg }) => {
  await pg.setViewportSize(VIEWPORTS.mobile);
  await blockExternalRequests(pg);
  await pg.emulateMedia({ reducedMotion: 'reduce' });
  await pg.addInitScript(() => {
    try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
  });
  await pg.addStyleTag({
    content: 'html{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans CJK SC","Noto Sans CJK",sans-serif !important}',
  });
  await freezeTime(pg);
  await pg.goto('/settings/display/', { waitUntil: 'domcontentloaded' });
  await waitPageReady(pg);
  await pg.click('.sgx-tb-nav');
  await expect(pg.locator('#sgx-drawer.is-open')).toBeVisible({ timeout: 10000 });
  /* 等抽屉稳定在打开状态再截图（不拍滑入中途） */
  await expect(pg.locator('#sgx-drawer')).toHaveAttribute('data-state', 'open');
  await expect(pg).toHaveScreenshot('baseline-drawer-open.png', { animations: 'disabled' });
});

/* 原地搜索层打开（2026-10-22）：设置子页上开抽屉、点底栏搜索框；空输入背景「聚合搜索」；拍收起键盘后的样子（光标不稳定） */
test('baseline-search-open', async ({ page: pg }) => {
  await pg.setViewportSize(VIEWPORTS.mobile);
  await blockExternalRequests(pg);
  await pg.emulateMedia({ reducedMotion: 'reduce' });
  await pg.addInitScript(() => {
    try {
      localStorage.setItem('sgx-lang', 'zh');
    } catch (e) {}
  });
  await pg.addStyleTag({
    content: 'html{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans CJK SC","Noto Sans CJK",sans-serif !important}',
  });
  await freezeTime(pg);
  await pg.goto('/settings/display/', { waitUntil: 'domcontentloaded' });
  await waitPageReady(pg);
  await pg.click('.sgx-tb-nav');
  await expect(pg.locator('#sgx-drawer')).toHaveAttribute('data-state', 'open');
  await pg.click('#sgx-drawer a.sgx-drawer-search');
  await expect(pg.locator('#sgx-srch-input')).toBeFocused({ timeout: 10000 });
  await expect(pg.locator('.sgx-srch-empty')).toBeVisible();
  await pg.locator('#sgx-srch-input').blur();
  await expect(pg).toHaveScreenshot('baseline-search-open.png', { animations: 'disabled' });
});

/* 快捷面板打开（2026-10-20）：设置子页上点顶栏右侧滑块圆，面板从顶部滑下（与 baseline-drawer-open 同一写法） */
test('baseline-quick-panel-open', async ({ page: pg }) => {
  await pg.setViewportSize(VIEWPORTS.mobile);
  await blockExternalRequests(pg);
  await pg.emulateMedia({ reducedMotion: 'reduce' });
  await pg.addInitScript(() => {
    try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
  });
  await pg.addStyleTag({
    content: 'html{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans CJK SC","Noto Sans CJK",sans-serif !important}',
  });
  await freezeTime(pg);
  await pg.goto('/settings/display/', { waitUntil: 'domcontentloaded' });
  await waitPageReady(pg);
  await pg.click('.sgx-tb-quick');
  await expect(pg.locator('#sgx-qp.is-open')).toBeVisible({ timeout: 10000 });
  /* 等面板稳定在打开状态再截图（不拍滑下中途） */
  await expect(pg.locator('#sgx-qp')).toHaveAttribute('data-state', 'open');
  await expect(pg).toHaveScreenshot('baseline-quick-panel-open.png', { animations: 'disabled' });
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
/* 2026-10-24：账号登录与锁屏同一套界面 —— default（页面）/ sheet（点「登录」后的方式弹层）/ expanded（密码弹层，密码框聚焦）/ error（密码错误） */
const DOOR_STATES = ['default', 'sheet', 'expanded', 'error'];

for (const lang of DOOR_LANGS) {
  for (const theme of DOOR_THEMES) {
    /* 账号登录页（与锁屏同一套：头像 + 欢迎回来 + 登录 → 方式弹层 → 密码弹层）的默认 / 方式弹层 / 密码弹层 / 报错态 */
    for (const state of DOOR_STATES) {
      const name = `mobile-account-login-${state}-${lang.name}-${theme.name}`;
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
        /* 账号凭证已设置、未登录；报错态：密码登录一律 403 wrong */
        await pg.route('**/api/account', async (route) => {
          if (route.request().method() === 'GET') {
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, password: true, passkey: true, ready: true, session: null }) });
            return;
          }
          await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'wrong' }) });
        });
        await freezeTime(pg);
        await pg.goto(lang.prefix + '/account/', { waitUntil: 'domcontentloaded' });
        await waitPageReady(pg);
        await expect(pg.locator('#acct-login-go')).toBeVisible({ timeout: 10000 });
        if (state !== 'default') {
          await pg.click('#acct-login-go');
          await expect(pg.locator('#sgx-method-sheet.visible #acct-pw-btn')).toBeVisible({ timeout: 5000 });
        }
        if (state === 'expanded' || state === 'error') {
          await pg.click('#acct-pw-btn');
          const field = pg.locator('#acct-pw-input');
          await expect(field).toBeVisible({ timeout: 5000 });
          await expect(field).toBeFocused();
          if (state === 'error') {
            await field.fill('wrong-value');
            await pg.click('#acct-pw-go');
            await expect(pg.locator('#acct-pw-err:not([hidden])')).toBeVisible({ timeout: 8000 });
          }
        }
        const overflow = await pg.evaluate(() => {
          const de = document.documentElement;
          return de.scrollWidth - de.clientWidth;
        });
        if (overflow > 1) throw new Error(`横向溢出 ${overflow}px on ${name}`);
        await expect(pg).toHaveScreenshot(`account-login-${state}-${lang.name}-${theme.name}.png`, { animations: 'disabled', caret: 'hide' });
      });
    }
  }
}
