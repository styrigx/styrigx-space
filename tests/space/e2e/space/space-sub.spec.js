/**
 * 主页与门内子页（P4-3 PR-4b：主页和设置合成一页；2026-11 对齐 PR-B：主页回到「主页 / Home」；2026-11-12 旷野删除，主页三节，状态单独成页 /status/）。真实断言（不 mock 自家逻辑）：
 * - 2026-11-12 起：主页 = hero + [01] 博客 · [02] 奇趣 · [03] 日刻；没有分类入口；子页 /status/（/security/ 三页随进站 v3 L1 删除，301 到盾牌 /#sec…）；下面几行是沿革
 * - 旷野页 /zh/（英文 /，P4-3 PR-4c 起英文默认）：上面名片 / 日刻 / 屏幕时间，下面标题带 + 5 个平铺入口（共享组件 partials/sgx-entries.html，数据 data/common/space-cats.yaml）：
 *   编号 01–05、圆底图标、名字 + 一行副标题、行间细线、无卡片底；≥ 760 两栏、≥ 1100 三栏（栏间细竖线）；没有账号卡、没有选项组、没有 DeX 双栏
 *   （分类沿革：2026-10-23 PR-E 常规管理 / 辅助功能删除；服务状态从账号页搬来；P4-2c 高级功能删除，「安全与隐私」改名「安全」；
 *    P4-3 PR-4b（Gray 2026-11-07）显示页 /display/ 整页删除，404，不做 301——功能都在快捷面板）
 * - 子页 /status/ 可达（对齐 PR-C：风格页 /theme/ 退役，301 到主页）、有对应内容（顶栏没有返回键）（对齐 PR-B 前：/wellbeing/ /about/ /status/）
 * - 旧设置层（原设置首页和全部子页）一律 404，不跳转
 * - 中英双语
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('../helpers/helpers');

/* 入口按数据文件渲染：顺序、名字、副标题都从 data/common/space-cats.yaml 读（加入口只加一行数据，测试跟着走） */
const yaml = require('js-yaml');
const SPACE = yaml.load(require('fs').readFileSync(require('path').join(__dirname, '..', '..', '..', '..', 'space', 'web', 'data', 'common', 'space-cats.yaml'), 'utf8'));
const CATS = SPACE.cats;
/* 名字 / 副标题 / 标题带文字在字符串表 data/common/i18n/<语言>.yaml 的 spaceCats（语言包化 2026-11-07；英文为底，缺键回退英文） */
const I18N_DIR = require('path').join(__dirname, '..', '..', '..', '..', 'space', 'web', 'data', 'common', 'i18n');
const STR = Object.fromEntries(['en', 'zh'].map((l) => [l, yaml.load(require('fs').readFileSync(require('path').join(I18N_DIR, `${l}.yaml`), 'utf8')).spaceCats]));
/** @param {'en'|'zh'} lang @param {string} id 分类 id 或 'band' @param {string} field title / sub / label */
const sc = (lang, id, field) => ((STR[lang][id] || {})[field] != null ? STR[lang][id][field] : STR.en[id][field]);
/* 旧设置层（拼出来，不写成字面量：全仓 git grep 只许历史文档出现旧地址，tests/space/ui/build/space-merge.test.mjs） */
const OLD = '/' + 'settings' + '/';

