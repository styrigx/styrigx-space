/**
 * 旷野（P4-3 PR-4b：主页和设置合成一个主站页「旷野 / Space」，就在根路径；2.6.0 起的设置二级页去掉 settings 一层挂到根下）。真实断言（不 mock 自家逻辑）：
 * - 旷野页 /（英文 /en/）：上面名片 / 日刻 / 屏幕时间，下面标题带 + 5 个平铺入口（共享组件 partials/sgx-entries.html，数据 data/space-cats.yaml）：
 *   编号 01–05、圆底图标、名字 + 一行副标题、行间细线、无卡片底；≥ 760 两栏、≥ 1100 三栏（栏间细竖线）；没有账号卡、没有选项组、没有 DeX 双栏
 *   （分类沿革：2026-10-23 PR-E 常规管理 / 辅助功能删除；服务状态从账号页搬来；P4-2c 高级功能删除，「安全与隐私」改名「安全」；
 *    P4-3 PR-4b（Gray 2026-11-07）显示页 /display/ 整页删除，404，不做 301——功能都在快捷面板）
 * - 子页 /theme/ /wellbeing/ /about/ 可达、有对应选项组（顶栏没有返回键），/security/ /status/ 是独立页面
 * - 旧设置层（原设置首页和全部子页）一律 404，不跳转
 * - 中英双语
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('../helpers/helpers');

/* 入口按数据文件渲染：顺序、名字、副标题都从 data/space-cats.yaml 读（加入口只加一行数据，测试跟着走） */
const yaml = require('js-yaml');
const SPACE = yaml.load(require('fs').readFileSync(require('path').join(__dirname, '..', '..', '..', '..', 'space', 'web', 'data', 'space-cats.yaml'), 'utf8'));
const CATS = SPACE.cats;
/* 旧设置层（拼出来，不写成字面量：全仓 git grep 只许历史文档出现旧地址，tests/space/ui/build/space-merge.test.mjs） */
const OLD = '/' + 'settings' + '/';

async function gotoSettings(pg, path) {
  await blockExternalRequests(pg);
  await pg.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(pg.locator('.set-layout, .home-wrap').first()).toBeVisible({ timeout: 15000 });
}

/* 2.8.0：2.7.0 起语言跟随浏览器（Playwright 默认 en-US），不钉住会导致
   中文断言被跳转到 /en/ 后失败。按测试意图显式钉住 sgx-lang；
   跟随行为本身由 lang-follow.spec.js 单独覆盖。 */
async function pinLang(pg, lang) {
  await pg.addInitScript((l) => {
    try { localStorage.setItem('sgx-lang', l); } catch (e) {}
  }, lang);
}

/* Mobile（竖屏）：单列 */
test.use({ viewport: { width: 412, height: 915 } });

