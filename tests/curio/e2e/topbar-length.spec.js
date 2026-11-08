/* 顶栏长度统一（P4-3 PR-4b 布局判定；2026-11 UI 重设计 PR-1 顶栏 v3），跑在拼好的整站（space/web/public：主站 /、奇趣 /curio/、日刻 /daymark/、博客 /blog/，同源）。
 * 布局只有手机 / 桌面，四站同一条规则（共享外壳 layout-mode.js）：手动照办；自动 = userAgentData.mobile（没有就看 UA），算出桌面但视口 < 720 → 手机。
 * 顶栏 v3：任何布局 / 设备都是贴顶通栏，内容收进居中的 --sgx-content-w（1080）：左右内边距 = max(页边距, (宽 − 1080) / 2)
 * （字标左缘 + 4 内缩、图标组右缘量出来）——同一视口四站每页都一样。
 * 页名不在页面顶栏显示（标记留着：子站首页 = 站名，切到页内分区换成分区名；锁屏顶栏抄它当标题）。
 * 主站在 space/web/public 里是生产构建（锁屏启用）：主站页面被锁屏盖住。2026-11 PR-A 起锁屏没有顶栏（设计稿 02:48 定），这时断言「看不到任何顶栏」、不量边距。
 * 主站自己的顶栏见 tests/space/e2e/topbar/topbar-length.spec.js。 */
const { test, expect } = require('@playwright/test');

const PAGES = ['/', '/security/', '/wild/', '/account/', '/?lock=1', '/blog/', '/blog/post/2026-10-07-muse-playbook/', '/curio/', '/daymark/'];
/* 任务书验收三档 + 宽竖屏 + 横屏 900 + 平板竖屏 + 桌面窄窗 700（自动落手机） */
const VIEWPORTS = [[412, 915], [1280, 800], [1920, 1080], [982, 2104], [900, 600], [1024, 1366], [700, 900]];

test.beforeEach(async ({ page }) => {
  /* 同 topbar-cross-site.spec.js：主站接口回 401（锁屏检查），子站数据接口回 503（子站把 401 当「锁了」会一直刷新） */
  await page.route('**/api/**', (r) => {
    const sub = /^\/(curio|daymark|blog)\//.test(new URL(r.request().url()).pathname);
    return r.fulfill(sub
      ? { status: 503, contentType: 'application/json', body: '{"ok":false,"error":"unavailable"}' }
      : { status: 401, contentType: 'application/json', body: '{"ok":false,"error":"session"}' });
  });
  await page.route(/^https:\/\/(?!localhost)/, (r) => r.abort());
});

/** 共享外壳 __sgxLayout() / __sgxDevice() 的规则（这里默认桌面 UA：无头 Chromium 的 userAgentData.mobile = false；
 *  两个 project 都是 isMobile + hasTouch = 粗指针，屏幕跟着 setViewportSize 走）→ 期望的布局、设备档和顶栏内容左右内边距 */
function expected(w, h, pref = 'auto', mobile = false) {
  const mode = pref === 'phone' ? 'phone' : pref === 'desktop' ? 'desktop' : mobile || w < 720 ? 'phone' : 'desktop';
  const device = mobile || Math.min(w, h) < 600 ? 'phone' : 'desktop';
  const m = w < 600 ? 12 /* 对齐 PR-B：手机页边距 12 */ : Math.min(48, Math.max(16, 5.333 + 0.022222 * w));
  return { mode, device, inset: Math.max(m, (w - 1080) / 2) };
}

/** 用户看得见的顶栏（最上层那条；主站页面自己的顶栏被锁屏盖住，不算）：
 *  通栏本身离视口两边的距离（bl / br，应为 0）+ 内容左右内边距（字标左缘 + 4、视口宽 − 图标组右缘）；右边按视口宽算，不按去掉滚动条的宽。
 *  锁着（#sgx-lock 在）：锁屏没有顶栏（2026-11 PR-A）→ 断言一条都看不到，返回 null（不量） */
async function insets(page) {
  if (await page.locator('#sgx-lock').count()) {
    expect(await visibleBars(page), '锁屏：看不到任何顶栏').toEqual([]);
    return null;
  }
  return visibleBars(page);
}
function visibleBars(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('.sgx-topbar'))
    .filter((el) => {
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return false;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && el.contains(hit);
    })
    .map((el) => {
      const r = el.getBoundingClientRect();
      const logo = el.querySelector('.sgx-tb-logo').getBoundingClientRect();
      const acts = el.querySelector('.sgx-tb-acts').getBoundingClientRect();
      return { bl: r.left, br: window.innerWidth - r.right, left: logo.left + 4, right: window.innerWidth - acts.right };
    }));
}

