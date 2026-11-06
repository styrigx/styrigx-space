/**
 * 顶栏 + 快捷面板 + AI 窗口（2026-11-04 P5-1，方案 6.2–6.5 / 5.5）验收。原 nav-drawer.spec.js（九宫格导航抽屉）删除，导航并进快捷面板第 1 页。
 * - 顶栏一整条胶囊 .sgx-topbar = [logo .sgx-tb-logo][中间 .sgx-tb-pill：主站标签 / 页名][右边 .sgx-tb-acts：快捷面板 .sgx-tb-quick · AI .sgx-tb-ai · 头像 .sgx-tb-me]；
 *   没有九宫格 .sgx-tb-nav、导航抽屉 #sgx-drawer、右圆 .sgx-tb-end；头像在最右，点了进账号页；窄屏（< 400px）logo 换成圆点简版。
 * - 快捷面板 #sgx-qp（非模态 <dialog> show()，dialog 本身是遮罩，只盖顶栏下沿以下）；面板顶边在顶栏下沿下面，正文不动。
 *   两页：「导航」（站点列表，当前站高亮，没有搜索框）/「快捷设置」（磁贴 + 调色板 + 布局）；顶部两个页签（role=tablist，点 / 左右键切换），
 *   下面横向 scroll-snap 左右滑；不在当前页的那页 inert；每次打开默认在第 1 页「导航」。
 * - 顶栏不被盖住、不被压暗：面板开着时 elementFromPoint(图标中心) 仍是图标；图标 aria-expanded="true" + 按下态，再点（真点击）关闭。
 * - 关闭：再点图标 / 点遮罩 / Esc / 系统返回（历史哨兵，只关面板不离开页面）/ 点顶栏别的按钮（先关面板再执行）；刚点开立刻 Esc 也能关（竞态回归）。
 * - 快捷面板和 AI 窗口互斥：开一个就先关另一个。
 * - 焦点：打开进面板，关上回到图标；Tab 在「图标 + 面板控件」里循环。
 * - 手机：左右对齐顶栏页边距 16px、最宽 480 居中；宽屏（≥ 980px）宽 400，右缘对齐顶栏右缘。
 * - 磁贴只放设置里已有的项，写的是和设置页同一个 localStorage key（同一套 setter，lib/prefs.js），即时生效、不刷新；设置页随之同步显示。
 *   主站：深色模式 | 跟随系统、语言 | 立即锁定，下面调色板（22 套）、布局；主站任何页面都没有「分享本页」磁贴（定案第 4 条，模板层不输出）。
 * - 390px 宽：长条页名放得下「安全」，英文长页名省略号，不压到两端图标。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('../helpers/helpers');

test.use({ viewport: { width: 412, height: 915 }, colorScheme: 'light' });

async function go(page, path, lang = 'zh', freeze = true) {
  await blockExternalRequests(page);
  /* 冻结时间会让 Date.now() 恒定，立即锁定的防误触窗口（400ms）永远过不去，那条测试不冻结 */
  if (freeze) await freezeTime(page);
  /* 只在没有偏好时写（语言磁贴切换后不要被 init script 改回去） */
  await page.addInitScript((l) => {
    try { if (!localStorage.getItem('sgx-lang')) localStorage.setItem('sgx-lang', l); } catch (e) {}
  }, lang);
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
}

const qp = (page) => page.locator('#sgx-qp');
const tile = (page, id) => page.locator(`#sgx-qp [data-qp="${id}"]`);
const ls = (page, k) => page.evaluate((key) => localStorage.getItem(key), k);

/**
 * 打开快捷面板。pg = 'set'（默认）：再切到第 2 页「快捷设置」（磁贴都在那页）；'nav'：停在默认的第 1 页「导航」。
 */
async function openQp(page, pg = 'set') {
  await page.locator('.sgx-tb-quick').click();
  await expect(qp(page)).toBeVisible();
  await expect(qp(page)).toHaveClass(/\bis-open\b/);
  /* 等滑下结束（data-state=open）；is-open 只是过渡起点 */
  await expect(qp(page)).toHaveAttribute('data-state', 'open');
  /* data-state=open 可能早于过渡尾巴结束（CI 机器慢时差几像素）：等面板内所有过渡跑完再量 */
  await page.waitForFunction(() => document.getElementById('sgx-qp').getAnimations({ subtree: true }).every((a) => a.playState !== 'running'));
  /* 每次打开默认在第 1 页 */
  await expect(page.locator('#sgx-qp-tab-nav')).toHaveAttribute('aria-selected', 'true');
  if (pg === 'set') await qpPage(page, 'set');
}
/** 切到快捷面板某一页（点页签），等横向滚动停在那一页、另一页 inert */
async function qpPage(page, pg) {
  await page.locator(`#sgx-qp-tab-${pg}`).click();
  await expectQpPage(page, pg);
}
async function expectQpPage(page, pg) {
  const other = pg === 'set' ? 'nav' : 'set';
  await expect(page.locator(`#sgx-qp-tab-${pg}`)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator(`#sgx-qp-tab-${other}`)).toHaveAttribute('aria-selected', 'false');
  await expect(page.locator(`#sgx-qp-page-${other}`)).toHaveAttribute('inert', '');
  await expect(page.locator(`#sgx-qp-page-${pg}`)).not.toHaveAttribute('inert', '');
  /* 滚动停在这一页（左缘对齐翻页容器左缘） */
  await expect.poll(() => page.evaluate((id) => {
    const pages = document.querySelector('#sgx-qp [data-qp-pages]');
    const pr = pages.getBoundingClientRect();
    const r = document.getElementById('sgx-qp-page-' + id).getBoundingClientRect();
    return Math.abs(r.left - pr.left) <= 1;
  }, pg)).toBe(true);
}
/** #sgx-main 第一块内容的位置（覆盖层开合不该动它） */
const mainTop = (page) => page.evaluate(() => {
  const m = document.getElementById('sgx-main');
  const el = Array.from(m.children).find((c) => c.getBoundingClientRect().height > 0) || m;
  return { main: m.getBoundingClientRect().top, first: el.getBoundingClientRect().top, scroll: window.scrollY };
});
async function expectClosed(page) {
  await expect(qp(page)).toBeHidden();
  await expect(qp(page)).toHaveAttribute('data-state', 'closed');
  await expect(qp(page)).not.toHaveClass(/\bis-open\b/);
  await expect(page.locator('.sgx-tb-quick')).toHaveAttribute('aria-expanded', 'false');
}

test.describe('顶栏：一整条胶囊 [logo][中间][快捷面板 · AI · 头像]', () => {
  const TABS = (p) => p === '/' || p === '/settings/';
  const PAGES = ['/', '/settings/', '/settings/display/', '/settings/security/', '/account/'];
  for (const path of PAGES) {
    test(`${path}：logo · 长条（${TABS(path) ? '主页 / 设置两栏' : '只有页名'}）· 快捷面板 · AI · 头像；没有九宫格、抽屉、右圆、‹、⋮、搜索图标`, async ({ page }) => {
      await go(page, path);
      const order = await page.evaluate(() =>
        Array.from(document.querySelector('.sgx-topbar').children).map((el) => el.className.split(' ')[0]));
      expect(order).toEqual(['sgx-tb-logo', 'sgx-tb-pill', 'sgx-tb-acts']);
      const acts = await page.evaluate(() =>
        Array.from(document.querySelector('.sgx-tb-acts').children).map((el) => el.className.split(' ').filter((c) => c !== 'sgx-tb-btn')[0]));
      expect(acts).toEqual(['sgx-tb-quick', 'sgx-tb-ai', 'sgx-tb-me']);
      const inner = await page.evaluate(() =>
        Array.from(document.querySelector('.sgx-tb-pill').children).map((el) => el.className.split(' ')[0]));
      /* 主页、设置首页长条里是两栏标签（2026-11-04 P5-1 去掉聊天），其他页是页名 */
      expect(inner).toEqual([TABS(path) ? 'sgx-tb-tabs' : 'sgx-tb-title']);
      if (TABS(path)) await expect(page.locator('.sgx-tb-tab')).toHaveText(['主页', '设置']);
      /* 删掉的：九宫格、导航抽屉、右圆、返回 / 更多、长条里的搜索图标；主站没有分享磁贴（模板层不输出，定案第 4 条） */
      await expect(page.locator('.sgx-tb-nav, #sgx-drawer, .sgx-tb-end, .sgx-tb-share, .sgx-tb-back, [data-go-back], .sgx-tb-more, [data-tb-more], .sgx-tb-search, #sgx-tb-search')).toHaveCount(0);
      await expect(page.locator('[data-qp="share"], [data-sgx-share]')).toHaveCount(0);
      /* logo：字标，点了回本站首页 */
      const logo = page.locator('.sgx-topbar > a.sgx-tb-logo');
      await expect(logo).toHaveAttribute('href', '/');
      await expect(logo).toHaveAttribute('aria-label', 'Styrigx 首页');
      await expect(logo.locator('svg.sgx-wordmark')).toBeVisible();
      await expect(logo.locator('.sgx-tb-dot')).toBeHidden();
      const q = page.locator('.sgx-tb-quick');
      expect(await q.evaluate((el) => el.tagName)).toBe('BUTTON');
      await expect(q).toHaveAttribute('aria-label', '快捷面板');
      await expect(q).toHaveAttribute('aria-controls', 'sgx-qp');
      await expect(q).toHaveAttribute('aria-expanded', 'false');
      /* 打开的是对话框（覆盖层） */
      await expect(q).toHaveAttribute('aria-haspopup', 'dialog');
      const ai = page.locator('.sgx-tb-ai');
      expect(await ai.evaluate((el) => el.tagName)).toBe('BUTTON');
      await expect(ai).toHaveAttribute('aria-label', 'AI 助手');
      await expect(ai).toHaveAttribute('aria-controls', 'sgx-ai');
      await expect(ai).toHaveAttribute('aria-haspopup', 'dialog');
      await expect(ai).toHaveAttribute('aria-expanded', 'false');
      /* 头像最右：链账号页，头像图 /avatar/192.webp（data-sgx-avatar） */
      const me = page.locator('.sgx-tb-me');
      await expect(me).toHaveAttribute('href', '/account/');
      await expect(me).toHaveAttribute('aria-label', '账号');
      await expect(me.locator('img.sgx-tb-avatar')).toHaveAttribute('src', '/avatar/192.webp');
      await expect(me.locator('img.sgx-tb-avatar')).toHaveAttribute('data-sgx-avatar', '192');
      /* 尺寸：胶囊高 52、左右贴页边距 16；三个按钮 40px 圆，胶囊里上下居中；头像右缘离胶囊右缘 (52 - 40) / 2 = 6 */
      const g = await page.evaluate(() => {
        const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, r: b.right }; };
        return { tb: r('.sgx-topbar'), pill: r('.sgx-tb-pill'), logo: r('.sgx-tb-logo'), q: r('.sgx-tb-quick'), ai: r('.sgx-tb-ai'), me: r('.sgx-tb-me'),
          rad: getComputedStyle(document.querySelector('.sgx-topbar')).borderTopLeftRadius, sw: document.documentElement.scrollWidth };
      });
      expect(Math.round(g.tb.h)).toBe(52);
      expect(Math.abs(g.tb.x - 16)).toBeLessThanOrEqual(1);
      expect(Math.abs(412 - g.tb.r - 16)).toBeLessThanOrEqual(1);
      expect(parseFloat(g.rad)).toBeGreaterThanOrEqual(26);
      for (const b of [g.q, g.ai, g.me]) {
        expect(Math.round(b.w)).toBe(40);
        expect(Math.round(b.h)).toBe(40);
        expect(Math.abs(b.y + b.h / 2 - (g.tb.y + g.tb.h / 2))).toBeLessThanOrEqual(1);
      }
      expect(g.logo.r).toBeLessThanOrEqual(g.pill.x + 1);
      expect(g.pill.x + g.pill.w).toBeLessThanOrEqual(g.q.x + 1);
      expect(g.q.x).toBeLessThan(g.ai.x);
      expect(g.ai.x).toBeLessThan(g.me.x);
      expect(Math.abs(g.tb.r - g.me.r - 6)).toBeLessThanOrEqual(1);
      expect(g.sw, '横向不溢出').toBe(412);
    });
  }

  test('点头像进账号页；点 logo 回首页', async ({ page }) => {
    await go(page, '/settings/display/');
    await page.locator('.sgx-tb-me').click();
    await expect(page).toHaveURL(/\/account\/$/);
    await expect(page.locator('.sgx-topbar')).toBeVisible();
    await page.locator('.sgx-tb-logo').click();
    await expect(page).toHaveURL(/localhost:\d+\/$/);
  });

  test('英文：logo / 快捷面板 / AI / 账号的读屏名，头像进 /en/account/', async ({ page }) => {
    await go(page, '/en/settings/', 'en');
    await expect(page.locator('.sgx-tb-logo')).toHaveAttribute('href', '/en/');
    await expect(page.locator('.sgx-tb-logo')).toHaveAttribute('aria-label', 'Styrigx home');
    await expect(page.locator('.sgx-tb-quick')).toHaveAttribute('aria-label', 'Quick panel');
    await expect(page.locator('.sgx-tb-ai')).toHaveAttribute('aria-label', 'Ask AI');
    await expect(page.locator('.sgx-tb-me')).toHaveAttribute('href', '/en/account/');
    await expect(page.locator('.sgx-tb-me')).toHaveAttribute('aria-label', 'Account');
    await expect(page.locator('.sgx-tb-tab')).toHaveText(['Home', 'Settings']);
  });

  for (const w of [360, 390]) {
    test(`窄屏 ${w}px：logo 换成圆点简版（< 400px），主页两栏和页名都不溢出、不折行`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: 800 });
      for (const path of ['/', '/settings/security/', '/en/', '/en/settings/security/']) {
        await go(page, path, path.startsWith('/en/') ? 'en' : 'zh');
        await expect(page.locator('.sgx-tb-logo svg.sgx-wordmark')).toBeHidden();
        await expect(page.locator('.sgx-tb-logo .sgx-tb-dot')).toBeVisible();
        const g = await page.evaluate(() => {
          const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, r: b.right }; };
          const pill = document.querySelector('.sgx-tb-pill');
          const kids = Array.from(pill.querySelectorAll('.sgx-tb-tab, .sgx-tb-title'));
          return { sw: document.documentElement.scrollWidth, tb: r('.sgx-topbar'), pill: r('.sgx-tb-pill'), logo: r('.sgx-tb-logo'), q: r('.sgx-tb-quick'),
            /* 每个标签只有一行（高度不超过一行字的 1.6 倍） */
            lines: kids.map((k) => { const cs = getComputedStyle(k); return k.getBoundingClientRect().height <= parseFloat(cs.lineHeight || '20') * 1.6 + 16; }),
            tabsOver: kids.filter((k) => k.classList.contains('sgx-tb-tab')).map((k) => k.scrollWidth > k.clientWidth + 1),
            tabsIn: kids.filter((k) => k.classList.contains('sgx-tb-tab')).every((k) => { const b = k.getBoundingClientRect(); const p = pill.getBoundingClientRect(); return b.left >= p.left - 0.5 && b.right <= p.right + 0.5; }) };
        });
        expect(g.sw, `${path}：横向不溢出`).toBe(w);
        expect(Math.abs(g.tb.r - (w - 16))).toBeLessThanOrEqual(1);
        expect(Math.round(g.logo.w)).toBe(40);
        expect(g.pill.x + g.pill.w).toBeLessThanOrEqual(g.q.x + 1);
        expect(g.lines.every(Boolean), `${path}：不折行`).toBe(true);
        expect(g.tabsOver.some(Boolean), `${path}：标签文字溢出`).toBe(false);
        expect(g.tabsIn, `${path}：标签在长条里`).toBe(true);
      }
    });
  }

  test('390px：「安全」「Security」完整显示（P4-2c 改名），更长的页名省略号，页名不出长条', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await go(page, '/settings/security/');
    const t = page.locator('.sgx-tb-title');
    await expect(t).toHaveText('安全');
    expect(await t.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.evaluate(() => localStorage.setItem('sgx-lang', 'en'));
    await page.goto('/en/settings/security/', { waitUntil: 'domcontentloaded' });
    await expect(t).toHaveText('Security');
    const st = await t.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, to: getComputedStyle(el).textOverflow }));
    expect(st.to).toBe('ellipsis');
    /* 2026-10-22：长条里没有图标了，390 宽放得下页名；更长的照样省略号 */
    expect(st.sw).toBeLessThanOrEqual(st.cw);
    await t.evaluate((el) => { el.textContent = 'A very long English page name that cannot fit'; });
    expect(await t.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    const tb = await t.boundingBox();
    const pill = await page.locator('.sgx-tb-pill').boundingBox();
    /* 页名在长条内居中（左右对称），不出长条 */
    expect(Math.abs(tb.x + tb.width / 2 - (pill.x + pill.width / 2))).toBeLessThanOrEqual(1);
    expect(tb.x).toBeGreaterThanOrEqual(pill.x);
    expect(tb.x + tb.width).toBeLessThanOrEqual(pill.x + pill.width);
  });
});