test('space home (mobile): widgets on top, then title band + flat entries from data (01–05, icon, name + subtitle, thin dividers, no card); no account card, no option groups', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/');
  await expect(pg).toHaveTitle('旷野 | Styrigx');
  await expect(pg.locator('.sgx-tb-tab')).toHaveText(['旷野']);
  await expect(pg.locator('.sgx-tb-tab')).toHaveAttribute('aria-current', 'page');
  // 账户卡在账号页，旷野页没有；名片、屏幕时间卡保留
  await expect(pg.locator('.sgx-account-card')).toHaveCount(0);
  await expect(pg.locator('#w-profile')).toBeVisible();
  await expect(pg.locator('#w-screen')).toBeVisible();
  // 名片在入口上面；标题带在入口列表上面
  const catList = pg.locator('.home-wrap [aria-label="分类"]');
  await expect(catList).toHaveCount(1);
  const band = pg.locator('#space-entries .sgx-ent-band');
  await expect(band.locator('.sgx-ent-label')).toHaveText('SPACE');
  await expect(band.locator('.sgx-ent-title')).toHaveText('旷野');
  await expect(band.locator('.sgx-ent-lede')).toHaveText(SPACE.band.sub_zh);
  const yProfile = (await pg.locator('#w-profile').boundingBox()).y;
  const yBand = (await band.boundingBox()).y;
  const yCats = (await catList.boundingBox()).y;
  expect(yBand).toBeGreaterThan(yProfile);
  expect(yCats).toBeGreaterThan(yBand);
  // 数量、顺序、地址、编号、名字、副标题全按数据
  const rows = catList.locator('a.sgx-ent');
  await expect(rows).toHaveCount(CATS.length);
  expect(await rows.evaluateAll((els) => els.map((a) => a.getAttribute('href')))).toEqual(CATS.map((c) => `/${c.id}/`));
  await expect(rows.locator('.sgx-ent-no')).toHaveText(CATS.map((_, i) => String(i + 1).padStart(2, '0')));
  await expect(rows.locator('.sgx-ent-name')).toHaveText(CATS.map((c) => c.zh));
  await expect(rows.locator('.sgx-ent-sub')).toHaveText(CATS.map((c) => c.sub_zh));
  await expect(rows.locator('.sgx-ent-ic svg')).toHaveCount(CATS.length);
  await expect(rows.locator('.sgx-ent-ch')).toHaveText(CATS.map(() => '›'));
  // 平铺：无卡片底（透明背景、无边框圆角卡），行间细线（每行下边框 1px）；手机一栏
  const st = await rows.first().evaluate((a) => {
    const li = a.parentElement;
    const cs = getComputedStyle(a);
    const ls = getComputedStyle(li);
    const ic = getComputedStyle(a.querySelector('.sgx-ent-ic'));
    return { bg: cs.backgroundColor, liBg: ls.backgroundColor, bb: ls.borderBottomWidth, br: ls.borderRightWidth, icR: ic.borderRadius, icW: ic.width, cols: getComputedStyle(li.parentElement).gridTemplateColumns.split(' ').length };
  });
  expect(st.bg).toBe('rgba(0, 0, 0, 0)');
  expect(st.liBg).toBe('rgba(0, 0, 0, 0)');
  expect(st.bb).toBe('1px');
  expect(st.br).toBe('0px');
  expect(st.icW).toBe('48px');
  expect(st.icR).toBe('999px');
  expect(st.cols).toBe(1);
  await expect(catList.locator('.set-card, .widget')).toHaveCount(0);
  // 删掉的分类（含显示页）不再出现；页面上没有任何指向旧设置层的链接
  for (const gone of ['display', 'manage', 'accessibility', 'goodlock', 'advanced', 'apps']) await expect(pg.locator(`a[href="/${gone}/"]`), gone).toHaveCount(0);
  await expect(pg.locator(`a[href^="${OLD}"], a[href^="/en${OLD}"]`)).toHaveCount(0);
  // 选项组与 DeX 双栏都不在旷野页
  await expect(pg.locator('#sg-display, #sg-theme, #sg-wellbeing, #sg-about, #set-cat-nav, .set-col-r')).toHaveCount(0);
});

/* 栏数：< 760 一栏，≥ 760 两栏（左栏右侧细竖线），≥ 1100 三栏（每行最后一栏没有竖线）；同一行的入口顶边对齐 */
for (const [w, h, cols] of [[759, 900, 1], [760, 900, 2], [1099, 900, 2], [1100, 900, 3], [1366, 768, 3]]) {
  test(`space entries: ${w}px wide → ${cols} column(s), vertical dividers between columns`, async ({ page: pg }) => {
    await pg.setViewportSize({ width: w, height: h });
    await pinLang(pg, 'zh');
    await gotoSettings(pg, '/');
    const list = pg.locator('#space-entries .sgx-ent-list');
    await expect(list.locator('.sgx-ent-li')).toHaveCount(CATS.length);
    const info = await list.evaluate((ul) => ({
      cols: getComputedStyle(ul).gridTemplateColumns.split(' ').length,
      tops: [...ul.children].map((li) => Math.round(li.getBoundingClientRect().top)),
      br: [...ul.children].map((li) => getComputedStyle(li).borderRightWidth),
    }));
    expect(info.cols).toBe(cols);
    expect(new Set(info.tops.slice(0, cols)).size, '第一行同一高度').toBe(1);
    const want = info.br.map((_, i) => (cols === 1 ? '0px' : cols === 2 ? (i % 2 === 0 ? '1px' : '0px') : (i % 3 === 2 ? '0px' : '1px')));
    expect(info.br).toEqual(want);
  });
}

