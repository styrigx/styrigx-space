/**
 * B1-8 子站回跳防死循环。
 *
 * 验收（任务书 B1-8）：
 * - 正常回到 blog/daymark（第一次被踢回 → 自动跳回子站，不出失败卡）
 * - 20 秒内第二次被踢回 → 出失败卡（One UI 样式，不显示原因码）
 * - 超过 20 秒仍然正常（不算死循环，继续回跳）
 *
 * 两条路径：
 * A. 会话已经有效时被踢回（initLock 分支）
 * B. 会话无效、访客解锁后被踢回（handleSessionOk 分支）
 *
 * 时钟：不 mock，直接把 sessionStorage 记录的时间改到 10 / 25 秒前。
 * sessionStorage 只在每个测试开始时清一次。
 *
 * 跳转断言（2026-10-21 起）：回跳 = 前端问 /api/lock-session-check?return=，服务端给校验过的 next，
 * location.replace(next) 直接去子站（不再「重载锁屏地址等 L1 302」）。
 * 这里 /api/lock-session-check* 由测试 mock（照服务端契约：next = 请求里的 return）；
 * 测试侧监听主框架导航请求（trackJumps）：去子站域名的导航就是一次回跳（被 blockExternalRequests 拦掉，页面不动）。
 * subsite-jump 记录保留在 sessionStorage，可断言。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('./helpers');

const TARGET_DAYMARK = 'https://daymark.styrigx.com/';
const TARGET_BLOG = 'https://blog.styrigx.com/';

/* 拦截由 JS 触发的导航（sgxReplace 的 location.replace），放行测试代码的 page.goto。
   注意：addInitScript 设置的 __allowNav 在每次导航都会重跑，先设 true。 */
async function blockJsNavigation(page) {
  /* 暂时禁用：先看原始行为 */
}


/* 记录回跳：主框架导航请求、URL 带 return=、且不是测试自己 goto 发出的（gotoWhy 先登记跳过一次） */
function trackJumps(page) {
  page.__jumps = [];
  page.__skipNav = 0;
  page.on('request', (r) => {
    try {
      if (!r.isNavigationRequest() || r.frame() !== page.mainFrame()) return;
      page.__navCount = (page.__navCount || 0) + 1;
      if (!/^https:\/\/(blog|daymark)\.styrigx\.com\//.test(r.url())) return;
      page.__jumps.push(r.url());
    } catch (e) {}
  });
}

/* 测试自己发起的带 why= 的导航：不计入回跳 */
async function gotoWhy(page, url) {
  page.__skipNav = (page.__skipNav || 0) + 1;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
}

async function getJumpTrace(page) {
  return (page.__jumps || []).slice();
}

function resetJumpTrace(page) {
  if (page.__jumps) page.__jumps.length = 0;
}

/* 等决策：回跳（出现子站导航请求）或失败卡，以先出现者为准 */
async function waitDecision(page, timeout) {
  const end = Date.now() + (timeout || 8000);
  while (Date.now() < end) {
    if (page.__jumps && page.__jumps.length > 0) return 'jump';
    const failed = await page.evaluate(() => {
      const el = document.getElementById('sgx-subsite-failure');
      return !!(el && !el.hidden);
    }).catch(() => false);
    if (failed) return 'failure';
    await page.waitForTimeout(50);
  }
  throw new Error('waitDecision timeout');
}

/* 回跳 = location.replace 到同一地址，页面会重载、重载后的 initLock 还会再判一次。
   不等它停下来就去改 sessionStorage / 发下一次 goto，会和重载抢跑，
   CI 偶发「既没回跳也没失败卡」的 waitDecision timeout。这里等到 300ms 内没有新的主框架导航为止。 */
async function settle(page) {
  const end = Date.now() + 5000;
  let n = page.__navCount || 0;
  while (Date.now() < end) {
    /* load 也要限时：回跳若发生在 load 之前（锁屏脚本变轻后 initLock 更早跑完），
       去子站的 204 导航会让本页的 load 事件不再触发，不限时就一直等到用例 30 秒超时。 */
    await page.waitForLoadState('load', { timeout: 1000 }).catch(() => {});
    await page.waitForTimeout(300);
    const m = page.__navCount || 0;
    if (m === n) return;
    n = m;
  }
}

/* /api/lock-session-check 的服务端契约 mock：已解锁 → {ok, role, next=return}；未解锁 → 401 */
async function mockSessionCheck(page) {
  /* 去子站的导航回 204：浏览器留在当前页（不进 chrome-error 页），sessionStorage 记录可读 */
  await page.route(/^https:\/\/(blog|daymark)\.styrigx\.com\//, (r) => r.fulfill({ status: 204, body: '' }));
  await page.route('**/api/lock-session-check*', async (route) => {
    if (page.__locked) return route.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false}' });
    const ret = new URL(route.request().url()).searchParams.get('return');
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, role: 'visitor', next: ret || null, upgrade: false }) });
  });
}

