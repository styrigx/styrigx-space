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
 * P4-3 PR-4b（2026-11-07）：主页和设置合成「旷野 / Space」（根路径 /），顶栏标签只剩一个「旷野」；原设置子页去掉 settings 一层挂到根下（/wild/ 等；显示页 /display/ 随后删除）。
 * 顶栏全大椭圆（2026-11-04 P5-1，四个站同一个）：一整条胶囊 .sgx-topbar = [logo][中间：主站标签 / 页名][快捷面板 · AI · 头像]；
 * 九宫格圆、导航抽屉、右圆删除（导航进快捷面板第 1 页，见 quick-panel.spec.js）；主站标签只剩 主页 / 设置。材质（--sgx-mat + 毛玻璃）在整条胶囊上，
 * 中间和按钮本身透明；胶囊高 = 原来圆按钮的高（52，≥ 600 宽按公式到 56），里面的按钮 40px；< 600 宽中间伸缩，≥ 600 宽中间按内容定宽、在屏幕正中。
 * P4-3 PR-4b 定稿（Gray 2026-11-07）：[字标（各宽度完整）][页名胶囊，只显示当前页名，按整条顶栏居中][九宫格 · 快捷设置 · AI]；头像不在顶栏（在 AI 窗口头部）；
 * 页名胶囊只在桌面布局显示（手机布局 = 字标 | 图标组），放不下退到字标后面、省略号；顶栏没有标签 / 分段。
 * 右边三颗圆按钮 40 × 40、图标 20px、间距 6px，没有公共底：九宫格 / 快捷 平时透明、打开浅一档（primary-container）；
 * AI 平时浅一档、打开深一档（primary-fill）。360 / 384 / 412 / 1280 / 1920 都不溢出。
 * 顶栏 v3（2026-11 UI 重设计 PR-1，Gray 定稿设计稿 tb4 / tb-v3 / prog-v1 / nav-v2）：贴顶通栏（高 64、底边 1px 线、毛玻璃），内容收在居中的 1080 里（--sgx-content-w）：
 * [字标 ❯ styrigx :~$_（光标 1.05s 闪）] … [盾牌 · 外观（调色盘）· 四格（NAVIGATE）· 分隔 · >_（终端）· 头像（账号窗口）]（v5 S6 顶栏 E）；底边滑页进度条；右下角 AI 浮钮。
 * 页名胶囊标记还在但顶栏不显示（锁屏顶栏照旧用它当标题）。NAVIGATE：01 主页 02 博客 03 奇趣 04 日刻 05 旷野 + lang / layout + share / lock + STATUS。
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

/** 同 go，但先挂 /api/status 的 mock（要排在 blockExternalRequests 之后注册才优先） */
async function goStatus(page, path, handler) {
  await blockExternalRequests(page);
  await freezeTime(page);
  await page.route('**/api/status', handler);
  /* 测试构建默认不自动问 /api/status（静态站没接口，免得 Lighthouse 控制台报 404）；这里打开 */
  await page.addInitScript(() => { window.__sgxStatusApi = true; });
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
}

async function box(page, sel) {
  const b = await page.locator(sel).first().boundingBox();
  if (!b) throw new Error('no box: ' + sel);
  return b;
}

function near(a, b, tol = 1) {
  return Math.abs(a - b) <= tol;
}

/** 把 CSS 变量解析成浏览器算出的颜色（和 getComputedStyle 的 backgroundColor 同一种写法） */
async function roleColor(page, v) {
  return page.evaluate((name) => {
    const d = document.createElement('div');
    d.style.backgroundColor = `var(${name})`;
    document.body.appendChild(d);
    const c = getComputedStyle(d).backgroundColor;
    d.remove();
    return c;
  }, v);
}
const bg = (page, sel) => page.locator(sel).evaluate((el) => getComputedStyle(el).backgroundColor);
/** 顶栏 / 页脚左右内边距（= CSS --sgx-tb-pad）：max(页边距, (宽 − 1080) / 2)；页边距 < 600 宽 16，≥ 600 宽 clamp(16, 5.333 + 2.2222vw, 48) */
const pad = (w) => Math.max(w < 600 ? 12 /* 对齐 PR-B：手机页边距 12 */ : Math.min(48, Math.max(16, 5.333 + 0.022222 * w)), (w - 1080) / 2);

