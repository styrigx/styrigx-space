/**
 * 主页与门内子页（P4-3 PR-4b：主页和设置合成一页；2026-11 对齐 PR-B：主页回到「主页 / Home」四节，旷野独立成 /wild/）。真实断言（不 mock 自家逻辑）：
 * - 对齐 PR-B 起：主页 = hero + [01] 博客 · [02] 奇趣 · [03] 日刻 · [04] 旷野；没有分类入口；子页 /theme/ /wild/（/security/ 独立页）；下面几行是沿革
 * - 旷野页 /zh/（英文 /，P4-3 PR-4c 起英文默认）：上面名片 / 日刻 / 屏幕时间，下面标题带 + 5 个平铺入口（共享组件 partials/sgx-entries.html，数据 data/space-cats.yaml）：
 *   编号 01–05、圆底图标、名字 + 一行副标题、行间细线、无卡片底；≥ 760 两栏、≥ 1100 三栏（栏间细竖线）；没有账号卡、没有选项组、没有 DeX 双栏
 *   （分类沿革：2026-10-23 PR-E 常规管理 / 辅助功能删除；服务状态从账号页搬来；P4-2c 高级功能删除，「安全与隐私」改名「安全」；
 *    P4-3 PR-4b（Gray 2026-11-07）显示页 /display/ 整页删除，404，不做 301——功能都在快捷面板）
 * - 子页 /theme/ /wild/ 可达、有对应内容（顶栏没有返回键），/security/ 是独立页面（对齐 PR-B 前：/wellbeing/ /about/ /status/）
 * - 旧设置层（原设置首页和全部子页）一律 404，不跳转
 * - 中英双语
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('../helpers/helpers');

/* 入口按数据文件渲染：顺序、名字、副标题都从 data/space-cats.yaml 读（加入口只加一行数据，测试跟着走） */
const yaml = require('js-yaml');
const SPACE = yaml.load(require('fs').readFileSync(require('path').join(__dirname, '..', '..', '..', '..', 'space', 'web', 'data', 'space-cats.yaml'), 'utf8'));
const CATS = SPACE.cats;
/* 名字 / 副标题 / 标题带文字在字符串表 data/i18n/<语言>.yaml 的 spaceCats（语言包化 2026-11-07；英文为底，缺键回退英文） */
const I18N_DIR = require('path').join(__dirname, '..', '..', '..', '..', 'space', 'web', 'data', 'i18n');
const STR = Object.fromEntries(['en', 'zh'].map((l) => [l, yaml.load(require('fs').readFileSync(require('path').join(I18N_DIR, `${l}.yaml`), 'utf8')).spaceCats]));
/** @param {'en'|'zh'} lang @param {string} id 分类 id 或 'band' @param {string} field title / sub / label */
const sc = (lang, id, field) => ((STR[lang][id] || {})[field] != null ? STR[lang][id][field] : STR.en[id][field]);
/* 旧设置层（拼出来，不写成字面量：全仓 git grep 只许历史文档出现旧地址，tests/space/ui/build/space-merge.test.mjs） */
const OLD = '/' + 'settings' + '/';

async function gotoSettings(pg, path) {
  await blockExternalRequests(pg);
  await pg.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(pg.locator('.set-layout, .home-wrap, .wild-wrap').first()).toBeVisible({ timeout: 15000 });
}

/* 2.8.0：2.7.0 起语言跟随浏览器（Playwright 默认 en-US），不钉住会导致
   中文断言被跳到英文页后失败（P4-3 PR-4c 起英文在 /、中文在 /zh/）。按测试意图显式钉住 sgx-lang；
   跟随行为本身由 lang-follow.spec.js 单独覆盖。 */
async function pinLang(pg, lang) {
  await pg.addInitScript((l) => {
    try { localStorage.setItem('sgx-lang', l); } catch (e) {}
  }, lang);
}

/* Mobile（竖屏）：单列 */
test.use({ viewport: { width: 412, height: 915 } });

