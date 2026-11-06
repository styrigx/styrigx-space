/**
 * 切换「桌面版/移动版网站」后不再跳到设置（Samsung Internet 实机复现）。
 *
 * 根因：直接打开 App 页（外部 / 无 referrer）时，navhistory.js 用
 * history.replaceState 把子页自己的那条历史改成主页地址，再 pushState 回子页，
 * 好让系统返回一次回到主页。replaceState 只改 URL，不改这条历史的
 * 「原始请求地址」——在 Chromium 里它仍是当初请求的子页（如 /theme/）。
 * 之后只要这条历史被跨文档加载成主页（离开设置后再连续系统返回、刷新、会话恢复；2026-10-20 起顶栏没有 ‹），
 * 页面显示的是 /，但「请求桌面版/移动版网站」按原始请求地址重载
 * （NavigationControllerImpl::LoadOriginalRequestURL），于是跳回那个子页。
 *
 * 修法：页面加载 / popstate / bfcache 恢复时，只要发现停在这条插入的主页历史上
 * （history.state.sgxRoot），先清标记，再 location.replace(当前地址)，
 * 换成一条真正请求主页的新历史（新条目的原始请求地址 = /）。
 *
 * headless 下没有「请求桌面版网站」，原始请求地址也读不到，这里断言等价条件：
 * 主页最终所在的文档不是从那条插入历史里「退回」出来的（state 不带 sgxRoot、
 * 导航类型是 navigate，即重新请求过 /），且只多请求一次（不死循环）。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('../helpers/helpers');

test.use({ viewport: { width: 412, height: 915 }, locale: 'zh-CN' });

/** 记录主文档请求的路径 */
function trackDocs(page) {
  const docs = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'document' && r.frame() === page.mainFrame()) {
      docs.push(new URL(r.url()).pathname);
    }
  });
  return docs;
}

/**
 * 落定：停在一份已经加载完的主页文档上，它的历史条目不带 sgxRoot。
 * navhistory.js 的 healRoot() 在模块执行时同步判断（load 之前），条目不带 sgxRoot 就什么都不做；
 * 所以这份文档 readyState=complete 且没有 sgxRoot 时，不会再有 location.replace（不会再多请求文档）。
 * @param {any} s homeState() 的结果
 * @param {string} [navType] 要求的导航类型（跨文档换成真正主页请求后是 'navigate'）
 */
function settledHome(s, navType) {
  return !!s && s.complete && s.home && !(s.state && s.state.sgxRoot) && (!navType || s.navType === navType);
}

/** 记本文档上 history 被 replace / location.replace 的次数（Navigation API navigate 事件，同步派发） */
async function armReplaceProbe(page) {
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__c8replace = 0;
    if (w.navigation) w.navigation.addEventListener('navigate', (/** @type {any} */ e) => { if (e.navigationType === 'replace') w.__c8replace++; });
  });
}

/** 读当前页状态；切页中途（执行上下文被销毁）返回 null，交给 expect.poll 重试 */
async function homeState(page) {
  try {
    return await page.evaluate(() => ({
      path: location.pathname,
      state: history.state,
      navType: performance.getEntriesByType('navigation')[0].type,
      len: history.length,
      home: !!document.body && !document.body.classList.contains('subpage'),
      complete: document.readyState === 'complete',
    }));
  } catch (e) {
    return null;
  }
}