test.describe('快捷面板：开合', () => {
  for (const path of ['/', '/settings/']) {
    test(`${path}：点图标打开，面板落在顶栏下方（顶栏不被盖住、不压暗），正文不动；再点图标关闭`, async ({ page }) => {
      await go(page, path);
      await expect(page.locator('.sgx-tb-quick')).toHaveAttribute('aria-expanded', 'false');
      expect(await qp(page).evaluate((el) => el.tagName)).toBe('DIALOG');
      /* 不在正文流里 */
      expect(await qp(page).evaluate((el) => !!el.closest('#sgx-main'))).toBe(false);
      const before = await mainTop(page);
      const pressedOff = await page.locator('.sgx-tb-quick').evaluate((el) => getComputedStyle(el).backgroundColor);
      await openQp(page);
      /* 非模态（不进顶层，顶栏留在它上面） */
      expect(await qp(page).evaluate((el) => el.open && !el.matches(':modal'))).toBe(true);
      await expect(page.locator('.sgx-tb-quick')).toHaveAttribute('aria-expanded', 'true');
      expect(await page.locator('.sgx-tb-quick').evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(pressedOff);
      /* 正文位置不变（覆盖层不推开内容） */
      const after = await mainTop(page);
      expect(Math.abs(after.main - before.main)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(after.first - before.first)).toBeLessThanOrEqual(0.5);
      const g = await page.evaluate(() => {
        const r = (el) => el.getBoundingClientRect();
        const q = document.querySelector('.sgx-tb-quick');
        const qr = r(q);
        const hit = document.elementFromPoint(qr.left + qr.width / 2, qr.top + qr.height / 2);
        const pill = r(document.querySelector('.sgx-tb-pill'));
        const hitPill = document.elementFromPoint(pill.left + pill.width / 2, pill.top + pill.height / 2);
        const hitOf = (sel) => { const b = r(document.querySelector(sel)); const h = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!h && !!h.closest(sel); };
        const d = document.getElementById('sgx-qp');
        return { iconHit: !!hit && q.contains(hit), pillHit: !!hitPill && !!hitPill.closest('.sgx-topbar'),
          logoHit: hitOf('.sgx-tb-logo'), aiHit: hitOf('.sgx-tb-ai'), meHit: hitOf('.sgx-tb-me'),
          tb: r(document.querySelector('.sgx-topbar')), dlg: r(d), sheet: r(d.querySelector('.sgx-qp-sheet')),
          scrim: getComputedStyle(d).backgroundColor, rad: getComputedStyle(d.querySelector('.sgx-qp-sheet')).borderTopLeftRadius };
      });
      /* 顶栏在最上面：图标、长条、logo、AI、头像都还点得到 */
      expect(g.iconHit, '快捷面板图标中心被盖住了').toBe(true);
      expect(g.pillHit).toBe(true);
      expect(g.logoHit).toBe(true);
      expect(g.aiHit).toBe(true);
      expect(g.meHit).toBe(true);
      /* 遮罩 = dialog 本身（--sgx-scrim），上沿 = 顶栏下沿：顶栏不被压暗 */
      expect(g.scrim).not.toBe('rgba(0, 0, 0, 0)');
      expect(Math.abs(g.dlg.top - g.tb.bottom)).toBeLessThanOrEqual(1);
      expect(g.dlg.bottom).toBeGreaterThanOrEqual(914);
      /* 面板顶边在顶栏下沿下面 8px；手机左右对齐顶栏页边距 16px，圆角 28px */
      expect(g.sheet.top).toBeGreaterThanOrEqual(g.tb.bottom);
      expect(Math.abs(g.sheet.top - g.tb.bottom - 8)).toBeLessThanOrEqual(1);
      expect(Math.abs(g.sheet.left - 16)).toBeLessThanOrEqual(1);
      expect(Math.abs(g.sheet.left - g.tb.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(g.sheet.width - (412 - 32))).toBeLessThanOrEqual(1);
      expect(g.rad).toBe('28px');
      /* 没有内嵌版的把手 / 裁切层 */
      await expect(page.locator('.sgx-qp-handle, .sgx-qp-clip, .sgx-qp-all')).toHaveCount(0);
      /* 顶栏图标真点得到：再点关闭 */
      await page.locator('.sgx-tb-quick').click();
      await expectClosed(page);
      await expect(page).toHaveURL(path === '/' ? /localhost:\d+\/$/ : /\/settings\/$/);
      const back = await mainTop(page);
      expect(Math.abs(back.first - before.first)).toBeLessThanOrEqual(0.5);
    });
  }

  test('滑下：从顶栏底下钻出来（收起位置在遮罩上沿之外，被裁掉）', async ({ page }) => {
    await go(page, '/settings/');
    await page.evaluate(() => {
      const d = document.getElementById('sgx-qp');
      d.querySelector('.sgx-qp-sheet').style.transition = 'none';
      d.show();
    });
    const m = await page.evaluate(() => {
      const d = document.getElementById('sgx-qp');
      return { d: d.getBoundingClientRect().top, s: d.querySelector('.sgx-qp-sheet').getBoundingClientRect().bottom, of: getComputedStyle(d).overflow };
    });
    expect(m.of).toBe('hidden');
    expect(m.s).toBeLessThanOrEqual(m.d);
    await page.evaluate(() => document.getElementById('sgx-qp').close());
  });

  test('长条页名不再换成「快捷面板」（面板盖住顶栏，自己有标题）', async ({ page }) => {
    await go(page, '/settings/security/');
    expect(await page.locator('.sgx-tb-title').getAttribute('data-qp-label')).toBeNull();
    await openQp(page);
    const after = await page.locator('.sgx-tb-title').evaluate((el) => getComputedStyle(el, '::after').content);
    expect(['none', 'normal']).toContain(after);
    await expect(page.locator('.sgx-tb-title')).toHaveText('安全');
  });

  /** 能 Tab 到的面板控件（不在 inert 页里、tabindex ≥ 0、看得见）+ 图标 */
  const tabbables = (page) => page.evaluate(() => [document.querySelector('.sgx-tb-quick')].concat(Array.from(document.querySelectorAll('#sgx-qp a[href], #sgx-qp button:not([disabled])')))
    .filter((el) => el.offsetParent !== null && !el.closest('[inert]') && el.tabIndex >= 0).length);

  test('焦点：打开后在面板里；Tab 在图标 + 面板控件里循环（只含当前页）；Esc 关上后回到图标', async ({ page }) => {
    await go(page, '/settings/');
    /* 第 1 页「导航」：图标 + 当前页签 + 4 个站点 = 6（另一个页签 tabindex=-1，第 2 页 inert） */
    await openQp(page, 'nav');
    expect(await page.evaluate(() => document.getElementById('sgx-qp').contains(document.activeElement))).toBe(true);
    expect(await tabbables(page)).toBe(6);
    await qpPage(page, 'set');
    const inside = await page.evaluate(() => document.getElementById('sgx-qp').contains(document.activeElement));
    expect(inside).toBe(true);
    const allowed = () => page.evaluate(() => {
      const a = document.activeElement;
      return (document.getElementById('sgx-qp').contains(a) && !a.closest('[inert]')) || a === document.querySelector('.sgx-tb-quick');
    });
    let sawIcon = false;
    /* 第 2 页「快捷设置」：一圈 = 图标 + 当前页签 + 4 磁贴 + 恢复默认 + 七色调色板 22 + 布局可用 2（412 宽 DeX 置灰）= 31 下 */
    const LOOP = 31;
    expect(await tabbables(page)).toBe(LOOP);
    for (let i = 0; i < LOOP + 10; i++) {
      await page.keyboard.press('Tab');
      expect(await allowed()).toBe(true);
      if (await page.evaluate(() => document.activeElement === document.querySelector('.sgx-tb-quick'))) sawIcon = true;
    }
    expect(sawIcon).toBe(true);
    /* 从图标出发正好 LOOP 下回到图标 */
    await page.locator('.sgx-tb-quick').focus();
    for (let i = 0; i < LOOP - 1; i++) await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement === document.querySelector('.sgx-tb-quick'))).toBe(false);
    await page.keyboard.press('Tab');
    await expect(page.locator('.sgx-tb-quick')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    expect(await allowed()).toBe(true);
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await expect(page.locator('.sgx-tb-quick')).toBeFocused();
  });

  test('互斥：面板开着点 AI 图标 → 先关面板，再打开 AI 窗口；反过来也一样；都不在历史里留哨兵', async ({ page }) => {
    await go(page, '/settings/');
    const ai = page.locator('#sgx-ai');
    await openQp(page, 'nav');
    await page.locator('.sgx-tb-ai').click();
    await expectClosed(page);
    await expect(ai).toHaveAttribute('data-state', 'open');
    await expect(page.locator('.sgx-tb-ai')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#sgx-qp[open], #sgx-ai[open]')).toHaveCount(1);
    await page.locator('.sgx-tb-quick').click();
    await expect(ai).toBeHidden();
    await expect(page.locator('.sgx-tb-ai')).toHaveAttribute('aria-expanded', 'false');
    await expect(qp(page)).toHaveAttribute('data-state', 'open');
    await expect(page.locator('#sgx-qp[open], #sgx-ai[open]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await expect(page).toHaveURL(/\/settings\/$/);
    await expect.poll(() => page.evaluate(() => !!(history.state && (history.state.sgxQp || history.state.sgxAi)))).toBe(false);
  });

  test('面板开着点顶栏 logo / 头像：先关面板，再跳转（不留哨兵）', async ({ page }) => {
    await go(page, '/');
    await page.goto('/settings/display/', { waitUntil: 'domcontentloaded' });
    await openQp(page, 'nav');
    await page.locator('.sgx-tb-me').click();
    await expect(page).toHaveURL(/\/account\/$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/settings\/display\/$/);
    await expect(qp(page)).toBeHidden();
  });

  test('点遮罩关闭', async ({ page }) => {
    await go(page, '/settings/');
    await openQp(page);
    /* 遮罩在面板下面的正文区（真点击命中 dialog 本身） */
    expect(await page.evaluate(() => document.elementFromPoint(200, 900) === document.getElementById('sgx-qp'))).toBe(true);
    await page.mouse.click(200, 900);
    await expectClosed(page);
    await expect(page).toHaveURL(/\/settings\/$/);
  });

  test('点面板里的空白处不关闭', async ({ page }) => {
    await go(page, '/settings/');
    await openQp(page);
    /* 面板顶部内边距（页签上方的空白） */
    const sh = await page.locator('#sgx-qp .sgx-qp-sheet').boundingBox();
    await page.mouse.click(sh.x + sh.width / 2, sh.y + 5);
    await expect(qp(page)).toHaveAttribute('data-state', 'open');
  });

  test('Esc 关闭', async ({ page }) => {
    await go(page, '/settings/');
    await openQp(page);
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await expect(page).toHaveURL(/\/settings\/$/);
  });

  test('系统返回只关面板，停在本页；再返回才离开', async ({ page }) => {
    await go(page, '/');
    await page.goto('/settings/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-topbar')).toBeVisible();
    await openQp(page);
    await page.goBack();
    await expectClosed(page);
    await expect(page).toHaveURL(/\/settings\/$/);
    await page.goBack();
    await expect(page).toHaveURL(/localhost:\d+\/$/);
  });

  test('刚点开（滑下还没开始）就 Esc / 连点两下：照样关上，之后还能正常打开', async ({ page }) => {
    await go(page, '/settings/');
    /* 同一任务里点开再发 cancel（= Esc），保证落在 is-open 那两帧 rAF 之前 */
    await page.evaluate(() => {
      document.querySelector('.sgx-tb-quick').click();
      document.getElementById('sgx-qp').dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    await expectClosed(page);
    /* 真键盘：点开后立刻按 Esc */
    await page.locator('.sgx-tb-quick').click();
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await page.evaluate(() => {
      const b = document.querySelector('.sgx-tb-quick');
      b.click();
      b.click();
    });
    await expectClosed(page);
    /* 关完历史里不留哨兵 */
    await expect.poll(() => page.evaluate(() => !!(history.state && history.state.sgxQp))).toBe(false);
    await openQp(page);
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await expect(page).toHaveURL(/\/settings\/$/);
  });

  test('减弱动效：开合立刻到位', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await go(page, '/settings/');
    await page.locator('.sgx-tb-quick').click();
    await expect(qp(page)).toHaveAttribute('data-state', 'open');
    await page.keyboard.press('Escape');
    await expectClosed(page);
  });

  test('AI 窗口照常工作（共用状态机）：开、Esc 关、焦点回到 AI 图标', async ({ page }) => {
    await go(page, '/settings/');
    await page.locator('.sgx-tb-ai').click();
    await expect(page.locator('#sgx-ai')).toHaveAttribute('data-state', 'open');
    await page.keyboard.press('Escape');
    await expect(page.locator('#sgx-ai')).toBeHidden();
    await expect(page.locator('.sgx-tb-ai')).toBeFocused();
    await openQp(page);
    await page.keyboard.press('Escape');
    await expectClosed(page);
  });
});

test.describe('快捷面板：内容', () => {
  test('中文：磁贴与行（只有设置里已有的项）+ 全部设置', async ({ page }) => {
    await go(page, '/');
    await openQp(page);
    await expect(page.locator('#sgx-qp .sgx-qp-tile .sgx-qp-label')).toHaveText(['深色模式', '跟随系统', '语言', '立即锁定']);
    await expect(page.locator('#sgx-qp .sgx-qp-tile')).toHaveCount(4);
    /* 减弱动效、字体大小已删除（2026-10-23 PR-E） */
    await expect(page.locator('#sgx-qp [data-qp="motion"]')).toHaveCount(0);
    await expect(page.locator('#sgx-qp [data-qp-seg="font-size"]')).toHaveCount(0);
    await expect(page.locator('#sgx-qp .sgx-qp-row-label')).toHaveText(['调色板', '布局']);
    /* 2026-10-23 PR-G：22 套七色调色板一个网格（含默认 dustyblue 和普通色板 lake），都是光晕方块 .pal-tile，没有撞色胶囊 */
    await expect(page.locator('#sgx-qp [data-qp-palette]')).toHaveCount(22);
    await expect(page.locator('#sgx-qp .sgx-qp-sw.pal-tile')).toHaveCount(22);
    await expect(page.locator('#sgx-qp [data-qp-palette="lake"]')).toHaveCount(1);
    await expect(page.locator('#sgx-qp [data-qp-palette^="x"]')).toHaveCount(0);
    await expect(page.locator('#sgx-qp .swatch-clash')).toHaveCount(0);
    await expect(page.locator('#sgx-qp [data-qp-reset]')).toHaveText('恢复默认');
    await expect(page.locator('#sgx-qp [data-qp-seg="layout"] button')).toHaveText(['Mobile', 'Auto', 'DeX']);
    /* 2026-10-24 PR4：没有「快捷面板」标题和齿轮（全部设置），面板第一项就是磁贴网格；读屏名字仍是「快捷面板」（aria-label） */
    await expect(page.locator('#sgx-qp .sgx-qp-head, #sgx-qp .sgx-qp-title, #sgx-qp .sgx-qp-set, #sgx-qp .sgx-qp-all')).toHaveCount(0);
    await expect(page.locator('#sgx-qp a[href$="/settings/"]')).toHaveCount(0);
    await expect(qp(page)).toHaveAccessibleName('快捷面板');
    /* 面板第一项是两页的页签；第 2 页第一项就是磁贴网格 */
    expect(await page.locator('#sgx-qp .sgx-qp-sheet').evaluate((el) => el.firstElementChild.className)).toContain('sgx-qp-tabs');
    expect(await page.locator('#sgx-qp-page-set').evaluate((el) => el.firstElementChild.className)).toContain('sgx-qp-grid');
    await expect(page.locator('#sgx-qp [role="tab"]')).toHaveText(['导航', '快捷设置']);
    /* 主站没有「分享本页」磁贴（定案第 4 条） */
    await expect(page.locator('#sgx-qp [data-qp="share"]')).toHaveCount(0);
    await expect(page.locator('#sgx-qp')).not.toContainText('快捷面板');
    /* 默认：浅色、跟随系统开、默认色板（恢复默认置灰，默认 dustyblue 色块选中）、自动布局 */
    await expect(tile(page, 'dark')).toHaveAttribute('aria-pressed', 'false');
    await expect(tile(page, 'dark').locator('[data-qp-state]')).toHaveText('关');
    await expect(tile(page, 'system')).toHaveAttribute('aria-pressed', 'true');
    await expect(tile(page, 'system').locator('[data-qp-state]')).toHaveText('开');
    await expect(tile(page, 'lang').locator('.sgx-qp-state')).toHaveText('中文');
    await expect(page.locator('#sgx-qp [data-qp-reset]')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('#sgx-qp [data-qp-palette][aria-pressed="true"]')).toHaveCount(1);
    await expect(page.locator('#sgx-qp [data-qp-palette="dustyblue"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#sgx-qp [data-qp-seg="layout"] [data-v="auto"]')).toHaveAttribute('aria-pressed', 'true');
    /* 开着的磁贴是主色容器底色 */
    const on = await tile(page, 'system').evaluate((el) => getComputedStyle(el).backgroundColor);
    const off = await tile(page, 'dark').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(on).not.toBe(off);
  });

  test('排版：深色模式 | 跟随系统、语言 | 立即锁定两两一行（半宽），下面调色板、布局；412 / 360 / 宽屏都不溢出', async ({ page }) => {
    for (const vp of [{ width: 412, height: 915 }, { width: 360, height: 800 }, { width: 1366, height: 768 }]) {
      await page.setViewportSize(vp);
      await go(page, '/settings/');
      await openQp(page);
      const g = await page.evaluate(() => {
        const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, r: b.right, b: b.bottom }; };
        const q = (s) => document.querySelector(s);
        const sheet = q('.sgx-qp-sheet');
        const ids = ['dark', 'system', 'lang', 'lock'];
        const rows = Array.from(sheet.querySelectorAll('.sgx-qp-row'));
        return {
          t: Object.fromEntries(ids.map((id) => [id, r(q('#sgx-qp [data-qp="' + id + '"]'))])),
          grid: r(q('.sgx-qp-grid')), rows: rows.map(r), labels: rows.map((x) => x.querySelector('.sgx-qp-row-label').textContent),
          over: Array.from(sheet.querySelectorAll('*')).filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'auto'
            && !el.matches('.sgx-qp-label, .sgx-qp-state')).map((el) => el.className),
          sheetOver: sheet.scrollWidth > sheet.clientWidth,
          reset: r(q('#sgx-qp [data-qp-reset]')), label: r(q('#sgx-qp .sgx-qp-row-head .sgx-qp-row-label')), row0: r(rows[0]),
        };
      });
      const { dark, system, lang, lock } = g.t;
      /* 行 1 / 行 2 各两块，同高同顶、各占一半 */
      expect(Math.abs(dark.y - system.y)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(lang.y - lock.y)).toBeLessThanOrEqual(0.5);
      expect(lang.y).toBeGreaterThan(dark.y + dark.h - 1);
      for (const t of [dark, system, lang, lock]) expect(Math.abs(t.w - (g.grid.w - 8) / 2)).toBeLessThanOrEqual(1);
      expect(dark.x).toBeLessThan(system.x);
      expect(lang.x).toBeLessThan(lock.x);
      /* 调色板在磁贴下面，布局在调色板下面 */
      expect(g.labels).toEqual(['调色板', '布局']);
      expect(g.rows[0].y).toBeGreaterThan(g.grid.b);
      expect(g.rows[1].y).toBeGreaterThan(g.rows[0].b);
      /* 恢复默认在调色板标题行右端，与标题竖直居中 */
      expect(Math.abs(g.row0.r - 12 - g.reset.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(g.reset.y + g.reset.h / 2 - (g.label.y + g.label.h / 2))).toBeLessThanOrEqual(1.5);
      expect(g.sheetOver, `${vp.width}：面板横向溢出`).toBe(false);
      expect(g.over, `${vp.width}：有元素横向溢出`).toEqual([]);
      await page.keyboard.press('Escape');
      await expectClosed(page);
    }
  });

  test('配色（2026-10-23 PR-G 修订）：兰紫浅色下磁贴 / 行 / 齿轮 = 中性玻璃（不铺 secondary-container）；深色模式开 = primary-container + 填充档图标圆', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-palette', 'orchid'); } catch (e) {} });
    await go(page, '/settings/');
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'orchid');
    await openQp(page);
    const cs = (sel, prop = 'backgroundColor') => page.locator(sel).first().evaluate((el, p) => getComputedStyle(el)[p], prop);
    const role = (name, prop = 'color') => page.evaluate(([n, p]) => {
      const d = document.createElement('div');
      d.style[p] = 'var(' + n + ')';
      document.body.appendChild(d);
      const c = getComputedStyle(d)[p];
      d.remove();
      return c;
    }, [name, prop]);
    const glass = await role('--sgx-qp-glass', 'backgroundColor');
    expect(await cs('#sgx-qp [data-qp="dark"]')).toBe(glass);
    expect(await cs('#sgx-qp .sgx-qp-row')).toBe(glass);
    const sec = await role('--m-secondary-container');
    for (const sel of ['#sgx-qp [data-qp="dark"]', '#sgx-qp .sgx-qp-row']) expect(await cs(sel)).not.toBe(sec);
    await tile(page, 'dark').click();
    await expect(tile(page, 'dark')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => cs('#sgx-qp [data-qp="dark"]')).toBe(await role('--m-primary-container'));
    expect(await cs('#sgx-qp [data-qp="dark"] .sgx-qp-ic')).toBe(await role('--m-primary-fill'));
    expect(await cs('#sgx-qp [data-qp="dark"] .sgx-qp-ic', 'color')).toBe(await role('--m-on-primary-fill'));
  });

  /* 2026-10-22：面板底是悬浮层磨砂（与顶栏同一份 --sgx-mat + 毛玻璃；2026-11-04 P5-1 起材质在整条胶囊 .sgx-topbar 上，长条本身透明），不是不透明的纯白 / 纯色卡；
     亮 / 暗、默认 dustyblue、紫、新色板奶油白都一样（2026-10-23 PR-G 撞色 x* 已合并） */
  for (const [dark, palette] of [[false, null], [true, null], [false, 'violet'], [false, 'cream'], [true, 'cream']]) {
    test(`面板底 = 悬浮层磨砂（${dark ? '暗色' : '亮色'}${palette ? '，调色板 ' + palette : ''}）`, async ({ page }) => {
      await page.addInitScript(([d, p]) => {
        try {
          localStorage.setItem('sgx-theme-mode', d ? 'dark' : 'light');
          if (p) localStorage.setItem('sgx-palette', p);
        } catch (e) {}
      }, [dark, palette]);
      await go(page, '/');
      await openQp(page);
      const st = await page.evaluate(() => {
        const g = (sel) => {
          const cs = getComputedStyle(document.querySelector(sel));
          return { bg: cs.backgroundColor, bf: cs.backdropFilter || cs.webkitBackdropFilter };
        };
        const role = (n) => { const d = document.createElement('div'); d.style.color = 'var(' + n + ')'; document.body.appendChild(d);
          const c = getComputedStyle(d).color; d.remove(); return c; };
        return { sheet: g('#sgx-qp .sgx-qp-sheet'), pill: g('.sgx-topbar'), lowest: role('--sgx-surface-container-lowest'),
          pal: document.documentElement.getAttribute('data-palette'), dark: document.documentElement.classList.contains('dark') };
      });
      expect(st.pal).toBe(palette);
      expect(st.dark).toBe(dark);
      expect(st.sheet.bg).toBe(st.pill.bg);
      expect(st.sheet.bg).not.toBe(st.lowest);
      /* 半透明（alpha < 1）+ 毛玻璃 */
      const alpha = (c) => { const m = c.match(/\/\s*([\d.]+)\s*\)$/) || c.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/); return m ? +m[1] : 1; };
      expect(alpha(st.sheet.bg), st.sheet.bg).toBeLessThan(1);
      expect(alpha(st.sheet.bg), st.sheet.bg).toBeGreaterThan(0.5);
      expect(st.sheet.bf).toBe(st.pill.bf);
      expect(st.sheet.bf).toContain('blur');
    });
  }

  test('英文文案', async ({ page }) => {
    await go(page, '/en/', 'en');
    await expect(page.locator('.sgx-tb-quick')).toHaveAttribute('aria-label', 'Quick panel');
    await openQp(page);
    await expect(page.locator('#sgx-qp .sgx-qp-tile .sgx-qp-label')).toHaveText(['Dark mode', 'Follow system', 'Language', 'Lock now']);
    await expect(page.locator('#sgx-qp .sgx-qp-row-label')).toHaveText(['Color palette', 'Layout']);
    await expect(page.locator('#sgx-qp [data-qp-reset]')).toHaveText('Reset');
    await expect(tile(page, 'system').locator('[data-qp-state]')).toHaveText('On');
    await expect(qp(page)).toHaveAccessibleName('Quick panel');
    await expect(page.locator('#sgx-qp .sgx-qp-title, #sgx-qp .sgx-qp-set')).toHaveCount(0);
  });
});

