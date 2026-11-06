/**
 * 顶栏 v2.0（与 Book 同一套）验收：左圆 + 长条（头像 + 居中 Styrigx + ⋮）+ 导航圆。
 * 顶栏 v3（2026-10-19，全站同一套）：左圆九宫格、右圆头像；长条主页 = 搜索 / Styrigx / 设置，子页面 = 返回 / Styrigx / ⋮。
 * 顶栏 v4（2026-10-20）：子页面长条里 ‹ 和 ⋮ 删除；九宫格改为左侧导航抽屉（见 nav-drawer.spec.js）。
 * 通版顶栏（2026-10-20）：全宽长条 = 最前端搜索图标 + 当前页名（主页「首页」，不再显示 Styrigx）；点长条进全网搜索。
 * 主页长条里没有单独的设置 / 搜索按钮；没有滚动换标题；子页面没有大标题区，正文从顶栏下方 16px 开始（--sgx-content-top）。
 * 快捷面板（2026-10-20）：长条与头像之间多一个快捷面板圆（与左圆同尺寸同材质），长条相应变短（见 quick-panel.spec.js）。
 * 对称顶栏（2026-10-20）：九宫格圆 + 搜索圆 | 长条（只显示页名，不可点）| 快捷面板圆 + 头像圆；
 * 左右两组同宽，长条中心 = 屏幕中心（390 / 1280 / 1920 都量）；搜索圆进全网搜索页。
 * 顶栏 v5（2026-10-20）：两个圆 + 一个长条：九宫格圆 | 长条（左端搜索图标 · 页名 · 右端快捷面板图标）| 头像圆；
 * 两个图标各 40px 圆形点击区、对称内缩（图标中心距长条外缘 26 = 圆半径），页名在长条正中，长条在屏幕正中。
 * 顶栏 v8（2026-10-22，三个站同一套）：九宫格圆 | 长条（只有页名）| 右圆（每站自定义；主站 = 快捷面板）；头像挪进导航抽屉头（字标右边）。
 * 主站顶栏三栏（2026-10-22 PR2，只在主站）：主页 / 聊天 / 设置（2026-10-24 PR4 第三栏由「状态」换成「设置」）这三页长条里是三个标签（.sgx-tb-tabs），
 * 不放页名；其他页照旧只有页名。三栏本身的验收见 space-status.spec.js。
 * P4-3 PR-4b（2026-11-07）：主页和设置合成「旷野 / Space」（根路径 /），顶栏标签只剩一个「旷野」；原设置子页去掉 settings 一层挂到根下（/theme/ 等；显示页 /display/ 随后删除）。
 * 顶栏全大椭圆（2026-11-04 P5-1，四个站同一个）：一整条胶囊 .sgx-topbar = [logo][中间：主站标签 / 页名][快捷面板 · AI · 头像]；
 * 九宫格圆、导航抽屉、右圆删除（导航进快捷面板第 1 页，见 quick-panel.spec.js）；主站标签只剩 主页 / 设置。材质（--sgx-mat + 毛玻璃）在整条胶囊上，
 * 中间和按钮本身透明；胶囊高 = 原来圆按钮的高（52，≥ 600 宽按公式到 56），里面的按钮 40px；< 600 宽中间伸缩，≥ 600 宽中间按内容定宽、在屏幕正中。
 * P4-3 PR-4b 定稿（Gray 2026-11-07）：[字标（各宽度完整）][页名胶囊，在字标与图标组之间的空余区居中][九宫格 · 快捷设置 · AI]；头像不在顶栏（在 AI 窗口头部）；
 * 右边按钮 38 宽 40 高、间距 2px，整体靠右；360 / 384 / 412 / 1280 / 1920 都不溢出、长页名省略号。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, nextFrames, animationsDone, scrolledTo, armNavProbe, expect } = require('../helpers/helpers');

async function go(page, path, opts = {}) {
  await blockExternalRequests(page);
  await freezeTime(page);
  if (opts.dark) {
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-theme-mode', 'dark'); } catch (e) {}
    });
  }
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
  /* C8：原来固定等 300ms；改成等字体就绪（量尺寸前文字排版要定）+ 入场动画 / 过渡结束 */
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await animationsDone(page);
}