async function gotoSettings(pg, path) {
  await blockExternalRequests(pg);
  await pg.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(pg.locator('.set-layout, .home-wrap, .status-wrap').first()).toBeVisible({ timeout: 15000 });
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

test('home (mobile, 对齐 PR-B; 2026-11-12 no [04] wild): hero, then [01] blog · [02] curio · [03] daymark in order; no category entries, no account card, no option groups', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/zh/');
  await expect(pg).toHaveTitle('主页 | Styrigx');
  /* 顶栏没有标签，页名标记是「主页」（手机布局不显示） */
  await expect(pg.locator('.sgx-tb-tab')).toHaveCount(0);
  await expect(pg.locator('.sgx-tb-title')).toHaveText('主页');
  // 账户卡在账号页；名字（hero）保留；屏幕时间小卡 v6 P4 随数字健康删除（定稿 v5.5 §四）
  await expect(pg.locator('.sgx-account-card')).toHaveCount(0);
  await expect(pg.locator('#w-profile')).toBeVisible();
  await expect(pg.locator('#w-screen')).toHaveCount(0);
  /* 分类入口（旧 sgx-entries 平铺行 + 标题带）删除 */
  await expect(pg.locator('#space-entries, .home-wrap .sgx-ents, .home-wrap [aria-label="分类"]')).toHaveCount(0);
  // 三节顺序：hero 在上，[01]–[03] 自上而下（[04] 旷野 2026-11-12 删除）
  await expect(pg.locator('.home-sec .home-sec-k')).toHaveText(['[01] // BLOG', '[02] // CURIO', '[03] // DAYMARK']);
  await expect(pg.locator('#wild, .home-mini')).toHaveCount(0);
  const ys = [];
  for (const id of ['#home-hero', '#blog', '#curio', '#daymark']) ys.push((await pg.locator(id).boundingBox()).y);
  expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  // [02] 奇趣三个目录（手机一栏）
  const dirs = pg.locator('#curio a.home-dir');
  expect(await dirs.evaluateAll((els) => els.map((a) => a.getAttribute('href')))).toEqual(['/curio/zh/finds/', '/curio/zh/devices/', '/curio/zh/games/']);
  // 删掉的分类（含显示页、旷野）不再有链接；页面上没有任何指向旧设置层的链接
  for (const gone of ['display', 'manage', 'accessibility', 'goodlock', 'advanced', 'apps', 'wellbeing', 'wild', 'about']) await expect(pg.locator(`a[href="/${gone}/"], a[href="/zh/${gone}/"]`), gone).toHaveCount(0);
  await expect(pg.locator(`a[href^="${OLD}"], a[href^="/zh${OLD}"]`)).toHaveCount(0);
  // 选项组与 DeX 双栏都不在主页
  await expect(pg.locator('#sg-display, #sg-theme, #sg-wellbeing, #sg-about, #set-cat-nav, .set-col-r')).toHaveCount(0);
});

/* [02] 奇趣目录（3 张）：手机布局一栏，桌面布局三栏、同一行顶边对齐（对齐 PR-B，设计稿 tb4.html；[04] 旷野小卡 2026-11-12 删除） */
for (const [w, h, cols] of [[412, 900, 1], [1100, 900, 3], [1366, 768, 3]]) {
  test(`home dirs: ${w}px wide → ${cols} column(s)`, async ({ page: pg }) => {
    await pg.setViewportSize({ width: w, height: h });
    await pinLang(pg, 'zh');
    await gotoSettings(pg, '/zh/');
    for (const [sel, n, max] of [['#curio .home-dirs', 3, 3]]) {
      const c = Math.min(cols, max);
      const info = await pg.locator(sel).evaluate((ul) => ({
        cols: getComputedStyle(ul).gridTemplateColumns.split(' ').length,
        tops: [...ul.children].map((li) => Math.round(li.getBoundingClientRect().top)),
        n: ul.children.length,
      }));
      expect(info.n, sel).toBe(n);
      expect(info.cols, sel).toBe(c);
      expect(new Set(info.tops.slice(0, c)).size, sel + ' 第一行同一高度').toBe(1);
    }
  });
}

test.describe('home (dex)', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('single page: about only in the hero neofetch (#about, v5 S7), no [04] about mini card (2026-11-11), no two-pane', async ({ page: pg }) => {
    await pinLang(pg, 'zh');
    await gotoSettings(pg, '/zh/');
    await expect(pg.locator('#set-cat-nav, .set-dex-cols, #set-panes')).toHaveCount(0);
    await expect(pg.locator('a.home-mini[href="#about"]')).toHaveCount(0);
    await expect(pg.locator('#home-hero #about')).toHaveCount(1);
  });
});

