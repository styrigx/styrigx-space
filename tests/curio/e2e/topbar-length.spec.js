/* 顶栏长度统一 + 页名胶囊（P4-3 PR-4b，Gray 2026-11-07 定稿），跑在拼好的整站（dist/site：主站 /、奇趣 /curio/、日刻 /daymark/、博客 /blog/，同源）。
 * 布局只有手机 / 桌面，四站同一条规则（共享外壳 layout-mode.js）：手动照办；自动 = userAgentData.mobile（没有就看 UA），算出桌面但视口 < 720 → 手机。
 * 顶栏宽：手机 min(100% − 32, 640)，桌面 min(960, 100% − 48)，居中——同一视口四站每页都一样长。
 * 页名胶囊只显示当前页名：手机布局不显示；子站首页 = 站名，切到页内分区（入口链接 hash）换成分区名。
 * 主站在 dist/site 里是生产构建（锁屏启用）：主站页面量的是最上层看得见的那条（锁屏的顶栏）。主站自己的顶栏见 tests/space/e2e/topbar/topbar-length.spec.js。 */
const { test, expect } = require('@playwright/test');

const PAGES = ['/', '/security/', '/theme/', '/account/', '/?lock=1', '/blog/', '/blog/post/2026-10-07-muse-playbook/', '/curio/', '/daymark/'];
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

/** 共享外壳 __sgxLayout() 的规则（这里默认桌面 UA：无头 Chromium 的 userAgentData.mobile = false）→ 期望的布局和左右边距 */
function expected(w, h, pref = 'auto', mobile = false) {
  const mode = pref === 'phone' ? 'phone' : pref === 'desktop' ? 'desktop' : mobile || w < 720 ? 'phone' : 'desktop';
  const width = mode === 'desktop' ? Math.min(960, w - 48) : Math.min(w - 32, 640);
  return { mode, inset: (w - width) / 2 };
}

/** 用户看得见的顶栏胶囊（最上层那条：锁屏时是锁屏的顶栏，主站页面自己的顶栏被锁屏盖住、还跟着页面缩小，不算）的左右边距；
 *  右边距按视口宽算，不按去掉滚动条的宽 */
async function insets(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('.sgx-topbar'))
    .filter((el) => {
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return false;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && el.contains(hit);
    })
    .map((el) => el.getBoundingClientRect())
    .map((r) => ({ left: r.left, right: window.innerWidth - r.right })));
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
  expect(got.length, `${label}：没有看得见的顶栏`).toBeGreaterThan(0);
  for (const b of got) {
    expect(Math.abs(b.left - want.inset), `${label} 左边距 ${b.left}，应为 ${want.inset}`).toBeLessThanOrEqual(1);
    expect(Math.abs(b.right - want.inset), `${label} 右边距 ${b.right}，应为 ${want.inset}`).toBeLessThanOrEqual(1);
  }
}

const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

for (const [w, h] of VIEWPORTS) {
  test(`${w}×${h}：四站每页顶栏胶囊左右边距一样，等于公式；不横向滚`, async ({ page }, info) => {
    test.skip(info.project.name !== 'phone-412', '视口在用例里设，一个 project 跑一遍就够');
    await page.setViewportSize({ width: w, height: h });
    const want = expected(w, h);
    const seen = [];
    for (const p of PAGES) {
      await open(page, p);
      await expect(page.locator('html'), p).toHaveAttribute('data-sgx-layout', want.mode);
      const got = await insets(page);
      check(got, want, `${w}×${h} ${p}`);
      expect(await noHScroll(page), `${w}×${h} ${p} 横向不滚`).toBe(true);
      seen.push(...got.map((b) => `${b.left.toFixed(1)}|${b.right.toFixed(1)}`));
    }
    expect(new Set(seen).size, `各页边距 ${[...new Set(seen)].join(' / ')}`).toBe(1);
  });
}

/* 名字按页面语言（博客跟主站 sgx-ui cookie / 浏览器语言，可能是英文） */
const SECTIONS = [
  ['/curio/', ['奇趣', 'Curio'], [['devices', ['设备', 'Devices']], ['games', ['游戏', 'Games']], ['finds', ['奇趣', 'Curio']]]],
  ['/daymark/', ['日刻', 'Daymark'], [['trove', ['拾录', 'Trove']], ['flavors', ['百味', 'Flavors']], ['echo', ['日刻', 'Daymark']]]],
  ['/blog/', ['博客', 'Blog'], [['posts', ['文章', 'Posts']], ['topics', ['专题', 'Topics']], ['home', ['博客', 'Blog']]]],
];
const pick = async (page, pair) => ((await page.evaluate(() => document.documentElement.lang)).startsWith('en') ? pair[1] : pair[0]);

test('子站首页：顶栏没有分区页签；分区入口（首页正文）切页内分区，顶栏边距不变，桌面布局页名胶囊 = 站名 → 分区名、按整条顶栏居中', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone-412');
  await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
  for (const [w, h] of [[412, 915], [1280, 800]]) {
    await page.setViewportSize({ width: w, height: h });
    const want = expected(w, h);
    for (const [p, site, secs] of SECTIONS) {
      await open(page, p);
      await expect(page.locator('.sgx-tb-pill [role="tab"], .sgx-tb-pill .sgx-seg, .sgx-tb-pill a')).toHaveCount(0);
      await expect(page.locator('.sgx-tb-title')).toHaveText(await pick(page, site));
      if (want.mode === 'phone') await expect(page.locator('.sgx-tb-title')).toBeHidden();
      for (const [id, name] of secs) {
        /* 回到首页分区时入口重新出现；先确保入口在 */
        if (await page.locator('[data-sgx-entries]').isHidden()) await page.evaluate(() => { location.hash = ''; });
        await page.locator(`[data-sgx-entries] [data-entry="${id}"]`).click();
        await settled(page);
        check(await insets(page), want, `${w}×${h} ${p} ${id}`);
        await expect(page.locator('.sgx-tb-title')).toHaveText(await pick(page, name));
        if (want.mode === 'desktop') {
          const c = await page.evaluate(() => {
            const t = document.querySelector('.sgx-tb-title').getBoundingClientRect();
            const b = document.querySelector('.sgx-topbar').getBoundingClientRect();
            return [t.left + t.width / 2, b.left + b.width / 2];
          });
          expect(Math.abs(c[0] - c[1]), `${p} ${id} 页名居中`).toBeLessThanOrEqual(2);
        }
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

test('本 project 的手机视口（412 / 360）：四站各页顶栏一样长、不横向滚，页名胶囊不显示', async ({ page }) => {
  const { width: w, height: h } = page.viewportSize();
  const want = expected(w, h);
  for (const p of PAGES) {
    await open(page, p);
    check(await insets(page), want, `${w}×${h} ${p}`);
    expect(await noHScroll(page), `${w}×${h} ${p}`).toBe(true);
    for (const t of await page.locator('.sgx-tb-title').all()) await expect(t, p).toBeHidden();
  }
});
