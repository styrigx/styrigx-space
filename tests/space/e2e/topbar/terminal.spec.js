/**
 * 终端（v5 S5 终端合一，term-design-v5；引擎 space/web/assets/shell/js/term/terminal.js，接线 shell/topbar-panel.js）：一个终端、一个会话、一份历史。
 *
 * v5 S7：主页首屏不再嵌终端（换成 neofetch about 卡，提示符跟身份）；主页也用顶栏 >_ / Ctrl K 打开终端窗口（v5 S6）：
 * - 真输入框（有可访问名）+ aria-live=polite 的输出区；欢迎语指向 man（help 删了）；提示符按身份 nobody@space:~$（访客，服务端说了算）
 * - man 索引按身份列、open blog 收起窗口滚到 [01] 博客、未知命令 · 试试 man、↑ / ↓ 历史、tab 补全 + 补全影子、theme <调色板 id>、clear
 * 全站终端窗口（#sgx-term，桌面居中大窗、手机整块卡片）：
 * - /blog/ 上 Ctrl K 打开（提示符 ~/blog$），Esc 关、焦点还回去；NAVIGATE 里的「Ctrl K 终端 ›」也能打开；open 去别的站 = 跳转
 * - su <用户> 在终端里原地选方式（v6 P4 起旧 sudo styrigx 删了）；盾牌 / sgx:sudo 打开终端、预填 su （不替人回车）
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
  if (o.term) await openTerm(page);
}
/** 顶栏 >_ 打开终端窗口（v5 S6） @param {import('@playwright/test').Page} page */
async function openTerm(page) {
  await page.locator('#site-nav .sgx-tb-term').click();
  await expect(page.locator('#sgx-term')).toHaveAttribute('open', '');
  await expect(page.locator('#sgx-term-in')).toBeVisible();
}
const home = (page) => page.locator('#sgx-term');
const input = (page) => page.locator('#sgx-term-in');
async function run(page, line, inp) {
  const i = inp || input(page);
  await i.fill(line);
  await i.press('Enter');
}
const lastLine = (root) => root.locator('[data-term-out] > *').last();

test('主页（v5 S7）：首屏是 neofetch about（提示符跟身份 nobody@space:~$），不再嵌终端；顶栏 >_ 打开终端：真输入框 + 标签、输出区 aria-live=polite；欢迎语指向 man；标题栏和按键提示', async ({ page }) => {
  await go(page, '/zh/');
  await expect(page.locator('[data-sgx-term="home"], #home-term')).toHaveCount(0);
  const nf = page.locator('#home-hero #about');
  await expect(nf).toBeVisible();
  await expect(nf.locator('.sgx-term-title')).toHaveText('about');
  await expect(nf.locator('[data-sgx-ps]')).toHaveText('nobody@space:~$');
  await expect(nf.locator('.trm-cmd')).toHaveText('nobody@space:~$ neofetch');
  await expect(nf.locator('[data-about="version"]')).toContainText('Styrigx UI');
  await expect(nf.locator('[data-about="uptime"]')).toHaveText(/^\d+ days?$/);
  await openTerm(page);
  const t = home(page);
  await expect(input(page)).toHaveAccessibleName('终端命令');
  await expect(input(page)).toHaveAttribute('type', 'text');
  const out = t.locator('[data-term-out]');
  await expect(out).toHaveAttribute('aria-live', 'polite');
  await expect(out).toHaveAttribute('role', 'log');
  await expect(t.locator('[data-term-ps]')).toHaveText('nobody@space:~$');
  await expect(t.locator('[data-term-title]')).toHaveText('nobody@space: ~');
  await expect(out.locator('.sgx-term-ln').first()).toContainText('space os 1.0 — 输入 man 看全部命令，open blog 直接跳过去');
  await expect(out.locator('.sgx-term-help')).toHaveCount(0);
  await page.keyboard.press('Escape');
  /* 首屏：hero 在 about 卡上面，名字 / whoami / 状态胶囊都在 */
  await expect(page.locator('#home-hero .home-who')).toHaveText('$ whoami');
  await expect(page.locator('#home-name')).toHaveText('Sloan Gray');
  await expect(page.locator('#home-hero .home-pill')).toContainText('STATUS: ONLINE');
});

