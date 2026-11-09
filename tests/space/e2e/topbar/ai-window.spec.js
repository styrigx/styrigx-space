/**
 * AI 窗口（重设计 PR-5 ai-v1；原 topbar/acct-sec-pop.spec.js AI 那一组，2026-11-08 按功能拆文件）：× 关窗、桌面浮在浮钮上方、模型胶囊、来源卡片。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('../helpers/helpers');

async function go(page, path, opts = {}) {
  await blockExternalRequests(page);
  await freezeTime(page);
  /* 中文页：先存语言偏好，免得按浏览器语言跳回英文页（同 topbar-spec.spec.js） */
  if (path.indexOf('/zh/') === 0) await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
  if (opts.route) await opts.route(page);
  if (opts.account !== undefined) {
    await page.route('**/api/account**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.account) }));
  }
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-sgx-layout'));
}
const settled = (page, id) => page.waitForFunction((i) => document.getElementById(i).getAnimations({ subtree: true }).every((a) => a.playState !== 'running' || (a.effect && a.effect.getTiming().iterations === Infinity)), id);
/* 页面时钟被 freezeTime 冻住：接口替身里的时间按页面的 Date.now() 算 */
const pageNow = (page) => page.evaluate(() => Date.now());

const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

test.describe('AI 窗口（ai-v1，按设计稿）', () => {
  test('× 关窗，焦点回 AI 浮钮；桌面浮在 AI 浮钮上方、不压暗页面', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await go(page, '/wild/');
    await page.locator('.sgx-tb-ai').click();
    const ai = page.locator('#sgx-ai');
    await expect(ai).toHaveAttribute('data-state', 'open');
    await settled(page, 'sgx-ai');
    const g = await page.evaluate(() => {
      const sh = document.querySelector('#sgx-ai .sgx-qp-sheet').getBoundingClientRect();
      const fab = document.querySelector('.sgx-tb-ai').getBoundingClientRect();
      return { shR: sh.right, shB: sh.bottom, fabR: fab.right, fabT: fab.top, bg: getComputedStyle(document.getElementById('sgx-ai')).backgroundColor };
    });
    expect(Math.abs(g.shR - g.fabR)).toBeLessThanOrEqual(1);
    expect(g.shB).toBeLessThan(g.fabT);
    expect(g.bg).toBe('rgba(0, 0, 0, 0)');
    await ai.locator('[data-ai-close]').click();
    await expect(ai).toBeHidden();
    await expect(page.locator('.sgx-tb-ai')).toBeFocused();
  });

  test('模型胶囊：登了账号能在窗口里换（写 sgx-ai-model，发问带上）；回答下站内链接成来源卡片、建议问题点了就问', async ({ page }) => {
    let body = null;
    await go(page, '/zh/wild/');
    await page.route('**/api/ai', (r) => {
      if (r.request().method() === 'GET') return r.fulfill(json({ ok: true, default: 'g4', canChoose: true, models: [{ id: 'g4', label: 'Gemma 4' }, { id: 'gf', label: 'Gemini Flash' }] }));
      body = r.request().postDataJSON();
      const sse = 'event: delta\ndata: ' + JSON.stringify({ text: '写过：[AI 代理协作开发规范白皮书](/blog/post/2026-10-11-agent-collaboration-whitepaper-v2/)' }) + '\n\nevent: done\ndata: {}\n\n';
      return r.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: sse });
    });
    await page.locator('.sgx-tb-ai').click();
    const ai = page.locator('#sgx-ai');
    const chip = ai.locator('[data-ai-model]');
    await expect(chip).toHaveText(/Gemma 4/);
    await chip.click();
    await expect(chip).toHaveAttribute('aria-expanded', 'true');
    await ai.locator('.sgx-ai-mopt', { hasText: 'Gemini Flash' }).click();
    await expect(chip).toHaveText(/Gemini Flash/);
    expect(await page.evaluate(() => localStorage.getItem('sgx-ai-model'))).toBe('gf');
    await ai.locator('.sgx-ai-sug').first().click();
    await expect(ai.locator('.sgx-ai-src')).toHaveCount(1);
    await expect(ai.locator('.sgx-ai-src code')).toHaveText('blog/post');
    await expect(ai.locator('.sgx-ai-src')).toContainText('AI 代理协作开发规范白皮书');
    expect(body.q).toBe('最近在听什么');
    expect(body.model).toBe('gf');
  });
});