test('home (mobile, 对齐 PR-B): hero, then [01] blog · [02] curio · [03] daymark · [04] wild in order; no category entries, no account card, no option groups', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/zh/');
  await expect(pg).toHaveTitle('主页 | Styrigx');
  /* 顶栏没有标签，页名标记是「主页」（手机布局不显示） */
  await expect(pg.locator('.sgx-tb-tab')).toHaveCount(0);
  await expect(pg.locator('.sgx-tb-title')).toHaveText('主页');
  // 账户卡在账号页；名字（hero）、屏幕时间小卡保留
  await expect(pg.locator('.sgx-account-card')).toHaveCount(0);
  await expect(pg.locator('#w-profile')).toBeVisible();
  await expect(pg.locator('#w-screen')).toBeVisible();
  /* 分类入口（旧 sgx-entries 平铺行 + 标题带）删除 */
  await expect(pg.locator('#space-entries, .home-wrap .sgx-ents, .home-wrap [aria-label="分类"]')).toHaveCount(0);
  // 四节顺序：hero 在上，[01]–[04] 自上而下
  await expect(pg.locator('.home-sec .home-sec-k')).toHaveText(['[01] // BLOG', '[02] // CURIO', '[03] // DAYMARK', '[04] // WILD']);
  const ys = [];
  for (const id of ['#home-hero', '#blog', '#curio', '#daymark', '#wild']) ys.push((await pg.locator(id).boundingBox()).y);
  expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  // [02] 奇趣三个目录、[04] 旷野三张小卡（手机一栏）
  const dirs = pg.locator('#curio a.home-dir');
  expect(await dirs.evaluateAll((els) => els.map((a) => a.getAttribute('href')))).toEqual(['/curio/zh/finds/', '/curio/zh/devices/', '/curio/zh/games/']);
  const mini = pg.locator('#wild a.home-mini');
  expect(await mini.evaluateAll((els) => els.map((a) => a.getAttribute('href')))).toEqual(['/zh/wild/#screen-time', '/zh/wild/#status', '/zh/wild/#about']);
  await expect(mini.locator('.home-dir-n')).toHaveText(['screen-time', 'status', 'about']);
  expect(await pg.locator('#wild .home-wild').evaluate((ul) => getComputedStyle(ul).gridTemplateColumns.split(' ').length)).toBe(1);
  // 删掉的分类（含显示页、并进旷野的三页）不再有链接；页面上没有任何指向旧设置层的链接
  for (const gone of ['display', 'manage', 'accessibility', 'goodlock', 'advanced', 'apps', 'wellbeing', 'status', 'about']) await expect(pg.locator(`a[href="/${gone}/"], a[href="/zh/${gone}/"]`), gone).toHaveCount(0);
  await expect(pg.locator(`a[href^="${OLD}"], a[href^="/zh${OLD}"]`)).toHaveCount(0);
  // 选项组与 DeX 双栏都不在主页
  await expect(pg.locator('#sg-display, #sg-theme, #sg-wellbeing, #sg-about, #set-cat-nav, .set-col-r')).toHaveCount(0);
});

/* [02] 奇趣目录 / [04] 旷野小卡：手机布局一栏，桌面布局三栏、同一行顶边对齐（对齐 PR-B，设计稿 tb4.html） */
for (const [w, h, cols] of [[412, 900, 1], [1100, 900, 3], [1366, 768, 3]]) {
  test(`home dirs / wild cards: ${w}px wide → ${cols} column(s)`, async ({ page: pg }) => {
    await pg.setViewportSize({ width: w, height: h });
    await pinLang(pg, 'zh');
    await gotoSettings(pg, '/zh/');
    for (const sel of ['#curio .home-dirs', '#wild .home-wild']) {
      const info = await pg.locator(sel).evaluate((ul) => ({
        cols: getComputedStyle(ul).gridTemplateColumns.split(' ').length,
        tops: [...ul.children].map((li) => Math.round(li.getBoundingClientRect().top)),
        n: ul.children.length,
      }));
      expect(info.n, sel).toBe(3);
      expect(info.cols, sel).toBe(cols);
      expect(new Set(info.tops.slice(0, cols)).size, sel + ' 第一行同一高度').toBe(1);
    }
  });
}

test.describe('home (dex)', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('single page: [04] about card is a plain link to /zh/wild/#about, no two-pane', async ({ page: pg }) => {
    await pinLang(pg, 'zh');
    await gotoSettings(pg, '/zh/');
    await expect(pg.locator('#set-cat-nav, .set-dex-cols, #set-panes')).toHaveCount(0);
    await pg.locator('#wild a.home-mini[href="/zh/wild/#about"]').click();
    await pg.waitForURL('**/zh/wild/#about', { timeout: 10000 });
    await expect(pg.locator('#sg-about')).toBeVisible();
  });
});