test.describe('space home (dex)', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('single page: entries are plain links, no two-pane', async ({ page: pg }) => {
    await pinLang(pg, 'zh');
    await gotoSettings(pg, '/');
    const catList = pg.locator('.home-wrap [aria-label="分类"]');
    await expect(catList).toBeVisible();
    await expect(pg.locator('#set-cat-nav, .set-dex-cols, #set-panes')).toHaveCount(0);
    await catList.locator('a[href="/theme/"]').click();
    await pg.waitForURL('**/theme/', { timeout: 10000 });
    await expect(pg.locator('#palette-dots')).toBeVisible();
  });
});

test('space home (en): title band + entries from data', async ({ page: pg }) => {
  await pinLang(pg, 'en');
  await gotoSettings(pg, '/en/');
  await expect(pg).toHaveTitle('Space | Styrigx');
  await expect(pg.locator('.sgx-tb-tab')).toHaveText(['Space']);
  await expect(pg.locator('#space-entries .sgx-ent-label')).toHaveText('SPACE');
  await expect(pg.locator('#space-entries .sgx-ent-title')).toHaveText('Space');
  await expect(pg.locator('#space-entries .sgx-ent-lede')).toHaveText(SPACE.band.sub_en);
  const rows = pg.locator('.home-wrap [aria-label="Categories"] a.sgx-ent');
  expect(await rows.evaluateAll((els) => els.map((a) => a.getAttribute('href')))).toEqual(CATS.map((c) => `/en/${c.id}/`));
  await expect(rows.locator('.sgx-ent-name')).toHaveText(CATS.map((c) => c.en));
  await expect(rows.locator('.sgx-ent-sub')).toHaveText(CATS.map((c) => c.sub_en));
  await expect(pg.locator('a[href="/en/display/"]')).toHaveCount(0);
});

/* P4-3 PR-4b（Gray 2026-11-07）：显示页整页删除，不做 301；功能都在快捷面板 */
test('display page is gone: /display/ and /en/display/ 404 without redirect', async ({ page: pg }) => {
  for (const p of ['/display/', '/en/display/']) {
    const r = await pg.request.get(p, { maxRedirects: 0 });
    expect(r.status(), p).toBe(404);
  }
  const sm = await (await pg.request.get('/sitemap.xml')).text();
  expect(sm).not.toContain('/display/');
});

