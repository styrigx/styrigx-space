/**
 * B1-8 子站回跳防死循环。
 *
 * 验收（任务书 B1-8）：
 * - 正常回到 blog/book（第一次被踢回 → 自动跳回子站，不出失败卡）
 * - 20 秒内第二次被踢回 → 出失败卡（One UI 样式，不显示原因码）
 * - 超过 20 秒仍然正常（不算死循环，继续回跳）
 *
 * 两条路径：
 * A. 会话已经有效时被踢回（initLock 分支）
 * B. 会话无效、访客解锁后被踢回（handleSessionOk 分支）
 *
 * 时钟：page.clock.install + fastForward（Date.now 被 mock）。
 * sessionStorage 只在每个测试开始时清一次。
 *
 * 跳转断言：sgxReplace 会先写 sessionStorage['sgx-last-jump'] 再调 location.replace。
 * 用 page.route abort 掉真跳转（避免 reload 后 why 还在 URL 里误判），
 * 但 jump trace 和 subsite-jump 记录都会保留，可断言。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('./helpers');

const TARGET_BOOK = 'https://book.styrigx.com/';
const TARGET_BLOG = 'https://blog.styrigx.com/';

/* 拦截由 JS 触发的导航（sgxReplace 的 location.replace），放行测试代码的 page.goto。
   注意：addInitScript 设置的 __allowNav 在每次导航都会重跑，先设 true。 */
async function blockJsNavigation(page) {
  /* 暂时禁用：先看原始行为 */
}