test('home (en): title Home, sections, wild cards to /wild/#…', async ({ page: pg }) => {
  await pinLang(pg, 'en');
  await gotoSettings(pg, '/');
  await expect(pg).toHaveTitle('Home | Styrigx');
  await expect(pg.locator('.sgx-tb-tab')).toHaveCount(0);
  await expect(pg.locator('.sgx-tb-title')).toHaveText('Home');
  await expect(pg.locator('#space-entries')).toHaveCount(0);
  await expect(pg.locator('.home-sec .home-sec-k')).toHaveText(['[01] // BLOG', '[02] // CURIO', '[03] // DAYMARK', '[04] // WILD']);
  expect(await pg.locator('#wild a.home-mini').evaluateAll((els) => els.map((a) => a.getAttribute('href')))).toEqual(['/wild/#screen-time', '/wild/#status', '/wild/#about']);
  expect(await pg.locator('#curio a.home-dir').evaluateAll((els) => els.map((a) => a.getAttribute('href')))).toEqual(['/curio/finds/', '/curio/devices/', '/curio/games/']);
  await expect(pg.locator('a[href="/display/"]')).toHaveCount(0);
});

/* P4-3 PR-4b（Gray 2026-11-07）：显示页整页删除，不做 301；功能都在快捷面板 */
test('display page is gone: /display/ and /zh/display/ 404 without redirect', async ({ page: pg }) => {
  for (const p of ['/display/', '/zh/display/']) {
    const r = await pg.request.get(p, { maxRedirects: 0 });
    expect(r.status(), p).toBe(404);
  }
  const sm = await (await pg.request.get('/sitemap.xml')).text();
  expect(sm).not.toContain('/display/');
});

test('old settings layer is gone: home and every subpage 404, no redirect', async ({ page: pg }) => {
  const subs = ['', 'theme/', 'wellbeing/', 'about/', 'status/', 'security/', 'security/lock/', 'security/tempkeys/', 'manage/', 'accessibility/', 'apps/', 'search/', 'advanced/', 'goodlock/', 'account/'];
  for (const pre of ['', '/zh']) {
    for (const s of subs) {
      const p = pre + OLD + s;
      const r = await pg.request.get(p, { maxRedirects: 0 });
      expect(r.status(), p).toBe(404);
    }
  }
  const fs = require('fs');
  const path = require('path');
  const rd = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'space', 'web', 'static', '_redirects'), 'utf8');
  expect(rd.includes(OLD)).toBe(false);
  expect(rd).toMatch(/^\/owner\/\s+\/security\/lock\/\s+301$/m);
});

const SUBCHECKS = {
  theme: ['#palette-dots'],
  /* 对齐 PR-B：旷野页 = 屏幕时间 / 服务状态 / 关于本站三窗 */
  wild: ['#wb-card', '#st-root', '#sg-about'],
};
/* 2026-10-23 PR-E / 对齐 PR-B：删掉的设置项（15 分钟提醒随「数字健康不做设置」删除） */
const GONE = {
  theme: ['#theme-previews', '#row-system', '#seg-layout', '#row-lang'],
  wild: ['#well-v-total', '#row-welltip', '#row-reset', '#sg-wellbeing'],
};

for (const c of CATS) {
  if (c.id === 'security') continue; // security 是独立页面，另有测试覆盖
  test(`subpage /${c.id}/: no back button + options`, async ({ page: pg }) => {
    await pinLang(pg, 'zh');
    await gotoSettings(pg, `/zh/${c.id}/`);
    await expect(pg.locator('[data-go-back]'), 'no back button').toHaveCount(0);
    await expect(pg.locator('.sgx-tb-title'), 'capsule title').toHaveText(sc('zh', c.id, 'title'));
    await expect(pg.locator('.subpage-title, [data-subpage-head]'), 'no big title').toHaveCount(0);
    for (const sel of SUBCHECKS[c.id]) {
      await expect(pg.locator(sel), sel).toHaveCount(1);
    }
    for (const sel of GONE[c.id] || []) {
      await expect(pg.locator(sel), `${sel} removed`).toHaveCount(0);
    }
    // noindex
    const robots = await pg.locator('meta[name="robots"]').getAttribute('content');
    expect(robots).toContain('noindex');
  });
}