test('提示符按服务端身份（term-design-v5）：访客 nobody@space:~$；cd 后 ~/blog$；账号标记不能把访客变成 root（以服务端为准）', async ({ page }) => {
  await go(page, '/zh/', { term: true });
  const ps = home(page).locator('[data-term-ps]');
  await expect(ps).toHaveText('nobody@space:~$');
  await run(page, 'cd blog');
  await expect(ps).toHaveText('nobody@space:~/blog$');
  await page.evaluate(() => document.documentElement.setAttribute('data-sgx-account-session', 'in'));
  await run(page, 'pwd');
  await expect(ps).toHaveText('nobody@space:~/blog$');
});

test('man（S9 全屏阅读页，less 式）：访客的索引只列通用命令 + find（P4-3 §四 分段，访客层无 sudo）；man sudo 中文正文；q / esc / ‹ 返回 退出，回到原来的命令行，滚动区不动；help 没有了', async ({ page }) => {
  await go(page, '/zh/', { term: true });
  const out = home(page).locator('[data-term-out]');
  const man = home(page).locator('[data-term-man]');
  const body = home(page).locator('[data-term-man-body]');
  const before = await out.locator('.sgx-term-ln').count();
  await run(page, 'man');
  await expect(man).toBeVisible();
  await expect(home(page).locator('[data-term-body]')).toBeHidden();
  await expect(home(page).locator('[data-term-man-st]')).toContainText('MAN(1)');
  await expect(body).toContainText('手册页 · man <命令> 查看一页');
  const lines = await body.locator('.sgx-term-ln').allTextContents();
  const names = lines.filter((l) => / — /.test(l)).map((l) => l.split(' — ')[0]);
  expect(names).toEqual(['man', 'open', 'cd', 'ls', 'cat', 'clear', 'history', 'exit', 'pwd', 'theme', 'find']);
  await page.keyboard.press('q');
  await expect(man).toBeHidden();
  await expect(input(page)).toBeVisible();
  /* 滚动区只多了一行回显（man 的输出不进滚动区） */
  await expect(out.locator('.sgx-term-ln')).toHaveCount(before + 1);
  await expect(lastLine(home(page))).toHaveText('nobody@space:~$ man');
  const ps = home(page).locator('[data-term-ps]');
  await expect(ps).toHaveText('nobody@space:~$');
  await run(page, 'man sudo');
  await expect(home(page).locator('[data-term-man-st]')).toContainText('SUDO(1)');
  await expect(body).toContainText('输自己的凭据，用 root 权限执行一条命令');
  await expect(body).not.toContainText('sudo styrigx');
  /* esc 只退阅读页，不关终端窗口 */
  await page.keyboard.press('Escape');
  await expect(man).toBeHidden();
  await expect(page.locator('#sgx-term')).toHaveAttribute('open', '');
  await run(page, 'man sub');
  await home(page).locator('[data-term-man-back]').click();
  await expect(man).toBeHidden();
  await expect(out.locator('.sgx-term-ln')).toHaveCount(before + 3);
  await expect(out).not.toContainText('(END)');
  await run(page, 'help');
  await expect(lastLine(home(page))).toHaveText('command not found: help · 试试 man');
});

