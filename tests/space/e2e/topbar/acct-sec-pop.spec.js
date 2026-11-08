/**
 * 重设计 PR-5（2026-11-08）：账号下拉 #sgx-acct（acct-v2）、站点安全下拉 #sgx-sec（sec-v1）、AI 窗口头部 ×（ai-v1）。
 * 只换外观：盾牌 / 头像仍是链接（href / 读屏名不变，修饰键点照旧按链接走），普通点击开下拉；下拉里是去账号 / 安全各页的入口，
 * 立即锁屏只在 NAVIGATE（Gray 2026-11-08 04:06：盾牌下拉不放）；账号下拉不放 AI 模型（04:45）、云同步（04:47）。登录态按 GET /api/account（ok + session / session=null；问不到不写）。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('../helpers/helpers');

async function go(page, path, opts = {}) {
  await blockExternalRequests(page);
  await freezeTime(page);
  /* 中文页：先存语言偏好，免得按浏览器语言跳回英文页（同 topbar-spec.spec.js） */
  if (path.indexOf('/zh/') === 0) await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
  if (opts.account !== undefined) {
    await page.route('**/api/account', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.account) }));
  }
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-sgx-layout'));
}
const settled = (page, id) => page.waitForFunction((i) => document.getElementById(i).getAnimations({ subtree: true }).every((a) => a.playState !== 'running' || (a.effect && a.effect.getTiming().iterations === Infinity)), id);
/* 页面时钟被 freezeTime 冻住：接口替身里的时间按页面的 Date.now() 算 */
const pageNow = (page) => page.evaluate(() => Date.now());

const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