test('space search removed: no bottom search bar on space pages; old settings search page is gone', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  for (const path of ['/zh/', '/zh/theme/', '/zh/wild/']) {
    await gotoSettings(pg, path);
    await expect(pg.locator('.sgx-cap, #sgx-cap-settings, #sgx-cap-input-setsearch'), path).toHaveCount(0);
    await expect(pg.locator('#setso-page')).toHaveCount(0);
    const i18n = await pg.evaluate(() => JSON.parse(document.getElementById('sgx-i18n-space').textContent));
    expect(i18n.setidx, 'setidx index removed').toBeUndefined();
  }
  for (const p of [OLD + 'search/', '/zh' + OLD + 'search/', '/search-settings/']) {
    const res = await pg.request.get(p, { maxRedirects: 0 });
    expect(res.status(), p).toBe(404);
  }
});

test('subpage: system back returns to the space page', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/zh/');
  await pg.locator('#wild .home-sec-more[href="/zh/wild/"]').click();
  await pg.waitForURL('**/zh/wild/', { timeout: 10000 });
  await pg.goBack();
  await pg.waitForURL((u) => u.pathname === '/zh/', { timeout: 10000 });
});

test('wild #about: neofetch rows (对齐 PR-B，原 /about/ 的版本行)', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/zh/wild/');
  /* 2.8.0：版本号从 data/version.yaml（唯一来源）读取，不再硬编码，版本推进时测试自动跟随 */
  const fs = require('fs');
  const path = require('path');
  const vy = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'space', 'web', 'data', 'version.yaml'), 'utf8');
  const ui = (vy.match(/^ui:\s*"([^"]+)"/m) || [])[1];
  const sgx = (vy.match(/^sgx:\s*"([^"]+)"/m) || [])[1];
  const body = pg.locator('#sg-about');
  await expect(body.locator('[data-about="version"]')).toHaveText(`Styrigx UI ${ui}`);
  await expect(body.locator('[data-about="kernel"]')).toHaveText(`SGX ${sgx}`);
  await expect(body.locator('[data-about="hugo"]')).not.toBeEmpty();
  await expect(body.locator('[data-about="tailwind"]')).toContainText('Tailwind CSS');
  await expect(body.locator('[data-about="build"]')).not.toBeEmpty();
  await expect(body.locator('[data-about="built"]')).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  /* 顺序 OS / Kernel / Host / Hugo / CSS / Build / Built / AI / Repo（设计稿 neofetch）；仓库链接回来了（稿里有 Repo 行） */
  const labels = await body.locator('.wild-info > div:not(.wild-info-h):not(.wild-info-r):not(.wild-info-sw) > dt').allTextContents();
  expect(labels.map((t) => t.trim())).toEqual(['OS', 'Kernel', 'Host', 'Hugo', 'CSS', 'Build', 'Built', 'AI', 'Repo']);
  await expect(body.locator('a[href="https://github.com/styrigx/styrigx-space"]')).toHaveCount(1);
  await expect(pg.locator('#row-reset')).toHaveCount(0);
});