for (const dark of [false, true]) {
  test.describe(`390×844 ${dark ? '暗色' : '亮色'}`, () => {
    test.use({ viewport: { width: 390, height: 844 } });

    for (const path of ['/', '/wild/', '/404.html']) { /* 进站 v3 L1：/security/ 已删，短页换 404 */
      test(`${path}：贴顶通栏（v5 S6 顶栏 E：字标 · 盾牌 · 外观 · 四格 · | · >_ · 头像；不显示页名），按钮 40 × 40；AI 浮钮右下角；按钮颜色按状态`, async ({ page }) => {
        await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
        await go(page, path, { dark });
        /* 390 宽、桌面 UA、自动：视口 < 720 → 手机布局 */
        await expect(page.locator('html')).toHaveAttribute('data-sgx-layout', 'phone');
        const [bar, logo, q, sh, g, tm, av, ai] = await Promise.all(['.sgx-topbar', '.sgx-tb-logo', '.sgx-tb-quick', '.sgx-tb-shield', '.sgx-tb-grid', '.sgx-tb-term', '.sgx-tb-av', '.sgx-tb-ai'].map((s) => box(page, s)));
        /* 通栏：贴顶、全宽；手机布局高 56（2026-11-09 fix/mobile-topbar-56，原 64；只收上下留白） */
        expect(near(bar.x, 0) && near(bar.width, 390), `顶栏 x ${bar.x} 宽 ${bar.width}`).toBe(true);
        expect(near(bar.y, 0) && near(bar.height, 56), `顶栏 y ${bar.y} 高 ${bar.height}`).toBe(true);
        /* 字标 / 按钮 40 高、上下居中；按钮 40 宽；字标左缘贴页边距（12 − 4 内缩）、头像右缘贴页边距 12（对齐 PR-B） */
        for (const b of [logo, q, sh, g, tm, av]) {
          expect(near(b.height, 40), `高 ${b.height}`).toBe(true);
          expect(near(b.y + b.height / 2, bar.y + bar.height / 2), `垂直居中 ${b.y}`).toBe(true);
        }
        for (const b of [q, sh, g, tm, av]) expect(near(b.width, 40), `按钮宽 ${b.width}`).toBe(true);
        expect(near(logo.x, 8), `logo 左 ${logo.x}`).toBe(true);
        expect(near(av.x + av.width, 390 - 12), `头像右 ${av.x + av.width}`).toBe(true);
        expect(sh.x < q.x && q.x < g.x && g.x < tm.x && tm.x < av.x, '盾牌 → 外观 → 四格 → >_ → 头像').toBe(true);
        expect(logo.x + logo.width).toBeLessThanOrEqual(sh.x + 0.5);
        expect(logo.width, `字标宽 ${logo.width}`).toBeGreaterThan(80);
        /* 2026-11 PR-2（Gray）：❯ + SVG 字标（手机 20px 高，和 ❯、光标上下居中）+ 光标；没有 :~$、窄屏不收 */
        await expect(page.locator('.sgx-tb-logo .sgx-tb-name svg.sgx-wordmark')).toHaveCount(1);
        await expect(page.locator('.sgx-tb-logo .sgx-tb-cu')).toHaveCount(1);
        await expect(page.locator('.sgx-tb-logo .sgx-tb-tl, .sgx-tb-mark, .sgx-tb-logo small')).toHaveCount(0);
        {
          const wm = await page.locator('.sgx-tb-logo .sgx-wordmark').boundingBox();
          const ps = await page.locator('.sgx-tb-logo .sgx-tb-ps').boundingBox();
          expect(near(wm.height, 20), `字标高 ${wm.height}`).toBe(true);
          expect(Math.abs((wm.y + wm.height / 2) - (ps.y + ps.height / 2)), '字标和 ❯ 上下居中').toBeLessThanOrEqual(3);
        }
        await expect(page.locator('.sgx-tb-back, [data-go-back], .sgx-tb-more, .sgx-tb-search, #sgx-tb-search, .sgx-tb-nav, .sgx-tb-end, #sgx-drawer')).toHaveCount(0);
        expect(await page.locator('.sgx-topbar > *').evaluateAll((els) => els.map((e) => e.className))).toEqual(['sgx-tb-logo', 'sgx-tb-pill', 'sgx-tb-acts', 'sgx-tb-prog']);
        expect(await page.locator('.sgx-tb-acts > *').evaluateAll((els) => els.map((e) => e.className.replace(/\s*\bis-busy\b/, '')))).toEqual([ /* 去掉 .is-busy：加载中头像外圈转快（2026-11-09） */'sgx-tb-btn sgx-tb-shield', 'sgx-tb-btn sgx-tb-quick', 'sgx-tb-btn sgx-tb-grid', 'sgx-tb-sep', 'sgx-tb-btn sgx-tb-term', 'sgx-tb-av']);
        /* 页名胶囊：标记在、只放页名，顶栏不显示 */
        expect(await page.locator('#site-nav .sgx-tb-pill > *').evaluateAll((els) => els.map((e) => e.className))).toEqual(['sgx-tb-title']);
        await expect(page.locator('#site-nav .sgx-tb-pill')).toBeHidden();
        for (const s of ['.sgx-tb-quick', '.sgx-tb-shield', '.sgx-tb-grid', '.sgx-tb-term']) {
          await expect(page.locator(s + ' svg')).toHaveCount(1);
          const sv = await box(page, s + ' svg');
          expect(near(sv.width, 20) && near(sv.height, 20), `${s} 图标 20px`).toBe(true);
        }
        /* 头像 30px 圆；分隔线 1 × 22 */
        const img = await box(page, '.sgx-tb-av img');
        expect(near(img.width, 30) && near(img.height, 30), `头像 ${img.width}`).toBe(true);
        const sep = await box(page, '.sgx-tb-sep');
        expect(near(sep.width, 1) && near(sep.height, 22), `分隔 ${sep.width}×${sep.height}`).toBe(true);
        /* AI 浮钮：右下角 56 × 56（手机边距 16），主题实色 */
        expect(near(ai.width, 56) && near(ai.height, 56), `AI 浮钮 ${ai.width}`).toBe(true);
        /* 2026-11-08 PR-A：离底抬到 28（右边距仍 16）；页脚露出时再往上让，见 layout/touch-scroll-fab.spec.js */
        {
          /* 短页（/404.html）页脚一进来就在视口里：浮钮停在页脚上沿之上 28 */
          const footTop = await page.evaluate(() => document.querySelector('.sgx-foot').getBoundingClientRect().top);
          const fabB = Math.min(844, footTop) - 28;
          expect(near(ai.x + ai.width, 390 - 16) && near(ai.y + ai.height, fabB), `AI 浮钮位置 ${ai.x},${ai.y}（页脚上沿 ${footTop}）`).toBe(true);
        }
        /* 颜色：外观 / >_ 平时透明，打开 = 选中衬底（--sgx-surface-container-high，2026-11 PR-A 照稿）；AI 浮钮平时实色（primary-fill），打开浅一档（primary-container） */
        const sel = await roleColor(page, '--sgx-surface-container-high') /* 2026-11 PR-A 照稿 .ic a.on：#2a2522 */;
        const fill = await roleColor(page, '--sgx-primary-fill');
        const cont = await roleColor(page, '--sgx-primary-container');
        expect(await bg(page, '.sgx-tb-grid')).toBe('rgba(0, 0, 0, 0)');
        expect(await bg(page, '.sgx-tb-quick')).toBe('rgba(0, 0, 0, 0)');
        expect(await bg(page, '.sgx-tb-term')).toBe('rgba(0, 0, 0, 0)');
        expect(await bg(page, '.sgx-tb-ai')).toBe(fill);
        await page.locator('.sgx-tb-quick').click();
        await expect(page.locator('.sgx-tb-quick')).toHaveAttribute('aria-expanded', 'true');
        await animationsDone(page);
        expect(await bg(page, '.sgx-tb-quick'), '外观面板打开').toBe(sel);
        await page.keyboard.press('Escape');
        await page.locator('.sgx-tb-grid').click();
        await expect(page.locator('.sgx-tb-grid')).toHaveAttribute('aria-expanded', 'true');
        await animationsDone(page);
        expect(await bg(page, '.sgx-tb-grid'), 'NAVIGATE 打开').toBe(sel);
        await page.keyboard.press('Escape');
        await page.locator('.sgx-tb-ai').click();
        await expect(page.locator('.sgx-tb-ai')).toHaveAttribute('aria-expanded', 'true');
        await animationsDone(page);
        expect(await bg(page, '.sgx-tb-ai'), 'AI 窗口打开').toBe(cont);
        await page.keyboard.press('Escape');
        /* 材质：通栏 = 悬浮层磨砂、底边 1px 线、没有圆角；图标组本身透明 */
        const st = await page.evaluate(() => {
          const c = (s) => getComputedStyle(document.querySelector(s));
          const b = c('.sgx-topbar');
          return { bar: b.backgroundColor, bf: b.backdropFilter || b.webkitBackdropFilter, bb: b.borderBottomWidth, bt: b.borderTopWidth, rad: b.borderTopLeftRadius, acts: c('.sgx-tb-acts').backgroundColor };
        });
        expect(st.bar).not.toBe('rgba(0, 0, 0, 0)');
        expect(st.bf).toContain('blur');
        expect(st.bb).toBe('1px');
        expect(st.bt).toBe('0px');
        expect(st.rad).toBe('0px');
        expect(st.acts).toBe('rgba(0, 0, 0, 0)');
      });
    }
  });
}