async function box(page, sel) {
  const b = await page.locator(sel).first().boundingBox();
  if (!b) throw new Error('no box: ' + sel);
  return b;
}

function near(a, b, tol = 1) {
  return Math.abs(a - b) <= tol;
}

for (const dark of [false, true]) {
  test.describe(`390×844 ${dark ? '暗色' : '亮色'}`, () => {
    test.use({ viewport: { width: 390, height: 844 } });

    for (const path of ['/', '/theme/', '/security/']) {
      test(`${path}：一整条胶囊（字标 · 页名胶囊 · 九宫格 · 快捷设置 · AI），没有头像；坐标、高度一致；材质只在胶囊上`, async ({ page }) => {
        await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
        await go(page, path, { dark });
        const [bar, logo, pill, g, q, ai] = await Promise.all(['.sgx-topbar', '.sgx-tb-logo', '.sgx-tb-pill', '.sgx-tb-grid', '.sgx-tb-quick', '.sgx-tb-ai'].map((s) => box(page, s)));
        /* 胶囊：左右贴页边距 16，y = 16，高 52 */
        expect(near(bar.x, 16) && near(bar.x + bar.width, 374), `胶囊 x ${bar.x}–${bar.x + bar.width}`).toBe(true);
        expect(near(bar.y, 16) && near(bar.height, 52), `胶囊 y ${bar.y} 高 ${bar.height}`).toBe(true);
        /* 里面的按钮 40 高、38 宽（紧凑）、上下居中；字标左缘 / AI 右缘离胶囊边 (52 − 40) / 2 = 6 */
        for (const b of [logo, g, q, ai]) {
          expect(near(b.height, 40), `高 ${b.height}`).toBe(true);
          expect(near(b.y + b.height / 2, bar.y + bar.height / 2), `垂直居中 ${b.y}`).toBe(true);
        }
        for (const b of [g, q, ai]) expect(near(b.width, 38), `按钮宽 ${b.width}`).toBe(true);
        expect(near(q.x - (g.x + g.width), 2) && near(ai.x - (q.x + q.width), 2), '按钮间距 2px').toBe(true);
        expect(near(logo.x - bar.x, 6), `logo 左距 ${logo.x - bar.x}`).toBe(true);
        expect(near(bar.x + bar.width - (ai.x + ai.width), 6), `AI 右距 ${bar.x + bar.width - (ai.x + ai.width)}`).toBe(true);
        /* 顺序：字标 → 中间 → 九宫格 → 快捷设置 → AI，互不重叠 */
        expect(logo.x + logo.width).toBeLessThanOrEqual(pill.x + 0.5);
        expect(pill.x + pill.width).toBeLessThanOrEqual(g.x + 0.5);
        expect(g.x + g.width).toBeLessThanOrEqual(q.x + 0.5);
        expect(q.x + q.width).toBeLessThanOrEqual(ai.x + 0.5);
        /* 390 宽：字标完整（真 SVG，不是 40px 图标版） */
        expect(logo.width, `字标宽 ${logo.width}`).toBeGreaterThan(60);
        await expect(page.locator('.sgx-tb-logo svg.sgx-wordmark')).toBeVisible();
        await expect(page.locator('.sgx-tb-mark')).toHaveCount(0);
        await expect(page.locator('.sgx-tb-back, [data-go-back], .sgx-tb-more, .sgx-tb-search, #sgx-tb-search, .sgx-tb-nav, .sgx-tb-end, #sgx-drawer')).toHaveCount(0);
        /* 头像不在顶栏 */
        await expect(page.locator('#site-nav .sgx-tb-me, #site-nav img')).toHaveCount(0);
        const home = path === '/';
        expect(await page.locator('.sgx-topbar > *').evaluateAll((els) => els.map((e) => e.className))).toEqual(['sgx-tb-logo', home ? 'sgx-tb-pill sgx-tb-pill-tabs' : 'sgx-tb-pill', 'sgx-tb-acts']);
        expect(await page.locator('.sgx-tb-acts > *').evaluateAll((els) => els.map((e) => e.className))).toEqual(['sgx-tb-btn sgx-tb-grid', 'sgx-tb-btn sgx-tb-quick', 'sgx-tb-btn sgx-tb-ai']);
        expect(await page.locator('.sgx-tb-pill > *').evaluateAll((els) => els.map((e) => e.className))).toEqual([home ? 'sgx-tb-tabs' : 'sgx-tb-title']);
        await expect(page.locator('.sgx-tb-pill svg, .sgx-tb-pill button')).toHaveCount(0);
        await expect(page.locator('.sgx-tb-pill a')).toHaveCount(home ? 1 : 0);
        for (const s of ['.sgx-tb-grid', '.sgx-tb-quick', '.sgx-tb-ai']) await expect(page.locator(s + ' svg')).toHaveCount(1);
        /* 页名胶囊在字标与图标组之间的空余区里水平居中、在胶囊里垂直居中；有主题色椭圆衬底 */
        const tx = await box(page, home ? '.sgx-tb-tab' : '.sgx-tb-title');
        const mid = (logo.x + logo.width + g.x) / 2;
        expect(near(tx.x + tx.width / 2, mid, 1.5), `页名中心 ${tx.x + tx.width / 2}，空余区中心 ${mid}`).toBe(true);
        expect(near(tx.y + tx.height / 2, bar.y + bar.height / 2), `页名垂直居中 ${tx.y + tx.height / 2}`).toBe(true);
        const lab = await page.locator(home ? '.sgx-tb-tab' : '.sgx-tb-title').evaluate((el) => { const c = getComputedStyle(el); return { bg: c.backgroundColor, r: parseFloat(c.borderTopLeftRadius) }; });
        expect(lab.bg).not.toBe('rgba(0, 0, 0, 0)');
        expect(lab.r).toBeGreaterThanOrEqual(16);
        /* 材质：胶囊 = 悬浮层磨砂（半透明 + 毛玻璃 + 发丝边）；中间、按钮区本身透明 */
        const st = await page.evaluate(() => {
          const c = (s) => getComputedStyle(document.querySelector(s));
          const b = c('.sgx-topbar');
          return { bar: b.backgroundColor, bf: b.backdropFilter || b.webkitBackdropFilter, bw: b.borderTopWidth, rad: b.borderTopLeftRadius,
            pill: c('.sgx-tb-pill').backgroundColor, acts: c('.sgx-tb-acts').backgroundColor, q: c('.sgx-tb-quick').backgroundColor };
        });
        expect(st.bar).not.toBe('rgba(0, 0, 0, 0)');
        expect(st.bf).toContain('blur');
        expect(st.bw).toBe('1px');
        expect(parseFloat(st.rad)).toBeGreaterThanOrEqual(26);
        expect([st.pill, st.acts, st.q]).toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)']);
      });
    }
  });
}

