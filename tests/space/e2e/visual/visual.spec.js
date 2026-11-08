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
/* 2026-11 UI 重设计 PR-1：旧截图基线已删除（普通提交，不改历史），新精简基线在重设计最后一个 PR 重拍；
   在那之前不比截图（SHOTS = false），同一用例里的布局 / 行为断言照跑。重拍时改回 true。 */
const SHOTS = false;
const { blockExternalRequests, freezeTime, expect } = require('../helpers/helpers');

const VIEWPORTS = {
  mobile: { width: 412, height: 915 },
  landscape: { width: 915, height: 412 },
  tabletPortrait: { width: 800, height: 1280 },
  tabletLandscape: { width: 1280, height: 800 },
  desktop: { width: 1920, height: 1080 },
};
/* 安全与隐私：新页面加入视觉回归（先只报告，基线未生成前不阻塞） */
/* 2026-11-08 账号 UI 改版：/account/ 整页（总览 / 账号安全 / 重置 / 应用授权）删除，账号在头像下拉的账号终端里，
   截图改拍终端各层（见下「账号终端」一组）；原 /account/* 四页 × 5 视口 × 中英 × 深浅、account-login-* 和 account-sub-devices 一并删除 */
const PAGES = ['/', '/security/', '/security/lock/'];
const fxGrants = require('../../../fixtures/app-grants.cjs');
const fxStatus = require('../../../fixtures/status-summary.cjs');
const LANGS = [
  /* P4-3 PR-4c：英文无前缀、中文 /zh/（截图名不变） */
  { prefix: '/zh', name: 'zh' },
  { prefix: '', name: 'en' },
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
            await pg.route('**/api/account**', async (route) => {
              await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ ok: true, signing: true, configured: { password: true, passkey: true }, session: null }),
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
          /* 2.8.0：语言跟随系统（2.7.0 起）会按浏览器 locale 跳到另一种语言（P4-3 PR-4c 起英文 /、中文 /zh/），
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
          if (SHOTS) await expect(pg).toHaveScreenshot(`${name}.png`, {
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

/** 快捷面板 / AI 窗口截图的共同准备：手机、减弱动效、中文、固定字体和时间，旷野子页 /wild/（P4-3 PR-4b 前是 /display/，显示页已删除） */
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
  await pg.goto('/zh/wild/', { waitUntil: 'domcontentloaded' }); /* P4-3 PR-4c：中文 /zh/ */
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
  if (SHOTS) await expect(pg).toHaveScreenshot('baseline-quick-panel-nav-open.png', { animations: 'disabled' });
});

/* 外观面板（2026-11 PR-1：MODE + PALETTE；分享 / 立即锁定搬进 NAVIGATE，四站同一套，主站也有分享） */
test('baseline-quick-panel-open', async ({ page: pg }) => {
  await shellShotPage(pg);
  await openQuickPanel(pg);
  await expect(pg.locator('#sgx-qp [data-qp-seg="mode"]')).toHaveCount(1);
  await expect(pg.locator('#sgx-qp [data-qp-palette]').first()).toBeVisible();
  await expect(pg.locator('#sgx-nav [data-qp="share"]')).toHaveCount(1);
  if (SHOTS) await expect(pg).toHaveScreenshot('baseline-quick-panel-open.png', { animations: 'disabled' });
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
  if (SHOTS) await expect(pg).toHaveScreenshot('baseline-ai-panel-open.png', { animations: 'disabled' });
});

/* ===== 账号终端（头像下拉 #sgx-acct，2026-11-08 账号 UI 改版，设计稿 acct-sec-redraw mock v3）=====
 * 手机 412×915 / 桌面 1920×1080 × 中英 × 深浅 × 七层：guest（未登录，sudo root 选方式）/ pw-error（密码输错一次）/ home（已登录主页）/
 * keys（账号安全，有 reauth 票，一把通行密钥）/ devices（两台）/ grants（5 个应用都已授权）/ reset（sudo root reset 恢复密钥输入）。
 * 截图名 <视口>-acct-<层>-<语言>-<主题>；倒计时（reauth · mm:ss / reset · mm:ss）遮罩。行为断言见 account/*.spec.js。 */
