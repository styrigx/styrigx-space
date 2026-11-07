/**
 * 站内终端（2026-11 UI 重设计 PR-2，设计稿 term-v1；引擎 space/web/assets/js/shell/terminal.js，接线 shell/topbar-panel.js）。
 *
 * 主页首屏嵌入的终端（#home-term）：
 * - 真输入框（有可访问名）+ aria-live=polite 的输出区；打开时自动跑过一次 help；提示符 guest@space:~$
 * - help（桌面三栏带说明 / 手机两栏不带说明）、cd blog 平滑滚到 [01] 博客（减弱动效直接跳）且提示符变 ~/blog$、未知命令、↑ / ↓ 历史、tab 补全 + 补全影子、
 *   theme dark / light、clear；Ctrl K 聚焦首屏终端（不开抽屉）
 * 全站抽屉（#sgx-term）：
 * - /blog/ 上 Ctrl K 打开（提示符 ~/blog$），Esc 关、焦点还回去；NAVIGATE 里的「$ terminal」也能打开；cd 去别的站 = 跳转
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('../helpers/helpers');

async function go(page, path, o = {}) {
  await page.setViewportSize(o.vp || { width: 1280, height: 800 });
  await page.addInitScript((ln) => { try { localStorage.setItem('sgx-lang', ln); } catch (e) {} }, o.lang || 'zh');
  await blockExternalRequests(page);
  await freezeTime(page);
  if (o.reduce !== false) await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
  await page.waitForLoadState('load');
}
const home = (page) => page.locator('#home-term');
const input = (page) => page.locator('#home-term-in');
async function run(page, line, inp) {
  const i = inp || input(page);
  await i.fill(line);
  await i.press('Enter');
}
const lastLine = (root) => root.locator('[data-term-out] > *').last();

test('主页终端：真输入框 + 标签、输出区 aria-live=polite；自动跑过 help；提示符 guest@space:~$；标题栏和按键提示', async ({ page }) => {
  await go(page, '/zh/');
  const t = home(page);
  await expect(t).toBeVisible();
  await expect(input(page)).toHaveAccessibleName('终端命令');
  await expect(input(page)).toHaveAttribute('type', 'text');
  const out = t.locator('[data-term-out]');
  await expect(out).toHaveAttribute('aria-live', 'polite');
  await expect(out).toHaveAttribute('role', 'log');
  await expect(t.locator('[data-term-ps]')).toHaveText('guest@space:~$');
  await expect(t.locator('[data-term-title]')).toHaveText('guest@space: ~');
  await expect(t.locator('.sgx-term-hint-l')).toHaveText('tab 补全 · ↑ 历史 · Ctrl K 全站呼出');
  await expect(out.locator('.sgx-term-ln').first()).toContainText('space os 1.0 — 输入 help 看全部命令，cd blog 直接跳过去');
  await expect(out.locator('.sgx-term-cmd').first()).toHaveText('guest@space:~$ help');
  await expect(out.locator('.sgx-term-help')).toHaveCount(1);
  /* 首屏：hero 在终端上面，名字 / whoami / 状态胶囊都在 */
  await expect(page.locator('#home-hero .home-who')).toHaveText('$ whoami');
  await expect(page.locator('#home-name')).toHaveText('Sloan Gray');
  await expect(page.locator('#home-hero .home-pill')).toContainText('STATUS: ONLINE');
});

test('help：桌面三栏、带说明；cd 一行在最上面', async ({ page }) => {
  await go(page, '/zh/');
  await run(page, 'help');
  const h = home(page).locator('.sgx-term-help').last();
  await expect(home(page).locator('.sgx-term-help')).toHaveCount(2);
  await expect(h.locator('.sgx-term-hh')).toHaveText('cd blog · curio · daymark · wild · ~');
  await expect(h.locator(':scope > div:not(.sgx-term-hh) > .sgx-term-k')).toHaveText(['ls', 'cat', 'sudo account', 'sudo security', 'theme', 'lock', 'ask', 'clear']);
  await expect(h.locator('.sgx-term-dsc').first()).toBeVisible();
  await expect(h.locator('.sgx-term-dsc').first()).toHaveText(' 列出目录');
  const cols = await h.evaluate((e) => getComputedStyle(e).gridTemplateColumns.split(' ').length);
  expect(cols).toBe(3);
});