test('cd blog：只改 cwd 和提示符 ~/blog$，不滚动（Gray 2026-11-10 02:11，T6b）；open blog 滚到 [01] 博客（顶栏下面），输出「滚动到 [01] 博客 · 最新 3 篇」；open ~ 回到首屏', async ({ page }) => {
  await go(page, '/zh/', { term: true });
  await run(page, 'cd blog');
  await expect(home(page).locator('[data-term-ps]')).toHaveText('nobody@space:~/blog$');
  await expect(home(page).locator('[data-term-title]')).toHaveText('nobody@space: ~/blog');
  await expect(lastLine(home(page))).toHaveText('nobody@space:~$ cd blog');
  expect(await page.evaluate(() => scrollY), 'cd 不滚动').toBeLessThan(80);
  await run(page, 'open blog');
  await expect(lastLine(home(page))).toHaveText('→ 滚动到 [01] 博客 · 最新 3 篇');
  await expect.poll(() => page.evaluate(() => Math.round(document.getElementById('blog').getBoundingClientRect().top)), { timeout: 3000 }).toBeLessThan(120);
  const top = await page.evaluate(() => document.getElementById('blog').getBoundingClientRect().top);
  const barH = await page.evaluate(() => document.querySelector('.sgx-topbar').getBoundingClientRect().bottom);
  expect(top, '在顶栏下面（不被顶栏挡）').toBeGreaterThanOrEqual(Math.floor(barH));
  /* 博客分节真的有最新几篇（构建期从博客分区取） */
  const posts = page.locator('#blog .home-post');
  expect(await posts.count()).toBeGreaterThan(0);
  expect(await posts.count()).toBeLessThanOrEqual(3);
  await expect(posts.first()).toHaveAttribute('href', /^\/blog\/zh\/post\//);
  /* open blog 收起了终端窗口（v5 S7）：再打开是新会话（S9）——滚动区回到欢迎行、cwd 回到本页 */
  await expect(page.locator('#sgx-term')).not.toHaveAttribute('open', '');
  await openTerm(page);
  await expect(home(page).locator('[data-term-ps]')).toHaveText('nobody@space:~$');
  await expect(home(page).locator('[data-term-out] .sgx-term-ln')).toHaveCount(1);
  await run(page, 'open ~');
  await expect.poll(() => page.evaluate(() => scrollY), { timeout: 3000 }).toBeLessThan(80);
});

test('open blog（不减弱动效）：平滑滚动，最后停在 [01] 博客', async ({ page }) => {
  await go(page, '/zh/', { reduce: false, term: true });
  await run(page, 'open blog');
  await expect.poll(() => page.evaluate(() => Math.round(document.getElementById('blog').getBoundingClientRect().top)), { timeout: 5000 }).toBeLessThan(120);
});

test('未知命令：command not found · 试试 man（出错色）；坏目录 cd 报错、提示符不变', async ({ page }) => {
  await go(page, '/zh/', { term: true });
  await run(page, 'xyzzy now');
  const l = lastLine(home(page));
  await expect(l).toHaveText('command not found: xyzzy · 试试 man');
  await expect(l).toHaveClass(/sgx-term-err/);
  await run(page, 'cd nowhere');
  await expect(lastLine(home(page))).toHaveText('cd: 没有这个目录：nowhere');
  await expect(home(page).locator('[data-term-ps]')).toHaveText('nobody@space:~$');
});

test('历史：↑ / ↓ 翻命令，到底回到正在打的字；clear 清屏', async ({ page }) => {
  await go(page, '/zh/', { term: true });
  await run(page, 'ls');
  await expect(lastLine(home(page))).toHaveText('blog/  curio/  daymark/  account/  proxy/');
  await run(page, 'theme lake');
  const i = input(page);
  await i.fill('ma');
  await i.press('ArrowUp');
  await expect(i).toHaveValue('theme lake');
  await i.press('ArrowUp');
  await expect(i).toHaveValue('ls');
  await i.press('ArrowDown');
  await expect(i).toHaveValue('theme lake');
  await i.press('ArrowDown');
  await expect(i).toHaveValue('ma');
  await i.fill('clear');
  await i.press('Enter');
  await expect(home(page).locator('[data-term-out] > *')).toHaveCount(0);
});

test('tab 补全：hist → history（打字时淡色影子 ory；v6 P4 起 sudo root 删了）；多个候选列出来；空行 Tab 照常移焦点', async ({ page }) => {
  await go(page, '/zh/', { term: true });
  const i = input(page);
  await i.click();
  await i.pressSequentially('hist');
  await expect(home(page).locator('[data-term-ghost]')).toHaveText('ory');
  await expect(home(page).locator('[data-term-ghost]')).toBeVisible();
  await i.press('Tab');
  await expect(i).toHaveValue('history');
  await expect(i).toBeFocused();
  await i.fill('c');
  await i.press('Tab');
  await expect(lastLine(home(page))).toHaveText('cd  cat  clear  ');
  await i.fill('');
  await i.press('Tab');
  await expect(i).not.toBeFocused();
});

test('theme <调色板 id>（调色板 v4）：直接切调色板，深浅跟着变；Tab 补全调色板 id；dark / light 不再认；theme 不带参数打开外观面板', async ({ page }) => {
  await go(page, '/zh/', { term: true });
  await run(page, 'theme sage');
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'sage');
  await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
  await expect(lastLine(home(page))).toHaveText('→ theme → sage');
  await run(page, 'theme lake');
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await run(page, 'theme dark');
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'lake');
  const i = input(page);
  await i.fill('theme gra');
  await i.press('Tab');
  await expect(i).toHaveValue('theme graphite');
  await i.fill('');
  await run(page, 'theme');
  await expect(page.locator('#sgx-qp')).toHaveAttribute('open', '');
});

