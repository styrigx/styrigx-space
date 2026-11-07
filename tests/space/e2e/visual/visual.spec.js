/**
 * 2.4.0 E：视觉回归测试。
 * 5 视口 × 中英 × 深浅色 × 主要页面（/ 旷野页、/security/ 等；P4-3 PR-4b 主页和设置合成旷野页，原设置首页那组截图删除（内容并进 /）；2026-10-22 /search/ 页删除（改成原地搜索层，见 baseline-search-open）；B2-2 删除 /store/，2026-10-19 删除 /files/，
 * 2026-10-20 /browser/ 拆成 /bookmarks/ + /search/，2026-10-21 主站书签下线（迁到 奇趣 Curio），/bookmarks/ 截图删除）
 * + F 的基准（弹层打开）+ 快捷面板打开（第 1 页导航 baseline-quick-panel-nav-open、第 2 页快捷设置 baseline-quick-panel-open）+ AI 窗口打开（baseline-ai-panel-open）。
 * 2026-11-04 P5-1（顶栏全大椭圆，方案 6.6）：全部重拍；baseline-drawer-open（导航抽屉删了）换成 baseline-quick-panel-nav-open；
 * baseline-search-open 删除、不重拍（导航页不放搜索框，搜索层在 P4-2 随页面退役，定案第 2 条）。
 * 首次运行：npx playwright test --update-snapshots 生成基准；
 * 后续运行自动对比，不一致即失败。
 *
 * Hark：goto 用 domcontentloaded + 等具体元素，不用 networkidle
 * （CI 里外部请求会让 networkidle 永远等不到）；删掉全部 waitForTimeout。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('../helpers/helpers');

const VIEWPORTS = {
  mobile: { width: 412, height: 915 },
  landscape: { width: 915, height: 412 },
  tabletPortrait: { width: 800, height: 1280 },
  tabletLandscape: { width: 1280, height: 800 },
  desktop: { width: 1920, height: 1080 },
};
/* 安全与隐私：新页面加入视觉回归（先只报告，基线未生成前不阻塞） */
/* 账号页（独立页 /account/，2026-10-22 从设置下的 account 子页挪出）三星式总览：/account/ 拍登录后的总览（登录区由下方 account-login-* 覆盖），
   P4-2d 起总览多一组「AI 模型」（/api/ai 打桩，副标题固定 Gemma 4），
   新增安全与隐私子页 /account/security/（已过门；倒计时数字在截图里遮罩），
   账号信息子页 /account/profile/ 2026-10-24 PR4 删除（登录方式 / 退出账号挪进设备页「此设备」卡），截图一并删除；
   PR4 新增的账号子页（云同步 / 设备）只拍手机，见文件末尾 account-sub-*；服务状态、临时钥匙搬到设置后也只拍手机，见文件末尾 space-status-* / space-tempkeys-*（P4-3 PR-4b 从 settings-* 改名） */