const ACCT_VPS = { mobile: VIEWPORTS.mobile, desktop: VIEWPORTS.desktop };
const ACCT_STATES = ['guest', 'pw-error', 'home', 'keys', 'devices', 'grants', 'reset'];
const FAR = 4102444800000;
const ACCT_DEVICES = [
  { deviceId: 'aaaaaaaaaaaaaaaa', current: true, name: 'Galaxy S25 Ultra', model: 'SM-S938B', platform: 'Android', browser: 'Samsung Internet', country: 'CN', by: 'passkey', lastSeen: 1760000000000 },
  { deviceId: 'bbbbbbbbbbbbbbbb', current: false, name: 'iPad', platform: 'iOS', browser: 'Safari', country: 'CN', lastSeen: fxStatus.NOW - 3 * 3600 * 1000 },
];
for (const [vpName, vp] of Object.entries(ACCT_VPS)) {
  for (const lang of LANGS) {
    for (const theme of THEMES) {
      for (const state of ACCT_STATES) {
        const name = `${vpName}-acct-${state}-${lang.name}-${theme.name}`;
        test(name, async ({ page: pg }) => {
          await pg.setViewportSize(vp);
          await blockExternalRequests(pg);
          await pg.emulateMedia({ reducedMotion: 'reduce' });
          const signedIn = state !== 'guest' && state !== 'pw-error' && state !== 'reset';
          await pg.route('**/api/account**', async (route) => {
            const req = route.request();
            const ok = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
            if (req.method() === 'GET') {
              return ok({ ok: true, signing: true, configured: { password: true, passkey: true },
                session: signedIn ? { by: 'passkey', device: 'Galaxy S25 Ultra', authAt: 1760000000000, expiresAt: FAR } : null,
                reauth: state === 'keys' ? { by: 'passkey', expiresAt: FAR } : null });
            }
            const b = JSON.parse(req.postData() || '{}');
            /* POST /api/account/<入口> { action }（NAMING-V2 P2） */
            const a = (new URL(req.url()).pathname.split('/')[3] || '') + '/' + b.action;
            if (a === 'session/password') return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'wrong' }) });
            if (a === 'grants/list') return ok({ ok: true, grants: fxGrants.grants() });
            if (a === 'devices/list') return ok({ ok: true, devices: ACCT_DEVICES });
            if (a === 'keys/passkey-list' || a === 'reset/passkey-list') return ok({ ok: true, keys: [{ credId: 'k1', name: 'Galaxy S26 Ultra', provider: 'samsung-pass', createdAt: 1760000000000, lastUsedAt: 1760000000000 }] });
            return ok({ ok: true });
          });
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
          const hash = state === 'reset' ? '#acct=reset' : state === 'keys' ? '#acct=security' : state === 'devices' ? '#acct=devices' : state === 'grants' ? '#acct=apps' : '#acct';
          await pg.goto(lang.prefix + '/wild/' + hash, { waitUntil: 'domcontentloaded' });
          await waitPageReady(pg);
          const d = pg.locator('#sgx-acct');
          await expect(d).toHaveAttribute('data-state', 'open', { timeout: 10000 });
          const at = d.locator('.sgx-at');
          if (state === 'guest' || state === 'pw-error') {
            await expect(at).toHaveAttribute('data-at-mode', 'pick', { timeout: 10000 });
            if (state === 'pw-error') {
              await d.locator('[data-at-pick="2"]').click();
              await d.locator('[data-at-in]').fill('wrong-value');
              await d.locator('[data-at-in]').press('Enter');
              await expect(d.locator('.sgx-at-l--er')).toHaveCount(1, { timeout: 8000 });
            }
          } else if (state === 'reset') {
            await expect(at).toHaveAttribute('data-at-mode', 'rkey', { timeout: 10000 });
          } else {
            await expect(at).toHaveAttribute('data-at-layer', state, { timeout: 10000 });
            if (state === 'keys') await expect(d.locator('.sgx-at-nm')).toHaveCount(1, { timeout: 10000 });
            if (state === 'devices') await expect(d.locator('.sgx-at-hv')).not.toHaveText('');
            if (state === 'grants') await expect(d.locator('.sgx-at-app')).toHaveCount(5, { timeout: 10000 });
            if (state === 'home') await expect(d.locator('[data-at-v="grants"] .sgx-pop-v')).toHaveText('5');
          }
          await pg.evaluate(() => { const a = /** @type {HTMLElement|null} */ (document.activeElement); if (a) a.blur(); });
          /* 面板在视口里、不横向溢出 */
          const m = await pg.evaluate(() => {
            const de = document.documentElement;
            const r = document.querySelector('#sgx-acct .sgx-qp-sheet').getBoundingClientRect();
            return { overflow: de.scrollWidth - de.clientWidth, l: r.left, r: r.right, vw: innerWidth };
          });
          if (m.overflow > 1) throw new Error(`横向溢出 ${m.overflow}px on ${name}`);
          expect(m.l).toBeGreaterThanOrEqual(-1);
          expect(m.r).toBeLessThanOrEqual(m.vw + 1);
          if (SHOTS) await expect(pg).toHaveScreenshot(`${name}.png`, { animations: 'disabled', caret: 'hide', mask: [d.locator('[data-at-cd]')] });
        });
      }
    }
  }
}