test('cat daymark/today：测试构建没有日刻接口 → 给日刻链接', async ({ page }) => {
  await go(page, '/zh/', { term: true });
  await run(page, 'cat daymark/today');
  const l = lastLine(home(page));
  await expect(l.locator('a.sgx-term-a')).toHaveAttribute('href', /\/daymark\/zh\/$/);
});

test('主页 Ctrl K（v5 S7 首屏不再嵌终端）：开合终端窗口，同顶栏 >_（aria-expanded 跟着）', async ({ page }) => {
  await go(page, '/zh/');
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('Control+k');
  await expect(page.locator('#sgx-term')).toHaveAttribute('open', '');
  await expect(input(page)).toBeFocused();
  await expect(page.locator('.sgx-tb-term')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Control+k');
  await expect(page.locator('#sgx-term')).not.toHaveAttribute('open', '');
  await expect(page.locator('.sgx-tb-term')).toHaveAttribute('aria-expanded', 'false');
});

test('终端窗口：/blog/ 上 Ctrl K 打开（提示符 ~/blog$），能跑 man；Esc 关；再按 Ctrl K 又开', async ({ page }) => {
  await go(page, '/blog/', { lang: 'en' });
  const dlg = page.locator('#sgx-term');
  await expect(dlg).not.toHaveAttribute('open', '');
  await page.keyboard.press('Control+k');
  await expect(dlg).toHaveAttribute('open', '');
  const inp = page.locator('#sgx-term-in');
  await expect(inp).toBeFocused();
  await expect(inp).toHaveAccessibleName('Terminal command');
  await expect(dlg.locator('[data-term-ps]')).toHaveText('nobody@space:~/blog$');
  await expect(dlg.locator('[data-term-out] .sgx-term-ln').first()).toHaveText('space os 1.0 — type man to see all commands, open blog to jump there');
  await expect(dlg.locator('[data-term-out]')).toHaveAttribute('aria-live', 'polite');
  await run(page, 'pwd', inp);
  await expect(lastLine(dlg)).toHaveText('~/blog');
  await run(page, 'whoops', inp);
  await expect(lastLine(dlg)).toHaveText('command not found: whoops · try man');
  await page.keyboard.press('Escape');
  await expect(dlg).not.toHaveAttribute('open', '');
  await expect(dlg).toHaveAttribute('data-state', 'closed');
  await page.keyboard.press('Control+k');
  await expect(dlg).toHaveAttribute('open', '');
  /* 历史跨开合保留 */
  await inp.press('ArrowUp');
  await expect(inp).toHaveValue('whoops');
  await page.keyboard.press('Escape');
  await expect(dlg).not.toHaveAttribute('open', '');
});

test('抽屉：Esc 关上后马上 Ctrl K 重开，上一次关闭迟到的 close 事件不会把重开的抽屉又关掉', async ({ page }) => {
  /* close 事件是 dialog.close() 后异步派发的；CI 上偶发它晚于重开才到（2026-11-08 main Deploy visual (2)）。
   * 这里把第一次关闭的 close 事件扣住，等重开之后再派发，确定性地复现那个先后顺序。 */
  await go(page, '/blog/', { lang: 'en' });
  const dlg = page.locator('#sgx-term');
  await page.keyboard.press('Control+k');
  await expect(dlg).toHaveAttribute('open', '');
  await dlg.evaluate((d) => {
    const hold = (e) => { d.removeEventListener('close', hold, true); e.stopImmediatePropagation(); window.__heldClose = true; };
    d.addEventListener('close', hold, true);
  });
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveAttribute('data-state', 'closed');
  await expect.poll(() => page.evaluate(() => window.__heldClose === true)).toBe(true);
  await page.keyboard.press('Control+k');
  await expect(dlg).toHaveAttribute('open', '');
  await dlg.evaluate((d) => d.dispatchEvent(new Event('close')));
  await expect(dlg).toHaveAttribute('open', '');
  await expect(dlg).not.toHaveAttribute('data-state', 'closed');
  await expect(page.locator('#sgx-term-in')).toBeFocused();
  /* 历史只多一条哨兵：再 Esc 关掉后回到打开前的那一条 */
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveAttribute('data-state', 'closed');
  await expect.poll(() => page.evaluate(() => history.state)).toBeNull();
});

test('抽屉：NAVIGATE 页脚的「Ctrl K 终端 ›」打开（2026-11 PR-A，原「$ terminal」按钮）；open curio 跳到奇趣（cd 不再跳页，T6b）', async ({ page }) => {
  await go(page, '/zh/status/');
  await page.locator('.sgx-tb-grid').click();
  await expect(page.locator('#sgx-nav')).toHaveAttribute('open', '');
  const btn = page.locator('#sgx-nav [data-qp="term"]');
  await expect(btn).toHaveAccessibleName('终端');
  await btn.click();
  const dlg = page.locator('#sgx-term');
  await expect(dlg).toHaveAttribute('open', '');
  await expect(page.locator('#sgx-nav')).not.toHaveAttribute('open', '');
  await run(page, 'open curio', page.locator('#sgx-term-in'));
  await page.waitForURL(/\/curio\/zh\/$/);
});

test('终端窗口（桌面）：居中大窗 min(1040px, 86vw) × 72vh，和顶栏之间留一截；手机整块卡片（宽 ≤ 820）', async ({ page }) => {
  await go(page, '/blog/', { lang: 'en' });
  await page.keyboard.press('Control+k');
  const box = page.locator('#sgx-term .sgx-term');
  await expect(page.locator('#sgx-term')).toHaveAttribute('open', '');
  await expect.poll(() => box.evaluate((e) => Math.round(e.getBoundingClientRect().width))).toBe(1040);
  const r = await box.evaluate((e) => { const b = e.getBoundingClientRect(); return { x: b.left, w: b.width, h: b.height, top: b.top, bar: document.querySelector('.sgx-topbar').getBoundingClientRect().bottom }; });
  expect(Math.abs(r.x + r.w / 2 - 640)).toBeLessThan(2);
  expect(Math.abs(r.h - 800 * 0.72)).toBeLessThan(2);
  expect(r.top - r.bar).toBeGreaterThanOrEqual(24);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'load' });
  await page.locator('.sgx-tb-grid').click();
  await page.locator('#sgx-nav [data-qp="term"]').click();
  await expect(page.locator('#sgx-term')).toHaveAttribute('open', '');
  const w = await box.evaluate((e) => e.getBoundingClientRect().width);
  expect(w).toBeLessThanOrEqual(390);
});

