/* 顶栏长度统一（P4-3 再修，Gray 2026-11-06 立规⑥；录屏：首页 → 发现 → 日刻，顶栏一会长一会短）。
 * 跑在拼好的整站（dist/site：主站 /、奇趣 /curio/、日刻 /daymark/、博客 /blog/，同源）。
 * 同一视口下，首页、设置页、账号页、锁屏、博客（首页 / 文章）、奇趣、日刻的顶栏胶囊左右边距逐页量，全部一样，且等于公式：
 *   页边距 m = < 600 宽 16，否则 clamp(16, 5.333 + 2.2222vw, 48)；最宽 = 布局模式 DeX 1440 / Mobile 640（主站 __layoutMode 规则）；
 *   胶囊宽 = min(宽 − 2m, 最宽)，左右边距 = (宽 − 胶囊宽) / 2。
 * 根因是奇趣的布局模式按「宽 < 980 = 手机」自己算（宽竖屏 982×2104 时奇趣 DeX 1440、其余三站 Mobile 640）；
 * 单测 tests/space/ui/shell/topbar-length.test.mjs 守四站规则一致，这里在真浏览器里量。
 * 主站在 dist/site 里是生产构建（锁屏启用、没有网关）：主站页面量的是最上层看得见的那条（锁屏的顶栏）；主站页面自己的顶栏（测试构建）见
 * tests/space/e2e/topbar/topbar-length.spec.js。 */
const { test, expect } = require('@playwright/test');

const PAGES = ['/', '/security/', '/theme/', '/account/', '/?lock=1', '/blog/', '/blog/post/2026-10-07-muse-playbook/', '/curio/', '/daymark/'];
/* 任务书验收三档 + 录屏那台（三星浏览器宽竖屏）+ 原来奇趣和主站规则分叉的两档（横屏 840–980、平板竖屏 ≥ 980） */
const VIEWPORTS = [[412, 915], [1280, 800], [1920, 1080], [982, 2104], [900, 600], [1024, 1366]];

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

/** 主站 __layoutMode() 的规则 → 期望的左右边距 */
function expected(w, h, pref = 'auto') {
  const m = w < 600 ? 16 : Math.min(48, Math.max(16, 5.333 + 0.022222 * w));
  const big = w >= 840 && h >= 500;
  const mode = pref === 'mobile' ? 'mobile' : pref === 'dex' ? (big ? 'dex' : 'mobile') : big && w > h ? 'dex' : 'mobile';
  const width = Math.min(w - 2 * m, mode === 'dex' ? 1440 : 640);
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

for (const [w, h] of VIEWPORTS) {
  test(`${w}×${h}：四站每页顶栏胶囊左右边距一样，等于公式`, async ({ page }, info) => {
    test.skip(info.project.name !== 'phone-412', '视口在用例里设，一个 project 跑一遍就够');
    await page.setViewportSize({ width: w, height: h });
    const want = expected(w, h);
    const seen = [];
    for (const p of PAGES) {
      await open(page, p);
      await expect(page.locator('html'), p).toHaveAttribute('data-sgx-layout', want.mode);
      const got = await insets(page);
      check(got, want, `${w}×${h} ${p}`);
      seen.push(...got.map((b) => `${b.left.toFixed(1)}|${b.right.toFixed(1)}`));
    }
    /* 换页不变：所有页量到的是同一对数 */
    expect(new Set(seen).size, `各页边距 ${[...new Set(seen)].join(' / ')}`).toBe(1);
  });
}

test('子站页内切分段（奇趣 / 日刻）、博客切栏：切之前、切之后顶栏边距不变', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone-412');
  for (const [w, h] of [[412, 915], [982, 2104], [1280, 800]]) {
    await page.setViewportSize({ width: w, height: h });
    const want = expected(w, h);
    for (const p of ['/curio/', '/daymark/', '/blog/']) {
      await open(page, p);
      const tabs = page.locator('.sgx-tb-pill [role="tab"], .sgx-tb-pill a[href]');
      const n = await tabs.count();
      expect(n, `${p} 顶栏中段的分段 / 标签`).toBeGreaterThan(1);
      for (let i = n - 1; i >= 0; i--) {
        await tabs.nth(i).click();
        await page.waitForLoadState('domcontentloaded');
        await expect(page.locator('.sgx-topbar').first()).toBeVisible();
        await settled(page);
        check(await insets(page), want, `${w}×${h} ${p} 第 ${i + 1} 个分段`);
      }
    }
  }
});

test('主站布局偏好（同源 localStorage sgx-layout）四站一起生效：桌面选 Mobile 都是 640 那档，平板竖屏选 DeX 都是 1440 那档', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone-412');
  for (const [w, h, pref] of [[1280, 800, 'mobile'], [1024, 1366, 'dex']]) {
    await page.setViewportSize({ width: w, height: h });
    await page.addInitScript((v) => { try { localStorage.setItem('sgx-layout', v); } catch (e) {} }, pref);
    const want = expected(w, h, pref);
    for (const p of ['/', '/curio/', '/daymark/', '/blog/']) {
      await open(page, p);
      check(await insets(page), want, `${w}×${h} 偏好 ${pref} ${p}`);
    }
  }
});

test('本 project 的手机视口（412 / 360，isMobile）：四站各页边距 16，一样长', async ({ page }) => {
  const { width: w, height: h } = page.viewportSize();
  const want = expected(w, h);
  for (const p of PAGES) {
    await open(page, p);
    check(await insets(page), want, `${w}×${h} ${p}`);
  }
});