test.describe('账号下拉 #sgx-acct（acct-v2，按设计稿）', () => {
  test('点头像开下拉（非模态、aria-expanded）：头部 姓名 · 昵称 · 编辑；四行去账号各子页（无云同步 / AI 模型）；Esc 关、焦点回头像', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await go(page, '/zh/wild/');
    const av = page.locator('.sgx-tb-av');
    await expect(av).toHaveAttribute('href', '/zh/account/');
    await expect(av).toHaveAccessibleName('账号');
    await av.click();
    const d = page.locator('#sgx-acct');
    await expect(d).toHaveAttribute('data-state', 'open');
    expect(await d.evaluate((el) => el.open && !el.matches(':modal'))).toBe(true);
    await expect(av).toHaveAttribute('aria-expanded', 'true');
    await expect(page).toHaveURL(/\/zh\/wild\/$/);
    expect(await d.locator('.sgx-pop-list a.sgx-pop-row').evaluateAll((els) => els.map((e) => e.getAttribute('href'))))
      .toEqual(['/zh/account/profile/', '/zh/account/devices/', '/zh/account/security/', '/zh/account/apps/']);
    await expect(d.locator('[data-acct-v="sync"]')).toHaveCount(0);
    await expect(d.locator('.sgx-pop-list').first()).not.toContainText('云同步');
    /* Gray 2026-11-08 04:45：账号下拉不放 AI 模型行，模型只在 AI 窗口右上角切换 */
    await expect(d.locator('[data-acct-v="ai"]')).toHaveCount(0);
    await expect(d.locator('.sgx-pop-list').first()).not.toContainText('AI 模型');
    await expect(d.locator('.sgx-pop-me-a')).toHaveAttribute('href', '/zh/account/');
    await expect(d.locator('.sgx-pop-edit')).toHaveAttribute('href', '/zh/account/profile/');
    await expect(d.locator('[data-acct-name]')).toHaveText('Sloan Gray');
    const hs = await d.locator('.sgx-pop-row').evaluateAll((els) => els.filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect().height));
    for (const h of hs) expect(h).toBeGreaterThanOrEqual(44);
    await settled(page, 'sgx-acct');
    await page.keyboard.press('Escape');
    await expect(d).toBeHidden();
    await expect(av).toHaveAttribute('aria-expanded', 'false');
    await expect(av).toBeFocused();
  });

  test('有账号会话：「✓ 已登录」、设备名、账号安全「已保护」、无 AI 模型行、退出登录（POST logout → 回账号页）', async ({ page }) => {
    let out = null;
    await go(page, '/zh/wild/');
    await page.route('**/api/ai', (r) => r.fulfill(json({ ok: true, default: 'g4', canChoose: true, models: [{ id: 'g4', label: 'Gemma 4' }] })));
    await page.route('**/api/account', (r) => {
      if (r.request().method() === 'POST') { out = r.request().postDataJSON(); return r.fulfill(json({ ok: true })); }
      return r.fulfill(json({ ok: true, password: true, passkey: true, session: { by: 'passkey', device: 'Galaxy S23 Ultra' } }));
    });
    await page.locator('.sgx-tb-av').click();
    const d = page.locator('#sgx-acct');
    await expect(d).toHaveAttribute('data-acct-state', 'in');
    await expect(d.locator('.sgx-pop-state')).toBeVisible();
    await expect(d.locator('[data-acct-v="device"]')).toHaveText('Galaxy S23 Ultra');
    await expect(d.locator('[data-acct-v="security"]')).toHaveText('已保护');
    /* 没有 AI 模型行（Gray 2026-11-08 04:45）：有会话、/api/ai 有模型也不画 */
    await expect(d.locator('[data-acct-v="ai"]')).toHaveCount(0);
    await expect(d).not.toContainText('Gemma 4');
    await expect(d.locator('[data-acct-login]').first()).toBeHidden();
    const lo = d.locator('[data-acct-logout]');
    await expect(lo).toBeVisible();
    await expect(lo).toContainText('退出登录');
    await lo.click();
    await page.waitForURL(/\/zh\/account\/$/);
    expect(out).toEqual({ action: 'logout' });
  });

  test('没有账号会话：$ ACCOUNT guest + 终端式「sudo account · [1] passkey [2] accountkey」，按 2 去账号页；资料头 / 列表 / 退出不显示', async ({ page }) => {
    await go(page, '/zh/wild/', { account: { ok: true, session: null } });
    await page.locator('.sgx-tb-av').click();
    const g = page.locator('#sgx-acct');
    await expect(g).toHaveAttribute('data-acct-state', 'guest');
    await expect(g.locator('.sgx-pop-gh')).toContainText('guest');
    await expect(g.locator('.sgx-pop-login')).toContainText('sudo account');
    await expect(g.locator('.sgx-pop-opt[data-key="1"]')).toHaveAttribute('href', '/zh/account/');
    await expect(g.locator('.sgx-pop-opt[data-key="2"]')).toContainText('accountkey');
    await expect(g.locator('.sgx-pop-me')).toBeHidden();
    await expect(g.locator('.sgx-pop-list').first()).toBeHidden();
    await expect(g.locator('[data-acct-logout]')).toBeHidden();
    await settled(page, 'sgx-acct');
    await page.keyboard.press('2');
    await page.waitForURL(/\/zh\/account\/$/);
  });

  test('接口不通：不写登录态，资料头和列表照常、没有退出', async ({ page }) => {
    await go(page, '/wild/');
    await page.route('**/api/account', (r) => r.fulfill({ status: 503, body: 'x' }));
    await page.locator('.sgx-tb-av').click();
    const d = page.locator('#sgx-acct');
    await expect(d).toHaveAttribute('data-state', 'open');
    await expect(d).toHaveAttribute('data-acct-state', '');
    await expect(d.locator('.sgx-pop-me')).toBeVisible();
    await expect(d.locator('.sgx-pop-list').first()).toBeVisible();
    await expect(d.locator('[data-acct-logout]')).toBeHidden();
  });

  test('本机缓存 sgx-profile 改过的姓名 / 昵称盖住默认值', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-profile', JSON.stringify({ v: 1, p: { name: 'Test Name', nickname: 'tnick' }, t: 1 })); } catch (e) {} });
    await go(page, '/wild/');
    await page.locator('.sgx-tb-av').click();
    await expect(page.locator('#sgx-acct [data-acct-name]')).toHaveText('Test Name');
    await expect(page.locator('#sgx-acct [data-acct-nick]')).toHaveText('tnick');
  });

  test('下拉里的链接：先关下拉再跳（不留历史哨兵）', async ({ page }) => {
    await go(page, '/zh/wild/');
    await page.locator('.sgx-tb-av').click();
    await expect(page.locator('#sgx-acct')).toHaveAttribute('data-state', 'open');
    await page.locator('#sgx-acct a.sgx-pop-row[href="/zh/account/devices/"]').click();
    await page.waitForURL(/\/zh\/account\/devices\/$/);
  });
});