test('old settings layer is gone: home and every subpage 404, no redirect', async ({ page: pg }) => {
  const subs = ['', 'theme/', 'wellbeing/', 'about/', 'status/', 'security/', 'security/lock/', 'security/tempkeys/', 'manage/', 'accessibility/', 'apps/', 'search/', 'advanced/', 'goodlock/', 'account/'];
  for (const pre of ['', '/en']) {
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
  wellbeing: ['#wb-card', '#row-welltip'],
  about: [],
};
/* 2026-10-23 PR-E：删掉的设置项 */
const GONE = {
  theme: ['#theme-previews', '#row-system', '#seg-layout', '#row-lang'],
  wellbeing: ['#well-v-total'],
  about: ['#row-reset'],
};

for (const c of CATS) {
  if (c.id === 'security' || c.id === 'status') continue; // security、status 是独立页面，各有测试覆盖（status 见 space-status.spec.js）
  test(`subpage /${c.id}/: no back button + options`, async ({ page: pg }) => {
    await pinLang(pg, 'zh');
    await gotoSettings(pg, `/${c.id}/`);
    await expect(pg.locator('[data-go-back]'), 'no back button').toHaveCount(0);
    await expect(pg.locator('.sgx-tb-title'), 'capsule title').toHaveText(c.zh);
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
  for (const path of ['/', '/theme/', '/wellbeing/']) {
    await gotoSettings(pg, path);
    await expect(pg.locator('.sgx-cap, #sgx-cap-settings, #sgx-cap-input-setsearch'), path).toHaveCount(0);
    await expect(pg.locator('#setso-page')).toHaveCount(0);
    const i18n = await pg.evaluate(() => JSON.parse(document.getElementById('sgx-i18n-space').textContent));
    expect(i18n.setidx, 'setidx index removed').toBeUndefined();
  }
  for (const p of [OLD + 'search/', '/en' + OLD + 'search/', '/search-settings/']) {
    const res = await pg.request.get(p, { maxRedirects: 0 });
    expect(res.status(), p).toBe(404);
  }
});

test('subpage: system back returns to the space page', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/');
  await pg.locator('.home-wrap [aria-label="分类"] a[href="/theme/"]').click();
  await pg.waitForURL('**/theme/', { timeout: 10000 });
  await pg.goBack();
  await pg.waitForURL((u) => u.pathname === '/', { timeout: 10000 });
});

test('about page: version rows (2.6.0 spec)', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/about/');
  /* 2.8.0：版本号从 data/version.yaml（唯一来源）读取，不再硬编码，
     版本推进时测试自动跟随 */
  const fs = require('fs');
  const path = require('path');
  const vy = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'space', 'web', 'data', 'version.yaml'), 'utf8');
  const ui = (vy.match(/^ui:\s*"([^"]+)"/m) || [])[1];
  const sgx = (vy.match(/^sgx:\s*"([^"]+)"/m) || [])[1];
  const body = pg.locator('#sg-about');
  await expect(body).toContainText(`Styrigx UI ${ui}`);
  await expect(body).toContainText(`SGX ${sgx}`);
  await expect(body).toContainText('Hugo');
  await expect(body).toContainText('Tailwind CSS');
  await expect(body).toContainText('构建时间');
  /* B2-4：顺序 版本/内核/Hugo/Tailwind/构建/构建时间；无 GitHub 仓库行；重置所有设置 2026-10-23 删除 */
  const labels = await body.locator('.set-row > span.font-medium').allTextContents();
  expect(labels.map((t) => t.trim())).toEqual(['版本', '内核', 'Hugo', 'Tailwind CSS', '构建', '构建时间']);
  await expect(body).not.toContainText('GitHub');
  await expect(body.locator('a[href*="github.com"]')).toHaveCount(0);
  await expect(pg.locator('#row-reset')).toHaveCount(0);
});

/* 解锁方式入口迁移：从账户卡移到「安全与隐私」第一行 */
test.describe('unlock methods entry relocation', () => {
  test('space home has no orphan #sgx-unlock-link', async ({ page: pg }) => {
    await pinLang(pg, 'zh');
    await gotoSettings(pg, '/');
    await expect(pg.locator('#sgx-unlock-link')).toHaveCount(0);
    /* 切英文再查一遍：后加的 init script 会覆盖前一个的 sgx-lang */
    await pinLang(pg, 'en');
    await gotoSettings(pg, '/en/');
    await expect(pg.locator('#sgx-unlock-link')).toHaveCount(0);
  });

  test('security page: three entries (owner credential moved to account avatar), no unlock-methods', async ({ page: pg }) => {
    await pinLang(pg, 'zh');
    await blockExternalRequests(pg);
    await pg.goto('/security/', { waitUntil: 'domcontentloaded' });
    await expect(pg.locator('.set-layout').first()).toBeVisible({ timeout: 15000 });
    /* 安全页三项（锁屏凭证/临时钥匙/立即锁定；临时钥匙从账号页搬来）；管理凭证已删除；账号在顶栏最右的头像（2026-10-22 从顶栏右圆挪进抽屉头，2026-11-04 P5-1 回到顶栏最右） */
    await expect(pg.locator('#sec-unlock-methods')).toHaveCount(0);
    await expect(pg.locator('#sec-owner-cred')).toHaveCount(0);
    await expect(pg.locator('.sgx-tb-me')).toHaveAttribute('href', '/account/');
    await expect(pg.locator('#sec-mgmt-cred')).toHaveCount(0);
    const lockCred = pg.locator('#sec-lock-cred');
    await expect(lockCred).toHaveCount(1);
    await expect(lockCred).toContainText('锁屏凭证');
    await expect(lockCred).toHaveAttribute('href', '/security/lock/');
    const tk = pg.locator('#sec-tempkeys');
    await expect(tk).toHaveCount(1);
    await expect(tk).toContainText('临时钥匙');
    await expect(tk).toHaveAttribute('href', '/security/tempkeys/');
    const locknow = pg.locator('#sec-locknow');
    await expect(locknow).toHaveCount(1);
    await expect(locknow).toContainText('立即锁定');
  });

  test('security page (en): three entries', async ({ page: pg }) => {
    await pinLang(pg, 'en');
    await blockExternalRequests(pg);
    await pg.goto('/en/security/', { waitUntil: 'domcontentloaded' });
    await expect(pg.locator('.set-layout').first()).toBeVisible({ timeout: 15000 });
    await expect(pg.locator('#sec-unlock-methods')).toHaveCount(0);
    await expect(pg.locator('#sec-owner-cred')).toHaveCount(0);
    await expect(pg.locator('#sec-lock-cred')).toContainText('Lock screen credentials');
    await expect(pg.locator('#sec-tempkeys')).toContainText('Temporary keys');
    await expect(pg.locator('#sec-tempkeys')).toHaveAttribute('href', '/en/security/tempkeys/');
    await expect(pg.locator('#sec-locknow')).toContainText('Lock now');
  });
});