/* P3-1：应用授权子页 /account/apps/ 按账号页惯例拍 5 视口 × 中英 × 深浅（20 张，Gray 2026-11-06 确认），5 张卡都已授权（含搜索框与过滤 chips） */
const PAGES = ['/', '/security/', '/security/lock/', '/account/', '/account/security/', '/account/reset/', '/account/apps/'];
const fxGrants = require('../../../fixtures/app-grants.cjs');
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
          if (page === '/security/') {
            await pg.route('**/api/account', async (route) => {
              await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ ok: true, password: true, passkey: true, ready: true, session: null }),
              });
            });
          }
          /* 账号总览 / 账号信息 / 安全与隐私子页：已登录账号（密码登录），已过门（倒计时数字遮罩），通行密钥列表固定一把 */
          if (page === '/account/' || page === '/account/security/') {
            await pg.route('**/api/account', async (route) => {
              if (route.request().method() === 'GET') {
                await route.fulfill({
                  status: 200,
                  contentType: 'application/json',
                  body: JSON.stringify({ ok: true, password: true, passkey: true, ready: true, session: { by: 'password', authAt: 1760000000000, expiresAt: 4102444800000, recent: true }, reauth: { by: 'password', expiresAt: 4102444800000 } }),
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
          /* 应用授权（P3-1）：已登录账号，grant-list 固定 5 个应用都已授权（fixtures/app-grants.cjs，授权时间固定） */
          if (page === '/account/apps/') {
            await pg.route('**/api/account', async (route) => {
              if (route.request().method() === 'GET') {
                await route.fulfill({ status: 200, contentType: 'application/json',
                  body: JSON.stringify({ ok: true, password: true, passkey: true, ready: true, session: { by: 'passkey', authAt: 1760000000000, expiresAt: 4102444800000 } }) });
                return;
              }
              await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, grants: fxGrants.grants() }) });
            });
          }
          /* 账号总览「AI 模型」一行（P4-2d）：GET /api/ai 固定两条模型、能切、没选过（副标题 = 默认模型 Gemma 4） */
          if (page === '/account/') {
            await pg.route('**/api/ai', async (route) => {
              await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ ok: true, default: '@cf/google/gemma-4-26b-a4b-it', canChoose: true, models: [
                  { id: '@cf/google/gemma-4-26b-a4b-it', label: 'Gemma 4', provider: 'workers-ai' },
                  { id: '@cf/openai/gpt-oss-20b', label: 'GPT-OSS 20B', provider: 'workers-ai' },
                ] }),
              });
            });
          }
          if (page === '/security/lock/') {
            await pg.route('**/api/lock-credentials', async (route) => {
              await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ ok: true, password: false, passkey: false }),
              });
            });
            await pg.route('**/api/lock-reauth', async (route) => {
              await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ ok: true, valid: true }),
              });
            });
            /* 门内列表 API：返回空列表，保证截图稳定 */
            await pg.route('**/api/lock-passkey', async (route) => {
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
          if (page === '/account/') {
            await expect(pg.locator('#acct-main')).toBeVisible({ timeout: 10000 });
            await expect(pg.locator('#acct-ai-sub')).toHaveText('Gemma 4');
          }
          if (page === '/account/reset/') await expect(pg.locator('#sgx-reset-root')).toBeVisible({ timeout: 10000 });
          if (page === '/account/apps/') await expect(pg.locator('#acct-apps-list .acct-app-card')).toHaveCount(5, { timeout: 10000 });
          if (page === '/account/security/') {
            await expect(pg.locator('#lockmgr-pklist .lockmgr-pkitem')).toHaveCount(1, { timeout: 10000 });
            await expect(pg.locator('#sgx-credential-countdown')).toBeVisible();
          }
          await expect(pg).toHaveScreenshot(`${name}.png`, {
            fullPage: false,
            animations: 'disabled',
            /* 遮罩动态区域：门内倒计时数字（P4-2c 起首页时钟、天气已删） */
            mask: [pg.locator('#sgx-credential-countdown .sgx-credential-countdown-text')],
          });
        });
      }
    }
  }
}

/* F 基准 1（日期和时间弹层）P4-2c 随日期和时间设置一起删除 */

/** 快捷面板 / AI 窗口截图的共同准备：手机、减弱动效、中文、固定字体和时间，旷野子页 /theme/（P4-3 PR-4b 前是 /display/，显示页已删除） */
async function shellShotPage(pg) {
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
  await pg.goto('/theme/', { waitUntil: 'domcontentloaded' });
  await waitPageReady(pg);
}
/** 点快捷面板图标，等面板稳定在打开状态（不拍滑下中途）。2026-11-07 PR-4b 2/2：快捷面板只有一页（没有导航 / 快捷设置两页），导航搬到九宫格面板 */
async function openQuickPanel(pg) {
  await pg.click('.sgx-tb-quick');
  await expect(pg.locator('#sgx-qp.is-open')).toBeVisible({ timeout: 10000 });
  await expect(pg.locator('#sgx-qp')).toHaveAttribute('data-state', 'open');
}
/** 点九宫格图标，等导航面板稳定在打开状态 */
async function openNavPanel(pg) {
  await pg.click('.sgx-tb-grid');
  await expect(pg.locator('.sgx-tb-grid')).toHaveAttribute('aria-expanded', 'true');
  await expect(pg.locator('#sgx-nav')).toHaveAttribute('data-state', 'open');
  await expect(pg.locator('#sgx-nav')).toBeVisible({ timeout: 10000 });
}

/* 导航面板（2026-11-07 PR-4b 2/2 起是九宫格面板，不再是快捷面板第 1 页；文件名沿用）：设置子页上点顶栏九宫格，面板落下，主站当前项高亮 */
test('baseline-quick-panel-nav-open', async ({ page: pg }) => {
  await shellShotPage(pg);
  await openNavPanel(pg);
  await expect(pg).toHaveScreenshot('baseline-quick-panel-nav-open.png', { animations: 'disabled' });
});