/* 失败卡是否显示（evaluate 读，不走 locator：页面刚被 204 取消过一次导航） */
async function failureShown(page) {
  return page.evaluate(() => {
    const el = document.getElementById('sgx-subsite-failure');
    return !!(el && !el.hidden);
  });
}

async function getJumpRecord(page) {
  return await page.evaluate(() => {
    try { return JSON.parse(sessionStorage.getItem('sgx-subsite-jump')); } catch (e) { return null; }
  });
}

async function clearJumpState(page) {
  resetJumpTrace(page);
  await page.evaluate(() => {
    try {
      sessionStorage.removeItem('sgx-subsite-jump');
    } catch (e) {}
  });
}

test.describe('B1-8 路径A：会话有效时被踢回', () => {
  const TARGET = TARGET_DAYMARK;

  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    /* 会话状态像线上 L1 那样写进 HTML 的 <html> 标签，页面脚本一跑就能读到。
       原先在 addInitScript 里设 dataset：那时 documentElement 还不存在，只能靠 10ms 轮询补设；
       CI 负载高时 initLock 先跑、读到空状态 → 进锁屏、不回跳也不出失败卡 → waitDecision timeout。
       英文测试设 page.__forceLang = 'en'。 */
    await page.route(/^http:\/\/localhost:\d+\//, async (route) => {
      const req = route.request();
      if (!req.isNavigationRequest() || req.frame() !== page.mainFrame()) {
        await route.fallback();
        return;
      }
      const res = await route.fetch();
      const type = res.headers()['content-type'] || '';
      if (type.indexOf('text/html') === -1) {
        await route.fulfill({ response: res });
        return;
      }
      const lang = page.__forceLang || 'zh';
      const body = (await res.text()).replace(/<html([^>]*)>/i, (m, attrs) =>
        '<html' + attrs.replace(/\s(lang|data-sgx-lock-session)="[^"]*"/gi, '') +
        ' lang="' + lang + '" data-sgx-lock-session="valid">');
      await route.fulfill({ response: res, body: body });
    });
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
    });
    await blockJsNavigation(page);
    trackJumps(page);
    page.__locked = false;
    await mockSessionCheck(page);
  });

  async function gotoKicked(page, target, why) {
    /* test-no-local-bypass：绕过 isLocalDev 检查，让 initLock 走 kickback 逻辑 */
    const url = '/?test-no-local-bypass&why=' + encodeURIComponent(why) + '&return=' + encodeURIComponent(target);
    await gotoWhy(page, url);
    /* 等 initLock 跑完：返回 'jump' 或 'failure'，以先出现者为准 */
    const decision = await waitDecision(page, 8000);
    if (decision === 'jump') await settle(page);
    return decision;
  }

  test('第一次：正常回跳（jump trace 有 replace 记录）、记录已写入、不出失败卡', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await clearJumpState(page);

    const decision = await gotoKicked(page, TARGET, 'no-cookie');
    /* 第一次：决策是 jump，不是 failure */
    expect(decision).toBe('jump');
    /* 回跳记录已写入 */
    const rec = await getJumpRecord(page);
    expect(rec).not.toBeNull();
    expect(rec.target).toBe(TARGET);
  });

  test('10 秒内第二次：出失败卡', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await clearJumpState(page);

    /* 第一次 */
    const d1 = await gotoKicked(page, TARGET, 'no-cookie');
    expect(d1).toBe('jump');

    /* 把记录时间设为 10 秒前 */
    await page.evaluate(() => {
      try {
        const raw = sessionStorage.getItem('sgx-subsite-jump');
        if (raw) {
          const rec = JSON.parse(raw);
          rec.at = Date.now() - 10000;
          sessionStorage.setItem('sgx-subsite-jump', JSON.stringify(rec));
        }
      } catch (e) {}
    });
    resetJumpTrace(page);

    const d2 = await gotoKicked(page, TARGET, 'no-cookie');
    expect(d2).toBe('failure');

    /* 出失败卡 */
    const card = page.locator('#sgx-subsite-failure');
    await expect(card).toBeVisible({ timeout: 5000 });
    await expect(card).toHaveClass(/sgx-card/);
    const text = await card.textContent();
    expect(text).not.toContain('no-cookie');
    expect(text).toContain('无法回到子站');
    await expect(page.locator('#sgx-subsite-home')).toBeVisible();
  });

  test('25 秒后第二次：正常回跳、不出失败卡', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await clearJumpState(page);

    /* 第一次 */
    const d1 = await gotoKicked(page, TARGET, 'no-cookie');
    expect(d1).toBe('jump');

    /* 把记录时间设为 25 秒前 */
    await page.evaluate(() => {
      try {
        const raw = sessionStorage.getItem('sgx-subsite-jump');
        if (raw) {
          const rec = JSON.parse(raw);
          rec.at = Date.now() - 25000;
          sessionStorage.setItem('sgx-subsite-jump', JSON.stringify(rec));
        }
      } catch (e) {}
    });
    resetJumpTrace(page);

    const d2 = await gotoKicked(page, TARGET, 'no-cookie');
    expect(d2).toBe('jump');
  });

  test('不同 target：正常回跳、不出失败卡', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await clearJumpState(page);

    /* 第一次踢回 daymark */
    const d1 = await gotoKicked(page, TARGET, 'no-cookie');
    expect(d1).toBe('jump');

    /* 把记录时间设为 10 秒前 */
    await page.evaluate(() => {
      try {
        const raw = sessionStorage.getItem('sgx-subsite-jump');
        if (raw) {
          const rec = JSON.parse(raw);
          rec.at = Date.now() - 10000;
          sessionStorage.setItem('sgx-subsite-jump', JSON.stringify(rec));
        }
      } catch (e) {}
    });
    resetJumpTrace(page);

    /* 10 秒内踢回 blog（不同 target） */
    const d2 = await gotoKicked(page, TARGET_BLOG, 'expired');
    expect(d2).toBe('jump');
    const rec = await getJumpRecord(page);
    expect(rec.target).toBe(TARGET_BLOG);
  });

  test('英文版失败卡', async ({ page }) => {
    /* 设置标志，让 beforeEach 注入的 <html lang> 用英文 */
    page.__forceLang = 'en';
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await clearJumpState(page);

    /* 第一次 */
    const d1 = await gotoKicked(page, TARGET, 'no-cookie');
    expect(d1).toBe('jump');

    /* 把记录时间设为 10 秒前 */
    await page.evaluate(() => {
      try {
        const raw = sessionStorage.getItem('sgx-subsite-jump');
        if (raw) {
          const rec = JSON.parse(raw);
          rec.at = Date.now() - 10000;
          sessionStorage.setItem('sgx-subsite-jump', JSON.stringify(rec));
        }
      } catch (e) {}
    });
    resetJumpTrace(page);

    /* 10 秒内第二次 */
    const d2 = await gotoKicked(page, TARGET, 'no-cookie');
    expect(d2).toBe('failure');

    const card = page.locator('#sgx-subsite-failure');
    await expect(card).toBeVisible({ timeout: 5000 });
    const text = await card.textContent();
    expect(text).toContain('Cannot return to the subsite');
    expect(text).not.toContain('无法回到子站');
  });
});