test('su styrigx 在终端里原地选方式（不跳锁屏；v6 P4 起旧 sudo styrigx 删了）；^C 回命令行；盾牌 = 打开终端、预填 su （不替人回车）', async ({ page }) => {
  await go(page, '/blog/', { lang: 'en' });
  await page.locator('#site-nav .sgx-tb-shield').click();
  const dlg = page.locator('#sgx-term');
  await expect(dlg).toHaveAttribute('open', '');
  const inp = page.locator('#sgx-term-in');
  await expect(inp).toHaveValue('su ');
  await expect(page).toHaveURL(/\/blog\/$/);
  await inp.fill('su styrigx');
  await inp.press('Enter');
  await expect(dlg.locator('[data-term-form]')).toHaveAttribute('data-mode', 'pick');
  await expect(dlg.locator('[data-term-out]')).toContainText('password');
  await inp.press('Control+c');
  await expect(dlg.locator('[data-term-form]')).toHaveAttribute('data-mode', 'cmd');
  await expect(dlg.locator('[data-term-ps]')).toHaveText('nobody@space:~/blog$');
});

test('上锁的地方发 sgx:sudo：打开终端、预填 su ；旧地址 ?entry=1 同（v5 S5 没有锁屏界面）', async ({ page }) => {
  await go(page, '/blog/', { lang: 'en' });
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('sgx:sudo')));
  await expect(page.locator('#sgx-term')).toHaveAttribute('open', '');
  await expect(page.locator('#sgx-term-in')).toHaveValue('su ');
  await go(page, '/zh/?entry=1');
  await expect(page.locator('#sgx-entry')).toHaveCount(0);
  await expect(input(page)).toHaveValue('su ');
});