async function getJumpTrace(page) {
  return await page.evaluate(() => {
    try {
      const raw = sessionStorage.getItem('sgx-last-jump');
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  });
}

async function getJumpRecord(page) {
  return await page.evaluate(() => {
    try { return JSON.parse(sessionStorage.getItem('sgx-subsite-jump')); } catch (e) { return null; }
  });
}

async function clearJumpState(page) {
  await page.evaluate(() => {
    try {
      sessionStorage.removeItem('sgx-subsite-jump');
      sessionStorage.removeItem('sgx-last-jump');
    } catch (e) {}
  });
}

test.describe('B1-8 路径A：会话有效时被踢回', () => {
  const TARGET = TARGET_BOOK;

  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await page.addInitScript(() => {
      /* documentElement 在 addInitScript 执行时可能还不存在，用轮询等待 */
      const setSession = () => {
        try {
          if (document.documentElement) {
            document.documentElement.dataset.sgxSession = 'valid';
            /* 英文测试会设置 __forceLang='en'，此时不覆盖 */
            if (window.__forceLang) {
              document.documentElement.lang = window.__forceLang;
            } else {
              document.documentElement.lang = 'zh';
            }
            return true;
          }
        } catch (e) {}
        return false;
      };
      if (!setSession()) {
        const iv = setInterval(() => { if (setSession()) clearInterval(iv); }, 10);
      }
      try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
    });
    await blockJsNavigation(page);
  });

  async function gotoKicked(page, target, why) {
    /* test-no-local-bypass：绕过 isLocalDev 检查，让 initLock 走 kickback 逻辑 */
    const url = '/?test-no-local-bypass&why=' + encodeURIComponent(why) + '&return=' + encodeURIComponent(target);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    /* 等 initLock 跑完：返回 'jump' 或 'failure'，以先出现者为准。
       注意：sgxReplace 会触发 reload，jump trace 先写入，必须在 reload 前捕获决策。 */
    const decision = await page.waitForFunction(() => {
      try {
        const raw = sessionStorage.getItem('sgx-last-jump');
        if (raw && JSON.parse(raw).length > 0) return 'jump';
      } catch (e) {}
      const el = document.getElementById('sgx-subsite-failure');
      if (el && !el.hidden) return 'failure';
      return null;
    }, null, { timeout: 8000 });
    return await decision.jsonValue();
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
    await page.evaluate(() => { try { sessionStorage.removeItem('sgx-last-jump'); } catch (e) {} });

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
    await page.evaluate(() => { try { sessionStorage.removeItem('sgx-last-jump'); } catch (e) {} });

    const d2 = await gotoKicked(page, TARGET, 'no-cookie');
    expect(d2).toBe('jump');
  });

  test('不同 target：正常回跳、不出失败卡', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await clearJumpState(page);

    /* 第一次踢回 book */
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
    await page.evaluate(() => { try { sessionStorage.removeItem('sgx-last-jump'); } catch (e) {} });

    /* 10 秒内踢回 blog（不同 target） */
    const d2 = await gotoKicked(page, TARGET_BLOG, 'expired');
    expect(d2).toBe('jump');
    const rec = await getJumpRecord(page);
    expect(rec.target).toBe(TARGET_BLOG);
  });

  test('英文版失败卡', async ({ page }) => {
    /* 设置标志，让 beforeEach 的脚本用英文 */
    await page.addInitScript(() => { window.__forceLang = 'en'; });
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
    await page.evaluate(() => { try { sessionStorage.removeItem('sgx-last-jump'); } catch (e) {} });

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
  const TARGET = TARGET_BOOK;

  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
    });
    await blockJsNavigation(page);
  });

  /* 访客解锁流程，handleSessionOk 会被触发 */
  async function unlockAsVisitor(page, target, why) {
    const url = '/?lock=1&why=' + encodeURIComponent(why) + '&return=' + encodeURIComponent(target);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.clock.install();
    await expect(page.locator('#sgx-lock')).toBeVisible({ timeout: 15000 });
    await page.click('#sgx-lock-avatar');
    await expect(page.locator('#sgx-method-sheet.visible')).toBeVisible({ timeout: 5000 });
    await page.click('#sgx-mopt-visitor');
    /* 等 handleSessionOk 跑完 */
    await page.waitForFunction(() => {
      try {
        const raw = sessionStorage.getItem('sgx-last-jump');
        if (raw && JSON.parse(raw).length > 0) return true;
      } catch (e) {}
      return !!document.getElementById('sgx-subsite-failure');
    }, null, { timeout: 8000 });
  }

  test('第一次：正常回跳、记录已写入、不出失败卡', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await clearJumpState(page);

    await unlockAsVisitor(page, TARGET, 'no-cookie');

    const trace = await getJumpTrace(page);
    expect(trace.length).toBeGreaterThan(0);
    const rec = await getJumpRecord(page);
    expect(rec).not.toBeNull();
    expect(rec.target).toBe(TARGET);
    await expect(page.locator('#sgx-subsite-failure')).toBeHidden();
  });

  test('10 秒内第二次：出失败卡', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await clearJumpState(page);

    /* 第一次 */
    await unlockAsVisitor(page, TARGET, 'no-cookie');
    await expect(page.locator('#sgx-subsite-failure')).toBeHidden();

    /* 把记录时间设为 10 秒前（clock 在 unlockAsVisitor 里已 install，跨页面导航后需重设） */
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.clock.install();
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

    const card = page.locator('#sgx-subsite-failure');
    await expect(card).toBeVisible({ timeout: 5000 });
    const text = await card.textContent();
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
    await page.clock.install();
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
    /* 清掉 jump trace，方便断言新增 */
    await page.evaluate(() => { try { sessionStorage.removeItem('sgx-last-jump'); } catch (e) {} });

    await unlockAsVisitor(page, TARGET, 'no-cookie');

    const trace2 = await getJumpTrace(page);
    expect(trace2.length).toBeGreaterThan(0);
    await expect(page.locator('#sgx-subsite-failure')).toBeHidden();
  });

  test('不同 target：正常回跳、不出失败卡', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await clearJumpState(page);

    /* 第一次踢回 book */
    await unlockAsVisitor(page, TARGET, 'no-cookie');
    const trace1 = await getJumpTrace(page);
    expect(trace1.length).toBeGreaterThan(0);

    /* 记录时间设为 10 秒前 */
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.clock.install();
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
    await page.evaluate(() => { try { sessionStorage.removeItem('sgx-last-jump'); } catch (e) {} });

    await unlockAsVisitor(page, TARGET_BLOG, 'expired');

    const trace2 = await getJumpTrace(page);
    expect(trace2.length).toBeGreaterThan(0);
    await expect(page.locator('#sgx-subsite-failure')).toBeHidden();
    const rec = await getJumpRecord(page);
    expect(rec.target).toBe(TARGET_BLOG);
  });
});