/* 解锁方式入口迁移：从账户卡移到「安全与隐私」第一行 */
test.describe('unlock methods entry relocation', () => {
  test('space home has no orphan #sgx-unlock-link', async ({ page: pg }) => {
    await pinLang(pg, 'zh');
    await gotoSettings(pg, '/zh/');
    await expect(pg.locator('#sgx-unlock-link')).toHaveCount(0);
    /* 切英文再查一遍：后加的 init script 会覆盖前一个的 sgx-lang */
    await pinLang(pg, 'en');
    await gotoSettings(pg, '/');
    await expect(pg.locator('#sgx-unlock-link')).toHaveCount(0);
  });

  test('security page: three entries (owner credential moved to account avatar), no unlock-methods', async ({ page: pg }) => {
    await pinLang(pg, 'zh');
    await blockExternalRequests(pg);
    await pg.goto('/zh/security/', { waitUntil: 'domcontentloaded' });
    await expect(pg.locator('.set-layout').first()).toBeVisible({ timeout: 15000 });
    /* 安全页三项（锁屏凭证/临时钥匙/立即锁定；临时钥匙从账号页搬来）；管理凭证已删除；账号在头像（2026-10-22 从顶栏右圆挪进抽屉头，2026-11-04 P5-1 回到顶栏最右，P4-3 PR-4b 搬进 AI 窗口头部） */
    await expect(pg.locator('#sec-unlock-methods')).toHaveCount(0);
    await expect(pg.locator('#sec-owner-cred')).toHaveCount(0);
    await expect(pg.locator('.sgx-tb-av')).toHaveAttribute('href', '/zh/account/');
    await expect(pg.locator('#sec-mgmt-cred')).toHaveCount(0);
    const lockCred = pg.locator('#sec-lock-cred');
    await expect(lockCred).toHaveCount(1);
    await expect(lockCred).toContainText('锁屏凭证');
    await expect(lockCred).toHaveAttribute('href', '/zh/security/lock/');
    const tk = pg.locator('#sec-tempkeys');
    await expect(tk).toHaveCount(1);
    await expect(tk).toContainText('临时钥匙');
    await expect(tk).toHaveAttribute('href', '/zh/security/tempkeys/');
    const locknow = pg.locator('#sec-locknow');
    await expect(locknow).toHaveCount(1);
    await expect(locknow).toContainText('立即锁定');
  });

  test('security page (en): three entries', async ({ page: pg }) => {
    await pinLang(pg, 'en');
    await blockExternalRequests(pg);
    await pg.goto('/security/', { waitUntil: 'domcontentloaded' });
    await expect(pg.locator('.set-layout').first()).toBeVisible({ timeout: 15000 });
    await expect(pg.locator('#sec-unlock-methods')).toHaveCount(0);
    await expect(pg.locator('#sec-owner-cred')).toHaveCount(0);
    await expect(pg.locator('#sec-lock-cred')).toContainText('Lock screen credentials');
    await expect(pg.locator('#sec-tempkeys')).toContainText('Temporary keys');
    await expect(pg.locator('#sec-tempkeys')).toHaveAttribute('href', '/security/tempkeys/');
    await expect(pg.locator('#sec-locknow')).toContainText('Lock now');
  });
});

/* v1.3 #42 → B2-7 → 2026-10-23 PR-G 七色调色板：22 套一个列表，按 group 分组（冷调 / 自然 / 暖调 / 花色 / 中性），没有单色 / 撞色分页。
   断言分组 + 412 宽每行 4 个 + 末行左对齐 + 选中描边 / 对勾 + 预览卡跟着换 + 键盘可选 + 恢复默认。
   注：像素级视觉基线需在 CI 环境生成，本地环境字体渲染有差异，故此处只做 DOM 断言。 */