/* v1.3 #42 → B2-7 → 2026-10-23 PR-G 七色调色板：22 套一个列表，按 group 分组（冷调 / 自然 / 暖调 / 花色 / 中性），没有单色 / 撞色分页。
   断言分组 + 412 宽每行 4 个 + 末行左对齐 + 选中描边 / 对勾 + 预览卡跟着换 + 键盘可选 + 恢复默认。
   注：像素级视觉基线需在 CI 环境生成，本地环境字体渲染有差异，故此处只做 DOM 断言。 */
test('palette 8-color test state', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/theme/');
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
  /* 默认 dustyblue 有「默认」标，初始选中；其他都没选 */
  await expect(grid.locator('.palette-cell:has([data-palette="dustyblue"]) .pal-def')).toHaveText('默认');
  await expect(grid.locator('.pal-def')).toHaveCount(1);
  await expect(grid.locator('.pal-tile[aria-pressed="true"]')).toHaveCount(1);
  await expect(grid.locator('[data-palette="dustyblue"]')).toHaveAttribute('aria-pressed', 'true');
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
  await expect(pg.locator('#pal-preview-name')).toHaveText('雾霾蓝');
  /* 选山绿：写 sgx-palette、整页换色、预览卡换成山绿的变量；刷新后仍选中 */
  await grid.locator('.pal-tile[data-palette="forest"]').click();
  await expect(pg.locator('html')).toHaveAttribute('data-palette', 'forest');
  await expect(grid.locator('[data-palette="forest"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(grid.locator('[data-palette="dustyblue"]')).toHaveAttribute('aria-pressed', 'false');
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
  /* 恢复默认（标题行右端）：非默认时可点 → 回 dustyblue（不存 key）、置灰（aria-disabled，不隐藏）；置灰时点了不动 */
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
  await expect(pg.locator('#palette-dots [data-palette="dustyblue"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(pg.locator('#pal-preview-name')).toHaveText('雾霾蓝');
  await rs.click({ force: true }); /* aria-disabled：强制点一下验证没反应 */
  expect(await pg.evaluate(() => localStorage.getItem('sgx-palette'))).toBeNull();
  await pg.reload({ waitUntil: 'domcontentloaded' });
  await expect(pg.locator('#palette-reset')).toHaveAttribute('aria-disabled', 'true');
});

/* 2026-10-23 PR-G：单色 / 撞色合并，旧的撞色 id x<id> 首屏迁到 <id>（localStorage 也改写），不认识的 id 清掉回默认 */
test('旧撞色 id 迁移：xforest → forest；不认识的 id → 默认 dustyblue', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await pg.addInitScript(() => { try { if (!sessionStorage.getItem('mig')) { localStorage.setItem('sgx-palette', 'xforest'); sessionStorage.setItem('mig', '1'); } } catch (e) {} });
  await gotoSettings(pg, '/theme/');
  await expect(pg.locator('html')).toHaveAttribute('data-palette', 'forest');
  expect(await pg.evaluate(() => localStorage.getItem('sgx-palette'))).toBe('forest');
  await expect(pg.locator('#palette-dots [data-palette="forest"]')).toHaveAttribute('aria-pressed', 'true');
  await pg.evaluate(() => localStorage.setItem('sgx-palette', 'neon'));
  await pg.reload({ waitUntil: 'domcontentloaded' });
  await expect(pg.locator('html')).not.toHaveAttribute('data-palette', /.+/);
  expect(await pg.evaluate(() => localStorage.getItem('sgx-palette'))).toBeNull();
  await expect(pg.locator('#palette-dots [data-palette="dustyblue"]')).toHaveAttribute('aria-pressed', 'true');
});

/* B2-1：诊断留痕已删除——即使 sessionStorage 里残留旧版的留痕/信标，安全与隐私页也不显示跳转日志卡；
   站内跳转不再写留痕 */
test('B2-1 security page: no jump-trace diagnostics', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/theme/');
  await pg.evaluate(() => {
    sessionStorage.setItem('sgx-last-jump', JSON.stringify([{ who: 'navhistory.js:59', reason: 'goback-primary;to=/', at: Date.now(), desktop: false, visibility: 'visible' }]));
    sessionStorage.setItem('sgx-credential-beacon', JSON.stringify({ path: '/security/owner/', at: Date.now() }));
  });
  await pg.goto('/security/', { waitUntil: 'domcontentloaded' });
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
  for (const p of ['/advanced/', '/en/advanced/', '/goodlock/', '/en/goodlock/']) {
    const r = await pg.request.get(p, { maxRedirects: 0 });
    expect(r.status(), p).toBe(404);
  }
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/');
  await expect(pg.locator('#sg-advanced, #row-datetime, #mod-keys, #row-weather')).toHaveCount(0);
  const fs = require('fs');
  const path = require('path');
  const rd = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'space', 'web', 'static', '_redirects'), 'utf8');
  expect(rd).not.toMatch(/goodlock|advanced|manage|accessibility/);
});