test('一个会话一份历史：主页终端窗口敲过的命令，/blog/ 的终端窗口里 ↑ 能翻到', async ({ page }) => {
  await go(page, '/zh/', { term: true });
  await run(page, 'pwd');
  await go(page, '/blog/', { lang: 'zh' });
  await page.keyboard.press('Control+k');
  const inp = page.locator('#sgx-term-in');
  await expect(inp).toBeFocused();
  await inp.press('ArrowUp');
  await expect(inp).toHaveValue('pwd');
});

test('每次打开终端都是干净的新会话（S9）：滚动区回到欢迎行、提示符重画、进行中的选择取消；history 照旧；没有标签栏', async ({ page }) => {
  await go(page, '/zh/', { term: true });
  const out = home(page).locator('[data-term-out]');
  await run(page, 'cd blog');
  await run(page, 'ls');
  await run(page, 'su styrigx');
  await expect(home(page).locator('[data-term-form]')).toHaveAttribute('data-mode', 'pick');
  await page.keyboard.press('Control+k');
  await expect(page.locator('#sgx-term')).not.toHaveAttribute('open', '');
  await openTerm(page);
  await expect(home(page).locator('[data-term-form]')).toHaveAttribute('data-mode', 'cmd');
  await expect(out.locator('.sgx-term-ln, .sgx-at-l')).toHaveCount(1);
  await expect(out).toContainText('space os 1.0');
  await expect(home(page).locator('[data-term-ps]')).toHaveText('nobody@space:~$');
  await expect(input(page)).toHaveValue('');
  /* history 还在 */
  await input(page).press('ArrowUp');
  await expect(input(page)).toHaveValue('su styrigx');
  await run(page, 'history');
  await expect(out).toContainText('cd blog');
  await expect(page.locator('#sgx-term [role="tablist"]')).toHaveCount(0);
});

test('Samsung Pass（S9）：空命令行 / [y/N] 时表单里没有用户名字段；输密码时才有（autocomplete=username），回命令行又拿掉', async ({ page }) => {
  await go(page, '/zh/', { term: true });
  const pmu = page.locator('#sgx-term [data-term-pmu]');
  await expect(pmu).toHaveCount(0);
  await expect(input(page)).toHaveAttribute('autocomplete', 'off');
  await expect(input(page)).not.toHaveAttribute('name', /./);
  await run(page, 'su styrigx');
  await expect(home(page).locator('[data-term-form]')).toHaveAttribute('data-mode', 'pick');
  await expect(pmu).toHaveCount(0);
  await expect(page.locator('#sgx-term input[name="username"], #sgx-term input[autocomplete="username"]')).toHaveCount(0);
  await page.keyboard.press('Control+c');
  await expect(home(page).locator('[data-term-form]')).toHaveAttribute('data-mode', 'cmd');
  await expect(pmu).toHaveCount(0);
});

/* 键盘跟随（Gray 2026-11-12 16:37）：手机上键盘弹起时终端窗口缩到键盘上方、输入行贴着键盘，收起恢复；桌面不动。
   假的 VirtualKeyboard API（vk.js 优先用它）驱动键盘高度；触屏用假的 matchMedia('(pointer: coarse)')，同 quick-panel.spec.js 的 AI 窗用例 */
async function fakeTouchKeyboard(page, coarse) {
  await page.addInitScript((c) => {
    const vk = new EventTarget();
    vk.overlaysContent = false;
    vk.boundingRect = { height: 0 };
    Object.defineProperty(navigator, 'virtualKeyboard', { value: vk, configurable: true });
    window.__kb = (h) => { vk.boundingRect = { height: h }; vk.dispatchEvent(new Event('geometrychange')); };
    if (!c) return;
    const mm = window.matchMedia.bind(window);
    const noop = () => {};
    window.matchMedia = (q) => (/pointer:\s*coarse/.test(q) ? { matches: true, media: q, onchange: null, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop } : mm(q));
  }, coarse);
}
const termGeo = (page) => page.evaluate(() => {
  const r = (sel) => document.querySelector(sel).getBoundingClientRect();
  return { vh: window.innerHeight, card: r('#sgx-term .sgx-term').bottom, bar: r('#sgx-term .sgx-term-bar').top, input: r('#sgx-term-in').bottom, tb: r('.sgx-topbar').bottom };
});