/* 快捷面板（2026-11-07 PR-4b 2/2 起只有一页，四站同一套：深色、跟随系统、分享、立即锁定四格，主站也有分享） */
test('baseline-quick-panel-open', async ({ page: pg }) => {
  await shellShotPage(pg);
  await openQuickPanel(pg);
  await expect(pg.locator('#sgx-qp [data-qp="share"]')).toHaveCount(1);
  await expect(pg).toHaveScreenshot('baseline-quick-panel-open.png', { animations: 'disabled' });
});

/* AI 窗口打开（2026-11-04 P5-1，方案 5.5）：空状态（没有历史），落在顶栏下方，和快捷面板同一种形式 */
test('baseline-ai-panel-open', async ({ page: pg }) => {
  await shellShotPage(pg);
  await pg.click('.sgx-tb-ai');
  await expect(pg.locator('#sgx-ai.is-open')).toBeVisible({ timeout: 10000 });
  await expect(pg.locator('#sgx-ai')).toHaveAttribute('data-state', 'open');
  await expect(pg.locator('#sgx-ai .sgx-ai-msg[data-greet]')).toBeVisible();
  /* 焦点在窗口里（光标闪烁不稳定）：拍之前移走 */
  await pg.evaluate(() => /** @type {HTMLElement} */ (document.activeElement).blur());
  await expect(pg).toHaveScreenshot('baseline-ai-panel-open.png', { animations: 'disabled' });
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

/* ===== 子页（只拍手机）：账号子页（2026-10-24 PR4）云同步（总开关 + 同步项）/ 设备（此设备卡：登录方式 + 退出账号）；
 * 设置里的门内页：服务状态（/status/，原顶栏「状态」页 → 账号页 → 设置）/ 临时钥匙（/security/tempkeys/，原账号 → 临时钥匙）=====
 * 截图名 mobile-<stem>-<lang>-<theme>：账号子页 stem = account-sub-<id>，旷野子页 stem = space-status / space-tempkeys（2026-11 从 account-sub-status / account-sub-tempkeys 改名为 settings-*，P4-3 PR-4b 再改 space-*，页面内容不变）。
 * 手机 412×915 × 中英 × 深浅色。/api/status 用 tests/fixtures/status-summary.cjs（含用量），/api/account 固定已登录（设置页不读它）、设备列表固定两台。 */
const fxStatus = require('../../../fixtures/status-summary.cjs');
const SUB_PAGES = [
  ['space-status', '/status/', async (pg) => { await expect(pg.locator('#st-root')).toHaveAttribute('data-state', 'ready', { timeout: 10000 }); }],
  ['account-sub-sync', '/account/sync/', async (pg) => { await expect(pg.locator('[data-sync-key="sgx-theme-mode"] [data-sync-val]')).not.toHaveText('', { timeout: 10000 }); }],
  ['account-sub-devices', '/account/devices/', async (pg) => { await expect(pg.locator('#acct-devices')).toBeVisible({ timeout: 10000 }); await expect(pg.locator('#acct-by')).not.toHaveText(''); }],
  /* 2026-10-24 分享短链：临时钥匙页（临时钥匙 + 分享短链两张列表），数据见 tests/fixtures/share-links.cjs */
  ['space-tempkeys', '/security/tempkeys/', async (pg) => { await expect(pg.locator('#acct-sl-list .sl-item')).toHaveCount(3, { timeout: 10000 }); await expect(pg.locator('#acct-tk-list .acct-dev-item')).toHaveCount(1); }],
];
const fxShare = require('../../../fixtures/share-links.cjs');
for (const lang of LANGS) {
  for (const theme of THEMES) {
    for (const [stem, path, ready] of SUB_PAGES) {
      const name = `mobile-${stem}-${lang.name}-${theme.name}`;
      test(name, async ({ page: pg }) => {
        await pg.setViewportSize(VIEWPORTS.mobile);
        await blockExternalRequests(pg);
        await pg.emulateMedia({ reducedMotion: 'reduce' });
        await pg.route('**/api/account', async (route) => {
          if (route.request().method() === 'GET') {
            await route.fulfill({ status: 200, contentType: 'application/json',
              body: JSON.stringify({ ok: true, password: true, passkey: true, ready: true, session: { by: 'passkey', authAt: 1760000000000, expiresAt: 4102444800000, recent: true } }) });
            return;
          }
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, keys: [], devices: [
            { deviceId: 'aaaaaaaaaaaaaaaa', current: true, name: 'Galaxy S25 Ultra', model: 'SM-S938B', platform: 'Android', browser: 'Samsung Internet', country: 'CN', by: 'passkey', lastSeen: 1760000000000 },
            { deviceId: 'bbbbbbbbbbbbbbbb', current: false, name: 'iPad', platform: 'iOS', browser: 'Safari', country: 'CN', lastSeen: fxStatus.NOW - 3 * 3600 * 1000 },
          ] }) });
        });
        await pg.route('**/api/status', (route) => route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify(fxStatus.withUsage(fxStatus.normal(), fxStatus.usage())) }));
        await pg.route('**/api/lock-tempkey', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, keys: fxShare.KEYS }) }));
        await pg.route('**/api/share', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, links: fxShare.LINKS }) }));
        await pg.addInitScript(([t, ln]) => {
          try {
            if (t === 'dark') localStorage.setItem('sgx-theme-mode', 'dark');
            localStorage.setItem('sgx-lang', ln);
          } catch (e) {}
        }, [theme.setup, lang.name]);
        await pg.addStyleTag({
          content: 'html{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans CJK SC","Noto Sans CJK",sans-serif !important}',
        });
        await freezeTime(pg);
        await pg.goto(lang.prefix + path, { waitUntil: 'domcontentloaded' });
        await waitPageReady(pg);
        await ready(pg);
        await expect(pg).toHaveScreenshot(`${name}.png`, { fullPage: false, animations: 'disabled' });
      });
    }
  }
}