test.describe('B1-8 路径B：会话无效、访客解锁后被踢回', () => {
  const TARGET = TARGET_DAYMARK;

  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
    });
    await blockJsNavigation(page);
    trackJumps(page);
    await mockSessionCheck(page);
    /* 访客入口：临时钥匙，/api/lock-tempkey-unlock 成功 → 会话生效 */
    await page.route('**/api/lock-tempkey-unlock', async (route) => {
      page.__locked = false;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
  });

  /* 访客解锁流程：解锁 → session-check?return → proceed（回跳或失败卡） */
  async function unlockAsVisitor(page, target, why) {
    page.__locked = true;
    resetJumpTrace(page);
    const url = '/?lock=1&test-no-local-bypass=1&why=' + encodeURIComponent(why) + '&return=' + encodeURIComponent(target);
    await gotoWhy(page, url);
    await expect(page.locator('#sgx-lock')).toBeVisible({ timeout: 15000 });
    await page.click('#sgx-lock-avatar');
    await expect(page.locator('#sgx-method-sheet.visible')).toBeVisible({ timeout: 5000 });
    await page.click('#sgx-mopt-visitor');
    await page.fill('#sgx-temp-input', 'AAAA-BBBB-CCCC');
    await page.click('#sgx-temp-go');
    /* 等 handleSessionOk 跑完 */
    await waitDecision(page, 8000);
  }

  test('第一次：正常回跳、记录已写入、不出失败卡', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await clearJumpState(page);

    await unlockAsVisitor(page, TARGET, 'no-cookie');

    const trace = await getJumpTrace(page);
    expect(trace.length).toBeGreaterThan(0);
    /* 回跳直接去服务端给的 next（子站原地址） */
    expect(trace[0]).toBe(TARGET);
    const rec = await getJumpRecord(page);
    expect(rec).not.toBeNull();
    expect(rec.target).toBe(TARGET);
    expect(await failureShown(page)).toBe(false);
  });

  test('10 秒内第二次：出失败卡', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await clearJumpState(page);

    /* 第一次 */
    await unlockAsVisitor(page, TARGET, 'no-cookie');
    expect(await failureShown(page)).toBe(false);

    /* 把记录时间设为 10 秒前 */
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      try {
        const raw = sessionStorage.getItem('sgx-subsite-jump');
        if (raw) {
          const rec = JSON.parse(raw);
          rec.at = Date.now() - 10000;
          sessionStorage.setItem('sgx-subsite-jump', JSON.stringify(rec));
        }
      } catch (e) {}
    });

    await unlockAsVisitor(page, TARGET, 'no-cookie');

    expect(await failureShown(page)).toBe(true);
    const text = await page.evaluate(() => document.getElementById('sgx-subsite-failure').textContent);
    expect(text).not.toContain('no-cookie');
    expect(text).toContain('无法回到子站');
  });

  test('25 秒后第二次：正常回跳、不出失败卡', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await clearJumpState(page);

    /* 第一次 */
    await unlockAsVisitor(page, TARGET, 'no-cookie');
    const trace1 = await getJumpTrace(page);
    expect(trace1.length).toBeGreaterThan(0);

    /* 记录时间设为 25 秒前 */
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      try {
        const raw = sessionStorage.getItem('sgx-subsite-jump');
        if (raw) {
          const rec = JSON.parse(raw);
          rec.at = Date.now() - 25000;
          sessionStorage.setItem('sgx-subsite-jump', JSON.stringify(rec));
        }
      } catch (e) {}
    });
    /* 清掉已记录的回跳，方便断言新增 */
    resetJumpTrace(page);

    await unlockAsVisitor(page, TARGET, 'no-cookie');

    const trace2 = await getJumpTrace(page);
    expect(trace2.length).toBeGreaterThan(0);
    expect(await failureShown(page)).toBe(false);
  });

  test('不同 target：正常回跳、不出失败卡', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await clearJumpState(page);

    /* 第一次踢回 daymark */
    await unlockAsVisitor(page, TARGET, 'no-cookie');
    const trace1 = await getJumpTrace(page);
    expect(trace1.length).toBeGreaterThan(0);

    /* 记录时间设为 10 秒前 */
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      try {
        const raw = sessionStorage.getItem('sgx-subsite-jump');
        if (raw) {
          const rec = JSON.parse(raw);
          rec.at = Date.now() - 10000;
          sessionStorage.setItem('sgx-subsite-jump', JSON.stringify(rec));
        }
      } catch (e) {}
    });
    resetJumpTrace(page);

    await unlockAsVisitor(page, TARGET_BLOG, 'expired');

    const trace2 = await getJumpTrace(page);
    expect(trace2.length).toBeGreaterThan(0);
    expect(await failureShown(page)).toBe(false);
    const rec = await getJumpRecord(page);
    expect(rec.target).toBe(TARGET_BLOG);
  });
});
