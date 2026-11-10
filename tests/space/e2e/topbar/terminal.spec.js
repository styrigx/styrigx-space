/**
 * 终端（v5 S5 终端合一，term-design-v5；引擎 space/web/assets/js/shell/terminal.js，接线 shell/topbar-panel.js）：一个终端、一个会话、一份历史。
 *
 * 主页首屏嵌入的终端（#home-term）：
 * - 真输入框（有可访问名）+ aria-live=polite 的输出区；欢迎语指向 man（help 删了）；提示符按身份 nobody@space:~$（访客，服务端说了算）
 * - man 索引按身份列、open blog 滚到 [01] 博客、未知命令 · 试试 man、↑ / ↓ 历史、tab 补全 + 补全影子、theme dark / light、clear；Ctrl K 聚焦首屏终端（不开窗口）
 * 全站终端窗口（#sgx-term，桌面居中大窗、手机整块卡片）：
 * - /blog/ 上 Ctrl K 打开（提示符 ~/blog$），Esc 关、焦点还回去；NAVIGATE 里的「Ctrl K 终端 ›」也能打开；open 去别的站 = 跳转
 * - sudo styrigx 在终端里原地选方式；盾牌 / sgx:sudo 打开终端、预填 sudo styrigx（不替人回车）
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

test('主页终端：真输入框 + 标签、输出区 aria-live=polite；欢迎语指向 man（不再自动跑 help）；提示符 nobody@space:~$；标题栏和按键提示', async ({ page }) => {
  await go(page, '/zh/');
  const t = home(page);
  await expect(t).toBeVisible();
  await expect(input(page)).toHaveAccessibleName('终端命令');
  await expect(input(page)).toHaveAttribute('type', 'text');
  const out = t.locator('[data-term-out]');
  await expect(out).toHaveAttribute('aria-live', 'polite');
  await expect(out).toHaveAttribute('role', 'log');
  await expect(t.locator('[data-term-ps]')).toHaveText('nobody@space:~$');
  await expect(t.locator('[data-term-title]')).toHaveText('nobody@space: ~');
  await expect(t.locator('.sgx-term-hint-l')).toHaveText('tab 补全 · ↑ 历史 · Ctrl K 全站呼出');
  await expect(out.locator('.sgx-term-ln').first()).toContainText('space os 1.0 — 输入 man 看全部命令，open blog 直接跳过去');
  await expect(out.locator('.sgx-term-help')).toHaveCount(0);
  /* 首屏：hero 在终端上面，名字 / whoami / 状态胶囊都在 */
  await expect(page.locator('#home-hero .home-who')).toHaveText('$ whoami');
  await expect(page.locator('#home-name')).toHaveText('Sloan Gray');
  await expect(page.locator('#home-hero .home-pill')).toContainText('STATUS: ONLINE');
});

test('提示符按服务端身份（term-design-v5）：访客 nobody@space:~$；cd 后 ~/blog$；账号标记不能把访客变成 root（以服务端为准）', async ({ page }) => {
  await go(page, '/zh/');
  const ps = home(page).locator('[data-term-ps]');
  await expect(ps).toHaveText('nobody@space:~$');
  await run(page, 'cd blog');
  await expect(ps).toHaveText('nobody@space:~/blog$');
  await page.evaluate(() => document.documentElement.setAttribute('data-sgx-account-session', 'in'));
  await run(page, 'pwd');
  await expect(ps).toHaveText('nobody@space:~/blog$');
});

test('man：访客的索引只列通用命令 + find + sudo（不列 ask / lock / share / 账号命令）；man sudo 一页进 pager，q 回命令行；help 没有了', async ({ page }) => {
  await go(page, '/zh/');
  await run(page, 'man');
  const out = home(page).locator('[data-term-out]');
  await expect(out).toContainText('手册页 · man <命令> 查看一页');
  const lines = await out.locator('.sgx-term-ln').allTextContents();
  const names = lines.filter((l) => / — /.test(l) && !/^space os/.test(l)).map((l) => l.split(' — ')[0]);
  expect(names).toEqual(['man', 'open', 'cd', 'ls', 'cat', 'clear', 'history', 'exit', 'pwd', 'theme', 'find', 'sudo']);
  const ps = home(page).locator('[data-term-ps]');
  await expect(ps).toHaveText('nobody@space:~$');
  await run(page, 'man sudo');
  await expect(out).toContainText('SUDO(1)');
  await expect(ps).toHaveText(':');
  await input(page).press('q');
  await expect(ps).toHaveText('nobody@space:~$');
  await run(page, 'help');
  await expect(lastLine(home(page))).toHaveText('command not found: help · 试试 man');
});