/* 窄屏到宽屏都不溢出；字标完整；内容收在居中的 1080 里（顶栏全宽） */
for (const w of [360, 384, 412, 1280, 1920]) {
  test(`${w} 宽：顶栏通栏不溢出，字标完整，内容区 = 居中的 min(宽 − 2 × 页边距, 1080)；页名不显示`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: w > 1000 ? 900 : 860 });
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
    /* P4-3 PR-4c：中文 /zh/…，英文无前缀 */
    for (const path of ['/zh/', '/zh/wild/', '/404.html', '/wild/']) { /* 进站 v3 L1：/zh/security/tempkeys/ 已删 */ /* 对齐 PR-B：旷野 /wild/ 取代 /status/ */
      if (!path.startsWith('/zh/')) await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'en'); } catch (e) {} });
      await go(page, path);
      const m = await page.evaluate(() => {
        const r = (s) => document.querySelector(s).getBoundingClientRect();
        const bar = r('.sgx-topbar'), logo = r('.sgx-tb-logo'), acts = r('.sgx-tb-acts'), t = document.querySelector('#site-nav .sgx-tb-title').getBoundingClientRect();
        return { bar: [bar.left, bar.right], logo: [logo.left, logo.right], acts: [acts.left, acts.right], shown: t.width > 0, sw: document.documentElement.scrollWidth,
          over: Array.from(document.querySelectorAll('.sgx-topbar *')).some((e) => { const b = e.getBoundingClientRect(); return b.width && (b.right > bar.right + 0.5 || b.left < bar.left - 0.5); }) };
      });
      expect(m.sw, `${path} 页面横向溢出`).toBeLessThanOrEqual(w);
      expect(m.over, `${path} 顶栏里有东西超出`).toBe(false);
      expect(near(m.bar[0], 0) && near(m.bar[1], w), `${path} 通栏`).toBe(true);
      expect(m.logo[1] - m.logo[0], `${path} 字标完整`).toBeGreaterThan(100);
      expect(m.shown, `${path} 页名不显示`).toBe(false);
      expect(near(m.acts[1], w - pad(w)), `${path} 图标组右缘 ${m.acts[1]}，应为 ${w - pad(w)}`).toBe(true);
      expect(near(m.logo[0], pad(w) - 4), `${path} 字标左缘 ${m.logo[0]}`).toBe(true);
    }
  });
}