test.describe('快捷面板：与设置页同一个设置', () => {
  test('深色模式：写 sgx-theme-mode，即时变深 / 变浅；设置页同步', async ({ page }) => {
    await go(page, '/');
    await openQp(page);
    await tile(page, 'dark').click();
    expect(await ls(page, 'sgx-theme-mode')).toBe('dark');
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await expect(tile(page, 'dark')).toHaveAttribute('aria-pressed', 'true');
    await expect(tile(page, 'system')).toHaveAttribute('aria-pressed', 'false');
    await expect(qp(page)).toHaveAttribute('data-state', 'open'); /* 不关面板、不刷新 */
    await page.goto('/settings/display/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#theme-previews [data-mode="dark"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#sw-system')).toHaveAttribute('aria-checked', 'false');
    await openQp(page);
    await tile(page, 'dark').click();
    expect(await ls(page, 'sgx-theme-mode')).toBe('light');
    await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
    /* 设置页开着时即时同步（同一页的设置行跟着变） */
    await expect(page.locator('#theme-previews [data-mode="light"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('跟随系统：与设置页「跟随系统」开关同一语义', async ({ page }) => {
    await go(page, '/settings/display/');
    await expect(page.locator('#sw-system')).toHaveAttribute('aria-checked', 'true');
    await openQp(page);
    await tile(page, 'system').click();
    /* 关掉跟随系统 → 固定为当前看到的浅色 */
    expect(await ls(page, 'sgx-theme-mode')).toBe('light');
    await expect(tile(page, 'system')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#sw-system')).toHaveAttribute('aria-checked', 'false');
    await tile(page, 'system').click();
    /* 改回跟随系统：默认值不存 */
    expect(await ls(page, 'sgx-theme-mode')).toBeNull();
    await expect(page.locator('#sw-system')).toHaveAttribute('aria-checked', 'true');
    /* 反向：在设置页改，面板打开时反映 */
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await page.locator('#theme-previews [data-mode="dark"]').click();
    await openQp(page);
    await expect(tile(page, 'dark')).toHaveAttribute('aria-pressed', 'true');
    await expect(tile(page, 'system')).toHaveAttribute('aria-pressed', 'false');
  });

  test('减弱动效 / 字体大小已删除：面板和设置页都没有，旧值不起作用', async ({ page }) => {
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-reduced-motion', '1'); localStorage.setItem('sgx-font-size', 'large'); } catch (e) {}
    });
    await go(page, '/settings/display/');
    await openQp(page);
    await expect(page.locator('#sgx-qp [data-qp="motion"]')).toHaveCount(0);
    await expect(page.locator('#sgx-qp [data-qp-seg="font-size"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await expect(page.locator('#seg-font, #row-motion, #sw-motion')).toHaveCount(0);
    /* 旧 localStorage 值：首屏清掉，<html> 不放大、不带 reduced-motion（系统没开减弱动效） */
    expect(await ls(page, 'sgx-reduced-motion')).toBeNull();
    expect(await ls(page, 'sgx-font-size')).toBeNull();
    expect(await page.evaluate(() => document.documentElement.style.fontSize)).toBe('');
    await expect(page.locator('html')).not.toHaveClass(/(^|\s)reduced-motion(\s|$)/);
  });

  test('调色板：写 sgx-palette，即时换色；设置页同步', async ({ page }) => {
    await go(page, '/settings/theme/');
    await openQp(page);
    await page.locator('#sgx-qp [data-qp-palette="forest"]').click();
    expect(await ls(page, 'sgx-palette')).toBe('forest');
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'forest');
    await expect(page.locator('#sgx-qp [data-qp-palette="forest"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#palette-dots [data-palette="forest"]')).toHaveAttribute('aria-pressed', 'true');
    /* 恢复默认：forest 时可点；点了回默认 dustyblue（不存 key），按钮置灰，设置页的恢复默认也同步置灰 */
    const rs = page.locator('#sgx-qp [data-qp-reset]');
    await expect(rs).toHaveAttribute('aria-disabled', 'false');
    await expect(page.locator('#palette-reset')).toHaveAttribute('aria-disabled', 'false');
    await rs.click();
    expect(await ls(page, 'sgx-palette')).toBeNull();
    await expect(page.locator('html')).not.toHaveAttribute('data-palette', /.+/);
    await expect(rs).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('#sgx-qp [data-qp-palette][aria-pressed="true"]')).toHaveCount(1);
    await expect(page.locator('#sgx-qp [data-qp-palette="dustyblue"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#palette-reset')).toHaveAttribute('aria-disabled', 'true');
    /* 置灰时点了不动、面板不关；半透明但不隐藏（位置不跳） */
    const box = await rs.boundingBox();
    await rs.click({ force: true }); /* aria-disabled：Playwright 默认不点，强制点一下验证没反应 */
    expect(await ls(page, 'sgx-palette')).toBeNull();
    await expect(qp(page)).toHaveAttribute('data-state', 'open');
    await expect(rs).toBeVisible();
    await expect.poll(() => rs.evaluate((el) => Number(getComputedStyle(el).opacity))).toBeLessThan(0.6); /* opacity 有 .15s 过渡 */
    expect(await rs.boundingBox()).toEqual(box);
  });

  test('恢复默认：自定义主题色时可点，点了清掉自定义色回到默认 dustyblue', async ({ page }) => {
    await page.addInitScript(() => { try { if (!sessionStorage.getItem('qp-seeded')) { localStorage.setItem('sgx-accent', '#ff6b9d'); sessionStorage.setItem('qp-seeded', '1'); } } catch (e) {} });
    await go(page, '/');
    await openQp(page);
    const rs = page.locator('#sgx-qp [data-qp-reset]');
    await expect(rs).toHaveAttribute('aria-disabled', 'false');
    await rs.click();
    expect(await ls(page, 'sgx-accent')).toBeNull();
    expect(await ls(page, 'sgx-palette')).toBeNull();
    await expect(page.locator('style#sgx-accent-roles')).toHaveCount(0);
    await expect(rs).toHaveAttribute('aria-disabled', 'true');
  });

  test('布局：窄屏 DeX 置灰；写 sgx-layout；设置页同步', async ({ page }) => {
    await go(page, '/settings/display/');
    await openQp(page);
    await expect(page.locator('#sgx-qp [data-qp-seg="layout"] [data-v="dex"]')).toBeDisabled();
    await expect(page.locator('#sgx-qp [data-qp-seg="layout"] [data-v="pc"]')).toHaveCount(0);
    await page.locator('#sgx-qp [data-qp-seg="layout"] [data-v="mobile"]').click();
    expect(await ls(page, 'sgx-layout')).toBe('mobile');
    await expect(page.locator('#seg-layout [data-v="mobile"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#sgx-qp [data-qp-seg="layout"] [data-v="auto"]').click();
    /* 自动 = 默认值；baseof.html __layoutMode 会把空值补写成 auto（与设置页相同） */
    expect(['auto', null]).toContain(await ls(page, 'sgx-layout'));
    await expect(page.locator('#seg-layout [data-v="auto"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('布局（宽屏）：选 DeX 立即换成 DeX 布局', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await go(page, '/settings/display/');
    await openQp(page);
    /* 宽屏（≥ 980px）：宽 400，右缘对齐顶栏右缘 */
    const sb = await page.locator('#sgx-qp .sgx-qp-sheet').boundingBox();
    const tb = await page.locator('.sgx-topbar').boundingBox();
    expect(Math.abs(sb.width - 400)).toBeLessThanOrEqual(1);
    expect(Math.abs(sb.x + sb.width - (tb.x + tb.width))).toBeLessThanOrEqual(1);
    await page.locator('#sgx-qp [data-qp-seg="layout"] [data-v="dex"]').click();
    expect(await ls(page, 'sgx-layout')).toBe('dex');
    await expect(page.locator('html')).toHaveClass(/\blayout-dex\b/);
    await page.locator('#sgx-qp [data-qp-seg="layout"] [data-v="auto"]').click();
    expect(['auto', null]).toContain(await ls(page, 'sgx-layout'));
    await expect(page.locator('html')).toHaveClass(/\blayout-dex\b/); /* 1366×768 横屏、宽 ≥ 840、高 ≥ 500 → 自动 = DeX */
  });

  test('语言：切到 English（sgx-lang=en），同一页，不在历史里多留一步', async ({ page }) => {
    await go(page, '/');
    await page.goto('/settings/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-topbar')).toBeVisible();
    await openQp(page);
    await expect(tile(page, 'lang')).toHaveAttribute('aria-label', /English/);
    await tile(page, 'lang').click();
    await expect(page).toHaveURL(/\/en\/settings\/$/);
    expect(await ls(page, 'sgx-lang')).toBe('en');
    await expect(page.locator('.sgx-tb-tab[data-tab="settings"]')).toHaveText('Settings');
    await expect(page.locator('.sgx-tb-tab[data-tab="settings"]')).toHaveAttribute('aria-current', 'page');
    await page.goBack();
    /* 回到进设置页之前的主页（语言偏好已是英文，主页 replace 到 /en/） */
    await expect(page).toHaveURL(/localhost:\d+\/(en\/)?$/);
  });

  test('立即锁定：关面板后弹出与安全页相同的确认层，确认后调 /api/lock-now', async ({ page }) => {
    let called = false;
    await go(page, '/', 'zh', false);
    await page.route('**/api/lock-now', async (route) => {
      called = true;
      await route.fulfill({ status: 200, body: '{}' });
    });
    await openQp(page);
    await tile(page, 'lock').click();
    await expectClosed(page);
    const dlg = page.locator('#sec-locknow-confirm');
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText('立即锁定？');
    /* 取消：不调接口 */
    await dlg.locator('[data-act="cancel"]').click();
    await expect(dlg).toBeHidden();
    expect(called).toBe(false);
    /* 防误触窗口（400ms）过去。C8：原来固定等 450ms；改成直接看页面自己的判据——
       lib/dialog-behavior.js 关弹层时记 window.__sgxLastDialogClosedAt，Date.now() 与它相差 < 400 就忽略点击（这个用例不冻结时间） */
    await page.waitForFunction(() => Date.now() - (/** @type {any} */ (window).__sgxLastDialogClosedAt || 0) >= 400);
    await openQp(page);
    await tile(page, 'lock').click();
    await expect(dlg).toBeVisible();
    await dlg.locator('[data-act="ok"]').click();
    await expect(page).toHaveURL(/\?lock=1/);
    expect(called).toBe(true);
  });

  test('PR4：设置入口 = 顶栏的「设置」标签（面板里不再有齿轮，导航页也没有设置项）；从主页点它进设置首页', async ({ page }) => {
    await go(page, '/');
    await openQp(page);
    await expect(page.locator('#sgx-qp-page-set a')).toHaveCount(0);
    await expect(page.locator('#sgx-qp a[href$="/settings/"], #sgx-qp [data-nav="settings"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await page.locator('.sgx-tb-tab[data-tab="settings"]').click();
    await expect(page).toHaveURL(/\/settings\/$/);
    await page.goBack();
    await expect(page).toHaveURL(/localhost:\d+\/$/);
  });
});

/* ---------------- 2026-11-04 P5-1：两页、导航页（原导航抽屉）、AI 窗口、logo 字标 ---------------- */

test.describe('快捷面板：两页（导航 / 快捷设置）', () => {
  test('每次打开默认在第 1 页「导航」；点页签切页，第 2 页内容可用；关上再开回到第 1 页', async ({ page }) => {
    await go(page, '/settings/');
    await openQp(page, 'nav');
    await expectQpPage(page, 'nav');
    await expect(page.locator('#sgx-qp .sgx-qp-tabs')).toHaveAttribute('role', 'tablist');
    await expect(page.locator('#sgx-qp-tab-nav')).toHaveAttribute('aria-controls', 'sgx-qp-page-nav');
    await expect(page.locator('#sgx-qp-tab-set')).toHaveAttribute('aria-controls', 'sgx-qp-page-set');
    await expect(page.locator('#sgx-qp-page-nav')).toHaveAttribute('role', 'tabpanel');
    await qpPage(page, 'set');
    await expect(tile(page, 'dark')).toBeVisible();
    await qpPage(page, 'nav');
    await qpPage(page, 'set');
    await page.keyboard.press('Escape');
    await expectClosed(page);
    await openQp(page, 'nav');
    await expectQpPage(page, 'nav');
  });

  test('键盘：页签上左右键 / Home / End 切页，焦点跟着页签走', async ({ page }) => {
    await go(page, '/settings/');
    await openQp(page, 'nav');
    await page.locator('#sgx-qp-tab-nav').focus();
    await page.keyboard.press('ArrowRight');
    await expectQpPage(page, 'set');
    await expect(page.locator('#sgx-qp-tab-set')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expectQpPage(page, 'nav');
    await page.keyboard.press('ArrowLeft');
    await expectQpPage(page, 'set');
    await page.keyboard.press('Home');
    await expectQpPage(page, 'nav');
    await expect(page.locator('#sgx-qp-tab-nav')).toBeFocused();
    await page.keyboard.press('End');
    await expectQpPage(page, 'set');
    await expect(page.locator('#sgx-qp-tab-set')).toBeFocused();
  });

  test('滑动：两页横向 scroll-snap，滑到第 2 页停下后页签跟着换', async ({ page }) => {
    await go(page, '/settings/');
    await openQp(page, 'nav');
    const st = await page.evaluate(() => {
      const p = document.querySelector('#sgx-qp [data-qp-pages]');
      const cs = getComputedStyle(p);
      return { snap: cs.scrollSnapType, ox: cs.overflowX, w: p.clientWidth, sw: p.scrollWidth };
    });
    expect(st.snap).toMatch(/^x mandatory/);
    expect(st.ox).toBe('auto');
    expect(Math.abs(st.sw - 2 * st.w)).toBeLessThanOrEqual(1);
    /* 手指滑等价于把翻页容器滚到第 2 页：滑停后按位置定页 */
    await page.evaluate(() => { const p = document.querySelector('#sgx-qp [data-qp-pages]'); p.scrollLeft = p.clientWidth; });
    await expectQpPage(page, 'set');
    await page.evaluate(() => { document.querySelector('#sgx-qp [data-qp-pages]').scrollLeft = 0; });
    await expectQpPage(page, 'nav');
  });
});

test.describe('快捷面板第 1 页：导航（原导航抽屉，2026-11-04 P5-1）', () => {
  const nav = (page) => page.locator('#sgx-qp-page-nav');

  test('主站 / 奇趣 / 日刻 / 博客，每项有图标；没有 设置、我的文件、帮助；没有搜索框（定案第 2 条）', async ({ page }) => {
    await go(page, '/settings/display/');
    await openQp(page, 'nav');
    const items = nav(page).locator('a.sgx-qp-nav-item');
    await expect(items).toHaveCount(4);
    await expect(nav(page).locator('.sgx-qp-nav-label')).toHaveText(['主站', '奇趣', '日刻', '博客']);
    for (let i = 0; i < 4; i++) await expect(items.nth(i).locator('.sgx-qp-nav-ic svg')).toHaveCount(1);
    await expect(nav(page).locator('hr.sgx-qp-nav-div')).toHaveCount(0);
    await expect(nav(page).locator('[data-nav="settings"], a[href$="/settings/"], a[href*="/files/"]')).toHaveCount(0);
    await expect(nav(page)).not.toContainText('设置');
    await expect(nav(page)).not.toContainText('我的文件');
    await expect(nav(page)).not.toContainText('帮助');
    /* 原抽屉底栏的搜索框不搬过来：搜索以后只在 AI 窗口里 */
    await expect(page.locator('#sgx-qp input, #sgx-qp [type="search"], #sgx-qp [role="search"], #sgx-qp a[href*="/search/"], #sgx-qp .sgx-drawer-search')).toHaveCount(0);
    /* 链接：三站和主站同在 styrigx.com，同源相对地址 */
    await expect(items.nth(0)).toHaveAttribute('href', '/');
    await expect(items.nth(1)).toHaveAttribute('href', '/curio/');
    await expect(items.nth(1)).toHaveAttribute('data-nav', 'curio');
    await expect(items.nth(2)).toHaveAttribute('href', '/daymark/');
    await expect(items.nth(3)).toHaveAttribute('href', '/blog/');
  });

  for (const path of ['/', '/settings/', '/account/']) {
    test(`当前站高亮：${path} → 主站（只有这一项），药丸底色与普通项不同`, async ({ page }) => {
      await go(page, path);
      await openQp(page, 'nav');
      await expect(nav(page).locator('[aria-current="page"]')).toHaveCount(1);
      await expect(nav(page).locator('[aria-current="page"] .sgx-qp-nav-label')).toHaveText('主站');
      const items = nav(page).locator('a.sgx-qp-nav-item');
      const bg = await items.nth(0).evaluate((el) => getComputedStyle(el).backgroundColor);
      const bg0 = await items.nth(1).evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(bg).not.toBe(bg0);
    });
  }

  test('英文：Space / Curio / Daymark / Blog，地址带 en', async ({ page }) => {
    await go(page, '/en/', 'en');
    await openQp(page, 'nav');
    await expect(page.locator('#sgx-qp [role="tab"]')).toHaveText(['Navigation', 'Quick settings']);
    await expect(nav(page).locator('.sgx-qp-nav-label')).toHaveText(['Space', 'Curio', 'Daymark', 'Blog']);
    const items = nav(page).locator('a.sgx-qp-nav-item');
    await expect(items.nth(0)).toHaveAttribute('href', '/en/');
    await expect(items.nth(1)).toHaveAttribute('href', '/curio/en/');
    await expect(items.nth(2)).toHaveAttribute('href', '/daymark/en/');
    await expect(items.nth(3)).toHaveAttribute('href', '/blog/en/');
  });

  test('点项跳转（先关面板），且不在历史里多留一步', async ({ page }) => {
    await go(page, '/');
    await page.goto('/settings/display/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.sgx-topbar')).toBeVisible();
    /* 设置子页里主站是当前项（只关面板）；跳去别的站用拦截：只看地址，不真的加载子站 */
    await page.route((u) => u.pathname.startsWith('/curio/'), (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>curio</title>' }));
    await openQp(page, 'nav');
    await nav(page).locator('a.sgx-qp-nav-item', { hasText: '奇趣' }).click();
    await expect(page).toHaveURL(/\/curio\/$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/settings\/display\/$/);
    await expect(qp(page)).toBeHidden();
    expect(await page.evaluate(() => !!(history.state && history.state.sgxQp))).toBe(false);
  });

  test('点当前站那一项只关闭，不跳页', async ({ page }) => {
    await go(page, '/settings/');
    await openQp(page, 'nav');
    await nav(page).locator('a.sgx-qp-nav-item', { hasText: '主站' }).click();
    await expectClosed(page);
    await expect(page).toHaveURL(/\/settings\/$/);
  });
});

test.describe('AI 窗口（2026-11-04 P5-1，方案 5.5）', () => {
  const ai = (page) => page.locator('#sgx-ai');
  async function openAi(page) {
    await page.locator('.sgx-tb-ai').click();
    await expect(ai(page)).toHaveAttribute('data-state', 'open');
    await page.waitForFunction(() => document.getElementById('sgx-ai').getAnimations({ subtree: true }).every((a) => a.playState !== 'running'));
  }
  /* 2026-11-06 起服务端不再发 event: hits；hits 非空时照旧版服务端那样先发一条，用来验证前端不渲染来源卡片 */
  const sse = (hits, deltas) => (hits && hits.length ? ['event: hits\ndata: ' + JSON.stringify({ hits }) + '\n\n'] : [])
    .concat(deltas.map((t) => 'event: delta\ndata: ' + JSON.stringify({ text: t }) + '\n\n'), ['event: done\ndata: {}\n\n']).join('');

  test('从顶栏下方落下（非模态，和快捷面板同一种形式）：标题 Gray AI、开场白、新对话 / 历史 / 联系、输入框、范围小字', async ({ page }) => {
    await go(page, '/settings/');
    await openAi(page);
    expect(await ai(page).evaluate((el) => el.open && !el.matches(':modal'))).toBe(true);
    const g = await page.evaluate(() => {
      const tb = document.querySelector('.sgx-topbar').getBoundingClientRect();
      const sh = document.querySelector('#sgx-ai .sgx-qp-sheet').getBoundingClientRect();
      return { tbBottom: tb.bottom, top: sh.top, left: sh.left, w: sh.width };
    });
    expect(Math.abs(g.top - g.tbBottom - 8)).toBeLessThanOrEqual(1);
    expect(Math.abs(g.left - 16)).toBeLessThanOrEqual(1);
    await expect(ai(page).locator('.sgx-ai-title')).toHaveText('Gray AI');
    /* 空态 = 开场白（助手气泡样式、不带操作行），没有旧的空态文案 */
    const greet = ai(page).locator('.sgx-ai-msg[data-greet]');
    await expect(greet).toHaveText('你好，我是 Gray 的 AI 助手。想了解站里的内容，或者聊聊你手上的问题，都行。');
    await expect(greet).toHaveAttribute('data-role', 'assistant');
    await expect(ai(page).locator('.sgx-ai-ops')).toHaveCount(0);
    await expect(ai(page)).not.toContainText('回答来自站内内容');
    /* 第 2 行三个按钮，都在左边、同一行，在标题下面、消息列表上面 */
    await expect(ai(page).locator('.sgx-ai-actions > *')).toHaveText(['新对话', '历史', '联系']);
    await expect(ai(page).locator('.sgx-ai-head [data-ai-clear]')).toHaveCount(0);
    const row = await page.evaluate(() => {
      const r = (el) => el.getBoundingClientRect();
      const q = (sel) => document.querySelector('#sgx-ai ' + sel);
      const bs = [...document.querySelectorAll('#sgx-ai .sgx-ai-actions > *')].map(r);
      return { tops: bs.map((b) => Math.round(b.top)), lefts: bs.map((b) => b.left), sheetL: r(q('.sgx-qp-sheet')).left, head: r(q('.sgx-ai-head')).bottom, list: r(q('.sgx-ai-list')).top, h: bs.map((b) => b.height) };
    });
    expect(new Set(row.tops).size).toBe(1);
    expect(row.lefts[0]).toBeLessThan(row.sheetL + 30);
    expect(row.lefts[0]).toBeLessThan(row.lefts[1]);
    expect(row.lefts[1]).toBeLessThan(row.lefts[2]);
    expect(row.tops[0]).toBeGreaterThanOrEqual(row.head - 1);
    expect(row.tops[0] + row.h[0]).toBeLessThanOrEqual(row.list + 1);
    expect(row.h).toEqual([32, 32, 32]);
    await expect(ai(page).locator('[data-ai-contact]')).toHaveAttribute('href', 'mailto:ai@styrigx.com');
    await expect(ai(page).locator('[data-ai-in]')).toHaveAttribute('maxlength', '200');
    await expect(ai(page).locator('[data-ai-scope]')).toHaveText('仅公开内容');
    await expect(ai(page).locator('[data-ai-clear]')).toBeDisabled();
    expect(await page.evaluate(() => document.getElementById('sgx-ai').contains(document.activeElement))).toBe(true);
  });

  test('问一句：POST /api/ai（问题 + 语言 + 历史），流式回答（不显示来源卡片，旧服务端发了 hits 也不显示）；范围按响应头；历史只存本地 sgx-ai-history', async ({ page }) => {
    await go(page, '/settings/');
    let body = null;
    await page.route('**/api/ai', async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Styrigx-AI-Scope': 'private' },
        body: sse([{ site: 'blog', title: 'Muse 手册', url: '/blog/post/2026-10-07-muse-playbook/' }, { title: '外站', url: 'https://evil.example/' }], ['Muse 是', '协作代理。']) });
    });
    await openAi(page);
    await ai(page).locator('[data-ai-in]').fill('Muse 是什么？');
    await ai(page).locator('[data-ai-in]').press('Enter');
    const ans = ai(page).locator('.sgx-ai-msg[data-role="assistant"]');
    await expect(ans.locator('> span')).toHaveText('Muse 是协作代理。');
    expect(body).toEqual({ q: 'Muse 是什么？', lang: 'zh', history: [] });
    await expect(ai(page).locator('.sgx-ai-msg[data-role="user"]')).toHaveText('Muse 是什么？');
    /* 2026-11-06：只显示模型正文，0 张来源卡片、0 个卡片链接 */
    await expect(ai(page).locator('.sgx-ai-hits')).toHaveCount(0);
    await expect(ans.locator('a')).toHaveCount(0);
    await expect(ai(page).locator('[data-ai-scope]')).toHaveText('包含私密内容');
    const h = JSON.parse(await ls(page, 'sgx-ai-history'));
    expect(h.v).toBe(2);
    expect(h.chats).toHaveLength(1);
    expect(h.cur).toBe(h.chats[0].id);
    expect(h.chats[0].title).toBe('Muse 是什么？');
    expect(h.chats[0].msgs.map((m) => [m.role, m.text])).toEqual([['user', 'Muse 是什么？'], ['assistant', 'Muse 是协作代理。']]);
    /* 第二问带上历史 */
    await ai(page).locator('[data-ai-in]').fill('再说说');
    await ai(page).locator('.sgx-ai-send').click();
    await expect(ai(page).locator('.sgx-ai-msg[data-role="assistant"]')).toHaveCount(2);
    expect(body.history).toEqual([{ role: 'user', text: 'Muse 是什么？' }, { role: 'assistant', text: 'Muse 是协作代理。' }]);
    /* 第二条回答流式结束后才写历史：等写满 4 条再换页，否则换页早于写入会只剩 3 条 */
    await expect.poll(async () => {
      const v = await ls(page, 'sgx-ai-history');
      return v ? JSON.parse(v).chats[0].msgs.length : 0;
    }).toBe(4);
    /* 换页再开：同一份本地历史 */
    await page.goto('/settings/display/', { waitUntil: 'domcontentloaded' });
    await openAi(page);
    await expect(ai(page).locator('.sgx-ai-msg')).toHaveCount(4);
    /* 新对话：当前对话留在历史里，窗口回到开场白 */
    await ai(page).locator('[data-ai-clear]').click();
    await expect(ai(page).locator('.sgx-ai-msg')).toHaveCount(1);
    await expect(ai(page).locator('.sgx-ai-msg[data-greet]')).toBeVisible();
    const h2 = JSON.parse(await ls(page, 'sgx-ai-history'));
    expect(h2.chats).toHaveLength(1);
    expect(h2.chats[0].msgs).toHaveLength(4);
    expect(h2.cur).not.toBe(h2.chats[0].id);
  });

  test('2026-11-06：旧历史里带 hits 的回答，点开也是 0 张来源卡片', async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('sgx-ai-history', JSON.stringify({ v: 1, msgs: [
          { role: 'user', text: '锁屏怎么开', ts: 1 },
          { role: 'assistant', text: '设置 → 安全 → 锁屏凭证。', hits: [{ site: 'space', title: '锁屏凭证', subtitle: '安全', url: '/settings/security/lock/' }], ts: 2 },
        ] }));
      } catch (e) {}
    });
    await go(page, '/settings/');
    await openAi(page);
    await expect(ai(page).locator('.sgx-ai-msg')).toHaveCount(2);
    await expect(ai(page).locator('.sgx-ai-msg[data-role="assistant"] > span')).toHaveText('设置 → 安全 → 锁屏凭证。');
    await expect(ai(page).locator('.sgx-ai-hits')).toHaveCount(0);
    await expect(ai(page).locator('.sgx-ai-msg a')).toHaveCount(0);
    /* v1 → v2 迁移：包成一份对话（标题 = 首问），hits 不再存 */
    const h = JSON.parse(await ls(page, 'sgx-ai-history'));
    expect(h.v).toBe(2);
    expect(h.chats.map((c) => c.title)).toEqual(['锁屏怎么开']);
    expect(h.cur).toBe(h.chats[0].id);
    expect(JSON.stringify(h)).not.toContain('hits');
  });

  for (const [status, err, want] of [[429, 'cooldown', '问得太快了，请一分钟后再试'], [429, 'busy', '现在问的人太多，请稍后再试'], [401, 'session', '锁屏会话已失效，请重新解锁后再问'], [502, 'upstream', '没能拿到回答，请稍后再试']]) {
    test(`出错：${status} ${err} → 「${want}」，不进历史`, async ({ page }) => {
      await go(page, '/settings/');
      await page.route('**/api/ai', (r) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ ok: false, error: err }) }));
      await openAi(page);
      await ai(page).locator('[data-ai-in]').fill('你好');
      await ai(page).locator('[data-ai-in]').press('Enter');
      const ans = ai(page).locator('.sgx-ai-msg[data-role="assistant"]');
      await expect(ans).toHaveAttribute('data-state', 'error');
      await expect(ans).toHaveText(want);
      const h = JSON.parse((await ls(page, 'sgx-ai-history')) || '{"chats":[]}');
      expect(h.chats.flatMap((c) => c.msgs).filter((m) => m.role === 'assistant')).toEqual([]);
    });
  }

  /* P4-2d：模型在账号页选（localStorage sgx-ai-model），AI 窗口只负责带上；窗口里没有切换 */
  const okSse = (route, model) => route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Styrigx-AI-Scope': 'private', 'X-Styrigx-AI-Model': model },
    body: sse([], ['好的。']) });

  test('P4-2d：账号页选过模型（sgx-ai-model）→ 发问带上 body.model；窗口里没有模型切换', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-ai-model', '@cf/openai/gpt-oss-20b'); } catch (e) {} });
    await go(page, '/settings/');
    const bodies = [];
    await page.route('**/api/ai', async (route) => {
      const b = route.request().postDataJSON();
      bodies.push(b);
      await okSse(route, b.model || 'default');
    });
    await openAi(page);
    await expect(ai(page).locator('select, [role="radiogroup"], [data-ai-model]')).toHaveCount(0);
    await ai(page).locator('[data-ai-in]').fill('你好');
    await ai(page).locator('[data-ai-in]').press('Enter');
    await expect(ai(page).locator('.sgx-ai-msg[data-role="assistant"] > span')).toHaveText('好的。');
    expect(bodies).toEqual([{ q: '你好', lang: 'zh', history: [], model: '@cf/openai/gpt-oss-20b' }]);
    expect(await ls(page, 'sgx-ai-model')).toBe('@cf/openai/gpt-oss-20b');
  });

  test('P4-2d：选的模型被下架 → 400 bad_model：清掉本地选择、不带 model 自动重发一次，回答照常', async ({ page }) => {
    await page.addInitScript(() => { try { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('sgx-ai-model', '@cf/gone/model'); } } catch (e) {} });
    await go(page, '/settings/');
    const bodies = [];
    await page.route('**/api/ai', async (route) => {
      const b = route.request().postDataJSON();
      bodies.push(b);
      if (b.model) await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'bad_model' }) });
      else await okSse(route, '@cf/google/gemma-4-26b-a4b-it');
    });
    await openAi(page);
    await page.evaluate(() => { window.__chg = 0; window.addEventListener('sgx-settings-changed', () => { window.__chg++; }); });
    await ai(page).locator('[data-ai-in]').fill('你好');
    await ai(page).locator('[data-ai-in]').press('Enter');
    const ans = ai(page).locator('.sgx-ai-msg[data-role="assistant"]');
    await expect(ans.locator('> span')).toHaveText('好的。');
    await expect(ans).not.toHaveAttribute('data-state', 'error');
    expect(bodies).toEqual([
      { q: '你好', lang: 'zh', history: [], model: '@cf/gone/model' },
      { q: '你好', lang: 'zh', history: [] },
    ]);
    expect(await ls(page, 'sgx-ai-model')).toBe(null);
    expect(await page.evaluate(() => window.__chg)).toBeGreaterThan(0);
    /* 下一问不再带 model，也不再多发 */
    await ai(page).locator('[data-ai-in]').fill('再问');
    await ai(page).locator('[data-ai-in]').press('Enter');
    await expect(ans).toHaveCount(2);
    await expect(ans.nth(1).locator('> span')).toHaveText('好的。');
    expect(bodies.length).toBe(3);
    expect(bodies[2].model).toBeUndefined();
  });

  test('P4-2d：只重发一次——重发仍出错就按普通错误显示，不再重试；没带 model 时的 400 bad_model 不重发', async ({ page }) => {
    await page.addInitScript(() => { try { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('sgx-ai-model', '@cf/gone/model'); } } catch (e) {} });
    await go(page, '/settings/');
    const bodies = [];
    await page.route('**/api/ai', async (route) => {
      bodies.push(route.request().postDataJSON());
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'bad_model' }) });
    });
    await openAi(page);
    await ai(page).locator('[data-ai-in]').fill('你好');
    await ai(page).locator('[data-ai-in]').press('Enter');
    const ans = ai(page).locator('.sgx-ai-msg[data-role="assistant"]');
    await expect(ans).toHaveAttribute('data-state', 'error');
    await expect(ans).toHaveText('没能拿到回答，请稍后再试');
    expect(bodies.map((b) => b.model)).toEqual(['@cf/gone/model', undefined]);
    /* 本地已清掉：再问只发一次 */
    await ai(page).locator('[data-ai-in]').fill('再问');
    await ai(page).locator('[data-ai-in]').press('Enter');
    await expect(ans).toHaveCount(2);
    await expect(ans.nth(1)).toHaveAttribute('data-state', 'error');
    expect(bodies.length).toBe(3);
  });

  /* P4-3 PR-3：键盘跟随。用假的 VirtualKeyboard API（vk.js 优先用它）驱动键盘高度；触屏用假的 matchMedia('(pointer: coarse)') */
  async function fakeKeyboard(page) {
    await page.addInitScript(() => {
      const vk = new EventTarget();
      vk.overlaysContent = false;
      vk.boundingRect = { height: 0 };
      Object.defineProperty(navigator, 'virtualKeyboard', { value: vk, configurable: true });
      window.__kb = (h) => { vk.boundingRect = { height: h }; vk.dispatchEvent(new Event('geometrychange')); };
    });
  }
  async function fakeCoarse(page) {
    await page.addInitScript(() => {
      const mm = window.matchMedia.bind(window);
      const noop = () => {};
      window.matchMedia = (q) => (/pointer:\s*coarse/.test(q) ? { matches: true, media: q, onchange: null, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop } : mm(q));
    });
  }
  const geo = (page) => page.evaluate(() => {
    const r = (sel) => document.querySelector(sel).getBoundingClientRect();
    return { vh: window.innerHeight, tb: r('.sgx-topbar').bottom, title: r('#sgx-ai .sgx-ai-title').top, sheet: r('#sgx-ai .sgx-qp-sheet').bottom,
      input: r('#sgx-ai [data-ai-in]').bottom, focused: document.activeElement === document.querySelector('#sgx-ai [data-ai-in]') };
  });

  test('P4-3 PR-3：输入框聚焦后跟键盘——窗口下沿抬到键盘上沿，标题栏和输入框都在可视区；键盘收了自动失焦', async ({ page }) => {
    await fakeKeyboard(page);
    await go(page, '/settings/');
    await openAi(page);
    await ai(page).locator('[data-ai-in]').click();
    await page.evaluate(() => window.__kb(320));
    await expect(ai(page)).toHaveAttribute('data-kb', '');
    expect(await page.evaluate(() => document.documentElement.classList.contains('sgx-vk') && navigator.virtualKeyboard.overlaysContent)).toBe(true);
    await page.waitForFunction(() => document.getElementById('sgx-ai').getAnimations({ subtree: true }).every((a) => a.playState !== 'running'));
    const g = await geo(page);
    expect(g.focused).toBe(true);
    expect(g.sheet).toBeLessThanOrEqual(g.vh - 320 + 1);
    expect(g.input).toBeLessThanOrEqual(g.vh - 320 + 1);
    expect(g.title).toBeGreaterThanOrEqual(g.tb);
    /* 键盘高度变化（换输入法 / 候选栏）跟着走 */
    await page.evaluate(() => window.__kb(400));
    expect((await geo(page)).input).toBeLessThanOrEqual((await geo(page)).vh - 400 + 1);
    /* 系统手势收键盘：高度回 0 → 输入框失焦，窗口回原位 */
    await page.evaluate(() => window.__kb(0));
    await expect(ai(page)).not.toHaveAttribute('data-kb', '');
    expect((await geo(page)).focused).toBe(false);
    expect(await ai(page).evaluate((el) => el.style.getPropertyValue('--sgx-kb'))).toBe('0px');
    expect(await page.evaluate(() => document.documentElement.classList.contains('sgx-vk'))).toBe(false);
    /* 再点输入框又跟上 */
    await ai(page).locator('[data-ai-in]').click();
    await page.evaluate(() => window.__kb(300));
    await expect(ai(page)).toHaveAttribute('data-kb', '');
    /* 关窗口 = 复位 */
    await page.keyboard.press('Escape');
    await expect(ai(page)).not.toHaveAttribute('data-kb', '');
  });

  test('P4-3 PR-3：触屏打开不自动聚焦（不弹键盘）；发送后收键盘', async ({ page }) => {
    await fakeCoarse(page);
    await go(page, '/settings/');
    await page.route('**/api/ai', (r) => r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }, body: sse([], ['好的。']) }));
    await openAi(page);
    expect((await geo(page)).focused).toBe(false);
    expect(await page.evaluate(() => document.getElementById('sgx-ai').contains(document.activeElement))).toBe(true);
    await ai(page).locator('[data-ai-in]').fill('你好');
    await ai(page).locator('[data-ai-in]').press('Enter');
    await expect(ai(page).locator('.sgx-ai-msg[data-role="assistant"] > span')).toHaveText('好的。');
    expect((await geo(page)).focused).toBe(false);
  });

  test('P4-3 PR-3：桌面（细指针）照旧——打开即聚焦，发送后焦点留在输入框', async ({ page }) => {
    await go(page, '/settings/');
    await page.route('**/api/ai', (r) => r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }, body: sse([], ['好的。']) }));
    await openAi(page);
    expect((await geo(page)).focused).toBe(true);
    await ai(page).locator('[data-ai-in]').fill('你好');
    await ai(page).locator('[data-ai-in]').press('Enter');
    await expect(ai(page).locator('.sgx-ai-msg[data-role="assistant"] > span')).toHaveText('好的。');
    expect((await geo(page)).focused).toBe(true);
  });

  test('P4-3 后续 §4：桌面鼠标点发送，焦点回输入框；回答中和答完直接打字都进输入框', async ({ page }) => {
    await go(page, '/settings/');
    let release;
    const gate = new Promise((r) => { release = r; });
    await page.route('**/api/ai', async (r) => { await gate; await r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }, body: sse([], ['巴黎。']) }); });
    await openAi(page);
    await ai(page).locator('[data-ai-in]').fill('法国首都是哪');
    await ai(page).locator('.sgx-ai-send').click();
    await expect(ai(page).locator('.sgx-ai-send')).toHaveAttribute('data-stop', '');
    expect((await geo(page)).focused).toBe(true);
    await page.keyboard.type('X');
    await expect(ai(page).locator('[data-ai-in]')).toHaveValue('X');
    release();
    await expect(ai(page).locator('.sgx-ai-msg[data-role="assistant"] > span')).toHaveText('巴黎。');
    await page.keyboard.type('Y');
    await expect(ai(page).locator('[data-ai-in]')).toHaveValue('XY');
  });

  test('P4-3 后续 §5：触屏键盘弹着时点发送，一次就发出去；不让输入框先失焦把点击吃掉', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true, colorScheme: 'light' });
    const page = await ctx.newPage();
    try {
      await fakeKeyboard(page);
      await fakeCoarse(page);
      await go(page, '/settings/');
      await page.route('**/api/ai', (r) => r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }, body: sse([], ['我是 Gray 的 AI 助手。']) }));
      await openAi(page);
      await ai(page).locator('[data-ai-in]').tap();
      await page.evaluate(() => window.__kb(320));
      await expect(ai(page)).toHaveAttribute('data-kb', '');
      await ai(page).locator('[data-ai-in]').fill('你是谁');
      /* 输入框失焦就收键盘（模拟真机：键盘高度回 0，窗口下沿落回底部、发送按钮下移） */
      await page.evaluate(() => document.querySelector('#sgx-ai [data-ai-in]').addEventListener('blur', () => window.__kb(0), { once: true }));
      await ai(page).locator('.sgx-ai-send').tap();
      await expect(ai(page).locator('.sgx-ai-msg[data-role="user"]')).toHaveText('你是谁');
      await expect(ai(page).locator('[data-ai-in]')).toHaveValue('');
      await expect(ai(page).locator('.sgx-ai-msg[data-role="assistant"] > span')).toHaveText('我是 Gray 的 AI 助手。');
      /* 发出去后照旧收键盘 */
      expect((await geo(page)).focused).toBe(false);
      await expect(ai(page)).not.toHaveAttribute('data-kb', '');
    } finally {
      await ctx.close();
    }
  });

  test('P4-3 后续 §3：新对话存进历史；历史是窗口内的列表（倒序、标题 + 时间），点一条载入，输入框里的字不丢', async ({ page }) => {
    await go(page, '/settings/');
    await page.route('**/api/ai', async (r) => {
      const q = r.request().postDataJSON().q;
      await r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }, body: sse([], ['答：' + q]) });
    });
    await openAi(page);
    const inp = ai(page).locator('[data-ai-in]');
    const last = ai(page).locator('.sgx-ai-msg[data-role="assistant"]').last().locator('> span');
    await inp.fill('第一份对话的问题，比二十个字还要长一点点');
    await inp.press('Enter');
    await expect(last).toHaveText('答：第一份对话的问题，比二十个字还要长一点点');
    await ai(page).locator('[data-ai-clear]').click();
    await inp.fill('第二份');
    await inp.press('Enter');
    await expect(last).toHaveText('答：第二份');
    /* 打开历史：窗口内视图（不是 dialog / 底部弹出），替换消息列表；按时间倒序 */
    await inp.fill('还没发的字');
    const hb = ai(page).locator('[data-ai-history]');
    await hb.click();
    await expect(hb).toHaveAttribute('aria-expanded', 'true');
    const items = ai(page).locator('[data-ai-hist] .sgx-ai-hist-item');
    await expect(items).toHaveCount(2);
    await expect(items.locator('.sgx-ai-hist-title')).toHaveText(['第二份', '第一份对话的问题，比二十个字还要长一']);
    await expect(items.first().locator('.sgx-ai-hist-time')).toHaveText(/\d{2}:\d{2}/);
    await expect(items.first()).toHaveAttribute('aria-current', 'true');
    await expect(ai(page).locator('[data-ai-list]')).toBeHidden();
    expect(await page.locator('dialog[open]').count()).toBe(1);
    /* 点旧的一份载入 */
    await items.nth(1).click();
    await expect(ai(page).locator('[data-ai-hist]')).toBeHidden();
    await expect(hb).toHaveAttribute('aria-expanded', 'false');
    await expect(ai(page).locator('.sgx-ai-msg[data-role="user"]')).toHaveText(['第一份对话的问题，比二十个字还要长一点点']);
    await expect(inp).toHaveValue('还没发的字');
    /* 换页再开：停在刚载入的那份 */
    await page.goto('/settings/display/', { waitUntil: 'domcontentloaded' });
    await openAi(page);
    await expect(ai(page).locator('.sgx-ai-msg[data-role="user"]')).toHaveText(['第一份对话的问题，比二十个字还要长一点点']);
  });

  test('P4-3 后续 §3.3：历史最多 20 份，超了删最旧的；空历史显示提示', async ({ page }) => {
    await page.addInitScript(() => {
      try {
        if (sessionStorage.getItem('seeded')) return;
        sessionStorage.setItem('seeded', '1');
        const chats = [];
        for (let i = 0; i < 20; i++) chats.push({ id: 'c' + i, title: '旧' + i, time: 1000 + i, msgs: [{ role: 'user', text: '旧' + i, ts: 1000 + i }, { role: 'assistant', text: '答', ts: 1000 + i }] });
        localStorage.setItem('sgx-ai-history', JSON.stringify({ v: 2, cur: '', chats }));
      } catch (e) {}
    });
    await go(page, '/settings/');
    await page.route('**/api/ai', (r) => r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }, body: sse([], ['好']) }));
    await openAi(page);
    await ai(page).locator('[data-ai-in]').fill('新的');
    await ai(page).locator('[data-ai-in]').press('Enter');
    await expect(ai(page).locator('.sgx-ai-msg[data-role="assistant"] > span')).toHaveText('好');
    await expect.poll(async () => JSON.parse(await ls(page, 'sgx-ai-history')).chats.length).toBe(20);
    const h = JSON.parse(await ls(page, 'sgx-ai-history'));
    expect(h.chats[0].title).toBe('新的');
    expect(h.chats.map((c) => c.id)).not.toContain('c0');
    await page.evaluate(() => localStorage.removeItem('sgx-ai-history'));
    await ai(page).locator('[data-ai-history]').click();
    await expect(ai(page).locator('[data-ai-hist]')).toHaveText('还没有历史对话');
  });

  test('P4-3 后续 §3.4：助手回答下有复制 / 重试 / 👍 / 👎；用户提问下没有；重试替换这条回答；👍👎 只存本地、再点取消', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await go(page, '/settings/');
    let n = 0;
    const bodies = [];
    await page.route('**/api/ai', async (r) => {
      bodies.push(r.request().postDataJSON());
      n += 1;
      await r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }, body: sse([], ['第 ' + n + ' 次回答']) });
    });
    await openAi(page);
    const inp = ai(page).locator('[data-ai-in]');
    await inp.fill('问一');
    await inp.press('Enter');
    await expect(ai(page).locator('.sgx-ai-msg[data-role="assistant"] > span')).toHaveText('第 1 次回答');
    await inp.fill('问二');
    await inp.press('Enter');
    await expect(ai(page).locator('.sgx-ai-msg[data-role="assistant"] > span')).toHaveText(['第 1 次回答', '第 2 次回答']);
    const ops = ai(page).locator('.sgx-ai-ops');
    await expect(ops).toHaveCount(2);
    await expect(ops.first().locator('button')).toHaveText(['复制', '重试', '👍', '👎']);
    await expect(ai(page).locator('.sgx-ai-msg[data-role="user"] .sgx-ai-ops')).toHaveCount(0);
    /* 复制 */
    await ops.first().locator('[data-op="copy"]').click();
    await expect(ops.first().locator('[data-op="copy"]')).toHaveText('已复制');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('第 1 次回答');
    /* 重试第一条：重问「问一」，历史只带它前面的（空），替换这条回答，不追加 */
    await ops.first().locator('[data-op="retry"]').click();
    await expect(ai(page).locator('.sgx-ai-msg[data-role="assistant"] > span')).toHaveText(['第 3 次回答', '第 2 次回答']);
    expect(bodies[2]).toEqual({ q: '问一', lang: 'zh', history: [] });
    await expect(ai(page).locator('.sgx-ai-msg[data-role="user"]')).toHaveCount(2);
    /* 👍 / 👎：同一条只能选一个，再点取消；存在本地这条消息上 */
    const up = ops.nth(1).locator('[data-op="up"]');
    const dn = ops.nth(1).locator('[data-op="down"]');
    await up.click();
    await expect(up).toHaveAttribute('aria-pressed', 'true');
    await dn.click();
    await expect(up).toHaveAttribute('aria-pressed', 'false');
    await expect(dn).toHaveAttribute('aria-pressed', 'true');
    let h = JSON.parse(await ls(page, 'sgx-ai-history'));
    expect(h.chats[0].msgs.map((m) => m.rate || '')).toEqual(['', '', '', 'down']);
    await dn.click();
    await expect(dn).toHaveAttribute('aria-pressed', 'false');
    h = JSON.parse(await ls(page, 'sgx-ai-history'));
    expect(h.chats[0].msgs.map((m) => m.rate || '')).toEqual(['', '', '', '']);
    expect(n).toBe(3);
    /* 换页再开：👍👎 随历史 */
    await ops.nth(0).locator('[data-op="up"]').click();
    await page.goto('/settings/display/', { waitUntil: 'domcontentloaded' });
    await openAi(page);
    await expect(ai(page).locator('.sgx-ai-ops').first().locator('[data-op="up"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('P4-3 PR-3：回答进行中发送按钮变停止，点它中断；回车不中断；停下后变回发送', async ({ page }) => {
    await go(page, '/settings/');
    let release;
    const hold = new Promise((r) => { release = r; });
    await page.route('**/api/ai', async (r) => {
      await hold;
      try { await r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }, body: sse([], ['迟到的回答。']) }); } catch (e) {}
    });
    await openAi(page);
    const send = ai(page).locator('.sgx-ai-send');
    await expect(send).toHaveAttribute('aria-label', '发送');
    await ai(page).locator('[data-ai-in]').fill('你好');
    await ai(page).locator('[data-ai-in]').press('Enter');
    await expect(send).toHaveAttribute('data-stop', '');
    await expect(send).toHaveAttribute('aria-label', '停止');
    await expect(send).toBeEnabled();
    /* 回答中回车：不发、不中断，输入留着 */
    await ai(page).locator('[data-ai-in]').fill('再问');
    await ai(page).locator('[data-ai-in]').press('Enter');
    await expect(send).toHaveAttribute('data-stop', '');
    await expect(ai(page).locator('[data-ai-in]')).toHaveValue('再问');
    await send.click();
    await expect(send).not.toHaveAttribute('data-stop', '');
    await expect(send).toHaveAttribute('aria-label', '发送');
    await expect(ai(page).locator('.sgx-ai-msg[data-role="user"]')).toHaveText('你好');
    await expect(ai(page).locator('.sgx-ai-msg[data-role="assistant"]')).toHaveCount(0);
    release();
    await expect(ai(page).locator('.sgx-ai-msg[data-role="assistant"]')).toHaveCount(0);
  });

  test('英文文案', async ({ page }) => {
    await go(page, '/en/settings/', 'en');
    await openAi(page);
    await expect(ai(page)).toHaveAccessibleName('Ask AI');
    await expect(ai(page).locator('.sgx-ai-title')).toHaveText('Gray AI');
    await expect(ai(page).locator('.sgx-ai-msg[data-greet]')).toHaveText("Hi, I'm Gray's AI assistant. Ask about this site, or talk through whatever you're working on.");
    await expect(ai(page).locator('[data-ai-scope]')).toHaveText('Public content only');
    await expect(ai(page).locator('.sgx-ai-actions > *')).toHaveText(['New chat', 'History', 'Contact']);
    await ai(page).locator('[data-ai-history]').click();
    await expect(ai(page).locator('[data-ai-hist]')).toHaveText('No past chats yet');
  });
});