test('palette 8-color test state', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/zh/theme/');
  const grid = pg.locator('#palette-dots');
  await expect(grid).toBeVisible();
  const fs = require('fs');
  const path = require('path');
  const yml = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'space', 'web', 'data', 'palettes.yaml'), 'utf8');
  const items = [...yml.matchAll(/^\s*- id: ([a-z]+)\n(?:\s+\w+: .*\n)*?\s+group: ([a-z]+)$/gm)].map((m) => [m[1], m[2]]);
  expect(items.length).toBe(22);
  /* 没有单色 / 撞色分页，没有撞色胶囊 */
  await expect(pg.locator('[data-pal-tab]')).toHaveCount(0);
  await expect(pg.locator('#palette-dots-clash, .swatch-clash')).toHaveCount(0);
  await expect(pg.locator('#sg-theme .text-m-on-surface-variant').first()).toHaveText('背景光晕和按钮、标题、图标一起换色。');
  /* 分组标题 + 每组的色块（顺序 = palettes.yaml） */
  await expect(grid.locator('.pal-group-title')).toHaveText(['冷调', '自然', '暖调', '花色', '中性']);
  const groups = grid.locator('.pal-grid');
  await expect(groups).toHaveCount(5);
  for (const [i, g] of ['cool', 'nature', 'warm', 'floral', 'neutral'].entries()) {
    const want = items.filter((x) => x[1] === g).map((x) => x[0]);
    expect(await groups.nth(i).locator('.pal-tile').evaluateAll((els) => els.map((e) => e.getAttribute('data-palette')))).toEqual(want);
  }
  await expect(grid.locator('.pal-tile')).toHaveCount(22);
  /* 默认 terra（2026-11 PR-A）有「默认」标，初始选中；其他都没选 */
  await expect(grid.locator('.palette-cell:has([data-palette="terra"]) .pal-def')).toHaveText('默认');
  await expect(grid.locator('.pal-def')).toHaveCount(1);
  await expect(grid.locator('.pal-tile[aria-pressed="true"]')).toHaveCount(1);
  await expect(grid.locator('[data-palette="terra"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(grid.locator('.pal-tile[aria-pressed="true"] .pal-check')).toBeVisible();
  /* 412 宽：冷调 6 个排成 4 + 2，末行左对齐；色块是正方形，6 个前景色点 */
  const boxes = await groups.nth(0).locator('.palette-cell').evaluateAll((els) =>
    els.map((el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left) }; })
  );
  const rows = [...new Set(boxes.map((b) => b.top))];
  expect(rows.length).toBe(2);
  expect(boxes.filter((b) => b.top === rows[0]).length).toBe(4);
  expect(Math.abs(boxes[4].left - boxes[0].left)).toBeLessThanOrEqual(2);
  const tb = await grid.locator('.pal-tile').first().boundingBox();
  expect(Math.abs(tb.width - tb.height)).toBeLessThanOrEqual(1);
  await expect(grid.locator('.pal-tile').first().locator('.pal-dots i')).toHaveCount(6);
  /* 预览卡：浅色 / 深色两部小手机（只有文字标签，没有单选、不能点），名字 = 当前色板 */
  const pv = pg.locator('#pal-preview');
  await expect(pv.locator('.pal-mini')).toHaveCount(2);
  await expect(pv.locator('.pal-pv-label')).toHaveText(['浅色', '深色']);
  await expect(pv.locator('input, button, [role="radio"]')).toHaveCount(0);
  await expect(pg.locator('#pal-preview-name')).toHaveText('陶土');
  /* 选山绿：写 sgx-palette、整页换色、预览卡换成山绿的变量；刷新后仍选中 */
  await grid.locator('.pal-tile[data-palette="forest"]').click();
  await expect(pg.locator('html')).toHaveAttribute('data-palette', 'forest');
  await expect(grid.locator('[data-palette="forest"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(grid.locator('[data-palette="terra"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(pg.locator('#pal-preview-name')).toHaveText('山绿');
  expect(await pv.getAttribute('style')).toBe(await grid.locator('[data-palette="forest"]').getAttribute('style'));
  await pg.reload({ waitUntil: 'domcontentloaded' });
  await expect(pg.locator('#palette-dots [data-palette="forest"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(pg.locator('#pal-preview-name')).toHaveText('山绿');
  /* 键盘：焦点到色块、Enter 选中 */
  await pg.locator('#palette-dots [data-palette="cream"]').focus();
  await pg.keyboard.press('Enter');
  await expect(pg.locator('html')).toHaveAttribute('data-palette', 'cream');
  await expect(pg.locator('#palette-dots [data-palette="cream"]')).toHaveAttribute('aria-pressed', 'true');
  /* 恢复默认（标题行右端）：非默认时可点 → 回默认 terra（不存 key）、置灰（aria-disabled，不隐藏）；置灰时点了不动 */
  const rs = pg.locator('#palette-reset');
  await expect(rs).toHaveText('恢复默认');
  await expect(rs).toHaveAttribute('aria-disabled', 'false');
  const title = pg.locator('#sg-theme p.text-sm.font-medium').first();
  const tt = await title.boundingBox();
  const rb = await rs.boundingBox();
  expect(rb.x).toBeGreaterThan(tt.x + tt.width);
  expect(Math.abs(rb.y + rb.height / 2 - (tt.y + tt.height / 2))).toBeLessThanOrEqual(1.5);
  await rs.click();
  await expect(pg.locator('html')).not.toHaveAttribute('data-palette', /.+/);
  expect(await pg.evaluate(() => localStorage.getItem('sgx-palette'))).toBeNull();
  await expect(rs).toHaveAttribute('aria-disabled', 'true');
  await expect(rs).toBeVisible();
  await expect.poll(() => rs.evaluate((el) => Number(getComputedStyle(el).opacity))).toBeLessThan(0.6); /* opacity 有 .15s 过渡 */
  await expect(pg.locator('#palette-dots .pal-tile[aria-pressed="true"]')).toHaveCount(1);
  await expect(pg.locator('#palette-dots [data-palette="terra"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(pg.locator('#pal-preview-name')).toHaveText('陶土');
  await rs.click({ force: true }); /* aria-disabled：强制点一下验证没反应 */
  expect(await pg.evaluate(() => localStorage.getItem('sgx-palette'))).toBeNull();
  await pg.reload({ waitUntil: 'domcontentloaded' });
  await expect(pg.locator('#palette-reset')).toHaveAttribute('aria-disabled', 'true');
});

/* 2026-10-23 PR-G：单色 / 撞色合并，旧的撞色 id x<id> 首屏迁到 <id>（localStorage 也改写），不认识的 id 清掉回默认 */
test('旧撞色 id 迁移：xforest → forest；不认识的 id → 默认 terra', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await pg.addInitScript(() => { try { if (!sessionStorage.getItem('mig')) { localStorage.setItem('sgx-palette', 'xforest'); sessionStorage.setItem('mig', '1'); } } catch (e) {} });
  await gotoSettings(pg, '/zh/theme/');
  await expect(pg.locator('html')).toHaveAttribute('data-palette', 'forest');
  expect(await pg.evaluate(() => localStorage.getItem('sgx-palette'))).toBe('forest');
  await expect(pg.locator('#palette-dots [data-palette="forest"]')).toHaveAttribute('aria-pressed', 'true');
  await pg.evaluate(() => localStorage.setItem('sgx-palette', 'neon'));
  await pg.reload({ waitUntil: 'domcontentloaded' });
  await expect(pg.locator('html')).not.toHaveAttribute('data-palette', /.+/);
  expect(await pg.evaluate(() => localStorage.getItem('sgx-palette'))).toBeNull();
  await expect(pg.locator('#palette-dots [data-palette="terra"]')).toHaveAttribute('aria-pressed', 'true');
});

/* B2-1：诊断留痕已删除——即使 sessionStorage 里残留旧版的留痕/信标，安全与隐私页也不显示跳转日志卡；
   站内跳转不再写留痕 */
test('B2-1 security page: no jump-trace diagnostics', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/zh/theme/');
  await pg.evaluate(() => {
    sessionStorage.setItem('sgx-last-jump', JSON.stringify([{ who: 'navhistory.js:59', reason: 'goback-primary;to=/', at: Date.now(), desktop: false, visibility: 'visible' }]));
    sessionStorage.setItem('sgx-credential-beacon', JSON.stringify({ path: '/security/owner/', at: Date.now() }));
  });
  await pg.goto('/zh/security/', { waitUntil: 'domcontentloaded' });
  await expect(pg.locator('main').first()).toBeVisible({ timeout: 15000 });
  /* C8：原来固定等 500ms；改成等 load（页面模块脚本都执行完，会渲染留痕卡的话此时已渲染） */
  await pg.waitForLoadState('load');
  await expect(pg.locator('#sgx-jump-note')).toHaveCount(0);
  await expect(pg.locator('main')).not.toContainText(/门内跳转|门内页已加载|navhistory\.js|\.js:\d+/);
  /* 站内返回（系统返回）：不再写新的留痕 */
  await pg.evaluate(() => sessionStorage.removeItem('sgx-last-jump'));
  await pg.goBack();
  await pg.waitForURL(/\/theme\/$/, { timeout: 15000 });
  expect(await pg.evaluate(() => sessionStorage.getItem('sgx-last-jump'))).toBeNull();
});

/* P4-2c（2026-11-05）：高级功能分类（原 Good Lock）整个删除：页面 404，没有 301（旧地址见上面「old settings layer is gone」）；
   PR-E 的常规管理 / 辅助功能 / 应用三条旧跳转随设置首页一起删了（PR-4b） */
test('P4-2c Advanced features gone; no redirects to the old settings layer', async ({ page: pg }) => {
  for (const p of ['/advanced/', '/zh/advanced/', '/goodlock/', '/zh/goodlock/']) {
    const r = await pg.request.get(p, { maxRedirects: 0 });
    expect(r.status(), p).toBe(404);
  }
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/zh/');
  await expect(pg.locator('#sg-advanced, #row-datetime, #mod-keys, #row-weather')).toHaveCount(0);
  const fs = require('fs');
  const path = require('path');
  const rd = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'space', 'web', 'static', '_redirects'), 'utf8');
  expect(rd).not.toMatch(/goodlock|advanced|manage|accessibility/);
});

test('wild #screen-time: one screen-time window (this device when signed out), no reminder switch (对齐 PR-B)', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/zh/wild/');
  const card = pg.locator('#wb-card');
  await expect(card).toHaveCount(1);
  await expect(card.locator('.sgx-term-title')).toHaveText('screen-time');
  await expect(card.locator('[data-wb="scope"]')).toHaveText('今天 · 本机');
  await expect(card.locator('[data-wb="total"]')).not.toHaveText('--');
  /* P2-2：卡片带 data-wb-detail，只有 /api/wellbeing 回 detail:true（账号已登录）才换成所有设备 */
  await expect(card).toHaveAttribute('data-wb-root', /.*/);
  await expect(card).toHaveAttribute('data-wb-detail', /.*/);
  /* 15 分钟提醒开关按 Gray 04:01「数字健康不做设置，做成展示页」删除 */
  await expect(pg.locator('#row-welltip, .switch')).toHaveCount(0);
});