/** 等有限时长的动画 / 过渡（锁屏入场缩放、切页 view transition）放完再量：量的是落定后的长度，不是动画中间帧
 *  （同 tests/space/e2e/helpers/helpers.js animationsDone；子站 e2e 不引主站 helpers） */
async function settled(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    for (let round = 0; round < 6; round++) {
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      const list = document.getAnimations().filter((a) => {
        if (a.playState !== 'running' && a.playState !== 'pending') return false;
        const end = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming().endTime : 0;
        return Number.isFinite(Number(end));
      });
      if (!list.length) return;
      await Promise.all(list.map((a) => a.finished.catch(() => {})));
    }
  });
}

async function open(page, p) {
  await page.goto(p, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar').first()).toBeVisible({ timeout: 15000 });
  await settled(page);
}

function check(got, want, label) {
  if (got === null) return; /* 锁屏：没有顶栏，上面已断言 */
  expect(got.length, `${label}：没有看得见的顶栏`).toBeGreaterThan(0);
  for (const b of got) {
    expect(Math.abs(b.bl) + Math.abs(b.br), `${label} 通栏 ${b.bl} / ${b.br}`).toBeLessThanOrEqual(1);
    expect(Math.abs(b.left - want.inset), `${label} 左边距 ${b.left}，应为 ${want.inset}`).toBeLessThanOrEqual(1);
    expect(Math.abs(b.right - want.inset), `${label} 右边距 ${b.right}，应为 ${want.inset}`).toBeLessThanOrEqual(1);
  }
}

const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

for (const [w, h] of VIEWPORTS) {
  test(`${w}×${h}：四站每页顶栏通栏、内容左右内边距一样，等于公式；不横向滚`, async ({ page }, info) => {
    test.skip(info.project.name !== 'phone-412', '视口在用例里设，一个 project 跑一遍就够');
    await page.setViewportSize({ width: w, height: h });
    const want = expected(w, h);
    const seen = [];
    for (const p of PAGES) {
      await open(page, p);
      await expect(page.locator('html'), p).toHaveAttribute('data-sgx-layout', want.mode);
      await expect(page.locator('html'), p).toHaveAttribute('data-sgx-device', want.device);
      const got = await insets(page);
      check(got, want, `${w}×${h} ${p}`);
      expect(await noHScroll(page), `${w}×${h} ${p} 横向不滚`).toBe(true);
      if (got) seen.push(...got.map((b) => `${b.left.toFixed(1)}|${b.right.toFixed(1)}`));
    }
    expect(new Set(seen).size, `各页边距 ${[...new Set(seen)].join(' / ')}`).toBe(1);
  });
}

/* 名字按页面语言（博客跟主站 sgx-ui cookie / 浏览器语言，可能是英文） */
const SECTIONS = [
  /* 奇趣（对齐 PR-C2）：页头下划线 tab 是子页链接，点了到子页，胶囊 = 子页名 */
  ['/curio/', ['奇趣', 'Curio'], [['#cu-tabs [data-ctab="devices"]', ['设备', 'Devices']], ['#cu-tabs [data-ctab="games"]', ['游戏', 'Games']], ['#cu-tabs [data-ctab="finds"]', ['发现', 'Finds']], ['#cu-tabs [data-ctab="movies"]', ['电影', 'Movies']]]],
  /* 日刻（对齐 PR-C2）：余响下面的窗标题进拾录 / 百味，那边「cd ..」回余响 */
  ['/daymark/', ['日刻', 'Daymark'], [['#dm-wt-trove a', ['拾录', 'Trove']], ['#dm-pane-trove .sgx-cmds a[href="#"]', ['日刻', 'Daymark']], ['#dm-wt-flavors a', ['百味', 'Flavors']], ['#dm-pane-flavors .sgx-cmds a[href="#"]', ['日刻', 'Daymark']]]],
  /* 博客（对齐 PR-C）：首页是一页文章列表 + 分类 chips，没有分区入口（tests/blog/e2e/app-topbar.spec.js 覆盖） */
];
const pick = async (page, pair) => ((await page.evaluate(() => document.documentElement.lang)).startsWith('en') ? pair[1] : pair[0]);

test('子站首页：顶栏没有分区页签；正文里的分区切换（奇趣 tab 去子页、日刻窗标题 / cd ..）顶栏边距不变；页名标记 = 站名 → 分区名，顶栏不显示', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone-412');
  await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
  for (const [w, h] of [[412, 915], [1280, 800]]) {
    await page.setViewportSize({ width: w, height: h });
    const want = expected(w, h);
    for (const [p, site, secs] of SECTIONS) {
      await open(page, p);
      await expect(page.locator('.sgx-tb-pill [role="tab"], .sgx-tb-pill .sgx-seg, .sgx-tb-pill a')).toHaveCount(0);
      await expect(page.locator('#site-nav .sgx-tb-title')).toHaveText(await pick(page, site));
      await expect(page.locator('#site-nav .sgx-tb-title')).toBeHidden();
      for (const [sel, name] of secs) {
        await page.locator(sel).click();
        await settled(page);
        check(await insets(page), want, `${w}×${h} ${p} ${sel}`);
        await expect(page.locator('#site-nav .sgx-tb-title')).toHaveText(await pick(page, name));
        await expect(page.locator('#site-nav .sgx-tb-title')).toBeHidden();
      }
    }
  }
});

