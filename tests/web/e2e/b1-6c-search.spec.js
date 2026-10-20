/* B1-6c｜设置搜索页：键盘 / 沉底 / 返回手势 / 内容置顶 / 小标题 / ⓧ 清空 + × 关闭
 *
 * 验收（任务书 B1-6）：
 * a. 设置主页点搜索胶囊 → 进入 /settings/search/，输入框聚焦
 * b. 进页即内容置顶：内容紧贴顶栏下方、大标题不可见、顶栏小标题「设置搜索」出现；
 *    滚到顶露出大标题、小标题消失
 * c. 输入后仍内容置顶
 * d. 未输入：ⓧ 清空隐藏、× 关闭显示；有输入：ⓧ 出现；点 ⓧ 清空、ⓧ 再隐藏、输入框仍聚焦；胶囊里没有 ⋮
 * i. 点 × 关闭：键盘态 / 沉底态都直接回到设置主页
 * e. 键盘态返回（popstate）：仍在本页，输入框失焦、搜索栏沉底（不再 .open）
 * f. 沉底态返回：回到 /settings/
 * g. 沉底态点顶栏 ← ：回到 /settings/
 * h. 回车：记录并收键盘（沉底），结果可见
 * 截图：360 宽浅色 结果态（沉底），作为测试附件留档
 */
import { test, expect } from '@playwright/test';

const INPUT = '#sgx-cap-input-setsearch';
const CAP = '#sgx-cap-setsearch';
const CLOSE = '#sgx-cap-setsearch [data-cap-close]';
const CLEAR = '#sgx-cap-setsearch [data-cap-clear]';

test.use({ viewport: { width: 360, height: 780 }, colorScheme: 'light' });

/** 从设置主页点胶囊进入搜索页（站内 history 推进） */
async function enterFromSettings(page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('sgx-lang', 'zh');
      localStorage.removeItem('sgx-setso-history');
    } catch (e) {}
  });
  await page.goto('/settings/', { waitUntil: 'domcontentloaded' });
  const cap = page.locator('#sgx-cap-settings');
  await expect(cap).toBeVisible({ timeout: 15000 });
  const box = await cap.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForURL(/\/settings\/search\/$/, { timeout: 15000 });
  await expect(page.locator(INPUT)).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(300);
}

async function geo(page) {
  return page.evaluate(() => {
    const bar = document.querySelector('.sgx-topbar');
    const heads = Array.from(document.querySelectorAll('[data-subpage-head]'));
    const head = heads.find((h) => h.getClientRects().length) || heads[0];
    const title = head.querySelector('.subpage-title');
    const main = document.querySelector('.setso-layout .set-main');
    return {
      barBottom: bar.getBoundingClientRect().bottom,
      titleBottom: title.getBoundingClientRect().bottom,
      mainTop: main.getBoundingClientRect().top,
      stuck: document.body.classList.contains('sgx-stuck'),
      scrollY: window.scrollY,
    };
  });
}

test('a+b 进页：输入框聚焦，内容置顶，小标题出现；滚到顶露出大标题', async ({ page }) => {
  await enterFromSettings(page);
  expect(await page.evaluate((s) => document.activeElement === document.querySelector(s), INPUT)).toBe(true);
  const g = await geo(page);
  expect(g.scrollY).toBeGreaterThan(0);
  expect(g.titleBottom).toBeLessThanOrEqual(g.barBottom); // 大标题已滚到顶栏下沿之上
  expect(Math.abs(g.mainTop - (g.barBottom + 16))).toBeLessThanOrEqual(2); // 内容紧贴顶栏下方
  expect(g.stuck).toBe(true);
  await expect(page.locator('.sgx-tb-pill .subpage-mini-title')).toHaveText('设置搜索');

  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(async () => (await geo(page)).stuck).toBe(false);
  const top = await geo(page);
  expect(top.titleBottom).toBeGreaterThan(top.barBottom);
});

test('c 输入后仍内容置顶', async ({ page }) => {
  await enterFromSettings(page);
  await page.locator(INPUT).pressSequentially('字体');
  await expect(page.locator('#setso-page .setso-item').first()).toBeVisible();
  await page.waitForTimeout(300);
  const g = await geo(page);
  expect(g.titleBottom).toBeLessThanOrEqual(g.barBottom);
  expect(g.stuck).toBe(true);
});