/* 2026-10-21 品牌：站名 = 内联 SVG 字标（可访问名 Styrigx）；i 上的圆点跟主题色（--sgx-primary），字母跟 --sgx-text-primary：
   默认 dustyblue 亮 / 暗、forest（含旧撞色 id xforest 迁移）都对。2026-11-04 P5-1：字标从抽屉头搬到顶栏 logo（20px 高）。
   标签页 SVG 图标：默认色板用静态 /favicon.svg，换色板后换成主题色的 data: 图标。 */
test.describe('顶栏 logo 字标 + 标签页图标跟主题色', () => {
  const CASES = [
    { name: 'dustyblue 亮色', pal: null, dark: false },
    { name: 'dustyblue 深色', pal: null, dark: true },
    { name: 'forest 亮色（存的是旧撞色 xforest，首屏迁到 forest）', store: 'xforest', pal: 'forest', dark: false },
    { name: 'forest 深色', pal: 'forest', dark: true },
  ];
  for (const c of CASES) {
    test(`${c.name}：字标渲染、圆点 = --sgx-primary、字母 = --sgx-text-primary`, async ({ page }) => {
      await page.addInitScript((o) => {
        try {
          if (o.store || o.pal) localStorage.setItem('sgx-palette', o.store || o.pal);
          localStorage.setItem('sgx-theme-mode', o.dark ? 'dark' : 'light');
        } catch (e) {}
      }, c);
      /* helpers 的拦截会把带 favicon 的地址换成占位 PNG；这里放行真的 /favicon.svg（后注册的路由优先） */
      await blockExternalRequests(page);
      await page.route('**/favicon.svg', (r) => r.continue());
      await freezeTime(page);
      await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
      const wm = page.locator('.sgx-tb-logo svg.sgx-wordmark');
      await expect(wm).toHaveCount(1);
      await expect(wm).toHaveAttribute('role', 'img');
      await expect(wm).toHaveAttribute('aria-label', 'Styrigx');
      await expect(page.locator('.sgx-tb-logo').getByRole('img', { name: 'Styrigx' })).toHaveCount(1);
      const m = await page.evaluate(() => {
        const svg = document.querySelector('.sgx-tb-logo .sgx-wordmark');
        const r = svg.getBoundingClientRect();
        const br = svg.parentElement.getBoundingClientRect();
        const probe = document.createElement('i');
        probe.style.cssText = 'position:absolute;color:var(--sgx-primary);background:var(--sgx-text-primary)';
        document.body.appendChild(probe);
        const cs = getComputedStyle(probe);
        const out = { w: r.width, h: r.height, inTop: r.top - br.top, inBottom: br.bottom - r.bottom, inLeft: r.left - br.left, inRight: br.right - r.right,
          dot: getComputedStyle(svg.querySelector('.wm-dot')).fill, ink: getComputedStyle(svg.querySelector('.wm-letters')).fill, primary: cs.color, text: cs.backgroundColor,
          pal: document.documentElement.getAttribute('data-palette'), dark: document.documentElement.classList.contains('dark') };
        probe.remove();
        return out;
      });
      expect(m.pal).toBe(c.pal);
      expect(m.dark).toBe(c.dark);
      expect(m.dot).toBe(m.primary);
      expect(m.ink).toBe(m.text);
      expect(m.dot).not.toBe(m.ink);
      /* 顶栏 logo：字标高 20px，宽按 viewBox 比例；整个在 logo 按钮里 */
      expect(Math.abs(m.h - 20)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(m.w - m.h * 5924 / 2010)).toBeLessThanOrEqual(0.5);
      for (const k of ['inTop', 'inBottom', 'inLeft', 'inRight']) expect(m[k], k).toBeGreaterThanOrEqual(-0.5);
      /* SVG 图标：默认 dustyblue 亮色用静态文件，其他换成主题色 data: 地址 */
      const icon = page.locator('link[rel="icon"][type="image/svg+xml"]');
      await expect(page.locator('link[rel="icon"][href="/favicon.ico"][sizes="32x32"]')).toHaveCount(1);
      if (!c.pal && !c.dark) {
        await expect(icon).toHaveAttribute('href', '/favicon.svg');
      } else {
        await expect(icon).toHaveAttribute('href', /^data:image\/svg\+xml,/);
        const svg = decodeURIComponent((await icon.getAttribute('href')).slice('data:image/svg+xml,'.length));
        const hex = (rgb) => '#' + rgb.match(/\d+/g).slice(0, 3).map((n) => (+n).toString(16).padStart(2, '0')).join('');
        expect(svg).toContain('fill="' + hex(m.primary) + '"');
      }
    });
  }
});

/* 原 nav-drawer.spec.js 里和抽屉无关的两组，原样搬过来 */
test.describe('主站书签已下线', () => {
  test('没有 /bookmarks/ 页面（/browser/ 的去向见 site-search.spec.js）', async ({ page }) => {
    await go(page, '/');
    for (const p of ['/bookmarks/', '/en/bookmarks/']) {
      const r = await page.request.get(p);
      expect(r.status(), p).not.toBe(200);
    }
  });
});