test('cd blog：只改 cwd 和提示符 ~/blog$，不滚动（Gray 2026-11-10 02:11，T6b）；open blog 滚到 [01] 博客（顶栏下面），输出「滚动到 [01] 博客 · 最新 3 篇」；open ~ 回到首屏', async ({ page }) => {
  await go(page, '/zh/');
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
  await expect(home(page).locator('[data-term-ps]')).toHaveText('nobody@space:~/blog$');
  await run(page, 'open ~');
  await expect.poll(() => page.evaluate(() => scrollY), { timeout: 3000 }).toBeLessThan(80);
  await run(page, 'cd ..');
  await expect(home(page).locator('[data-term-ps]')).toHaveText('nobody@space:~$');
});

test('open blog（不减弱动效）：平滑滚动，最后停在 [01] 博客', async ({ page }) => {
  await go(page, '/zh/', { reduce: false });
  await run(page, 'open blog');
  await expect.poll(() => page.evaluate(() => Math.round(document.getElementById('blog').getBoundingClientRect().top)), { timeout: 5000 }).toBeLessThan(120);
});

test('未知命令：command not found · 试试 man（出错色）；坏目录 cd 报错、提示符不变', async ({ page }) => {
  await go(page, '/zh/');
  await run(page, 'xyzzy now');
  const l = lastLine(home(page));
  await expect(l).toHaveText('command not found: xyzzy · 试试 man');
  await expect(l).toHaveClass(/sgx-term-err/);
  await run(page, 'cd nowhere');
  await expect(lastLine(home(page))).toHaveText('cd: 没有这个目录：nowhere');
  await expect(home(page).locator('[data-term-ps]')).toHaveText('nobody@space:~$');
});

test('历史：↑ / ↓ 翻命令，到底回到正在打的字；clear 清屏', async ({ page }) => {
  await go(page, '/zh/');
  await run(page, 'ls');
  await expect(lastLine(home(page))).toHaveText('blog/  curio/  daymark/  wild/  account/  proxy/');
  await run(page, 'theme dark');
  const i = input(page);
  await i.fill('ma');
  await i.press('ArrowUp');
  await expect(i).toHaveValue('theme dark');
  await i.press('ArrowUp');
  await expect(i).toHaveValue('ls');
  await i.press('ArrowDown');
  await expect(i).toHaveValue('theme dark');
  await i.press('ArrowDown');
  await expect(i).toHaveValue('ma');
  await i.fill('clear');
  await i.press('Enter');
  await expect(home(page).locator('[data-term-out] > *')).toHaveCount(0);
});

test('tab 补全：sudo ro → sudo root（打字时淡色影子 ot；2026-11-08 sudo account → sudo root）；多个候选列出来；空行 Tab 照常移焦点', async ({ page }) => {
  await go(page, '/zh/');
  const i = input(page);
  await i.click();
  await i.pressSequentially('sudo ro');
  await expect(home(page).locator('[data-term-ghost]')).toHaveText('ot');
  await expect(home(page).locator('[data-term-ghost]')).toBeVisible();
  await i.press('Tab');
  await expect(i).toHaveValue('sudo root');
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
  await go(page, '/zh/wild/');
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

test('sudo styrigx 在终端里原地选方式（不跳锁屏）；^C 回命令行；盾牌 = 打开终端、预填 sudo styrigx（不替人回车）', async ({ page }) => {
  await go(page, '/blog/', { lang: 'en' });
  await page.locator('#site-nav .sgx-tb-shield').click();
  const dlg = page.locator('#sgx-term');
  await expect(dlg).toHaveAttribute('open', '');
  const inp = page.locator('#sgx-term-in');
  await expect(inp).toHaveValue('sudo styrigx');
  await expect(page).toHaveURL(/\/blog\/$/);
  await inp.press('Enter');
  await expect(dlg.locator('[data-term-form]')).toHaveAttribute('data-mode', 'pick');
  await expect(dlg.locator('[data-term-out]')).toContainText('password');
  await inp.press('Control+c');
  await expect(dlg.locator('[data-term-form]')).toHaveAttribute('data-mode', 'cmd');
  await expect(dlg.locator('[data-term-ps]')).toHaveText('nobody@space:~/blog$');
});

test('上锁的地方发 sgx:sudo：打开终端、预填 sudo styrigx；旧地址 ?entry=1 同（v5 S5 没有锁屏界面）', async ({ page }) => {
  await go(page, '/blog/', { lang: 'en' });
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('sgx:sudo')));
  await expect(page.locator('#sgx-term')).toHaveAttribute('open', '');
  await expect(page.locator('#sgx-term-in')).toHaveValue('sudo styrigx');
  await go(page, '/zh/?entry=1');
  await expect(page.locator('#sgx-entry')).toHaveCount(0);
  await expect(input(page)).toHaveValue('sudo styrigx');
});

test('一个会话一份历史：主页首屏终端敲过的命令，/blog/ 的终端窗口里 ↑ 能翻到', async ({ page }) => {
  await go(page, '/zh/');
  await run(page, 'pwd');
  await go(page, '/blog/', { lang: 'zh' });
  await page.keyboard.press('Control+k');
  const inp = page.locator('#sgx-term-in');
  await expect(inp).toBeFocused();
  await inp.press('ArrowUp');
  await expect(inp).toHaveValue('pwd');
});