/* ===== 子页（只拍手机）：账号子页（2026-10-24 PR4）云同步（总开关 + 同步项）/ 设备（此设备卡：登录方式 + 退出账号）；
 * 设置里的门内页：服务状态（/status/，原顶栏「状态」页 → 账号页 → 设置）/ 临时钥匙（/security/tempkeys/，原账号 → 临时钥匙）=====
 * 截图名 mobile-<stem>-<lang>-<theme>：账号子页 stem = account-sub-<id>，旷野子页 stem = space-status / space-tempkeys（2026-11 从 account-sub-status / account-sub-tempkeys 改名为 settings-*，P4-3 PR-4b 再改 space-*，页面内容不变）。
 * 手机 412×915 × 中英 × 深浅色。/api/status 用 tests/fixtures/status-summary.cjs（含用量），/api/account 固定已登录（设置页不读它）、设备列表固定两台。 */
const SUB_PAGES = [
  /* 对齐 PR-B：服务状态并进旷野 /wild/（截图名留 space-status，新基线在重设计最后一个 PR 重拍） */
  ['space-status', '/wild/', async (pg) => { await expect(pg.locator('#st-root')).toHaveAttribute('data-state', 'ready', { timeout: 10000 }); }],
  /* 账号子页（云同步 2026-11-08 删除；设备随 /account/ 整页 2026-11-08 删除，改拍账号终端 devices 层，见上「账号终端」） */
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
        await pg.route('**/api/account**', async (route) => {
          if (route.request().method() === 'GET') {
            await route.fulfill({ status: 200, contentType: 'application/json',
              body: JSON.stringify({ ok: true, signing: true, configured: { password: true, passkey: true }, session: { by: 'passkey', authAt: 1760000000000, expiresAt: 4102444800000, recent: true } }) });
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
        if (SHOTS) await expect(pg).toHaveScreenshot(`${name}.png`, { fullPage: false, animations: 'disabled' });
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
      await pg.route('**/api/account**', (route) => route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, signing: true, configured: { password: true, passkey: true }, session: { by: 'passkey', authAt: 1760000000000, expiresAt: 4102444800000, recent: true } }) }));
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
      await pg.goto(lang.prefix + '/wild/', { waitUntil: 'domcontentloaded' });
      await waitPageReady(pg);
      await expect(pg.locator('#st-root')).toHaveAttribute('data-state', 'ready', { timeout: 10000 });
      await pg.locator('#st-audit summary').click();
      await expect(pg.locator('.st-audit-item')).toHaveCount(2, { timeout: 10000 });
      await expect(pg.locator('#st-audit-body')).toHaveAttribute('aria-busy', 'false');
      await pg.locator('#st-foot').scrollIntoViewIfNeeded();
      const overflow = await pg.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 1) throw new Error(`横向溢出 ${overflow}px on ${name}`);
      if (SHOTS) await expect(pg).toHaveScreenshot(`${name}.png`, { fullPage: false, animations: 'disabled' });
    });
  }
}