test('PR-E Digital wellbeing: one screen-time card (this device when signed out) + 15-minute reminder', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/wellbeing/');
  const card = pg.locator('#wb-card');
  await expect(pg.locator('#sg-wellbeing .p-5')).toHaveCount(1);
  await expect(card).toContainText('我的屏幕时间');
  await expect(card.locator('[data-wb="scope"]')).toHaveText('今天 · 本机');
  await expect(card.locator('[data-wb="total"]')).not.toHaveText('--');
  /* P2-2：卡片不再按等级标记去掉 data-wb-root；改为带 data-wb-detail，只有 /api/wellbeing 回 detail:true（账号已登录）才换成所有设备 */
  await expect(card).toHaveAttribute('data-wb-root', /.*/);
  await expect(card).toHaveAttribute('data-wb-detail', /.*/);
  const tip = pg.locator('#row-welltip');
  await expect(tip.locator('.switch')).toHaveAttribute('aria-checked', 'true');
  await tip.click();
  await expect(tip.locator('.switch')).toHaveAttribute('aria-checked', 'false');
  expect(await pg.evaluate(() => localStorage.getItem('sgx-well-tip'))).toBe('0');
});

test('B2-2 store and its apps are gone; main-site bookmarks are gone too', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await blockExternalRequests(pg);
  await pg.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(pg.locator('#home-widgets')).toBeVisible({ timeout: 15000 });
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
  await gotoSettings(pg, '/');
  const hrefs = await pg.locator('.home-wrap [aria-label="分类"] a.sgx-ent').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
  expect(hrefs).not.toContain('/apps/');
  await expect(pg.locator('#sg-apps, #row-app-files, #row-app-browser')).toHaveCount(0);
  await expect(pg.locator('#row-reset')).toHaveCount(0);
  await expect(pg.locator('body')).not.toContainText('重置所有设置');
});

test('No top-bar menu; Security has no privacy group or search engine row (P4-2c)', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await blockExternalRequests(pg);
  await pg.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(pg.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
  await expect(pg.locator('#brw-more, .sgx-tb-more')).toHaveCount(0);
  await gotoSettings(pg, '/security/');
  await expect(pg.locator('.sgx-tb-title')).toHaveText('安全');
  await expect(pg.locator('#sec-engine')).toHaveCount(0);
  await expect(pg.locator('main')).not.toContainText('搜索引擎');
});