test.describe('390×844 行为', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('旧顶栏元素、标题区旧按钮、大标题区、Styrigx 品牌字都已删除', async ({ page }) => {
    await go(page, '/wild/');
    for (const sel of ['#nav-time-center', '#nav-wx', '#nav-music-note', '.nav-inner', '.subpage-back', '#nav-brand', '.sgx-tb-text', '.subpage-mini-title']) {
      await expect(page.locator(sel), sel).toHaveCount(0);
    }
    await expect(page.locator('[data-tb-more]')).toHaveCount(0);
  });

  /* 页名胶囊标记（不显示）仍是当前页名：子站脚本和锁屏顶栏读它 */
  const NAMES = [
    /* P4-3 PR-4c：英文无前缀、中文 /zh/ */
    ['/zh/wild/', '旷野'],
    ['/zh/', '主页'],
    ['/wild/', 'Wild'],
    ['/', 'Home'],
  ];
  for (const [path, name] of NAMES) {
    test(`${path}：页名标记是「${name}」（顶栏不显示），没有大标题区`, async ({ page }) => {
      await page.addInitScript((en) => { try { localStorage.setItem('sgx-lang', en ? 'en' : 'zh'); } catch (e) {} }, !path.startsWith('/zh/'));
      await go(page, path);
      await expect(page.locator('#site-nav .sgx-tb-title')).toHaveText(name);
      await expect(page.locator('#site-nav .sgx-tb-pill')).toBeHidden();
      await expect(page.locator('.subpage-title, .subpage-hero, [data-subpage-head]')).toHaveCount(0);
      await expect(page.locator('.sgx-tb-pill svg')).toHaveCount(0);
    });
  }

  test('主页：顶栏没有设置按钮、没有搜索图标、没有标签；页名标记是「主页」（对齐 PR-B）', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
    await go(page, '/zh/');
    await expect(page.locator('.sgx-tb-set')).toHaveCount(0);
    await expect(page.locator('.sgx-tb-psearch')).toHaveCount(0);
    expect(await page.locator('#site-nav .sgx-tb-pill > *').evaluateAll((els) => els.map((e) => e.className.split(' ')[0]))).toEqual(['sgx-tb-title']);
    await expect(page.locator('#site-nav .sgx-tb-title')).toHaveText('主页');
    await expect(page.locator('.sgx-tb-tabs, .sgx-tb-tab, .sgx-tb-pill a')).toHaveCount(0);
    await expect(page.locator('#sgx-tb-cap')).toHaveCount(0);
    await expect(page.locator('.sgx-topbar .sgx-tb-search, #sgx-tb-search')).toHaveCount(0);
    /* 顶栏里没有任何指向旧设置层的链接（旧地址运行时拼，免得 git grep 命中） */
    await expect(page.locator('.sgx-topbar a[href$="' + '/' + 'settings' + '/' + '"]')).toHaveCount(0);
  });

  test('盾牌 / 头像的链接（盾牌 /zh/#sec——进站 v3 L1 安全页删了；v5 S5 起普通点击打开终端；头像没 JS 时去 /zh/account/ → 301 首页 #acct，2026-11-08）、字标回首页', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
    await go(page, '/zh/wild/');
    await expect(page.locator('.sgx-tb-shield')).toHaveAttribute('href', '/zh/#sec');
    await expect(page.locator('.sgx-tb-shield')).toHaveAccessibleName('站点安全');
    await expect(page.locator('.sgx-tb-av')).toHaveAttribute('href', '/zh/account/');
    await expect(page.locator('.sgx-tb-av')).toHaveAccessibleName('账号');
    await expect(page.locator('.sgx-tb-logo')).toHaveAttribute('href', '/zh/');
    /* v5 S5：盾牌下拉删了，普通点击打开终端（钥匙命令见 shield.spec.js） */
    await expect(page.locator('.sgx-tb-shield')).toHaveAttribute('aria-controls', 'sgx-term');
    await page.locator('.sgx-tb-shield').click();
    await expect(page.locator('#sgx-term')).toHaveAttribute('open', '');
    await expect(page.locator('#sgx-sec')).toHaveCount(0);
  });

  for (const path of ['/', '/404.html', '/wild/']) { /* 进站 v3 L1：/security/ 已删 */
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

  test('滚动时顶栏不动（没有 sgx-stuck 切换）；底边进度条跟着滚动变长：顶上不显示、到底整宽', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
    await go(page, '/zh/'); /* 主页够长（首屏 + 四节），手机上能滚；v5 S7 旷野页只剩两窗、不够长（对齐 PR-C 前是风格页） */
    const prog = page.locator('#site-nav .sgx-tb-prog');
    await expect(prog).toHaveAttribute('data-empty', '');
    const before = await Promise.all(['.sgx-tb-quick', '.sgx-tb-logo', '.sgx-tb-grid', '.sgx-tb-ai'].map((s) => box(page, s)));
    const max = await page.evaluate(() => document.scrollingElement.scrollHeight - innerHeight);
    expect(max, '页面要能滚').toBeGreaterThan(200);
    const y = Math.round(max / 2);
    await page.evaluate((v) => window.scrollTo(0, v), y);
    await scrolledTo(page, y);
    await animationsDone(page);
    expect(await page.evaluate(() => document.body.classList.contains('sgx-stuck'))).toBe(false);
    await expect(prog).not.toHaveAttribute('data-empty', '');
    const half = await page.evaluate(() => { const i = document.querySelector('#site-nav .sgx-tb-prog > i'); return { w: i.getBoundingClientRect().width, bar: document.querySelector('.sgx-tb-prog').getBoundingClientRect() }; });
    expect(near(half.w, 390 / 2, 4), `一半进度 ${half.w}`).toBe(true);
    /* 进度条在顶栏底边、整个视口宽、3px */
    const bar = await box(page, '.sgx-topbar');
    expect(near(half.bar.left, 0) && near(half.bar.width, 390) && near(half.bar.height, 3)).toBe(true);
    expect(near(half.bar.bottom, bar.y + bar.height, 1.5)).toBe(true);
    const after = await Promise.all(['.sgx-tb-quick', '.sgx-tb-logo', '.sgx-tb-grid', '.sgx-tb-ai'].map((s) => box(page, s)));
    for (let i = 0; i < 4; i++) expect(near(after[i].x, before[i].x) && near(after[i].y, before[i].y)).toBe(true);
    await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
    await scrolledTo(page);
    await expect.poll(() => page.evaluate(() => document.querySelector('#site-nav .sgx-tb-prog > i').getBoundingClientRect().width)).toBeGreaterThan(386);
    /* 段在流动（有动画） */
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('#site-nav .sgx-tb-prog > i')).animationName)).toBe('sgx-tb-flow');
  });

  test('减弱动效：进度条静止（不流动），字标光标常亮', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await go(page, '/wild/');
    const st = await page.evaluate(() => ({
      prog: getComputedStyle(document.querySelector('#site-nav .sgx-tb-prog > i')).animationName,
      cu: getComputedStyle(document.querySelector('.sgx-tb-cu')).animationName,
    }));
    expect(st).toEqual({ prog: 'none', cu: 'none' });
  });

  test('顶栏切页过渡名挂在有尺寸的 .sgx-topbar 上', async ({ page }) => {
    await go(page, '/wild/');
    const names = await page.evaluate(() => ({
      bar: getComputedStyle(document.querySelector('.sgx-topbar')).viewTransitionName,
      nav: getComputedStyle(document.getElementById('site-nav')).viewTransitionName,
    }));
    expect(names).toEqual({ bar: 'sgx-topbar', nav: 'none' });
  });

  test('AI 窗口（AI 浮钮打开）头部（2026-11 PR-5 按设计稿 ai-v1）：G 徽标 · Gray AI / 副标题 · 模型胶囊 · 新对话 · 历史 · ×；底部「回答可能出错 · 仅公开内容」+ 邮箱', async ({ page }) => {
    /* 固定中文：不设 sgx-lang 时语言跟随浏览器（en-US）会停在英文 /（P4-3 PR-4c：中文在 /zh/） */
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
    await go(page, '/zh/');
    /* 拦外部请求之后再注册（后注册的路由先匹配） */
    await page.route('**/api/ai', (r) => (r.request().method() === 'GET' ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, default: 'gemma-4', canChoose: false, models: [{ id: 'gemma-4', label: 'Gemma 4' }] }) }) : r.continue()));
    await page.locator('.sgx-tb-ai').click();
    const dlg = page.locator('#sgx-ai');
    await expect(dlg).toBeVisible();
    await animationsDone(page);
    await expect(dlg.locator('[data-ai-model]')).toBeVisible();
    expect(await dlg.locator('.sgx-ai-head > *').evaluateAll((els) => els.map((e) => e.className + '|' + (e.getAttribute('aria-label') || e.textContent.trim())))).toEqual(
      ['sgx-ai-badge|G', 'sgx-ai-tt|Gray AI问这个空间里的任何东西', 'sgx-ai-model|AI 模型', 'sgx-ai-hbtn|新对话', 'sgx-ai-hbtn|历史', 'sgx-ai-hbtn sgx-ai-x|关闭']);
    await expect(dlg.locator('.sgx-ai-title')).toHaveText('Gray AI');
    await expect(dlg.locator('[data-ai-model-name]')).toHaveText('Gemma 4');
    await expect(dlg.locator('[data-ai-model]')).toHaveAttribute('aria-disabled', 'true');
    const [t, mo, nc, hi, x] = await Promise.all(['.sgx-ai-tt', '[data-ai-model]', '[data-ai-clear]', '[data-ai-history]', '[data-ai-close]'].map((s) => box(page, '#sgx-ai ' + s)));
    expect(t.x + t.width <= mo.x && mo.x + mo.width <= nc.x && nc.x + nc.width <= hi.x && hi.x + hi.width <= x.x, '从左到右：标题 → 模型 → 新对话 → 历史 → ×').toBe(true);
    for (const b of [nc, hi, x]) expect(Math.abs(b.y + b.height / 2 - (t.y + t.height / 2)), '一行对齐').toBeLessThanOrEqual(3);
    await expect(dlg.locator('.sgx-ai-me')).toHaveCount(0);
    expect(await dlg.locator('.sgx-ai-head').evaluate((el) => getComputedStyle(el).borderBottomWidth)).toBe('1px');
    await expect(dlg.locator('.sgx-ai-foot')).toHaveText('回答可能出错 · 仅公开内容styrigx@gmail.com');
    await expect(dlg.locator('[data-ai-contact]')).toHaveAttribute('href', 'mailto:styrigx@gmail.com');
    /* 空态：开场白后面是建议问题 */
    await expect(dlg.locator('.sgx-ai-sug')).toHaveCount(3);
  });

  test('英文页：AI 窗口底部 Answers may be wrong · Public content only + 邮箱（title Contact me）', async ({ page }) => {
    await go(page, '/');
    await expect(page.locator('#sgx-ai .sgx-ai-me')).toHaveCount(0);
    await expect(page.locator('#sgx-ai [data-ai-contact]')).toHaveText('styrigx@gmail.com');
    await expect(page.locator('#sgx-ai [data-ai-contact]')).toHaveAttribute('title', 'Contact me');
    await expect(page.locator('#sgx-ai [data-ai-contact]')).toHaveAttribute('href', 'mailto:styrigx@gmail.com');
    await expect(page.locator('#sgx-ai [data-ai-clear]')).toHaveAttribute('aria-label', 'New chat');
  });


  test('四格打开 NAVIGATE（v5 S6）：$ NAVIGATE 01/05 · 五项（编号 · 名字 · 路径提示，当前项「开」态）· lang / layout · STATUS · systemctl status / esc 关闭（v6 P4 拿掉 share）', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
    await go(page, '/zh/');
    await page.locator('.sgx-tb-grid').click();
    const nav = page.locator('#sgx-nav');
    await expect(nav).toBeVisible();
    await expect(page.locator('.sgx-tb-grid')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.sgx-tb-grid')).toHaveAccessibleName('导航');
    await expect(nav.locator('.sgx-nav-h')).toHaveText('$ NAVIGATE01/05');
    await expect(nav.locator('.sgx-nav-tile .sgx-nav-name')).toHaveText(['主页', '博客', '奇趣', '日刻', '旷野']);
    await expect(nav.locator('.sgx-nav-tile .sgx-nav-no')).toHaveText(['01', '02', '03', '04', '05']);
    await expect(nav.locator('.sgx-nav-tile .sgx-nav-hint')).toHaveText(['~', 'blog/', 'curio/', 'daymark/', 'wild/']);
    await expect(nav.locator('.sgx-nav-tile[aria-current="page"]')).toHaveAttribute('data-nav', 'home');
    await expect(nav.locator('.sgx-nav-tile')).toHaveCount(5);
    await expect(nav.locator('[data-nav="account"], [data-nav="settings"]')).toHaveCount(0);
    await animationsDone(page);
    /* 五项竖排、整宽 */
    const t = await nav.locator('.sgx-nav-tile').evaluateAll((els) => els.map((e) => { const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width)]; }));
    for (let i = 1; i < 5; i++) { expect(t[i][0]).toBe(t[0][0]); expect(t[i][1]).toBeGreaterThan(t[i - 1][1]); expect(t[i][2]).toBe(t[0][2]); }
    const cur = await nav.locator('.sgx-nav-tile[aria-current="page"]').evaluate((el) => ({ c: getComputedStyle(el).color, sh: getComputedStyle(el).boxShadow }));
    const other = await nav.locator('.sgx-nav-tile[data-nav="curio"]').evaluate((el) => getComputedStyle(el).color);
    expect(cur.c).not.toBe(other);
    expect(cur.sh).toContain('inset');
    /* 顺序：五项 → lang / layout → STATUS → 底行（v6 P4：share 那一行拿掉，Gray 11-11 17:47） */
    const order = await nav.locator('.sgx-qp-sheet > *').evaluateAll((els) => els.map((e) => e.className));
    expect(order).toEqual(['sgx-nav-h', '', 'sgx-nav-pf', 'sgx-nav-st', 'sgx-nav-f']);
    await expect(nav.locator('.sgx-nav-pfk')).toHaveText(['lang', 'layout']);
    /* 2026-11 PR-A 照稿：share / lock 两颗；v5 S6 去掉 lock（上锁走终端 lock / 已进站点盾牌）；终端（PR-2 的功能）在页脚一行「Ctrl K 终端 ›」，顶栏另有 >_ */
    await expect(nav.locator('.sgx-nav-act, [data-qp="share"]')).toHaveCount(0);
    await expect(nav.locator('.sgx-nav-f [data-qp="term"]')).toHaveText('Ctrl K 终端 ›');
    await expect(nav.locator('.sgx-nav-f [data-qp="term"]')).toHaveAccessibleName('终端');
    await expect(nav.locator('[data-st]')).toHaveCount(6);
    await expect(nav.locator('[data-st] span')).toHaveText(['space', 'blog', 'curio', 'daymark', 'gray-ai', 'auth']);
    /* 没有 /api/status 数据（测试静态站没有接口）：延迟空着、点是灰的（2026-11 PR-A 接真数据，见 nav-status.spec） */
    await expect(nav.locator('[data-st-ms]').first()).toHaveText('');
    await expect(nav.locator('[data-st="space"]')).not.toHaveAttribute('data-up', /./);
    await expect(nav.locator('.sgx-nav-st-h span')).toHaveText('STATUS');
    await expect(nav.locator('a.sgx-nav-flink')).toHaveAttribute('href', '/zh/wild/#status'); /* 对齐 PR-B：服务状态在旷野 #status */
    await expect(nav.locator('a.sgx-nav-flink')).toHaveText('systemctl status ›');
    await expect(nav.locator('[data-nav-close]')).toHaveText('esc 关闭');
    /* 手机：左右对齐顶栏内容区 */
    const sh = await box(page, '#sgx-nav .sgx-qp-sheet');
    expect(near(sh.x, 12) && near(sh.width, 390 - 24), `面板 ${sh.x} / ${sh.width}`).toBe(true); /* 对齐 PR-B：手机页边距 12 */
    await page.keyboard.press('Escape');
    await expect(nav).toBeHidden();
    await expect(page.locator('.sgx-tb-grid')).toBeFocused();
    await expect(page.locator('.sgx-tb-grid')).toHaveAttribute('aria-expanded', 'false');
    /* 「esc 关闭」按钮也能关 */
    await page.locator('.sgx-tb-grid').click();
    await expect(nav).toHaveAttribute('data-state', 'open');
    await nav.locator('[data-nav-close]').click();
    await expect(nav).toBeHidden();
    await expect(nav).toHaveAttribute('data-state', 'closed');
  });

  test('NAVIGATE STATUS + 页脚 ● n/6（2026-11 PR-A 接 /api/status）：主站一项 → space / blog / curio / daymark，ai → gray-ai，auth = 网关这一问；拿不到时灰点 –/6', async ({ page }) => {
    let calls = 0;
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
    await goStatus(page, '/zh/', (r) => { calls++; return r.fulfill({ json: { ok: true, all_up: true, sites: [
      { site: 'space', up: true, last: { ok: true, ms: 38 } }, { site: 'proxy-rules', up: true, last: { ok: true, ms: 50 } }, { site: 'ai', up: false, last: { ok: false, ms: 900 } }] } }); });
    await expect(page.locator('.sgx-foot-st')).toContainText('5/6');
    await expect(page.locator('.sgx-foot-st')).toHaveAttribute('data-up', '0');
    await page.locator('.sgx-tb-grid').click();
    const nav = page.locator('#sgx-nav');
    await expect(nav.locator('[data-st="space"] [data-st-ms]')).toHaveText('38ms');
    await expect(nav.locator('[data-st="blog"] [data-st-ms]')).toHaveText('38ms');
    await expect(nav.locator('[data-st="daymark"]')).toHaveAttribute('data-up', '1');
    await expect(nav.locator('[data-st="gray-ai"]')).toHaveAttribute('data-up', '0');
    await expect(nav.locator('[data-st="auth"]')).toHaveAttribute('data-up', '1');
    await expect(nav.locator('[data-st-sum]')).toHaveText('5/6');
    /* 2 分钟内打开 NAVIGATE 不重复问（sessionStorage 缓存） */
    expect(calls).toBe(1);
  });

  test('NAVIGATE STATUS：全部在线 =「● 全部在线」绿；接口 401（锁着）= 灰点、页脚 –/6', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
    await goStatus(page, '/zh/', (r) => r.fulfill({ json: { ok: true, sites: [{ site: 'space', up: true, last: { ms: 40 } }, { site: 'ai', up: true, last: { ms: 120 } }] } }));
    await expect(page.locator('.sgx-foot-st')).toContainText('● 6/6');
    await page.locator('.sgx-tb-grid').click();
    await expect(page.locator('#sgx-nav [data-st-sum]')).toHaveText('● 全部在线');
    await expect(page.locator('#sgx-nav [data-nav-status]')).toHaveAttribute('data-state', 'up');
    const p2 = await page.context().newPage();
    await goStatus(p2, '/zh/', (r) => r.fulfill({ status: 401, json: { ok: false } }));
    await p2.waitForTimeout(1500);
    await expect(p2.locator('.sgx-foot-st')).toContainText('–/6');
    await expect(p2.locator('#sgx-nav [data-st="space"]')).not.toHaveAttribute('data-up', /./);
  });

  test('NAVIGATE：旷野页（/zh/wild/）当前项是 05 旷野，地址 /zh/wild/；不在五站里的页（404）没有当前项（00/05）', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
    await go(page, '/zh/wild/');
    await expect(page.locator('#sgx-nav .sgx-nav-tile[data-nav="wild"]')).toHaveAttribute('href', '/zh/wild/');
    await expect(page.locator('#sgx-nav .sgx-nav-tile[aria-current="page"]')).toHaveAttribute('data-nav', 'wild');
    await expect(page.locator('#sgx-nav [data-nav-count]')).toHaveText('05/05');
    await go(page, '/404.html'); /* 进站 v3 L1：安全页已删 */
    await expect(page.locator('#sgx-nav .sgx-nav-tile[aria-current="page"]')).toHaveCount(0);
    await expect(page.locator('#sgx-nav [data-nav-count]')).toHaveText('00/05');
  });

  test('NAVIGATE：点别的站 / 子页点本站关面板后跳过去；已在本站首页点本站只关面板', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
    await go(page, '/zh/wild/');
    await page.locator('.sgx-tb-grid').click();
    await page.locator('#sgx-nav .sgx-nav-tile[data-nav="home"]').click();
    await page.waitForURL((u) => new URL(u).pathname === '/zh/', { waitUntil: 'commit' });
    await go(page, '/zh/wild/');
    await page.locator('.sgx-tb-grid').click();
    await page.route('**/curio/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>curio</title>' }));
    await page.locator('#sgx-nav .sgx-nav-tile[data-nav="curio"]').click();
    await page.waitForURL((u) => new URL(u).pathname === '/curio/zh/', { waitUntil: 'commit' });
    await go(page, '/zh/');
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

  /* 顶栏 v3：通栏、高 64；内容区 = 居中的 min(宽 − 2 × 页边距, 1080)；按钮 40 × 40；自动（桌面 UA）视口 < 720 → 手机 */
  for (const [w, h] of [[600, 900], [840, 600], [1280, 800], [1920, 1080], [2560, 1440]]) {
    test(`${w}×${h}：通栏高 64（手机布局 56），内容区按公式（±1px），居中`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await go(page, '/wild/');
      const desktop = w >= 720;
      await expect(page.locator('html')).toHaveAttribute('data-sgx-layout', desktop ? 'desktop' : 'phone');
      const bar = await box(page, '.sgx-topbar');
      expect(near(bar.x, 0) && near(bar.width, w), `通栏 ${bar.x} / ${bar.width}`).toBe(true);
      expect(near(bar.height, desktop ? 64 : 56), `顶栏高 ${bar.height}`).toBe(true);
      const [logo, q, av, acts] = await Promise.all(['.sgx-tb-logo', '.sgx-tb-quick', '.sgx-tb-av', '.sgx-tb-acts'].map((s) => box(page, s)));
      expect(near(q.width, 40) && near(av.width, 40) && near(logo.height, 40), `按钮 ${q.width} / ${av.width} / logo 高 ${logo.height}`).toBe(true);
      const p = pad(w);
      expect(near(acts.x + acts.width, w - p), `右缘 ${acts.x + acts.width} ≠ ${w - p}`).toBe(true);
      expect(near(logo.x, p - 4), `左缘 ${logo.x} ≠ ${p - 4}`).toBe(true);
      if (w >= 1080 + 2 * 48) expect(near(acts.x + acts.width - logo.x - 4, 1080), '宽屏内容区 1080').toBe(true);
    });
  }

  test('1280：AI 浮钮右下角（桌面右 32、离底 40），NAVIGATE 宽 360 落在 >_ 下面', async ({ page }) => {
    /* v6 P4-2：旷野拿掉 #screen-time 后 1280×800 一屏装得下，页脚露出来浮钮会让位（--sgx-foot-lift），改测比一屏长的主页 */
    await go(page, '/');
    const ai = await box(page, '.sgx-tb-ai');
    expect(near(ai.x + ai.width, 1280 - 32) && near(ai.y + ai.height, 800 - 40), `AI 浮钮 ${ai.x},${ai.y}`).toBe(true);
    await page.locator('.sgx-tb-grid').click();
    await expect(page.locator('#sgx-nav')).toHaveAttribute('data-state', 'open');
    await animationsDone(page);
    const [sh, acts] = await Promise.all(['#sgx-nav .sgx-qp-sheet', '.sgx-tb-acts'].map((s) => box(page, s)));
    expect(near(sh.width, 360)).toBe(true);
    expect(near(sh.x + sh.width, acts.x + acts.width - 44), `右缘 ${sh.x + sh.width}`).toBe(true);
  });

  for (const path of ['/', '/wild/']) {
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