/* PR-4b：窄屏到宽屏都不溢出；页名胶囊在空余区居中；长页名省略号（窄屏保最小间距） */
for (const w of [360, 384, 412, 1280, 1920]) {
  test(`${w} 宽：顶栏不溢出，字标完整，页名胶囊在字标与图标组之间居中、和两边都留空`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: w > 1000 ? 900 : 860 });
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
    for (const path of ['/', '/wellbeing/', '/security/tempkeys/', '/en/status/']) {
      if (path.startsWith('/en/')) await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'en'); } catch (e) {} });
      await go(page, path);
      const m = await page.evaluate(() => {
        const r = (s) => document.querySelector(s).getBoundingClientRect();
        const lab = document.querySelector('.sgx-tb-title, .sgx-tb-tab');
        const bar = r('.sgx-topbar'), logo = r('.sgx-tb-logo'), acts = r('.sgx-tb-acts'), t = lab.getBoundingClientRect();
        return { bar: [bar.left, bar.right], logo: [logo.left, logo.right], acts: [acts.left, acts.right], t: [t.left, t.right], sw: document.documentElement.scrollWidth,
          over: Array.from(document.querySelectorAll('.sgx-topbar *')).some((e) => { const b = e.getBoundingClientRect(); return b.width && (b.right > bar.right + 0.5 || b.left < bar.left - 0.5); }) };
      });
      expect(m.sw, `${path} 页面横向溢出`).toBeLessThanOrEqual(w);
      expect(m.over, `${path} 顶栏里有东西超出胶囊`).toBe(false);
      expect(m.t[0] - m.logo[1], `${path} 页名离字标`).toBeGreaterThanOrEqual(4);
      expect(m.acts[0] - m.t[1], `${path} 页名离图标组`).toBeGreaterThanOrEqual(4);
      expect(Math.abs((m.t[0] + m.t[1]) / 2 - (m.logo[1] + m.acts[0]) / 2), `${path} 页名居中`).toBeLessThanOrEqual(1.5);
      expect(m.logo[1] - m.logo[0], `${path} 字标完整`).toBeGreaterThan(60);
    }
  });
}