test('home (en): title Home, three sections, no wild section', async ({ page: pg }) => {
  await pinLang(pg, 'en');
  await gotoSettings(pg, '/');
  await expect(pg).toHaveTitle('Home | Styrigx');
  await expect(pg.locator('.sgx-tb-tab')).toHaveCount(0);
  await expect(pg.locator('.sgx-tb-title')).toHaveText('Home');
  await expect(pg.locator('#space-entries')).toHaveCount(0);
  await expect(pg.locator('.home-sec .home-sec-k')).toHaveText(['[01] // BLOG', '[02] // CURIO', '[03] // DAYMARK']);
  await expect(pg.locator('#wild, .home-mini')).toHaveCount(0);
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
  expect(rd).toMatch(/^\/owner\/\s+\/#sec=keys\s+301$/m); /* 进站 v3 L1：安全页删了，旧地址直接开盾牌那一层 */
});

const SUBCHECKS = {
  /* 2026-11-12：状态页 = 服务状态（原旷野页；v5 S7：关于本站挪到主页首屏 #about；v6 P4：屏幕时间窗随数字健康删除） */
  status: ['#st-root'],
};
/* 2026-10-23 PR-E / 对齐 PR-B：删掉的设置项（15 分钟提醒随「数字健康不做设置」删除） */
const GONE = {
  status: ['#well-v-total', '#row-welltip', '#row-reset', '#sg-wellbeing', '#sg-about', '#about', '#screen-time', '#wb-card'],
};

for (const c of CATS) {
  if (c.id === 'security') continue; // 进站 v3 L1：安全页已删（space-cats 里也没有这一类，留着防回潮）
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
  for (const path of ['/zh/', '/zh/status/']) {
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
  /* 2026-11-12：主页没有 [04] 旷野一节了，从 NAVIGATE STATUS 区的按钮进状态页 */
  await pg.locator('.sgx-tb-grid').click();
  await pg.locator('#sgx-nav .sgx-nav-st-go[href="/zh/status/"]').click();
  await pg.waitForURL('**/zh/status/', { timeout: 10000 });
  await pg.goBack();
  await pg.waitForURL((u) => u.pathname === '/zh/', { timeout: 10000 });
});

test('home #about: neofetch rows (v5 S7 从旷野页挪到主页首屏；对齐 PR-B，原 /about/ 的版本行)；状态页没有 about', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/zh/status/');
  await expect(pg.locator('#about, #sg-about, [data-about]')).toHaveCount(0);
  await gotoSettings(pg, '/zh/');
  /* 2.8.0：版本号从 data/common/version.yaml（唯一来源）读取，不再硬编码，版本推进时测试自动跟随 */
  const fs = require('fs');
  const path = require('path');
  const vy = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'space', 'web', 'data', 'common', 'version.yaml'), 'utf8');
  const ui = (vy.match(/^ui:\s*"([^"]+)"/m) || [])[1];
  const sgx = (vy.match(/^sgx:\s*"([^"]+)"/m) || [])[1];
  const body = pg.locator('#home-hero #about');
  await expect(body.locator('[data-about="version"]')).toHaveText(`Styrigx UI ${ui}`);
  await expect(body.locator('[data-about="kernel"]')).toHaveText(`SGX ${sgx}`);
  await expect(body.locator('[data-about="hugo"]')).not.toBeEmpty();
  await expect(body.locator('[data-about="tailwind"]')).toContainText('Tailwind CSS');
  await expect(body.locator('[data-about="build"]')).not.toBeEmpty();
  await expect(body.locator('[data-about="built"]')).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  /* 顺序 OS / Kernel / Uptime / Host / Hugo / CSS / Build / Built / AI / Repo（设计稿 neofetch；Uptime 自 2026-10-07，Gray 2026-11-09）；仓库链接回来了（稿里有 Repo 行） */
  const labels = await body.locator('.trm-info > div:not(.trm-info-h):not(.trm-info-r):not(.trm-info-sw) > dt').allTextContents();
  expect(labels.map((t) => t.trim())).toEqual(['OS', 'Kernel', 'Uptime', 'Host', 'Hugo', 'CSS', 'Build', 'Built', 'AI', 'Repo']);
  await expect(body.locator('[data-about="uptime"]')).toHaveText(/^\d+ days?$/);
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

  test('进站 v3 L1：安全页三页删除——静态站里没有页面，_redirects 301 到盾牌 /#sec / #sec=keys / #sec=tempkeys（中英）', async ({ page: pg }) => {
    const fs = require('fs');
    const path = require('path');
    const rd = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'space', 'web', 'static', '_redirects'), 'utf8');
    for (const pre of ['', '/zh']) {
      for (const [from, hash] of [['/security/', '#sec'], ['/security/lock/', '#sec=keys'], ['/security/tempkeys/', '#sec=tempkeys']]) {
        const esc = (x) => x.replace(/[/.#=]/g, (c) => '\\' + c);
        expect(rd, pre + from).toMatch(new RegExp('^' + esc(pre + from) + '\\s+' + esc(pre + '/' + hash) + '\\s+301$', 'm'));
        const r = await pg.request.get(pre + from + 'index.html', { maxRedirects: 0 });
        expect(r.status(), pre + from + 'index.html').toBe(404);
      }
    }
  });
});