/* ===== 服务状态页底「进站凭证使用记录」展开态（2026-10-26）：手机 412×915 × 中英 × 深浅色 =====
 * 默认收起态已在 mobile-space-status-*（首屏，不含页底折叠区）；这里点开摘要、等两条记录渲染完，把折叠区滚到视口里拍首屏。
 * 数据：/api/status 同 space-status；/api/space-audit 固定两条（一条成功、一条失败），时间相对 fxStatus.NOW。 */
const AUDIT_ITEMS = [
  { ts: fxStatus.NOW - 30 * 60 * 1000, ipPrefix: '203.0.113.x', ok: true },
  { ts: fxStatus.NOW - 26 * 3600 * 1000, ipPrefix: '2001:db8:1:2::x', ok: false },
];
for (const lang of LANGS) {
  for (const theme of THEMES) {
    const name = `mobile-space-status-audit-open-${lang.name}-${theme.name}`;
    test(name, async ({ page: pg }) => {
      await pg.setViewportSize(VIEWPORTS.mobile);
      await blockExternalRequests(pg);
      await pg.emulateMedia({ reducedMotion: 'reduce' });
      await pg.route('**/api/account', (route) => route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, password: true, passkey: true, ready: true, session: { by: 'passkey', authAt: 1760000000000, expiresAt: 4102444800000, recent: true } }) }));
      await pg.route('**/api/status', (route) => route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(fxStatus.withUsage(fxStatus.normal(), fxStatus.usage())) }));
      await pg.route('**/api/space-audit', (route) => route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, items: AUDIT_ITEMS }) }));
      await pg.addInitScript(([t, ln]) => {
        try {
          if (t === 'dark') localStorage.setItem('sgx-theme-mode', 'dark');
          localStorage.setItem('sgx-lang', ln);
        } catch (e) {}
      }, [theme.setup, lang.name]);
      await pg.addStyleTag({
        content: 'html{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans CJK SC","Noto Sans CJK",sans-serif !important}',
      });
      await freezeTime(pg);
      await pg.goto(lang.prefix + '/status/', { waitUntil: 'domcontentloaded' });
      await waitPageReady(pg);
      await expect(pg.locator('#st-root')).toHaveAttribute('data-state', 'ready', { timeout: 10000 });
      await pg.locator('#st-audit summary').click();
      await expect(pg.locator('.st-audit-item')).toHaveCount(2, { timeout: 10000 });
      await expect(pg.locator('#st-audit-body')).toHaveAttribute('aria-busy', 'false');
      await pg.locator('#st-foot').scrollIntoViewIfNeeded();
      const overflow = await pg.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 1) throw new Error(`横向溢出 ${overflow}px on ${name}`);
      await expect(pg).toHaveScreenshot(`${name}.png`, { fullPage: false, animations: 'disabled' });
    });
  }
}
