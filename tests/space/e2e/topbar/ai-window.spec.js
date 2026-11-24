/**
 * AI 窗口（重设计 PR-5 ai-v1；原 topbar/acct-sec-pop.spec.js AI 那一组，2026-11-08 按功能拆文件）：× 关窗、桌面浮在浮钮上方、模型胶囊、来源卡片。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, nextFrames, expect } = require('../helpers/helpers');

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
    await go(page, '/status/');
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

  test('没进站（v5 S3 三处上锁之一）：GET /api/ai 401 → 模型矩形只显示锁标；点锁 / 发问都不问 AI，打开终端预填 su ', async ({ page }) => {
    let posts = 0;
    await go(page, '/zh/status/');
    await page.route('**/api/ai', (r) => {
      if (r.request().method() !== 'GET') posts++;
      return r.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false,"error":"unauthorized"}' });
    });
    await page.locator('.sgx-tb-ai').click();
    const ai = page.locator('#sgx-ai');
    const chip = ai.locator('[data-ai-model]');
    await expect(chip).toHaveClass(/is-locked/);
    await expect(chip.locator('[data-ai-model-lock] svg')).toBeVisible();
    await expect(chip.locator('[data-ai-model-name]')).toBeHidden();
    await expect(chip).toHaveAttribute('aria-label', '已上锁，su 登录后可用');
    await chip.click();
    await expect(page.locator('#sgx-term')).toHaveAttribute('open', '');
    await expect(page.locator('#sgx-term [data-term-in]')).toHaveValue('su ');
    await page.keyboard.press('Escape');
    await expect(page.locator('#sgx-term')).not.toHaveAttribute('open', '');
    await page.locator('.sgx-tb-ai').click();
    await ai.locator('[data-ai-in]').fill('你好');
    await ai.locator('[data-ai-in]').press('Enter');
    await expect(page.locator('#sgx-term [data-term-in]')).toHaveValue('su ');
    expect(posts).toBe(0);
  });

  test('R-28：AI 窗口锁 → 终端 su 成功（sgx:session live ok）→ 收终端、回 AI 窗口并解锁；没登录就关终端不算', async ({ page }) => {
    let authed = false;
    await go(page, '/zh/status/');
    await page.route('**/api/ai', (r) => authed
      ? r.fulfill(json({ ok: true, default: 'g4', canChoose: false, models: [{ id: 'g4', label: 'Gemma 4' }] }))
      : r.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false,"error":"unauthorized"}' }));
    await page.locator('.sgx-tb-ai').click();
    const ai = page.locator('#sgx-ai');
    const chip = ai.locator('[data-ai-model]');
    const term = page.locator('#sgx-term');
    const su = () => page.evaluate(() => window.dispatchEvent(new CustomEvent('sgx:session', { detail: { ok: true, live: true } })));
    /* 没登录就 Esc 关终端：之后别处 su 成功不回 AI */
    await chip.click();
    await expect(term).toHaveAttribute('open', '');
    await page.keyboard.press('Escape');
    await expect(term).not.toHaveAttribute('open', '');
    await su();
    /* 没有「从 AI 锁来」那一笔：sgx:session 的处理同步返回（不收终端、不退历史哨兵），没有迟到的重开；两帧后看 */
    await nextFrames(page, 2);
    await expect(ai).not.toHaveAttribute('open', '');
    /* 从 AI 锁来、su 成功：终端收起，AI 窗口重开、锁标没了 */
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('sgx:session', { detail: { ok: false, live: true } })));
    await page.locator('.sgx-tb-ai').click();
    await expect(chip).toHaveClass(/is-locked/);
    await chip.click();
    await expect(term).toHaveAttribute('open', '');
    await expect(page.locator('#sgx-term [data-term-in]')).toHaveValue('su ');
    authed = true;
    /* 终端滑入走完（modalSheet data-state 到 open）再 su，收终端走正常的滑出 + 退哨兵 */
    await expect(term).toHaveAttribute('data-state', 'open');
    await su();
    await expect(term).not.toHaveAttribute('open', '');
    await expect(ai).toHaveAttribute('open', '');
    await expect(chip).not.toHaveClass(/is-locked/);
    await expect(chip).toHaveText(/Gemma 4/);
    /* AI 窗口重开走完（data-state 到 open）、历史里是它自己的哨兵（终端那次 history.back() 的 popstate 已经过去），停住不被关掉 */
    await expect(ai).toHaveAttribute('data-state', 'open');
    await expect.poll(() => page.evaluate(() => !!(history.state && history.state.sgxAi))).toBe(true);
    await expect(ai).toHaveAttribute('open', '');
  });

  test('模型胶囊：登了账号能在窗口里换（写 sgx-ai-model，发问带上）；回答下站内链接成来源卡片、建议问题点了就问', async ({ page }) => {
    let body = null;
    await go(page, '/zh/status/');
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
