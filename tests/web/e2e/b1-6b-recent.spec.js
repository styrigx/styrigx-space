/* B1-6b｜设置搜索最近搜索卡验收测试
 *
 * 验收（任务书）：
 * a. 没记录：进页看不到卡片
 * b. 输入「字体」+ Enter，再清空：卡片出现，第一个胶囊是「字体」
 * c. 只输入不按 Enter 不点结果：不记录
 * d. 去重和上限：12 个词（第 1 个最后又搜一次）→ 10 条，重复的排第一，最早的被挤掉
 * e. 点结果会记录：跳走再回来，这条在第一个
 * f. 点胶囊：输入框被填上，出现「搜索结果」，输入框仍是 document.activeElement
 * g. 点 ×：只少一条；删到最后一条时卡片消失
 * h. 全部清除：卡片消失，localStorage 空数组或无此 key
 * i. /en/settings/search/：卡头 Recent searches，按钮 Clear all
 * j. 写入非法 JSON 再进页：不报错，卡片不显示
 */
import { test, expect } from '@playwright/test';

const INPUT = '#sgx-cap-input-setsearch';
const CARD = '.setso-recent';
const CHIP_TX = '.setso-chip-tx';

/* 进搜索页；每条用例开头显式清空历史（防共享 context） */
async function gotoSearch(page, en) {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e));
  await page.addInitScript((l) => {
    try {
      localStorage.setItem('sgx-lang', l);
    } catch (e) {}
  }, en ? 'en' : 'zh');
  await page.goto(en ? '/en/settings/search/' : '/settings/search/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator(INPUT)).toBeVisible({ timeout: 15000 });
  await page.evaluate(() => {
    try {
      localStorage.removeItem('sgx-setso-history');
      localStorage.removeItem('sgx-set-recent');
    } catch (e) {}
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator(INPUT)).toBeVisible({ timeout: 15000 });
  return errs;
}

/** @param {import('@playwright/test').Page} page */
async function histOf(page) {
  return page.evaluate(() => {
    try {
      const v = localStorage.getItem('sgx-setso-history');
      return v === null ? null : JSON.parse(v);
    } catch (e) {
      return 'BAD';
    }
  });
}

/** @param {import('@playwright/test').Page} page @param {string} word */
async function searchEnter(page, word) {
  await page.locator(INPUT).fill(word);
  await page.locator(INPUT).press('Enter');
}

test.describe('B1-6b 最近搜索卡', () => {
  test('a. 没有记录：进页后看不到卡片', async ({ page }) => {
    const errs = await gotoSearch(page);
    await expect(page.locator(CARD)).toHaveCount(0);
    expect(errs).toEqual([]);
  });

  test('b. 输入「字体」+ Enter，再清空：卡片出现，第一个胶囊是「字体」', async ({ page }) => {
    const errs = await gotoSearch(page);
    await searchEnter(page, '字体');
    await page.locator(INPUT).fill('');
    await expect(page.locator(CARD)).toBeVisible({ timeout: 5000 });
    await expect(page.locator(CHIP_TX).first()).toHaveText('字体');
    expect(errs).toEqual([]);
  });

  test('c. 只输入、不按 Enter 也不点结果：不记录', async ({ page }) => {
    await gotoSearch(page);
    await page.locator(INPUT).fill('字体');
    await page.waitForTimeout(500); /* 过了去抖，render 跑了但不记录 */
    expect(await histOf(page)).toBeNull();
  });

  test('d. 去重和上限：12 个词（第 1 个最后又搜一次）', async ({ page }) => {
    await gotoSearch(page);
    const words = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '甲', '乙'];
    for (const w of words) await searchEnter(page, w);
    await searchEnter(page, '一');
    await page.locator(INPUT).fill('');
    await expect(page.locator(CARD)).toBeVisible({ timeout: 5000 });
    const got = await page.locator(CHIP_TX).allTextContents();
    expect(got.length).toBe(10);
    expect(got[0]).toBe('一');
    expect(got).not.toContain('二');
    expect(got).not.toContain('三');
    expect(got).toContain('乙');
  });

  test('e. 点结果会记录：跳走再回来，这条在第一个', async ({ page }) => {
    const errs = await gotoSearch(page);
    await page.locator(INPUT).fill('字体');
    await expect(page.locator('.setso-item').first()).toBeVisible({ timeout: 5000 });
    await page.locator('.setso-item').first().click();
    await page.waitForTimeout(400); /* 等跳转/弹层 */
    await page.goto('/settings/search/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator(INPUT)).toBeVisible({ timeout: 15000 });
    await expect(page.locator(CARD)).toBeVisible({ timeout: 5000 });
    await expect(page.locator(CHIP_TX).first()).toHaveText('字体');
    expect(errs).toEqual([]);
  });

  test('f. 点胶囊：输入框被填上，出现「搜索结果」，输入框仍是 activeElement', async ({ page }) => {
    await gotoSearch(page);
    await searchEnter(page, '字体');
    await page.locator(INPUT).fill('');
    await expect(page.locator(CARD)).toBeVisible({ timeout: 5000 });
    await page.locator(CHIP_TX).first().click();
    await expect(page.locator(INPUT)).toHaveValue('字体');
    await expect(page.locator('.setso-title')).toContainText('搜索结果');
    const activeId = await page.evaluate(() => (document.activeElement && document.activeElement.id) || '');
    expect(activeId).toBe('sgx-cap-input-setsearch');
  });

  test('g. 点 ×：只少一条；删到最后一条时卡片消失', async ({ page }) => {
    await gotoSearch(page);
    await searchEnter(page, '甲');
    await searchEnter(page, '乙');
    await page.locator(INPUT).fill('');
    await expect(page.locator(CARD)).toBeVisible({ timeout: 5000 });
    await expect(page.locator(CHIP_TX)).toHaveCount(2);
    await page.locator('[data-setso-del]').first().click();
    await expect(page.locator(CHIP_TX)).toHaveCount(1);
    await expect(page.locator(CARD)).toBeVisible();
    await page.locator('[data-setso-del]').first().click();
    await expect(page.locator(CARD)).toHaveCount(0);
    expect(await histOf(page)).toEqual([]);
  });

  test('h. 全部清除：卡片消失，localStorage 空数组或无此 key', async ({ page }) => {
    await gotoSearch(page);
    await searchEnter(page, '字体');
    await page.locator(INPUT).fill('');
    await expect(page.locator(CARD)).toBeVisible({ timeout: 5000 });
    await page.locator('[data-setso-clear]').click();
    await expect(page.locator(CARD)).toHaveCount(0);
    const v = await histOf(page);
    expect(v === null || (Array.isArray(v) && v.length === 0)).toBe(true);
  });

  test('i. /en/settings/search/：卡头 Recent searches，按钮 Clear all', async ({ page }) => {
    const errs = await gotoSearch(page, true);
    await searchEnter(page, 'font');
    await page.locator(INPUT).fill('');
    await expect(page.locator(CARD)).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.setso-recent-title')).toHaveText('Recent searches');
    await expect(page.locator('[data-setso-clear]')).toHaveText('Clear all');
    expect(errs).toEqual([]);
  });

  test('j. 写入非法 JSON 再进页：页面不报错，卡片不显示', async ({ page }) => {
    const errs = [];
    page.on('pageerror', (e) => errs.push(e));
    await page.addInitScript(() => {
      try {
        localStorage.setItem('sgx-lang', 'zh');
        localStorage.setItem('sgx-setso-history', 'not-json{{{');
      } catch (e) {}
    });
    await page.goto('/settings/search/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator(INPUT)).toBeVisible({ timeout: 15000 });
    await expect(page.locator(CARD)).toHaveCount(0);
    /* 非法 JSON 不影响后续正常写入 */
    await searchEnter(page, '字体');
    await page.locator(INPUT).fill('');
    await expect(page.locator(CARD)).toBeVisible({ timeout: 5000 });
    expect(errs).toEqual([]);
  });

  test('k. 删除钮是 <button>，aria-label 里带搜索词', async ({ page }) => {
    const errs = await gotoSearch(page);
    await searchEnter(page, '字体');
    await page.locator(INPUT).fill('');
    await expect(page.locator(CARD)).toBeVisible({ timeout: 5000 });
    const del = page.locator('.setso-chip-x').first();
    await expect(del).toBeVisible();
    expect(await del.evaluate((el) => el.tagName.toLowerCase())).toBe('button');
    const label = await del.getAttribute('aria-label');
    expect(label).toContain('字体');
    expect(errs).toEqual([]);
  });
});