test.describe('站点安全下拉 #sgx-sec（sec-v1，按设计稿）', () => {
  test('有 3 分钟验证票：头部倒计时、通行密钥个数、锁屏钥匙 LockKey、临时钥匙、锁屏会话剩余、锁定所有设备（没有立即锁屏）；和账号下拉互斥', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await go(page, '/zh/wild/');
    const now = await pageNow(page);
    await page.route('**/api/lock-session-check', (r) => r.fulfill(json({ ok: true, exp: now + (11 * 60 + 20) * 60000 + 30000 })));
    await page.route('**/api/lock-reauth', (r) => r.fulfill(json({ ok: true, valid: true, expiresAt: now + 161000 })));
    await page.route('**/api/lock-passkey', (r) => r.fulfill(json({ ok: true, keys: [{ credId: 'a' }, { credId: 'b' }] })));
    await page.locator('.sgx-tb-shield').click();
    const s = page.locator('#sgx-sec');
    await expect(s).toHaveAttribute('data-state', 'open');
    await expect(s).toHaveAttribute('data-sec-state', 'open');
    await expect(s.locator('[data-sec-head]')).toHaveText(/^0[0-2]:\d\d$/);
    await expect(s.locator('[data-sec-v="pk"]')).toHaveText('2 个');
    await expect(s.locator('[data-sec-v="sess"]')).toHaveText(/^剩 11h 2\dm$/);
    expect(await s.locator('[data-sec-open] a.sgx-pop-row').evaluateAll((els) => els.map((e) => e.getAttribute('href'))))
      .toEqual(['/zh/security/lock/', '/zh/security/lock/', '/zh/security/tempkeys/', '/zh/security/', '/zh/security/lock/#lockmgr-sessions']);
    await expect(s).toContainText('LockKey');
    /* 立即锁屏不在盾牌里（Gray 2026-11-08 04:06），只在 NAVIGATE 底部 lock */
    await expect(s.locator('[data-sec="lock"]')).toHaveCount(0);
    await expect(s).not.toContainText('立即锁屏');
    await expect(s.locator('[data-sec-locked]')).toBeHidden();
    await settled(page, 'sgx-sec');
    await page.locator('.sgx-tb-av').click();
    await expect(page.locator('#sgx-acct')).toHaveAttribute('data-state', 'open');
    await expect(s).toBeHidden();
    await expect(page.locator('#sgx-acct[open], #sgx-sec[open], #sgx-qp[open], #sgx-nav[open], #sgx-ai[open]')).toHaveCount(1);
  });

  test('没有验证票：$ SECURITY locked + 终端式「sudo security · [1] passkey [2] lockkey」去锁屏凭证页的门，按 1 也行', async ({ page }) => {
    await go(page, '/zh/wild/');
    await page.route('**/api/lock-reauth', (r) => r.fulfill(json({ ok: true, valid: false })));
    await page.locator('.sgx-tb-shield').click();
    const s = page.locator('#sgx-sec');
    await expect(s).toHaveAttribute('data-sec-state', 'locked');
    await expect(s.locator('[data-sec-head]')).toHaveText('locked');
    await expect(s.locator('[data-sec-locked]')).toContainText('sudo security');
    await expect(s.locator('.sgx-pop-opt[data-key="2"]')).toContainText('lockkey');
    await expect(s.locator('[data-sec-open]')).toBeHidden();
    await settled(page, 'sgx-sec');
    /* Ctrl+C = 返回（同 esc） */
    await page.keyboard.press('Control+c');
    await expect(s).toBeHidden();
    await page.locator('.sgx-tb-shield').click();
    await expect(s).toHaveAttribute('data-sec-state', 'locked');
    await settled(page, 'sgx-sec');
    await page.keyboard.press('1');
    await page.waitForURL(/\/zh\/security\/lock\/$/);
  });

  test('Ctrl 点盾牌不开下拉（照旧按链接走）', async ({ page, context }) => {
    await go(page, '/wild/');
    const pop = context.waitForEvent('page');
    await page.locator('.sgx-tb-shield').click({ modifiers: ['Control'] });
    const np = await pop;
    await np.waitForLoadState('domcontentloaded');
    expect(new URL(np.url()).pathname).toBe('/security/');
    await expect(page.locator('#sgx-sec')).toBeHidden();
  });
});

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
      const sse = 'event: delta\ndata: ' + JSON.stringify({ text: '写过：[博客搬到 Hugo](/blog/post/2026-10-07-navfolio-migration/)' }) + '\n\nevent: done\ndata: {}\n\n';
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
    await expect(ai.locator('.sgx-ai-src')).toContainText('博客搬到 Hugo');
    expect(body.q).toBe('最近在听什么');
    expect(body.model).toBe('gf');
  });
});