test('手机键盘跟随：输入行聚焦、键盘弹起 → 窗口下沿和输入行都在键盘上方，标题栏还在；键盘收起 → 失焦、复位；关窗复位', async ({ page }) => {
  await fakeTouchKeyboard(page, true);
  await go(page, '/zh/status/', { vp: { width: 412, height: 915 } });
  await openTerm(page);
  for (let i = 0; i < 12; i++) await run(page, 'pwd');
  await input(page).click();
  await page.evaluate(() => window.__kb(420));
  await expect(home(page)).toHaveAttribute('data-kb', '');
  const g = await termGeo(page);
  expect(g.card).toBeLessThanOrEqual(g.vh - 420 + 1);
  expect(g.input).toBeLessThanOrEqual(g.vh - 420 + 1);
  expect(g.bar).toBeGreaterThanOrEqual(g.tb);
  /* 键盘几何变了（变高）跟着走 */
  await page.evaluate(() => window.__kb(480));
  const g2 = await termGeo(page);
  expect(g2.input).toBeLessThanOrEqual(g2.vh - 480 + 1);
  /* 系统手势收键盘：输入框失焦，窗口回原位 */
  await page.evaluate(() => window.__kb(0));
  await expect(home(page)).not.toHaveAttribute('data-kb', '');
  expect(await page.evaluate(() => document.activeElement === document.getElementById('sgx-term-in'))).toBe(false);
  /* 再点又跟上；关窗复位 */
  await input(page).click();
  await page.evaluate(() => window.__kb(300));
  await expect(home(page)).toHaveAttribute('data-kb', '');
  await page.keyboard.press('Escape');
  await expect(home(page)).not.toHaveAttribute('data-kb', '');
});

/* 真机（三星）：键盘弹着、输出越来越长 → 窗口一直收在键盘上方，输入行可见，顶栏不出屏（页面不滚） */
test('手机键盘跟随：键盘弹着时输出超过一屏，窗口仍在键盘上方、输入行可见、页面不滚', async ({ page }) => {
  await fakeTouchKeyboard(page, true);
  await go(page, '/zh/status/', { vp: { width: 412, height: 915 } });
  await openTerm(page);
  await input(page).click();
  await page.evaluate(() => window.__kb(420));
  await expect(home(page)).toHaveAttribute('data-kb', '');
  for (let i = 0; i < 30; i++) await run(page, 'pwd');
  await input(page).click();
  const g = await termGeo(page);
  expect(g.card).toBeLessThanOrEqual(g.vh - 420 + 1);
  expect(g.input).toBeLessThanOrEqual(g.vh - 420 + 1);
  expect(g.bar).toBeGreaterThanOrEqual(g.tb);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await page.evaluate(() => { const b = document.querySelector('#sgx-term [data-term-body]'); return b.scrollHeight - b.scrollTop - b.clientHeight; })).toBeLessThanOrEqual(2);
});

/* 真机（三星）：可视区比键盘上沿还小（浏览器缩可视区、不发 geometrychange）→ 按可视区底重算 */
test('手机键盘跟随：可视区缩小（只发 visualViewport resize）时窗口下沿跟着可视区底', async ({ page }) => {
  await fakeTouchKeyboard(page, true);
  await go(page, '/zh/status/', { vp: { width: 412, height: 915 } });
  await openTerm(page);
  for (let i = 0; i < 20; i++) await run(page, 'pwd');
  await input(page).click();
  await page.evaluate(() => window.__kb(300));
  await expect(home(page)).toHaveAttribute('data-kb', '');
  await page.evaluate(() => {
    const vv = window.visualViewport;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => window.innerHeight - 480 });
    vv.dispatchEvent(new Event('resize'));
  });
  await expect.poll(async () => { const g = await termGeo(page); return g.vh - 480 + 1 - g.input; }).toBeGreaterThanOrEqual(0);
  const g = await termGeo(page);
  expect(g.card).toBeLessThanOrEqual(g.vh - 480 + 1);
  expect(g.bar).toBeGreaterThanOrEqual(g.tb);
});

test('桌面（不是触屏）：键盘几何变化不动终端窗口', async ({ page }) => {
  await fakeTouchKeyboard(page, false);
  await go(page, '/zh/status/', { term: true });
  await input(page).click();
  await page.evaluate(() => window.__kb(300));
  await expect(home(page)).not.toHaveAttribute('data-kb', '');
});