test('B2-2 store and its apps are gone; main-site bookmarks are gone too', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await blockExternalRequests(pg);
  await pg.goto('/zh/', { waitUntil: 'domcontentloaded' });
  await expect(pg.locator('#home-hero')).toBeVisible({ timeout: 15000 });
  for (const sel of ['[data-dock="store"]', '[data-navpage="store"]', 'a[href="/store/"]', 'a[href="/ai/"]', 'a[href="/books/"]', 'a[href="/music/"]', 'a[href="/goodlock/"]', '#np-widget', '#books', '#music', '[data-appid]']) {
    await expect(pg.locator(sel), sel).toHaveCount(0);
  }
  /* 2026-10-19：Dock 已全部删除 */
  for (const sel of ['#mobile-dock', '#dex-dock', '#dex-drawer']) await expect(pg.locator(sel), sel).toHaveCount(0);
  for (const p of ['/store/', '/ai/', '/books/', '/music/']) {
    const r = await pg.request.get(p);
    expect(r.status(), p).toBe(404);
  }
  const idx = await (await pg.request.get('/files-index.json')).json();
  const bad = idx.items.filter((it) => it.type === 'book' || it.type === 'music' || /\/(store|ai|books|music)\//.test(it.url || ''));
  expect(bad).toEqual([]);
  // 2026-10-21：主站书签下线 —— 索引里没有书签（type=link）和书签 App
  expect(idx.items.filter((it) => it.type === 'link' || /\/bookmarks\//.test(it.url || ''))).toEqual([]);
  // 2026-10-22：主站不再顺带博客文章（博客自己写搜索索引 site:blog）—— 索引里没有 type=post
  expect(idx.items.filter((it) => it.type === 'post')).toEqual([]);
});

/* B2-4：设置里的「应用」整块删除（重置所有设置 2026-10-23 PR-E 随常规管理一起删除） */
test('B2-4 space has no Apps category; no reset-all-settings row anywhere', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/zh/');
  const hrefs = await pg.locator('.home-wrap a').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
  expect(hrefs).not.toContain('/apps/');
  await expect(pg.locator('#sg-apps, #row-app-files, #row-app-browser')).toHaveCount(0);
  await expect(pg.locator('#row-reset')).toHaveCount(0);
  await expect(pg.locator('body')).not.toContainText('重置所有设置');
});

test('No top-bar menu; Security has no privacy group or search engine row (P4-2c)', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await blockExternalRequests(pg);
  await pg.goto('/zh/', { waitUntil: 'domcontentloaded' });
  await expect(pg.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
  await expect(pg.locator('#brw-more, .sgx-tb-more')).toHaveCount(0);
  await gotoSettings(pg, '/zh/security/');
  await expect(pg.locator('.sgx-tb-title')).toHaveText('安全');
  await expect(pg.locator('#sec-engine')).toHaveCount(0);
  await expect(pg.locator('main')).not.toContainText('搜索引擎');
});