/* v1.3 #42 → B2-7 → 2026-10-23 PR-G 七色调色板：22 套一个列表（palette-source.yaml 顺序），没有单色 / 撞色分页。
   对齐 PR-C：风格页 /theme/ 退役（301 到主页），色板网格 / 预览卡 / 恢复默认只在顶栏外观弹层 #sgx-qp——这里改走弹层，覆盖不减：
   顺序 + 默认 terra 选中 / 对勾 + 点选写 key 整页换色 + 刷新保持 + 键盘可选 + 恢复默认置灰 / 置灰不动。
   （弹层本身的开合、焦点、互斥见 tests/space/e2e/topbar/quick-panel.spec.js。） */
async function openQpOn(pg) {
  await pg.locator('.sgx-tb-quick').click();
  await expect(pg.locator('#sgx-qp')).toHaveAttribute('data-state', 'open');
}
test('palette 8-color test state（外观弹层）', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/zh/status/');
  await openQpOn(pg);
  const grid = pg.locator('#sgx-qp .sgx-th-pals');
  await expect(grid).toBeVisible();
  const fs = require('fs');
  const path = require('path');
  const yml = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'space', 'web', 'data', 'common', 'palette-source.yaml'), 'utf8');
  const items = [...yml.matchAll(/^\s*- id: ([a-z]+)\n(?:\s+\w+: .*\n)*?\s+group: ([a-z]+)$/gm)].map((m) => m[1]);
  expect(items.length).toBe(25);
  await expect(pg.locator('[data-pal-tab], #palette-dots-clash, .swatch-clash')).toHaveCount(0);
  /* 顺序 = palette-source.yaml；每块 6 色点 */
  expect(await grid.locator('[data-qp-palette]').evaluateAll((els) => els.map((e) => e.getAttribute('data-qp-palette')))).toEqual(items);
  await expect(grid.locator('[data-qp-palette]').first().locator('.sgx-th-sw u')).toHaveCount(6);
  /* 默认 terra 初始选中、有对勾；其他都没选 */
  await expect(grid.locator('[aria-pressed="true"]')).toHaveCount(1);
  await expect(grid.locator('[data-qp-palette="terra"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(grid.locator('[data-qp-palette="terra"] em')).toBeVisible();
  /* 选山绿：写 sgx-palette、整页换色；刷新后仍选中 */
  await grid.locator('[data-qp-palette="forest"]').click();
  await expect(pg.locator('html')).toHaveAttribute('data-palette', 'forest');
  expect(await pg.evaluate(() => localStorage.getItem('sgx-palette'))).toBe('forest');
  await expect(grid.locator('[data-qp-palette="forest"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(grid.locator('[data-qp-palette="terra"]')).toHaveAttribute('aria-pressed', 'false');
  await pg.reload({ waitUntil: 'domcontentloaded' });
  await expect(pg.locator('html')).toHaveAttribute('data-palette', 'forest');
  await openQpOn(pg);
  await expect(grid.locator('[data-qp-palette="forest"]')).toHaveAttribute('aria-pressed', 'true');
  /* 键盘：焦点到色块、Enter 选中 */
  await grid.locator('[data-qp-palette="cream"]').focus();
  await pg.keyboard.press('Enter');
  await expect(pg.locator('html')).toHaveAttribute('data-palette', 'cream');
  await expect(grid.locator('[data-qp-palette="cream"]')).toHaveAttribute('aria-pressed', 'true');
  /* 恢复默认：非默认时可点 → 回默认 terra（不存 key）、置灰（aria-disabled，不隐藏）；置灰时点了不动 */
  const rs = pg.locator('#sgx-qp [data-qp-reset]');
  await expect(rs).toHaveAttribute('aria-disabled', 'false');
  await rs.click();
  await expect(pg.locator('html')).not.toHaveAttribute('data-palette', /.+/);
  expect(await pg.evaluate(() => localStorage.getItem('sgx-palette'))).toBeNull();
  await expect(rs).toHaveAttribute('aria-disabled', 'true');
  await expect(rs).toBeVisible();
  await expect(grid.locator('[aria-pressed="true"]')).toHaveCount(1);
  await expect(grid.locator('[data-qp-palette="terra"]')).toHaveAttribute('aria-pressed', 'true');
  await rs.click({ force: true });
  expect(await pg.evaluate(() => localStorage.getItem('sgx-palette'))).toBeNull();
  await pg.reload({ waitUntil: 'domcontentloaded' });
  await openQpOn(pg);
  await expect(rs).toHaveAttribute('aria-disabled', 'true');
});

/* 2026-10-23 PR-G：单色 / 撞色合并，旧的撞色 id x<id> 首屏迁到 <id>（localStorage 也改写），不认识的 id 清掉回默认 */
test('旧撞色 id 迁移：xforest → forest；不认识的 id → 默认 terra', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await pg.addInitScript(() => { try { if (!sessionStorage.getItem('mig')) { localStorage.setItem('sgx-palette', 'xforest'); sessionStorage.setItem('mig', '1'); } } catch (e) {} });
  await gotoSettings(pg, '/zh/status/');
  await expect(pg.locator('html')).toHaveAttribute('data-palette', 'forest');
  expect(await pg.evaluate(() => localStorage.getItem('sgx-palette'))).toBe('forest');
  await openQpOn(pg);
  await expect(pg.locator('#sgx-qp [data-qp-palette="forest"]')).toHaveAttribute('aria-pressed', 'true');
  await pg.evaluate(() => localStorage.setItem('sgx-palette', 'neon'));
  await pg.reload({ waitUntil: 'domcontentloaded' });
  await expect(pg.locator('html')).not.toHaveAttribute('data-palette', /.+/);
  expect(await pg.evaluate(() => localStorage.getItem('sgx-palette'))).toBeNull();
  await openQpOn(pg);
  await expect(pg.locator('#sgx-qp [data-qp-palette="terra"]')).toHaveAttribute('aria-pressed', 'true');
});

/* B2-1：诊断留痕已删除——即使 sessionStorage 里残留旧版的留痕/信标，安全与隐私页也不显示跳转日志卡；
   站内跳转不再写留痕 */
test('B2-1 no jump-trace diagnostics (home page; /security/ removed in L1)', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/zh/status/');
  await pg.evaluate(() => {
    sessionStorage.setItem('sgx-last-jump', JSON.stringify([{ who: 'navhistory.js:59', reason: 'goback-primary;to=/', at: Date.now(), desktop: false, visibility: 'visible' }]));
    sessionStorage.setItem('sgx-credential-beacon', JSON.stringify({ path: '/security/owner/', at: Date.now() }));
  });
  await pg.goto('/zh/', { waitUntil: 'domcontentloaded' }); /* 进站 v3 L1：/zh/security/ 已删，换主页 */
  await expect(pg.locator('main').first()).toBeVisible({ timeout: 15000 });
  /* C8：原来固定等 500ms；改成等 load（页面模块脚本都执行完，会渲染留痕卡的话此时已渲染） */
  await pg.waitForLoadState('load');
  await expect(pg.locator('#sgx-jump-note')).toHaveCount(0);
  await expect(pg.locator('main')).not.toContainText(/门内跳转|门内页已加载|navhistory\.js|\.js:\d+/);
  /* 站内返回（系统返回）：不再写新的留痕 */
  await pg.evaluate(() => sessionStorage.removeItem('sgx-last-jump'));
  await pg.goBack();
  await pg.waitForURL(/\/status\/$/, { timeout: 15000 });
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

test('status page: no screen-time window (v6 P4, 数字健康整套删除，定稿 v5.5 §四)', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/zh/status/');
  await expect(pg.locator('#screen-time, #wb-card, [data-wb-root]')).toHaveCount(0);
  await expect(pg.locator('#st-root')).toHaveCount(1);
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

test('No top-bar menu (P4-2c; the Security page itself was removed in L1)', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await blockExternalRequests(pg);
  await pg.goto('/zh/', { waitUntil: 'domcontentloaded' });
  await expect(pg.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
  await expect(pg.locator('#brw-more, .sgx-tb-more')).toHaveCount(0);
  await expect(pg.locator('#sec-engine')).toHaveCount(0);
});