test('d ⓧ 清空随输入出现，点 ⓧ 清空且不收键盘；× 关闭常驻、没有 ⋮', async ({ page }) => {
  await enterFromSettings(page);
  await expect(page.locator('#sgx-cap-setsearch [data-cap-more]')).toHaveCount(0);
  await expect(page.locator(CLOSE)).toBeVisible();
  await expect(page.locator(CLEAR)).toBeHidden();
  await page.locator(INPUT).pressSequentially('字');
  await expect(page.locator(CLEAR)).toBeVisible();
  await expect(page.locator(CLOSE)).toBeVisible();
  await page.locator(CLEAR).click();
  await expect(page.locator(INPUT)).toHaveValue('');
  await expect(page.locator(CLEAR)).toBeHidden();
  await expect(page.locator(CLOSE)).toBeVisible();
  expect(await page.evaluate((s) => document.activeElement === document.querySelector(s), INPUT)).toBe(true);
});

test('i 键盘态点 × 关闭：直接回设置主页', async ({ page }) => {
  await enterFromSettings(page);
  await page.locator(INPUT).pressSequentially('字体');
  await expect(page.locator(CAP)).toHaveClass(/\bopen\b/);
  await page.locator(CLOSE).click();
  await page.waitForURL(/\/settings\/$/, { timeout: 15000 });
});

test('i 沉底态点 × 关闭：直接回设置主页', async ({ page }) => {
  await enterFromSettings(page);
  await page.locator(INPUT).pressSequentially('字体');
  await page.locator(INPUT).press('Enter');
  await expect(page.locator(CAP)).not.toHaveClass(/\bopen\b/);
  await page.locator(CLOSE).click();
  await page.waitForURL(/\/settings\/$/, { timeout: 15000 });
});

test('e 键盘态返回：只收键盘，留在本页；f 沉底态再返回：回设置主页', async ({ page }) => {
  await enterFromSettings(page);
  await page.locator(INPUT).pressSequentially('字体');
  await expect(page.locator(CAP)).toHaveClass(/\bopen\b/);
  await page.goBack();
  await page.waitForTimeout(400);
  expect(new URL(page.url()).pathname).toBe('/settings/search/');
  await expect(page.locator(CAP)).not.toHaveClass(/\bopen\b/);
  expect(await page.evaluate((s) => document.activeElement === document.querySelector(s), INPUT)).toBe(false);
  await expect(page.locator(INPUT)).toHaveValue('字体'); // 结果仍在

  await page.evaluate(() => history.back());
  await page.waitForURL(/\/settings\/$/, { timeout: 15000 });
});

test('g 沉底态系统返回回设置主页（顶栏没有 ←）', async ({ page }) => {
  await enterFromSettings(page);
  await page.locator(INPUT).pressSequentially('字体');
  await page.locator(INPUT).press('Enter'); // h：回车收键盘
  await expect(page.locator(CAP)).not.toHaveClass(/\bopen\b/);
  await expect(page.locator('#setso-page .setso-item').first()).toBeVisible();
  await expect(page.locator('.sgx-tb-back')).toHaveCount(0);
  await page.goBack();
  await page.waitForURL(/\/settings\/$/, { timeout: 15000 });
});

test('h 回车：记录历史并沉底；结果态截图', async ({ page }, testInfo) => {
  await enterFromSettings(page);
  await page.locator(INPUT).pressSequentially('字体');
  await page.locator(INPUT).press('Enter');
  await expect(page.locator(CAP)).not.toHaveClass(/\bopen\b/);
  const hist = await page.evaluate(() => JSON.parse(localStorage.getItem('sgx-setso-history') || '[]'));
  expect(hist[0]).toBe('字体');
  // 沉底：胶囊在视口底部附近
  const box = await page.locator(CAP).boundingBox();
  expect(780 - (box.y + box.height)).toBeLessThanOrEqual(40);
  // 截图只作附件留档（不做像素比对，基线统一由 visual.spec.js 管）
  await testInfo.attach('360-light-results-sunk', { body: await page.screenshot(), contentType: 'image/png' });
});