test.describe('桌面/移动版切换：主页历史的原始请求地址必须是主页', () => {
  test('直接打开设置 → 离开 → 系统返回两次：落在插入的主页历史上时换成真正的主页请求', async ({ page }) => {
    await blockExternalRequests(page);
    const docs = trackDocs(page);
    /* 无 referrer 直接打开设置：插入一条主页历史 */
    await page.goto('/theme/');
    await expect.poll(() => page.evaluate(() => history.state && history.state.sgxHere)).toBe(1);

    /* 从快捷面板导航页点「主站」离开设置（2026-11-04 P5-1 原导航抽屉并进快捷面板；主站是当前站，点它只关面板不跳，
       所以改点 logo：回本站首页、新文档）；插入的主页历史属于设置那份文档 */
    await page.click('.sgx-tb-logo');
    await page.waitForURL((u) => u.pathname === '/');
    await page.waitForLoadState('load');
    const lenAfterOpen = await page.evaluate(() => history.length);
    /* 系统返回：回到设置（重新加载文档） */
    await page.goBack();
    await page.waitForURL((u) => u.pathname === '/theme/');
    await page.waitForLoadState('load');

    docs.length = 0;
    /* 再系统返回：回到插入的主页历史（Chromium 可能按同文档 popstate 或跨文档加载处理，两条路都要治好） */
    await page.goBack();
    await expect.poll(() => homeState(page).then((s) => s && s.home && s.navType)).toBe('navigate');
    /* C8：原来固定等 600ms 看会不会再重载；改成等「落定」（见 settledHome） */
    await expect.poll(() => homeState(page).then((s) => settledHome(s, 'navigate'))).toBe(true);

    const s = await homeState(page);
    expect(s.path).toBe('/');
    expect(s.state && s.state.sgxRoot).toBeFalsy();
    /* 跨文档：退回加载一次 + 换成真正主页请求一次；同文档 popstate：只换一次。都不多（无循环） */
    expect(docs.length).toBeGreaterThanOrEqual(1);
    expect(docs.length).toBeLessThanOrEqual(2);
    expect(docs.every((d) => d === '/')).toBe(true);
    /* 是替换，不新增历史 */
    expect(s.len).toBe(lenAfterOpen);
  });

  test('直接打开设置 → 系统返回一次回到主页（原有行为），主页是真正的主页请求', async ({ page }) => {
    await blockExternalRequests(page);
    const docs = trackDocs(page);
    await page.goto('/theme/');
    await expect.poll(() => page.evaluate(() => history.state && history.state.sgxHere)).toBe(1);
    docs.length = 0;

    await page.goBack();
    await page.waitForURL((u) => u.pathname === '/');
    await expect.poll(() => homeState(page).then((s) => s && s.home)).toBe(true);
    await expect.poll(() => homeState(page).then((s) => settledHome(s, 'navigate'))).toBe(true);

    const s = await homeState(page);
    expect(s.path).toBe('/');
    expect(s.navType).toBe('navigate');
    expect(s.state && s.state.sgxRoot).toBeFalsy();
    expect(docs).toEqual(['/']);
  });

  test('修好的主页历史以后再退回到，不会再重载', async ({ page }) => {
    await blockExternalRequests(page);
    const docs = trackDocs(page);
    await page.goto('/theme/');
    await expect.poll(() => page.evaluate(() => history.state && history.state.sgxHere)).toBe(1);
    await page.goBack();
    await page.waitForURL((u) => u.pathname === '/');
    await expect.poll(() => homeState(page).then((s) => settledHome(s, 'navigate'))).toBe(true);

    /* 站内从旷野页的分类卡进子页（P4-3 PR-4b 起没有页内切换，是一次普通的跨文档导航），再系统返回：回到旷野页；
       这条历史是真正请求过 / 的，不带 sgxRoot，不会再 location.replace 出第二份文档 */
    await page.locator('.home-wrap [aria-label="分类"] a[href="/theme/"]').click();
    await page.waitForURL((u) => u.pathname === '/theme/');
    await page.waitForLoadState('load');
    docs.length = 0;
    await page.goBack();
    await page.waitForURL((u) => u.pathname === '/');
    await expect.poll(() => homeState(page).then((s) => !!(s && s.home && s.complete))).toBe(true);
    const s = await homeState(page);
    expect(s.state && s.state.sgxRoot).toBeFalsy();
    /* 退回最多加载一次（bfcache 恢复时一次都不加载），没有第二次 replace */
    expect(docs.length).toBeLessThanOrEqual(1);
    expect(docs.every((d) => d === '/')).toBe(true);
  });
});