test('布局偏好（同源 localStorage sgx-layout）四站一起生效：桌面选手机都是手机那档；手机（userAgentData.mobile）选桌面四站都是桌面那档', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone-412');
  await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => { try { if (!sessionStorage.getItem('t2')) localStorage.setItem('sgx-layout', 'phone'); } catch (e) {} });
  for (const p of ['/', '/curio/', '/daymark/', '/blog/']) {
    await open(page, p);
    await expect(page.locator('html'), p).toHaveAttribute('data-sgx-layout', 'phone');
    check(await insets(page), expected(1280, 800, 'phone'), `1280×800 偏好手机 ${p}`);
  }
  await page.addInitScript(() => {
    try { sessionStorage.setItem('t2', '1'); } catch (e) {}
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => ({ mobile: true, platform: 'Android', brands: [] }), configurable: true });
  });
  await page.setViewportSize({ width: 980, height: 2104 });
  await open(page, '/curio/');
  await page.evaluate(() => { localStorage.setItem('sgx-layout', 'desktop'); });
  for (const p of ['/', '/curio/', '/daymark/', '/blog/']) {
    await open(page, p);
    await expect(page.locator('html'), p).toHaveAttribute('data-sgx-layout', 'desktop');
    check(await insets(page), expected(980, 2104, 'desktop', true), `980×2104 手机选桌面 ${p}`);
    expect(await noHScroll(page), p).toBe(true);
  }
});

test('本 project 的手机视口（412 / 360）：四站各页顶栏一样、不横向滚，页面顶栏不显示页名', async ({ page }) => {
  const { width: w, height: h } = page.viewportSize();
  const want = expected(w, h);
  for (const p of PAGES) {
    await open(page, p);
    check(await insets(page), want, `${w}×${h} ${p}`);
    expect(await noHScroll(page), `${w}×${h} ${p}`).toBe(true);
    for (const t of await page.locator('#site-nav .sgx-tb-title').all()) await expect(t, p).toBeHidden();
  }
});

/* 手机开「桌面版网站」（2026-11-07 Gray 录屏：S23 Ultra 三星浏览器，视口约 980、屏幕 384 宽）：四站同一结果——桌面布局、设备 phone、顶栏通栏（内容按 980 算）。
   UA 还报手机（userAgentData.mobile = true，切换后没重载 / 某次跳转没带上桌面 UA）时也按「布局视口 > 屏幕宽 × 1.25」认桌面版网站：
   录屏里主站是桌面、奇趣还是手机（顶栏 640、没页名胶囊）就是这条没认。 */
for (const uadMobile of [false, true]) {
  test(`手机桌面版网站 980×2104（屏幕 384×824，userAgentData.mobile=${uadMobile}）：四站桌面布局、设备 phone、顶栏通栏、内容居中`, async ({ browser, baseURL }, info) => {
    test.skip(info.project.name !== 'phone-412');
    const ctx = await browser.newContext({ viewport: { width: 980, height: 2104 }, screen: { width: 384, height: 824 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1.1,
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/29.0 Chrome/130.0.0.0 Safari/537.36',
      baseURL });
    await ctx.addInitScript((m) => {
      Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => ({ mobile: m, platform: m ? 'Android' : 'Linux', brands: [] }), configurable: true });
      try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
    }, uadMobile);
    const page = await ctx.newPage();
    await page.route('**/api/**', (r) => {
      const sub = /^\/(curio|daymark|blog)\//.test(new URL(r.request().url()).pathname);
      return r.fulfill(sub ? { status: 503, contentType: 'application/json', body: '{"ok":false}' } : { status: 401, contentType: 'application/json', body: '{"ok":false}' });
    });
    await page.route(/^https:\/\/(?!localhost)/, (r) => r.abort());
    for (const p of ['/', '/curio/', '/daymark/', '/blog/']) {
      await open(page, p);
      await expect(page.locator('html'), p).toHaveAttribute('data-sgx-layout', 'desktop');
      await expect(page.locator('html'), p).toHaveAttribute('data-sgx-device', 'phone');
      check(await insets(page), expected(980, 2104, 'desktop', true), `980 桌面版网站 ${p}`);
      expect(await noHScroll(page), p).toBe(true);
    }
    await ctx.close();
  });
}
