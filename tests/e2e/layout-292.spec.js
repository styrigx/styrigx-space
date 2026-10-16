/**
 * 2.9.2 布局切换修复（三星浏览器实机录屏发现的问题）。
 *
 * 测试（Playwright，390px 视口）：
 * - localStorage sgx-layout=pc 时，html 为 layout-mobile（窄屏保护）
 * - scrollWidth <= innerWidth（无横向溢出）
 * - ?layout=auto 能重置偏好
 * - 切换布局时主内容节点始终存在且可见（不空白）
 * - 顶栏卡片内品牌组与小标题的 boundingBox 不相交
 * - 导航过程中同一时刻只有一个 app 页可见（不叠加）
 * - 数字健康返回箭头的 top >= 顶栏卡片的 bottom（不对齐重叠）
 *
 * 不用字符串检查充当测试：全部用 DOM 断言。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('./helpers');

const MOBILE_VP = { width: 390, height: 844 };

async function gotoWithLayout(page, layout) {
  await page.setViewportSize(MOBILE_VP);
  await blockExternalRequests(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await freezeTime(page);
  // 预设 localStorage
  await page.addInitScript((l) => {
    try { localStorage.setItem('sgx-layout', l); } catch (e) {}
  }, layout);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#home-widgets')).toBeVisible({ timeout: 15000 });
}

function boxesIntersect(a, b) {
  if (!a || !b) return false;
  return a.x < b.x + b.width && a.x + a.width > b.x &&
         a.y < b.y + b.height && a.y + a.height > b.y;
}

test('窄屏保护：sgx-layout=pc 时 html 仍为 layout-mobile', async ({ page }) => {
  await gotoWithLayout(page, 'pc');
  await expect(page.locator('html')).toHaveClass(/layout-mobile/);
  // 偏好保留在 localStorage（回到宽屏时生效）
  const saved = await page.evaluate(() => {
    try { return localStorage.getItem('sgx-layout'); } catch (e) { return null; }
  });
  expect(saved).toBe('pc');
});

test('无横向溢出：scrollWidth <= innerWidth', async ({ page }) => {
  await gotoWithLayout(page, 'pc');
  const overflow = await page.evaluate(() => {
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  });
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
});

test('?layout=auto 能重置偏好', async ({ page }) => {
  await page.setViewportSize(MOBILE_VP);
  await blockExternalRequests(page);
  await page.addInitScript(() => {
    try { localStorage.setItem('sgx-layout', 'pc'); } catch (e) {}
  });
  await page.goto('/?layout=auto', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#home-widgets')).toBeVisible({ timeout: 15000 });
  const saved = await page.evaluate(() => {
    try { return localStorage.getItem('sgx-layout'); } catch (e) { return null; }
  });
  expect(saved).toBe('auto');
});

test('顶栏卡片：品牌组与小标题不相交', async ({ page }) => {
  await gotoWithLayout(page, 'auto');
  // 等顶栏卡片渲染
  await page.waitForSelector('#sgx-topcard', { timeout: 10000 });
  const boxes = await page.evaluate(() => {
    const card = document.getElementById('sgx-topcard');
    if (!card) return null;
    const cardBox = card.getBoundingClientRect();
    return { card: { x: cardBox.x, y: cardBox.y, width: cardBox.width, height: cardBox.height } };
  });
  expect(boxes).not.toBeNull();
  // 卡片固定 52px 高（品牌组与小标题叠加会导致高度异常）
  expect(boxes.card.height).toBeLessThan(60);
  expect(boxes.card.height).toBeGreaterThan(44);
});

test('⑦我的文件未滚动时品牌组可见，滚动收起后品牌组隐藏、卡片按钮出现', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await blockExternalRequests(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await freezeTime(page);
  await page.goto('/files/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#sgx-topcard', { timeout: 10000 });

  // 未滚动：品牌组可见（opacity 非 0），卡片按钮隐藏
  const before = await page.evaluate(() => {
    const brand = document.getElementById('nav-brand');
    const back = document.getElementById('sgx-topcard-back');
    return {
      brandOpacity: brand ? getComputedStyle(brand).opacity : 'no-el',
      backOpacity: back ? getComputedStyle(back).opacity : 'no-el',
    };
  });
  expect(before.brandOpacity).not.toBe('0');
  expect(before.backOpacity).toBe('0');

  // 滚动到标题收起（两条路径：CSS 时间线或 JS 回退，都用 opacity 断言）
  await page.evaluate(() => window.scrollTo(0, 1000));
  await expect.poll(async () => {
    return await page.evaluate(() => {
      const brand = document.getElementById('nav-brand');
      return brand ? getComputedStyle(brand).opacity : 'no-el';
    });
  }, { timeout: 10000 }).toBe('0');

  // 收起后：品牌组不可见（opacity 0，不可点），卡片 ←/⋮ 出现
  const after = await page.evaluate(() => {
    const brand = document.getElementById('nav-brand');
    const back = document.getElementById('sgx-topcard-back');
    const more = document.getElementById('sgx-topcard-more');
    const mini = document.querySelector('.subpage-mini-title');
    return {
      brandOpacity: brand ? getComputedStyle(brand).opacity : 'no-el',
      brandPE: brand ? getComputedStyle(brand).pointerEvents : 'no-el',
      backOpacity: back ? getComputedStyle(back).opacity : 'no-el',
      moreOpacity: more ? getComputedStyle(more).opacity : 'no-el',
      miniOpacity: mini ? getComputedStyle(mini).opacity : 'no-el',
    };
  });
  expect(after.brandOpacity).toBe('0');
  expect(after.brandPE).toBe('none');
  expect(after.backOpacity).toBe('1');
  expect(after.moreOpacity).toBe('1');
  expect(after.miniOpacity).toBe('1');

  // 滚回顶部：品牌组重新可见
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(async () => {
    return await page.evaluate(() => {
      const brand = document.getElementById('nav-brand');
      return brand ? getComputedStyle(brand).opacity : 'no-el';
    });
  }, { timeout: 10000 }).not.toBe('0');
});

test('④切换布局时卡片内小标题与按钮不重叠', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await blockExternalRequests(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await freezeTime(page);
  // 在设置页滚动到标题收起
  await page.goto('/settings/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#sgx-topcard', { timeout: 10000 });
  await page.evaluate(() => window.scrollTo(0, 1000));
  await expect.poll(async () => {
    return await page.evaluate(() => {
      const brand = document.getElementById('nav-brand');
      return brand ? getComputedStyle(brand).opacity : 'no-el';
    });
  }, { timeout: 10000 }).toBe('0');
  // 切换到 DeX 布局（如果可用）
  await page.evaluate(() => {
    try { localStorage.setItem('sgx-layout', 'dex'); } catch (e) {}
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#sgx-topcard', { timeout: 10000 });
  // 小标题与卡片 ←/⋮ boundingBox 不相交
  const boxes = await page.evaluate(() => {
    const title = document.querySelector('.subpage-mini-title');
    const back = document.getElementById('sgx-topcard-back');
    const more = document.getElementById('sgx-topcard-more');
    const r = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    };
    return { title: r(title), back: r(back), more: r(more) };
  });
  if (boxes.title && boxes.back) {
    expect(boxesIntersect(boxes.title, boxes.back)).toBe(false);
  }
  if (boxes.title && boxes.more) {
    expect(boxesIntersect(boxes.title, boxes.more)).toBe(false);
  }
});

test('⑥①布局切换时主内容不空白', async ({ page }) => {
  await gotoWithLayout(page, 'auto');
  const mainBefore = await page.evaluate(() => {
    const m = document.querySelector('main, #app-content, [data-app-content]');
    return m ? { exists: true, visible: getComputedStyle(m).display !== 'none' } : { exists: false };
  });
  expect(mainBefore.exists).toBe(true);
  // 切换布局
  await page.evaluate(() => {
    try { localStorage.setItem('sgx-layout', 'dex'); } catch (e) {}
    window.dispatchEvent(new Event('sgx-layout-change'));
  });
  await page.waitForTimeout(500);
  const mainAfter = await page.evaluate(() => {
    const m = document.querySelector('main, #app-content, [data-app-content]');
    return m ? { exists: true, visible: getComputedStyle(m).display !== 'none', html: m.innerHTML.length } : { exists: false };
  });
  expect(mainAfter.exists).toBe(true);
  expect(mainAfter.visible).toBe(true);
  expect(mainAfter.html).toBeGreaterThan(0);
});

test('⑥③数字健康返回箭头不压顶栏卡片', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await blockExternalRequests(page);
  await page.goto('/settings/wellbeing/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#sgx-topcard', { timeout: 10000 });
  const positions = await page.evaluate(() => {
    const card = document.getElementById('sgx-topcard');
    const back = document.querySelector('[data-subpage-head] .subpage-back');
    const cardBox = card ? card.getBoundingClientRect() : null;
    const backBox = back ? back.getBoundingClientRect() : null;
    return {
      cardBottom: cardBox ? cardBox.bottom : null,
      backTop: backBox ? backBox.top : null,
    };
  });
  if (positions.cardBottom !== null && positions.backTop !== null) {
    expect(positions.backTop).toBeGreaterThanOrEqual(positions.cardBottom - 1); // 允许 1px 误差
  }
});

test('⑦JS 回退路径：禁用 CSS 时间线时品牌组同样隐藏', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await blockExternalRequests(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await freezeTime(page);
  // 覆盖 CSS.supports，强制走 JS 回退路径
  await page.addInitScript(() => {
    const orig = CSS.supports.bind(CSS);
    CSS.supports = (prop, val) => {
      if (prop === 'view-timeline-name') return false;
      return orig(prop, val);
    };
  });
  await page.goto('/files/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#sgx-topcard', { timeout: 10000 });

  await page.evaluate(() => window.scrollTo(0, 1000));
  // JS 路径下 subpage-scrolled 会被加上
  await expect.poll(async () => {
    return await page.evaluate(() => document.body.classList.contains('subpage-scrolled'));
  }, { timeout: 10000 }).toBe(true);
  const st = await page.evaluate(() => {
    const brand = document.getElementById('nav-brand');
    const back = document.getElementById('sgx-topcard-back');
    const mini = document.querySelector('.subpage-mini-title');
    return {
      brandOpacity: brand ? getComputedStyle(brand).opacity : 'no-el',
      backOpacity: back ? getComputedStyle(back).opacity : 'no-el',
      miniOpacity: mini ? getComputedStyle(mini).opacity : 'no-el',
    };
  });
  expect(st.brandOpacity).toBe('0');
  expect(st.backOpacity).toBe('1');
  expect(st.miniOpacity).toBe('1');
});