test('help（手机）：两栏，不显示说明', async ({ page }) => {
  await go(page, '/zh/', { vp: { width: 390, height: 844 } });
  const h = home(page).locator('.sgx-term-help').first();
  await expect(h).toBeVisible();
  expect(await h.evaluate((e) => getComputedStyle(e).gridTemplateColumns.split(' ').length)).toBe(2);
  await expect(h.locator('.sgx-term-dsc').first()).toBeHidden();
  /* 手机标题栏只显示短提示 */
  await expect(home(page).locator('.sgx-term-hint-s')).toBeVisible();
  await expect(home(page).locator('.sgx-term-hint-l')).toBeHidden();
});

test('cd blog：滚到 [01] 博客（顶栏下面），提示符 ~/blog$，输出「滚动到 [01] 博客 · 最新 3 篇」；cd .. 回到首屏', async ({ page }) => {
  await go(page, '/zh/');
  await run(page, 'cd blog');
  await expect(lastLine(home(page))).toHaveText('→ 滚动到 [01] 博客 · 最新 3 篇');
  await expect(home(page).locator('[data-term-ps]')).toHaveText('guest@space:~/blog$');
  await expect(home(page).locator('[data-term-title]')).toHaveText('guest@space: ~/blog');
  await expect.poll(() => page.evaluate(() => Math.round(document.getElementById('blog').getBoundingClientRect().top)), { timeout: 3000 }).toBeLessThan(120);
  const top = await page.evaluate(() => document.getElementById('blog').getBoundingClientRect().top);
  expect(top, '在顶栏下面（不被顶栏挡）').toBeGreaterThanOrEqual(64);
  /* 博客分节真的有最新几篇（构建期从博客分区取） */
  const posts = page.locator('#blog .home-post');
  expect(await posts.count()).toBeGreaterThan(0);
  expect(await posts.count()).toBeLessThanOrEqual(3);
  await expect(posts.first()).toHaveAttribute('href', /^\/blog\/zh\/post\//);
  await run(page, 'cd ..');
  await expect(home(page).locator('[data-term-ps]')).toHaveText('guest@space:~$');
  await expect.poll(() => page.evaluate(() => scrollY), { timeout: 3000 }).toBeLessThan(80);
});

test('cd blog（不减弱动效）：平滑滚动，最后停在 [01] 博客', async ({ page }) => {
  await go(page, '/zh/', { reduce: false });
  await run(page, 'cd blog');
  await expect.poll(() => page.evaluate(() => Math.round(document.getElementById('blog').getBoundingClientRect().top)), { timeout: 5000 }).toBeLessThan(120);
});

test('未知命令：command not found · 试试 help（出错色）；坏目录 cd 报错、提示符不变', async ({ page }) => {
  await go(page, '/zh/');
  await run(page, 'xyzzy now');
  const l = lastLine(home(page));
  await expect(l).toHaveText('command not found: xyzzy · 试试 help');
  await expect(l).toHaveClass(/sgx-term-err/);
  await run(page, 'cd nowhere');
  await expect(lastLine(home(page))).toHaveText('cd: 没有这个目录：nowhere');
  await expect(home(page).locator('[data-term-ps]')).toHaveText('guest@space:~$');
});

test('历史：↑ / ↓ 翻命令，到底回到正在打的字；clear 清屏', async ({ page }) => {
  await go(page, '/zh/');
  await run(page, 'ls');
  await expect(lastLine(home(page))).toHaveText('blog/  curio/  daymark/  wild/');
  await run(page, 'theme dark');
  const i = input(page);
  await i.fill('he');
  await i.press('ArrowUp');
  await expect(i).toHaveValue('theme dark');
  await i.press('ArrowUp');
  await expect(i).toHaveValue('ls');
  await i.press('ArrowDown');
  await expect(i).toHaveValue('theme dark');
  await i.press('ArrowDown');
  await expect(i).toHaveValue('he');
  await i.fill('clear');
  await i.press('Enter');
  await expect(home(page).locator('[data-term-out] > *')).toHaveCount(0);
});

test('tab 补全：sudo acc → sudo account（打字时淡色影子 ount）；多个候选列出来；空行 Tab 照常移焦点', async ({ page }) => {
  await go(page, '/zh/');
  const i = input(page);
  await i.click();
  await i.pressSequentially('sudo acc');
  await expect(home(page).locator('[data-term-ghost]')).toHaveText('ount');
  await expect(home(page).locator('[data-term-ghost]')).toBeVisible();
  await i.press('Tab');
  await expect(i).toHaveValue('sudo account');
  await expect(i).toBeFocused();
  await i.fill('c');
  await i.press('Tab');
  await expect(lastLine(home(page))).toHaveText('cd  cat  clear  ');
  await i.fill('');
  await i.press('Tab');
  await expect(i).not.toBeFocused();
});

test('theme dark / light：直接切深浅色；theme 不带参数打开外观面板', async ({ page }) => {
  await go(page, '/zh/');
  await run(page, 'theme dark');
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await expect(lastLine(home(page))).toHaveText('→ theme → dark');
  await run(page, 'theme light');
  await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
  await run(page, 'theme');
  await expect(page.locator('#sgx-qp')).toHaveAttribute('open', '');
});

test('cat daymark/today：测试构建没有日刻接口 → 给日刻链接', async ({ page }) => {
  await go(page, '/zh/');
  await run(page, 'cat daymark/today');
  const l = lastLine(home(page));
  await expect(l.locator('a.sgx-term-a')).toHaveAttribute('href', /\/daymark\/zh\/$/);
});

test('主页 Ctrl K：聚焦首屏终端（滚回来），不开抽屉', async ({ page }) => {
  await go(page, '/zh/');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('Control+k');
  await expect(input(page)).toBeFocused();
  await expect(page.locator('#sgx-term')).not.toHaveAttribute('open', '');
  await expect.poll(() => input(page).evaluate((e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })).toBe(true);
});

test('抽屉：/blog/ 上 Ctrl K 打开（提示符 ~/blog$），能跑 help；Esc 关；再按 Ctrl K 又开', async ({ page }) => {
  await go(page, '/blog/', { lang: 'en' });
  const dlg = page.locator('#sgx-term');
  await expect(dlg).not.toHaveAttribute('open', '');
  await page.keyboard.press('Control+k');
  await expect(dlg).toHaveAttribute('open', '');
  const inp = page.locator('#sgx-term-in');
  await expect(inp).toBeFocused();
  await expect(inp).toHaveAccessibleName('Terminal command');
  await expect(dlg.locator('[data-term-ps]')).toHaveText('guest@space:~/blog$');
  await expect(dlg.locator('[data-term-out]')).toHaveAttribute('aria-live', 'polite');
  await run(page, 'help', inp);
  await expect(dlg.locator('.sgx-term-help')).toHaveCount(1);
  await run(page, 'whoops', inp);
  await expect(lastLine(dlg)).toHaveText('command not found: whoops · try help');
  await page.keyboard.press('Escape');
  await expect(dlg).not.toHaveAttribute('open', '');
  await page.keyboard.press('Meta+k');
  await expect(dlg).toHaveAttribute('open', '');
  /* 历史跨开合保留 */
  await inp.press('ArrowUp');
  await expect(inp).toHaveValue('whoops');
  await page.keyboard.press('Escape');
  await expect(dlg).not.toHaveAttribute('open', '');
});

test('抽屉：NAVIGATE 里的「$ terminal」打开；cd curio 跳到奇趣', async ({ page }) => {
  await go(page, '/zh/theme/');
  await page.locator('.sgx-tb-grid').click();
  await expect(page.locator('#sgx-nav')).toHaveAttribute('open', '');
  const btn = page.locator('#sgx-nav [data-qp="term"]');
  await expect(btn).toHaveAccessibleName('终端');
  await btn.click();
  const dlg = page.locator('#sgx-term');
  await expect(dlg).toHaveAttribute('open', '');
  await expect(page.locator('#sgx-nav')).not.toHaveAttribute('open', '');
  await run(page, 'cd curio', page.locator('#sgx-term-in'));
  await page.waitForURL(/\/curio\/zh\/$/);
});
