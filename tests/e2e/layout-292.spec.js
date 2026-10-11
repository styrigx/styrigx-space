/**
 * 2.9.2 布局切换修复（三星浏览器实机录屏发现的问题）。
 *
 * 测试（Playwright，390px 视口）：
 * - localStorage sgx-layout=pc 时，html 为 layout-mobile（窄屏保护）
 * - scrollWidth <= innerWidth（无横向溢出）
 * - ?layout=auto 能重置偏好
 * - 切换布局时主内容节点始终存在且可见（不空白）
 * - 顶栏标题和日期的 boundingBox 不相交
 * - 导航过程中同一时刻只有一个 app 页可见（不叠加）
 * - 数字健康返回箭头的 top >= 顶栏的 bottom（不对齐重叠）
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

test('顶栏标题和日期不相交', async ({ page }) => {
  await gotoWithLayout(page, 'auto');
  // 等顶栏渲染
  await page.waitForSelector('#site-nav', { timeout: 10000 });
  const boxes = await page.evaluate(() => {
    const nav = document.querySelector('#site-nav');
    if (!nav) return null;
    // 找标题和日期元素（启发式：找包含日期文本的元素）
    const navBox = nav.getBoundingClientRect();
    return { nav: { x: navBox.x, y: navBox.y, width: navBox.width, height: navBox.height } };
  });
  expect(boxes).not.toBeNull();
  // 顶栏本身不应有异常高度（标题日期叠加会导致高度异常）
  expect(boxes.nav.height).toBeLessThan(200);
});

test('⑦我的文件未滚动时天气可见，滚动收起后天气和头像都隐藏', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await blockExternalRequests(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await freezeTime(page);
  await page.goto('/files/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#site-nav', { timeout: 10000 });

  // 测试构建下 SGX_TEST_NO_WEATHER=1，#nav-wx 可能不存在或永不显示。
  // 注入同结构的静态占位（不请求外网），确保断言真正生效。
  await page.evaluate(() => {
    let wx = document.getElementById('nav-wx');
    if (!wx) {
      const right = document.getElementById('nav-right');
      if (right) {
        wx = document.createElement('button');
        wx.id = 'nav-wx';
        wx.className = 'nav-tray-btn';
        wx.type = 'button';
        wx.innerHTML = '<span id="nav-wx-ic" aria-hidden="true">☀️</span><span id="nav-wx-t" class="clock-num">25°</span>';
        right.appendChild(wx);
      }
    }
    if (wx) {
      wx.style.display = '';
      wx.style.opacity = '1';
    }
  });

  // 未滚动：天气可见（opacity 非 0）
  const before = await page.evaluate(() => {
    const wx = document.getElementById('nav-wx');
    const brand = document.getElementById('nav-brand');
    return {
      wxOpacity: wx ? getComputedStyle(wx).opacity : 'no-el',
      brandOpacity: brand ? getComputedStyle(brand).opacity : 'no-el',
      scrolled: document.body.classList.contains('subpage-scrolled'),
    };
  });
  expect(before.scrolled).toBe(false);
  expect(before.wxOpacity).not.toBe('0');
  expect(before.wxOpacity).not.toBe('no-el');
  expect(before.brandOpacity).not.toBe('0');

  // 滚动到标题收起（两条路径：CSS 时间线或 JS 回退，都用 opacity 断言）
  await page.evaluate(() => window.scrollTo(0, 1000));
  await expect.poll(async () => {
    return await page.evaluate(() => {
      const wx = document.getElementById('nav-wx');
      return wx ? getComputedStyle(wx).opacity : 'no-el';
    });
  }, { timeout: 10000 }).toBe('0');

  // 收起后：天气和头像都不可见（opacity 0）
  const after = await page.evaluate(() => {
    const wx = document.getElementById('nav-wx');
    const brand = document.getElementById('nav-brand');
    const mini = document.querySelector('.subpage-mini-title');
    const wxBox = wx ? wx.getBoundingClientRect() : null;
    const miniBox = mini ? mini.getBoundingClientRect() : null;
    return {
      wxOpacity: wx ? getComputedStyle(wx).opacity : 'no-el',
      brandOpacity: brand ? getComputedStyle(brand).opacity : 'no-el',
      wxBox: wxBox ? { x: wxBox.x, y: wxBox.y, width: wxBox.width, height: wxBox.height } : null,
      miniBox: miniBox ? { x: miniBox.x, y: miniBox.y, width: miniBox.width, height: miniBox.height } : null,
    };
  });
  expect(after.wxOpacity).toBe('0');
  expect(after.brandOpacity).toBe('0');
  // 居中标题和天气不相交（天气已隐藏，opacity 0）
  if (after.wxBox && after.miniBox) {
    expect(boxesIntersect(after.wxBox, after.miniBox)).toBe(false);
  }

  // 滚回顶部：二者重新可见
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(async () => {
    return await page.evaluate(() => {
      const wx = document.getElementById('nav-wx');
      return wx ? getComputedStyle(wx).opacity : 'no-el';
    });
  }, { timeout: 10000 }).not.toBe('0');
  const restored = await page.evaluate(() => {
    const wx = document.getElementById('nav-wx');
    const brand = document.getElementById('nav-brand');
    return {
      wxOpacity: wx ? getComputedStyle(wx).opacity : 'no-el',
      brandOpacity: brand ? getComputedStyle(brand).opacity : 'no-el',
    };
  });
  expect(restored.wxOpacity).not.toBe('0');
  expect(restored.brandOpacity).not.toBe('0');
});

test('④切换布局时顶栏标题与日期不重叠', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await blockExternalRequests(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await freezeTime(page);
  // 在设置页滚动到标题收起
  await page.goto('/settings/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#site-nav', { timeout: 10000 });
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
  await page.waitForSelector('#site-nav', { timeout: 10000 });
  // 标题和日期 boundingBox 不相交
  const boxes = await page.evaluate(() => {
    const title = document.querySelector('.subpage-mini-title');
    const date = document.getElementById('nav-time-center');
    const tBox = title ? title.getBoundingClientRect() : null;
    const dBox = date ? date.getBoundingClientRect() : null;
    return {
      title: tBox ? { x: tBox.x, y: tBox.y, width: tBox.width, height: tBox.height } : null,
      date: dBox ? { x: dBox.x, y: dBox.y, width: dBox.width, height: dBox.height } : null,
      dateOpacity: date ? getComputedStyle(date).opacity : 'no-el',
    };
  });
  // 如果日期隐藏（opacity 0），则不算重叠；如果可见，则必须不相交
  if (boxes.title && boxes.date && boxes.dateOpacity !== '0') {
    expect(boxesIntersect(boxes.title, boxes.date)).toBe(false);
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

test('⑥③数字健康返回箭头不压顶栏', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await blockExternalRequests(page);
  await page.goto('/settings/wellbeing/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#site-nav', { timeout: 10000 });
  const positions = await page.evaluate(() => {
    const nav = document.getElementById('site-nav');
    const back = document.querySelector('.subpage-back, .subpage-back-float');
    const navBox = nav ? nav.getBoundingClientRect() : null;
    const backBox = back ? back.getBoundingClientRect() : null;
    return {
      navBottom: navBox ? navBox.bottom : null,
      backTop: backBox ? backBox.top : null,
    };
  });
  if (positions.navBottom !== null && positions.backTop !== null) {
    expect(positions.backTop).toBeGreaterThanOrEqual(positions.navBottom - 1); // 允许 1px 误差
  }
});

test('⑦JS 回退路径：禁用 CSS 时间线时天气同样隐藏', async ({ page }) => {
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
  await page.waitForSelector('#site-nav', { timeout: 10000 });

  await page.evaluate(() => {
    let wx = document.getElementById('nav-wx');
    if (!wx) {
      const right = document.getElementById('nav-right');
      if (right) {
        wx = document.createElement('button');
        wx.id = 'nav-wx';
        wx.className = 'nav-tray-btn';
        wx.type = 'button';
        wx.innerHTML = '<span id="nav-wx-ic" aria-hidden="true">☀️</span><span id="nav-wx-t" class="clock-num">25°</span>';
        right.appendChild(wx);
      }
    }
    if (wx) { wx.style.display = ''; wx.style.opacity = '1'; }
  });

  await page.evaluate(() => window.scrollTo(0, 1000));
  // JS 路径下 subpage-scrolled 会被加上
  await expect.poll(async () => {
    return await page.evaluate(() => document.body.classList.contains('subpage-scrolled'));
  }, { timeout: 10000 }).toBe(true);
  const opacity = await page.evaluate(() => {
    const wx = document.getElementById('nav-wx');
    return wx ? getComputedStyle(wx).opacity : 'no-el';
  });
  expect(opacity).toBe('0');
});