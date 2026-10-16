/**
 * B1-8 子站回跳防死循环（只加测试，不改功能）。
 *
 * 验收（任务书 B1-8）：
 * - 正常回到 blog/book（第一次被踢回 → 自动跳回子站，不出失败卡）
 * - 20 秒内第二次被踢回 → 出失败卡（One UI 样式，不显示原因码）
 * - 超过 20 秒仍然正常（不算死循环，继续回跳）
 *
 * 用假时钟：page.addInitScript 替换 Date.now，测试里手动推进。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('./helpers');

/* 假时钟：__now 可手动推进 */
async function setupFakeClock(page, startMs) {
  await page.addInitScript((start) => {
    window.__fakeNow = start;
    const RealDate = Date;
    // @ts-ignore
    window.Date = class extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(window.__fakeNow);
        else super(...args);
      }
      static now() { return window.__fakeNow; }
    };
  }, startMs);
}

async function advanceClock(page, ms) {
  await page.evaluate((delta) => { window.__fakeNow += delta; }, ms);
}

/* 模拟子站踢回：带 ?why=xxx&return=target 的锁屏页，通过访客解锁触发 handleSessionOk */
async function gotoKickedBackAndUnlock(page, target, why) {
  const url = '/?lock=1&why=' + encodeURIComponent(why) + '&return=' + encodeURIComponent(target);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#sgx-lock')).toBeVisible({ timeout: 15000 });
  /* 访客解锁：点头像 → 方法弹层 → 访客进入 */
  await page.click('#sgx-lock-avatar');
  await expect(page.locator('#sgx-method-sheet.visible')).toBeVisible({ timeout: 5000 });
  await page.click('#sgx-mopt-visitor');
  /* 等待 handleSessionOk 执行 */
  await page.waitForTimeout(1000);
}

test.describe('B1-8 子站回跳防死循环', () => {
  const START = new Date('2026-10-09T12:00:00+08:00').getTime();
  const TARGET = 'https://book.styrigx.com/';

  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await setupFakeClock(page, START);
    /* 清掉 sessionStorage */
    await page.addInitScript(() => {
      try { sessionStorage.clear(); } catch (e) {}
    });
  });

  test('第一次被踢回：自动跳回子站，不出失败卡', async ({ page }) => {
    await gotoKickedBackAndUnlock(page, TARGET, 'no-cookie');
    /* 第一次：不算死循环，继续回跳（不显示失败卡） */
    await expect(page.locator('#sgx-subsite-failure')).toBeHidden({ timeout: 5000 });
    /* sessionStorage 记录了这次回跳 */
    const rec = await page.evaluate(() => {
      try { return JSON.parse(sessionStorage.getItem('sgx-subsite-jump')); } catch (e) { return null; }
    });
    expect(rec).not.toBeNull();
    expect(rec.target).toBe(TARGET);
  });

  test('20 秒内第二次被踢回：出失败卡，不显示原因码', async ({ page }) => {
    /* 第一次 */
    await gotoKickedBackAndUnlock(page, TARGET, 'no-cookie');
    await expect(page.locator('#sgx-subsite-failure')).toBeHidden({ timeout: 5000 });

    /* 推进 10 秒（<20s），第二次被踢回 */
    await advanceClock(page, 10000);
    await gotoKickedBackAndUnlock(page, TARGET, 'no-cookie');

    /* 出失败卡 */
    const card = page.locator('#sgx-subsite-failure');
    await expect(card).toBeVisible({ timeout: 5000 });
    /* One UI 样式：sgx-card class */
    await expect(card).toHaveClass(/sgx-card/);
    /* 不显示原因码 */
    const text = await card.textContent();
    expect(text).not.toContain('no-cookie');
    expect(text).toContain('无法回到子站');
    /* 有「回到主站」按钮 */
    await expect(page.locator('#sgx-subsite-home')).toBeVisible();
  });

  test('超过 20 秒：仍然正常回跳，不出失败卡', async ({ page }) => {
    /* 第一次 */
    await gotoKickedBackAndUnlock(page, TARGET, 'no-cookie');
    await expect(page.locator('#sgx-subsite-failure')).toBeHidden({ timeout: 5000 });

    /* 推进 25 秒（>20s），第二次被踢回 */
    await advanceClock(page, 25000);
    await gotoKickedBackAndUnlock(page, TARGET, 'no-cookie');

    /* 不算死循环，不出失败卡 */
    await expect(page.locator('#sgx-subsite-failure')).toBeHidden({ timeout: 5000 });
  });

  test('不同 target：不算死循环', async ({ page }) => {
    const TARGET2 = 'https://blog.styrigx.com/';
    /* 第一次踢回 book */
    await gotoKickedBackAndUnlock(page, TARGET, 'no-cookie');
    await expect(page.locator('#sgx-subsite-failure')).toBeHidden({ timeout: 5000 });

    /* 10 秒内踢回 blog（不同 target） */
    await advanceClock(page, 10000);
    await gotoKickedBackAndUnlock(page, TARGET2, 'expired');

    /* 不同目标，不算死循环 */
    await expect(page.locator('#sgx-subsite-failure')).toBeHidden({ timeout: 5000 });
  });
});