test('窄屏长页名：省略号截断，不挤字标、不挤图标', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'en'); } catch (e) {} });
  await go(page, '/en/security/tempkeys/');
  await page.evaluate(() => { document.querySelector('.sgx-tb-title').textContent = 'A very long page name that cannot possibly fit here'; });
  const m = await page.evaluate(() => {
    const t = document.querySelector('.sgx-tb-title');
    const r = (e) => e.getBoundingClientRect();
    return { clipped: t.scrollWidth > t.clientWidth, ov: getComputedStyle(t).textOverflow, gapL: r(t).left - r(document.querySelector('.sgx-tb-logo')).right, gapR: r(document.querySelector('.sgx-tb-acts')).left - r(t).right };
  });
  expect(m.clipped).toBe(true);
  expect(m.ov).toBe('ellipsis');
  expect(m.gapL).toBeGreaterThanOrEqual(4);
  expect(m.gapR).toBeGreaterThanOrEqual(4);
});

test.describe('390×844 行为', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('旧顶栏元素、标题区旧按钮、大标题区、Styrigx 品牌字都已删除', async ({ page }) => {
    await go(page, '/theme/');
    for (const sel of ['#nav-time-center', '#nav-wx', '#nav-music-note', '.nav-inner', '.subpage-back', '#nav-brand', '.sgx-tb-text', '.subpage-mini-title']) {
      await expect(page.locator(sel), sel).toHaveCount(0);
    }
    await expect(page.locator('[data-tb-more]')).toHaveCount(0);
  });

  /* 旷野页（/、/en/）长条里是单个「旷野」标签、没有页名（space-status.spec.js）；旷野子页照旧显示页名 */
  const NAMES = [
    ['/status/', '服务状态'],
    ['/account/sync/', '云同步'],
    /* PR3：账号页没登录（这里没有账号会话）时页名是「登录账号」，登录后才是「账号」 */
    ['/account/', '登录账号'],
    ['/account/reset/', '重置登录'],
    ['/security/', '安全'],
    ['/security/lock/', '锁屏凭证'],
    ['/theme/', '风格'],
    ['/en/status/', 'Service status'],
    ['/en/account/', 'Sign in'],
    ['/en/account/reset/', 'Reset sign-in'],
  ];
  for (const [path, name] of NAMES) {
    test(`${path}：长条显示当前页名「${name}」（不是 Styrigx），没有大标题区`, async ({ page }) => {
      await page.addInitScript((en) => { try { localStorage.setItem('sgx-lang', en ? 'en' : 'zh'); } catch (e) {} }, path.startsWith('/en/'));
      await go(page, path);
      await expect(page.locator('.sgx-tb-title')).toHaveText(name);
      await expect(page.locator('.sgx-tb-pill')).not.toContainText('Styrigx');
      await expect(page.locator('.subpage-title, .subpage-hero, [data-subpage-head]')).toHaveCount(0);
      /* 长条里没有图标 */
      await expect(page.locator('.sgx-tb-pill svg')).toHaveCount(0);
    });
  }

  test('旷野页长条里没有设置按钮、没有搜索图标；长条只有一个「旷野」标签（2026-10-22 起不放页名；P4-3 PR-4b 主页 / 设置合并），长条本身不可点', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
    await go(page, '/');
    await expect(page.locator('.sgx-tb-set')).toHaveCount(0);
    await expect(page.locator('.sgx-tb-psearch')).toHaveCount(0);
    expect(await page.locator('.sgx-tb-pill > *').evaluateAll((els) => els.map((e) => e.className.split(' ')[0]))).toEqual(['sgx-tb-tabs']);
    await expect(page.locator('.sgx-tb-pill .sgx-tb-tab')).toHaveText(['旷野']);
    await expect(page.locator('.sgx-tb-pill .sgx-tb-tab')).toHaveAttribute('href', '/');
    await expect(page.locator('.sgx-tb-pill .sgx-tb-tab')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.sgx-tb-title')).toHaveCount(0);
    await expect(page.locator('#sgx-tb-cap')).toHaveCount(0);
    await expect(page.locator('.sgx-topbar .sgx-tb-search, #sgx-tb-search')).toHaveCount(0);
    expect(await page.locator('.sgx-tb-pill').evaluate((el) => getComputedStyle(el).cursor)).toBe('default');
    /* 顶栏里没有任何指向旧设置层的链接（旧地址运行时拼，免得 git grep 命中） */
    await expect(page.locator('.sgx-topbar a[href$="' + '/' + 'settings' + '/' + '"]')).toHaveCount(0);
  });

  for (const path of ['/', '/account/', '/theme/']) {
    test(`${path}：正文从顶栏下方 16px 开始（--sgx-content-top，全站同一个值）`, async ({ page }) => {
      await go(page, path);
      const m = await page.evaluate(() => {
        const bar = document.querySelector('.sgx-topbar').getBoundingClientRect();
        const main = document.getElementById('sgx-main');
        const first = main.firstElementChild.getBoundingClientRect();
        return { barBottom: bar.bottom, firstTop: first.top, scrollY: window.scrollY };
      });
      expect(m.scrollY).toBe(0);
      expect(Math.abs(m.firstTop - (m.barBottom + 16)), `首块顶 ${m.firstTop}，顶栏下沿 ${m.barBottom}`).toBeLessThanOrEqual(1);
    });
  }

  test('滚动时长条不变：页名一直显示，没有 sgx-stuck 切换，按钮不动', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
    await go(page, '/security/');
    const before = await Promise.all(['.sgx-tb-pill', '.sgx-tb-quick', '.sgx-tb-logo', '.sgx-tb-ai'].map((s) => box(page, s)));
    await page.evaluate(() => window.scrollTo(0, 400));
    /* C8：原来固定等 300ms；改成等滚动落地（scroll 监听跑完）+ 顶栏可能的过渡结束 */
    await scrolledTo(page, 400);
    await animationsDone(page);
    expect(await page.evaluate(() => document.body.classList.contains('sgx-stuck'))).toBe(false);
    await expect(page.locator('.sgx-tb-title')).toHaveText('安全');
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.sgx-tb-title')).opacity)).toBe('1');
    const after = await Promise.all(['.sgx-tb-pill', '.sgx-tb-quick', '.sgx-tb-logo', '.sgx-tb-ai'].map((s) => box(page, s)));
    for (let i = 0; i < 4; i++) {
      expect(near(after[i].x, before[i].x) && near(after[i].y, before[i].y)).toBe(true);
    }
  });

  test('点长条（页名）不跳转', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
    await go(page, '/account/');
    const navs = await armNavProbe(page);
    await page.locator('.sgx-tb-title').click();
    /* C8：原来固定等 400ms；点击处理同步，要跳的话 navigate 事件此时已派发 */
    await nextFrames(page);
    expect(await navs(), '点页名不触发任何导航').toEqual([]);
    expect(new URL(page.url()).pathname).toBe('/account/');
  });

  test('顶栏切页过渡名挂在有尺寸的 .sgx-topbar 上', async ({ page }) => {
    await go(page, '/theme/');
    const names = await page.evaluate(() => ({
      bar: getComputedStyle(document.querySelector('.sgx-topbar')).viewTransitionName,
      nav: getComputedStyle(document.getElementById('site-nav')).viewTransitionName,
    }));
    expect(names).toEqual({ bar: 'sgx-topbar', nav: 'none' });
  });

  test('头像在 AI 窗口头部（PR-4b）：Gray AI · 新对话 · 历史 · 头像（主题色环），点头像进账号页', async ({ page }) => {
    /* 固定中文：不设 sgx-lang 时语言跟随浏览器（en-US）会把 / 带到 /en/ */
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
    await go(page, '/');
    await page.locator('.sgx-tb-ai').click();
    const dlg = page.locator('#sgx-ai');
    await expect(dlg).toBeVisible();
    await animationsDone(page);
    expect(await dlg.locator('.sgx-ai-head > *').evaluateAll((els) => els.map((e) => e.className + '|' + (e.getAttribute('aria-label') || e.textContent.trim())))).toEqual(
      ['sgx-ai-title|Gray AI', 'sgx-ai-hbtn|新对话', 'sgx-ai-hbtn|历史', 'sgx-ai-me|账号']);
    const [t, nc, hi, me] = await Promise.all(['.sgx-ai-title', '[data-ai-clear]', '[data-ai-history]', '.sgx-ai-me'].map((s) => box(page, '#sgx-ai ' + s)));
    expect(t.x + t.width <= nc.x && nc.x + nc.width <= hi.x && hi.x + hi.width <= me.x, '从左到右：标题 → 新对话 → 历史 → 头像').toBe(true);
    for (const b of [nc, hi, me]) expect(Math.abs(b.y + b.height / 2 - (t.y + t.height / 2)), '一行对齐').toBeLessThanOrEqual(2);
    await expect(dlg.locator('.sgx-ai-actions, .sgx-ai-pill')).toHaveCount(0);
    const av = await dlg.locator('img.sgx-ai-avatar').evaluate((el) => {
      const c = getComputedStyle(el);
      const probe = document.createElement('span');
      probe.style.color = 'var(--sgx-primary-fill)';
      document.body.appendChild(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      return { br: c.borderTopLeftRadius, of: c.objectFit, sh: c.boxShadow, accent, w: el.getBoundingClientRect().width };
    });
    expect(parseFloat(av.br)).toBeGreaterThanOrEqual(16);
    expect(av.of).toBe('cover');
    expect(av.sh.startsWith(av.accent), `头像环 = 主题色（${av.sh}）`).toBe(true);
    expect(av.sh).not.toContain('rgb(255, 255, 255)');
    /* 头部下有一条细线 */
    expect(await dlg.locator('.sgx-ai-head').evaluate((el) => getComputedStyle(el).borderBottomWidth)).toBe('1px');
    /* 底部：仅公开内容 · 联系我（mailto:styrigx@gmail.com） */
    await expect(dlg.locator('.sgx-ai-foot')).toHaveText('仅公开内容·联系我');
    await expect(dlg.locator('[data-ai-contact]')).toHaveAttribute('href', 'mailto:styrigx@gmail.com');
    await expect(dlg.locator('.sgx-ai-me')).toHaveAttribute('href', '/account/');
    await dlg.locator('.sgx-ai-me').click();
    await page.waitForURL(/\/account\/$/);
    await expect(page.locator('#acct-login')).toBeVisible();
  });

  test('英文页：AI 窗口头像链到英文账号页，底部 Public content only · Contact me', async ({ page }) => {
    await go(page, '/en/');
    await expect(page.locator('#sgx-ai .sgx-ai-me')).toHaveAttribute('href', '/en/account/');
    await expect(page.locator('#sgx-ai [data-ai-contact]')).toHaveText('Contact me');
    await expect(page.locator('#sgx-ai [data-ai-contact]')).toHaveAttribute('href', 'mailto:styrigx@gmail.com');
    await expect(page.locator('#sgx-ai [data-ai-clear]')).toHaveAttribute('aria-label', 'New chat');
  });

  test('九宫格打开导航面板（2×2 站点磁贴，当前站「开」态），Esc 关闭、焦点回到九宫格；快捷面板只有一页', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
    await go(page, '/');
    await page.locator('.sgx-tb-grid').click();
    const nav = page.locator('#sgx-nav');
    await expect(nav).toBeVisible();
    await expect(page.locator('.sgx-tb-grid')).toHaveAttribute('aria-expanded', 'true');
    await expect(nav.locator('.sgx-nav-tile .sgx-qp-label')).toHaveText(['旷野', '奇趣', '日刻', '博客']);
    await expect(nav.locator('.sgx-nav-tile[aria-current="page"]')).toHaveAttribute('data-nav', 'home');
    await animationsDone(page);
    const t = await nav.locator('.sgx-nav-tile').evaluateAll((els) => els.map((e) => { const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top)]; }));
    expect(t[0][1]).toBe(t[1][1]);
    expect(t[2][1]).toBe(t[3][1]);
    expect(t[0][0]).toBe(t[2][0]);
    expect(t[2][1]).toBeGreaterThan(t[0][1]);
    const cur = await nav.locator('.sgx-nav-tile[aria-current="page"]').evaluate((el) => getComputedStyle(el).backgroundColor);
    const other = await nav.locator('.sgx-nav-tile[data-nav="curio"]').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(cur).not.toBe(other);
    /* 面板高度按内容（不撑满） */
    const sh = await box(page, '#sgx-nav .sgx-qp-sheet');
    expect(sh.height).toBeLessThan(260);
    await page.keyboard.press('Escape');
    await expect(nav).toBeHidden();
    await expect(page.locator('.sgx-tb-grid')).toBeFocused();
    await expect(page.locator('.sgx-tb-grid')).toHaveAttribute('aria-expanded', 'false');
    await page.locator('.sgx-tb-quick').click();
    const qp = page.locator('#sgx-qp');
    await expect(qp).toBeVisible();
    await expect(qp.locator('[role="tab"], [role="tabpanel"], .sgx-qp-nav-item')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(qp).toBeHidden();
    await expect(qp).toHaveAttribute('data-state', 'closed');
    await expect(qp).not.toHaveClass(/\bis-open\b/);
  });

  test('导航面板：点别的站 / 本站子页点本站关面板后跳过去；已在本站首页点本站只关面板', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
    await go(page, '/security/');
    await page.locator('.sgx-tb-grid').click();
    await page.locator('#sgx-nav .sgx-nav-tile[data-nav="home"]').click();
    await page.waitForURL((u) => new URL(u).pathname === '/', { waitUntil: 'commit' });
    await go(page, '/security/');
    await page.locator('.sgx-tb-grid').click();
    await page.route('**/curio/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>curio</title>' }));
    await page.locator('#sgx-nav .sgx-nav-tile[data-nav="curio"]').click();
    await page.waitForURL((u) => new URL(u).pathname === '/curio/', { waitUntil: 'commit' });
    await go(page, '/');
    await page.locator('.sgx-tb-grid').click();
    const navs = await armNavProbe(page);
    await page.locator('#sgx-nav .sgx-nav-tile[data-nav="home"]').click();
    await expect(page.locator('#sgx-nav')).toBeHidden();
    /* 只有关面板退哨兵的 traverse，没有跳转 */
    expect((await navs()).filter((n) => !n.startsWith('traverse '))).toEqual([]);
  });
});

