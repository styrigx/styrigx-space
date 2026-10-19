/**
 * 切换「桌面版/移动版网站」后不再跳到设置（Samsung Internet 实机复现）。
 *
 * 根因：直接打开 App 页（外部 / 无 referrer）时，navhistory.js 用
 * history.replaceState 把子页自己的那条历史改成主页地址，再 pushState 回子页，
 * 好让系统返回一次回到主页。replaceState 只改 URL，不改这条历史的
 * 「原始请求地址」——在 Chromium 里它仍是当初请求的 /settings/。
 * 之后只要这条历史被跨文档加载成主页（点 ‹ 回主页后再系统返回、刷新、会话恢复），
 * 页面显示的是 /，但「请求桌面版/移动版网站」按原始请求地址重载
 * （NavigationControllerImpl::LoadOriginalRequestURL），于是跳到 /settings/。
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
const { blockExternalRequests, expect } = require('./helpers');

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

/** 读当前页状态；切页中途（执行上下文被销毁）返回 null，交给 expect.poll 重试 */
async function homeState(page) {
  try {
    return await page.evaluate(() => ({
      path: location.pathname,
      state: history.state,
      navType: performance.getEntriesByType('navigation')[0].type,
      len: history.length,
      home: !!document.body && !document.body.classList.contains('subpage'),
    }));
  } catch (e) {
    return null;
  }
}

test.describe('桌面/移动版切换：主页历史的原始请求地址必须是主页', () => {
  test('直接打开设置 → 点 ‹ 回主页 → 系统返回：落在插入的主页历史上时换成真正的主页请求', async ({ page }) => {
    await blockExternalRequests(page);
    const docs = trackDocs(page);
    /* 无 referrer 直接打开设置：插入一条主页历史 */
    await page.goto('/settings/');
    await expect.poll(() => page.evaluate(() => history.state && history.state.sgxHere)).toBe(1);
    const lenAfterOpen = await page.evaluate(() => history.length);

    /* 点顶栏 ‹：location.replace('/') 换掉设置这条，插入的主页历史还在它后面 */
    await page.click('.sgx-tb-back');
    await page.waitForURL((u) => u.pathname === '/');
    await page.waitForLoadState('load');

    docs.length = 0;
    /* 系统返回：跨文档回到插入的主页历史（不发 popstate） */
    await page.goBack();
    await expect.poll(() => homeState(page).then((s) => s && s.home && s.navType)).toBe('navigate');
    await page.waitForTimeout(600);

    const s = await homeState(page);
    expect(s.path).toBe('/');
    expect(s.state && s.state.sgxRoot).toBeFalsy();
    /* 退回加载一次 + 换成真正主页请求一次，不多不少（无循环） */
    expect(docs).toEqual(['/', '/']);
    /* 是替换，不新增历史 */
    expect(s.len).toBe(lenAfterOpen);
  });

  test('直接打开设置 → 系统返回一次回到主页（原有行为），主页是真正的主页请求', async ({ page }) => {
    await blockExternalRequests(page);
    const docs = trackDocs(page);
    await page.goto('/settings/');
    await expect.poll(() => page.evaluate(() => history.state && history.state.sgxHere)).toBe(1);
    docs.length = 0;

    await page.goBack();
    await page.waitForURL((u) => u.pathname === '/');
    await expect.poll(() => homeState(page).then((s) => s && s.home)).toBe(true);
    await page.waitForTimeout(600);

    const s = await homeState(page);
    expect(s.path).toBe('/');
    expect(s.navType).toBe('navigate');
    expect(s.state && s.state.sgxRoot).toBeFalsy();
    expect(docs).toEqual(['/']);
  });

  test('修好的主页历史以后再退回到，不会再重载', async ({ page }) => {
    await blockExternalRequests(page);
    const docs = trackDocs(page);
    await page.goto('/settings/');
    await expect.poll(() => page.evaluate(() => history.state && history.state.sgxHere)).toBe(1);
    await page.goBack();
    await page.waitForURL((u) => u.pathname === '/');
    await page.waitForTimeout(600);

    /* 站内点设置，再系统返回：主页正常退回，只请求一次 */
    await page.click('a[href="/settings/"][aria-label="设置"]');
    await page.waitForURL((u) => u.pathname === '/settings/');
    await page.waitForLoadState('load');
    docs.length = 0;
    await page.goBack();
    await page.waitForURL((u) => u.pathname === '/');
    await page.waitForTimeout(800);

    const s = await homeState(page);
    expect(s.state && s.state.sgxRoot).toBeFalsy();
    expect(docs).toEqual(['/']);
  });
});