test.describe('1280×800', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  /* 2026-10-23 PR-D：顶栏 = 外壳框 --sgx-shell-w = min(100% − 2 × 页边距, 最宽)，最宽 DeX 1440 / Mobile 640；
     页边距 ≥ 600 宽 = clamp(16, 5.333 + 2.2222vw, 48)；顶栏高（原圆按钮）clamp(52, 42 + 1.667vw, 56)（≥ 840 宽 56）。
     2026-11-04 P5-1 胶囊：里面的按钮 40px，logo 左缘 / 头像右缘离胶囊边 (高 − 40) / 2 */
  for (const [w, h] of [[600, 900], [840, 600], [1280, 800], [1920, 1080], [2560, 1440]]) {
    test(`${w}×${h}：外壳框宽 / 页边距 / 圆按钮按公式（±1px），居中`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await go(page, '/theme/');
      const m = Math.min(48, Math.max(16, 5.333 + 0.022222 * w));
      const max = w >= 840 && h >= 500 && w > h ? 1440 : 640;
      const want = Math.min(w - 2 * m, max);
      const btn = Math.min(56, Math.max(52, 42 + 0.01667 * w));
      const gap = Math.min(12, Math.max(8, -2 + 0.01667 * w));
      const bar = await box(page, '.sgx-topbar');
      expect(near(bar.width, want), `宽 ${bar.width} ≠ ${want}`).toBe(true);
      expect(near(bar.x, (w - want) / 2), `x ${bar.x}`).toBe(true);
      const me = await box(page, '.sgx-tb-ai');
      const logo = await box(page, '.sgx-tb-logo');
      const q = await box(page, '.sgx-tb-quick');
      expect(near(bar.height, btn), `顶栏高 ${bar.height}，应为 ${btn}`).toBe(true);
      expect(near(me.width, 38) && near(q.width, 38) && near(logo.height, 40) && near(me.height, 40), `按钮 ${me.width} / ${q.width} / logo 高 ${logo.height}`).toBe(true);
      const inset = (btn - 40) / 2;
      expect(near(logo.x - bar.x, inset) && near(bar.x + bar.width - (me.x + me.width), inset), `logo / AI 离胶囊边应为 ${inset}`).toBe(true);
      void gap;
    });
  }

  for (const [w, h] of [[1280, 800], [1920, 1080]]) {
    test(`${w}px：字标贴左、图标组贴右（紧凑），页名胶囊按字定宽、在两者之间的空余区居中（±1.5px）`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await go(page, '/security/');
      const [bar, logo, g, ai] = await Promise.all(['.sgx-topbar', '.sgx-tb-logo', '.sgx-tb-grid', '.sgx-tb-ai'].map((s) => box(page, s)));
      expect(logo.x - bar.x).toBeLessThanOrEqual(9);
      expect(bar.x + bar.width - (ai.x + ai.width)).toBeLessThanOrEqual(9);
      expect(ai.x + ai.width - g.x, '三个图标紧凑（3 × 38 + 2 × 2）').toBeLessThanOrEqual(119);
      const tx = await box(page, '.sgx-tb-title');
      expect(tx.width, `页名胶囊按字定宽 ${tx.width}`).toBeLessThan(200);
      expect(near(tx.x + tx.width / 2, (logo.x + logo.width + g.x) / 2, 1.5), `页名中心 ${tx.x + tx.width / 2}`).toBe(true);
    });
  }

  for (const path of ['/', '/theme/']) {
    test(`${path}：宽屏正文同样从顶栏下方 16px 开始，没有大标题区`, async ({ page }) => {
      await go(page, path);
      const m = await page.evaluate(() => {
        const bar = document.querySelector('.sgx-topbar').getBoundingClientRect();
        const first = document.getElementById('sgx-main').firstElementChild.getBoundingClientRect();
        return { barBottom: bar.bottom, firstTop: first.top };
      });
      expect(Math.abs(m.firstTop - (m.barBottom + 16)), `首块顶 ${m.firstTop}，顶栏下沿 ${m.barBottom}`).toBeLessThanOrEqual(1);
      await expect(page.locator('.subpage-title, [data-subpage-head]')).toHaveCount(0);
    });
  }
});
