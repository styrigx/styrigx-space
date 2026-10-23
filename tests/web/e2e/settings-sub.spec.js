/**
 * 2.6.0：设置二级页。真实断言（不 mock 自家逻辑）：
 * - Mobile /settings/ 只留 6 分类入口（账户卡已移到账号页 /account/），无选项组（B2-2 新增 Good Lock，B2-4 删除应用；
 *   2026-10-23 PR-E：Good Lock 改名高级功能，常规管理 / 辅助功能删除，分组卡片 [显示 风格] [安全与隐私] [高级功能 数字健康] [关于本站]）
 * - DeX/PC /settings/ 左右双栏：左分类导航、右详情窗格（复用子页同一套 partial）
 * - 7 个子页可达、有对应选项组（2026-10-20 起顶栏没有返回键）
 * - 旧 hash 跳转到子页
 * - 设置搜索结果跳子页（含跨页高亮）
 * - 中英双语
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('./helpers');

const CATS = [
  { id: 'display', zh: '显示', en: 'Display' },
  { id: 'theme', zh: '风格', en: 'Style' },
  { id: 'security', zh: '安全与隐私', en: 'Security and privacy' },
  { id: 'advanced', zh: '高级功能', en: 'Advanced features' },
  { id: 'wellbeing', zh: '数字健康', en: 'Digital wellbeing' },
  { id: 'about', zh: '关于本站', en: 'About' },
];

async function gotoSettings(pg, path) {
  await blockExternalRequests(pg);
  await pg.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(pg.locator('.set-layout').first()).toBeVisible({ timeout: 15000 });
}

/* 2.8.0：2.7.0 起语言跟随浏览器（Playwright 默认 en-US），不钉住会导致
   中文断言被跳转到 /en/ 后失败。按测试意图显式钉住 sgx-lang；
   跟随行为本身由 lang-follow.spec.js 单独覆盖。 */
async function pinLang(pg, lang) {
  await pg.addInitScript((l) => {
    try { localStorage.setItem('sgx-lang', l); } catch (e) {}
  }, lang);
}

/* Mobile（竖屏）：单列分类列表 */
test.use({ viewport: { width: 412, height: 915 } });

test('settings home (mobile): 6 category links, each in its own card, no account card, no option groups', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/settings/');
  // 账户卡已移到账号页（顶栏右圆头像进入），设置页不再有
  await expect(pg.locator('.sgx-account-card')).toHaveCount(0);
  // 6 个分类入口（2.8.0：分类列表由 .set-main 内 aria-label="分类" 的容器承载；2026-10-23 起每项单独一张卡片）
  const catList = pg.locator('.set-main [aria-label="分类"]');
  for (const c of CATS) {
    const link = catList.locator(`.set-row[href="/settings/${c.id}/"]`);
    await expect(link, `${c.id} link`).toHaveCount(1);
    await expect(link, `${c.id} title`).toContainText(c.zh);
    await expect(link, `${c.id} visible`).toBeVisible();
  }
  await expect(catList.locator('.set-row')).toHaveCount(CATS.length);
  // 分组卡片：每组一张 .set-card
  const groups = await catList.locator('.set-card').evaluateAll((els) => els.map((el) => [...el.querySelectorAll('.set-row')].map((a) => a.getAttribute('href'))));
  expect(groups).toEqual([
    ['/settings/display/'],
    ['/settings/theme/'],
    ['/settings/security/'],
    ['/settings/advanced/'],
    ['/settings/wellbeing/'],
    ['/settings/about/'],
  ]);
  // 2026-10-23：卡片只有名称，没有灰色副标题
  await expect(catList.locator('a[href="/settings/security/"]')).not.toContainText('锁屏、隐私');
  await expect(catList.locator('.set-row .text-xs')).toHaveCount(0);
  // 删掉的分类不再出现
  for (const gone of ['manage', 'accessibility', 'goodlock']) await expect(pg.locator(`a[href="/settings/${gone}/"]`), gone).toHaveCount(0);
  // 选项组与双栏导航在移动端不显示（DOM 存在但隐藏）
  for (const gid of ['#sg-display', '#sg-theme', '#sg-advanced', '#sg-wellbeing', '#sg-about']) {
    await expect(pg.locator(gid), gid).toBeHidden();
  }
  await expect(pg.locator('#set-cat-nav')).toBeHidden();
  await expect(pg.locator('.set-col-r')).toBeHidden();
});

test.describe('settings home (dex): two-pane', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('left nav switches right pane in place', async ({ page: pg }) => {
    await pinLang(pg, 'zh');
    await gotoSettings(pg, '/settings/');
    // 左栏导航可见、6 项
    const nav = pg.locator('#set-cat-nav');
    await expect(nav).toBeVisible();
    await expect(nav.locator('.set-cat')).toHaveCount(6);
    // 移动端列表隐藏
    await expect(pg.locator('.set-mobile-only')).toBeHidden();
    // 默认显示 display 窗格
    await expect(pg.locator('#sg-display')).toBeVisible();
    await expect(pg.locator('#set-right-title')).toContainText('显示');
    // 点主题：右窗格原地切换，不跳转
    await nav.locator('[data-cat="theme"]').click();
    await expect(pg.locator('#sg-theme')).toBeVisible();
    await expect(pg.locator('#sg-display')).toBeHidden();
    await expect(pg.locator('#set-right-title')).toContainText('风格');
    expect(new URL(pg.url()).pathname).toBe('/settings/');
    // 点安全与隐私：跳独立页面
    await nav.locator('[data-cat="security"]').click();
    await pg.waitForURL('**/settings/security/', { timeout: 10000 });
  });
});

test('settings home (en): 6 category links', async ({ page: pg }) => {
  await pinLang(pg, 'en');
  await gotoSettings(pg, '/en/settings/');
  for (const c of CATS) {
    const link = pg.locator(`.set-row[href="/en/settings/${c.id}/"]`);
    await expect(link, `${c.id} link`).toHaveCount(1);
    await expect(link, `${c.id} title`).toContainText(c.en);
  }
  // 2026-10-23：卡片只有名称，没有灰色副标题
  await expect(pg.locator('.set-row[href="/en/settings/security/"]')).toHaveText(/^\s*Security and privacy\s*$/);
  await expect(pg.locator('.set-main [aria-label="Categories"] .set-row .text-xs')).toHaveCount(0);
});

const SUBCHECKS = {
  display: ['#theme-previews', '#row-system', '#seg-layout', '#row-lang'],
  theme: ['#palette-dots'],
  /* advanced：测试构建（SGX_TEST_NO_WEATHER=1，见 deploy.yml）编译期禁用天气组件，
     #row-weather 只在生产构建输出，见 layouts/partials/feature.html */
  advanced: ['#row-datetime', '#mod-keys'],
  wellbeing: ['#wb-card', '#row-welltip'],
  about: [],
};
/* 2026-10-23 PR-E：删掉的设置项 */
const GONE = {
  display: ['#seg-font', '#row-font'],
  advanced: ['#mod-wellbeing', '#mod-parallax', '#mod-clockstyle', '#mod-sound', '#mod-edgeglow', '#row-reset', '#row-motion', '.exp-tag'],
  wellbeing: ['#well-v-total'],
  about: ['#row-reset'],
};

for (const c of CATS) {
  if (c.id === 'security') continue; // security 子页已有测试覆盖
  test(`subpage /settings/${c.id}/: no back button + options`, async ({ page: pg }) => {
    await pinLang(pg, 'zh');
    await gotoSettings(pg, `/settings/${c.id}/`);
    await expect(pg.locator('[data-go-back]'), 'no back button').toHaveCount(0);
    await expect(pg.locator('.sgx-tb-title'), 'capsule title').toHaveText(c.zh);
    await expect(pg.locator('.subpage-title, [data-subpage-head]'), 'no big title').toHaveCount(0);
    for (const sel of SUBCHECKS[c.id]) {
      await expect(pg.locator(sel), sel).toHaveCount(1);
    }
    for (const sel of GONE[c.id] || []) {
      await expect(pg.locator(sel), `${sel} removed`).toHaveCount(0);
    }
    if (c.id === 'advanced') {
      // 测试构建禁用天气：天气行必须不存在（生产构建才有，见上）
      await expect(pg.locator('#row-weather'), '#row-weather absent in test build').toHaveCount(0);
    }
    // noindex
    const robots = await pg.locator('meta[name="robots"]').getAttribute('content');
    expect(robots).toContain('noindex');
  });
}

test('legacy hash #display redirects to subpage', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await blockExternalRequests(pg);
  await pg.goto('/settings/#display', { waitUntil: 'domcontentloaded' });
  await pg.waitForURL('**/settings/display/', { timeout: 10000 });
  await expect(pg.locator('#theme-previews')).toBeVisible();
});

test('settings search removed: no bottom search bar on settings pages; /settings/search/ is gone', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  for (const path of ['/settings/', '/settings/display/', '/settings/advanced/']) {
    await gotoSettings(pg, path);
    await expect(pg.locator('.sgx-cap, #sgx-cap-settings, #sgx-cap-input-setsearch'), path).toHaveCount(0);
    await expect(pg.locator('#setso-page')).toHaveCount(0);
    const i18n = await pg.evaluate(() => JSON.parse(document.getElementById('sgx-i18n-settings').textContent));
    expect(i18n.setidx, 'setidx index removed').toBeUndefined();
  }
  const res = await pg.request.get('/settings/search/');
  expect(res.status()).toBe(404);
  const resEn = await pg.request.get('/en/settings/search/');
  expect(resEn.status()).toBe(404);
});

test('subpage: system back returns to settings home', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/settings/');
  await pg.locator('.set-main [aria-label="分类"] a[href="/settings/advanced/"]').click();
  await pg.waitForURL('**/settings/advanced/', { timeout: 10000 });
  await pg.goBack();
  await pg.waitForURL('**/settings/', { timeout: 10000 });
});

test('about page: version rows (2.6.0 spec)', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/settings/about/');
  /* 2.8.0：版本号从 data/version.yaml（唯一来源）读取，不再硬编码，
     版本推进时测试自动跟随 */
  const fs = require('fs');
  const path = require('path');
  const vy = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'web', 'data', 'version.yaml'), 'utf8');
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
  test('settings home has no orphan #sgx-unlock-link', async ({ page: pg }) => {
    await pinLang(pg, 'zh');
    await gotoSettings(pg, '/settings/');
    await expect(pg.locator('#sgx-unlock-link')).toHaveCount(0);
    /* 切英文再查一遍：后加的 init script 会覆盖前一个的 sgx-lang */
    await pinLang(pg, 'en');
    await gotoSettings(pg, '/en/settings/');
    await expect(pg.locator('#sgx-unlock-link')).toHaveCount(0);
  });

  test('security page: two entries (owner credential moved to account avatar), no unlock-methods', async ({ page: pg }) => {
    await pinLang(pg, 'zh');
    await blockExternalRequests(pg);
    await pg.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
    await expect(pg.locator('.set-layout').first()).toBeVisible({ timeout: 15000 });
    /* 安全页两项（锁屏凭证/立即锁定）；管理凭证已删除；账号在导航抽屉头的头像（2026-10-22 从顶栏右圆挪进去） */
    await expect(pg.locator('#sec-unlock-methods')).toHaveCount(0);
    await expect(pg.locator('#sec-owner-cred')).toHaveCount(0);
    await expect(pg.locator('.sgx-drawer-me')).toHaveAttribute('href', '/account/');
    await expect(pg.locator('#sec-mgmt-cred')).toHaveCount(0);
    const lockCred = pg.locator('#sec-lock-cred');
    await expect(lockCred).toHaveCount(1);
    await expect(lockCred).toContainText('锁屏凭证');
    await expect(lockCred).toHaveAttribute('href', '/settings/security/lock/');
    const locknow = pg.locator('#sec-locknow');
    await expect(locknow).toHaveCount(1);
    await expect(locknow).toContainText('立即锁定');
  });

  test('security page (en): two entries', async ({ page: pg }) => {
    await pinLang(pg, 'en');
    await blockExternalRequests(pg);
    await pg.goto('/en/settings/security/', { waitUntil: 'domcontentloaded' });
    await expect(pg.locator('.set-layout').first()).toBeVisible({ timeout: 15000 });
    await expect(pg.locator('#sec-unlock-methods')).toHaveCount(0);
    await expect(pg.locator('#sec-owner-cred')).toHaveCount(0);
    await expect(pg.locator('#sec-lock-cred')).toContainText('Lock screen credentials');
    await expect(pg.locator('#sec-locknow')).toContainText('Lock now');
  });
});

/* v1.3 #42 → B2-7 → 2026-10-23 PR-G 七色调色板：22 套一个列表，按 group 分组（冷调 / 自然 / 暖调 / 花色 / 中性），没有单色 / 撞色分页。
   断言分组 + 412 宽每行 4 个 + 末行左对齐 + 选中描边 / 对勾 + 预览卡跟着换 + 键盘可选 + 恢复默认。
   注：像素级视觉基线需在 CI 环境生成，本地环境字体渲染有差异，故此处只做 DOM 断言。 */
test('palette 8-color test state', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/settings/theme/');
  const grid = pg.locator('#palette-dots');
  await expect(grid).toBeVisible();
  const fs = require('fs');
  const path = require('path');
  const yml = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'web', 'data', 'palettes.yaml'), 'utf8');
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
  await gotoSettings(pg, '/settings/theme/');
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
  await gotoSettings(pg, '/settings/');
  await pg.evaluate(() => {
    sessionStorage.setItem('sgx-last-jump', JSON.stringify([{ who: 'navhistory.js:59', reason: 'goback-primary;to=/', at: Date.now(), desktop: false, visibility: 'visible' }]));
    sessionStorage.setItem('sgx-door-beacon', JSON.stringify({ path: '/settings/security/owner/', at: Date.now() }));
  });
  await pg.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
  await expect(pg.locator('main').first()).toBeVisible({ timeout: 15000 });
  await pg.waitForTimeout(500);
  await expect(pg.locator('#sgx-jump-note')).toHaveCount(0);
  await expect(pg.locator('main')).not.toContainText(/门内跳转|门内页已加载|navhistory\.js|\.js:\d+/);
  /* 站内返回（系统返回）：不再写新的留痕 */
  await pg.evaluate(() => sessionStorage.removeItem('sgx-last-jump'));
  await pg.goBack();
  await pg.waitForURL(/\/settings\/$/, { timeout: 15000 });
  expect(await pg.evaluate(() => sessionStorage.getItem('sgx-last-jump'))).toBeNull();
});

/* 2026-10-23 PR-E：Good Lock 改名「高级功能」（/settings/advanced/），旧地址跳过去；常规管理 / 辅助功能删除，旧地址回设置首页 */
test('PR-E Advanced features: renamed from Good Lock, no Good Lock branding or LAB badges', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/settings/advanced/');
  await expect(pg.locator('.sgx-tb-title')).toHaveText('高级功能');
  await expect(pg.locator('main')).not.toContainText(/Good Lock|实验/);
  const rows = await pg.locator('#sg-advanced .set-row').evaluateAll((els) => els.map((e) => e.id));
  expect(rows).toEqual(['row-datetime', 'mod-keys']); /* 测试构建没有天气行 */
  /* 快捷键开关写同一个 key */
  const row = pg.locator('#mod-keys');
  const sw = row.locator('.gl-switch');
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await row.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  expect(await pg.evaluate(() => localStorage.getItem('sgx-gl-keys'))).toBe('1');
  await row.click();
  expect(await pg.evaluate(() => localStorage.getItem('sgx-gl-keys'))).toBeNull();
  /* 时钟样式在日期和时间弹层里（key 仍是 sgx-gl-clockstyle） */
  const sheet = pg.locator('#sheet-body');
  await expect(async () => {
    await pg.locator('#row-datetime').click();
    await expect(sheet.locator('#dt-clock')).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 15000 });
  await expect(sheet.locator('#dt-clock')).toContainText('时钟样式');
  await expect(sheet.locator('#dt-clock-sw')).toHaveAttribute('aria-checked', 'false');
  await sheet.locator('#dt-clock').click();
  await expect(sheet.locator('#dt-clock-sw')).toHaveAttribute('aria-checked', 'true');
  expect(await pg.evaluate(() => localStorage.getItem('sgx-gl-clockstyle'))).toBe('1');
});

test('PR-E Advanced features (en)', async ({ page: pg }) => {
  await pinLang(pg, 'en');
  await gotoSettings(pg, '/en/settings/advanced/');
  await expect(pg.locator('.sgx-tb-title')).toHaveText('Advanced features');
  await expect(pg.locator('main')).not.toContainText(/Good Lock|LAB/);
  await expect(pg.locator('#mod-keys')).toContainText('Keyboard shortcuts');
});

test('PR-E old settings URLs redirect', async ({ page: pg }) => {
  await blockExternalRequests(pg);
  /* 每条用对应语言钉住（sgx-lang 和地址语言不一致会再跳一次） */
  for (const [from, to] of [
    ['/settings/goodlock/', '/settings/advanced/'],
    ['/en/settings/goodlock/', '/en/settings/advanced/'],
    ['/settings/manage/', '/settings/'],
    ['/settings/accessibility/', '/settings/'],
    ['/en/settings/manage/', '/en/settings/'],
    ['/en/settings/accessibility/', '/en/settings/'],
  ]) {
    await pinLang(pg, from.startsWith('/en/') ? 'en' : 'zh');
    await pg.goto(from, { waitUntil: 'domcontentloaded' });
    await pg.waitForURL((u) => u.pathname === to, { timeout: 10000 });
  }
  await pinLang(pg, 'zh');
  /* 旧 hash */
  await pg.goto('/settings/#goodlock', { waitUntil: 'domcontentloaded' });
  await pg.waitForURL('**/settings/advanced/', { timeout: 10000 });
  /* 线上 301（Pages _redirects） */
  const fs = require('fs');
  const path = require('path');
  const rd = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'web', 'static', '_redirects'), 'utf8');
  expect(rd).toMatch(/^\/settings\/goodlock\/\s+\/settings\/advanced\/\s+301$/m);
  expect(rd).toMatch(/^\/goodlock\/\s+\/settings\/advanced\/\s+301$/m);
  expect(rd).toMatch(/^\/settings\/manage\/\s+\/settings\/\s+301$/m);
  expect(rd).toMatch(/^\/settings\/accessibility\/\s+\/settings\/\s+301$/m);
});

test('PR-E Digital wellbeing: one screen-time card (this device when signed out) + 15-minute reminder', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/settings/wellbeing/');
  const card = pg.locator('#wb-card');
  await expect(pg.locator('#sg-wellbeing .p-5')).toHaveCount(1);
  await expect(card).toContainText('我的屏幕时间');
  await expect(card.locator('[data-wb="scope"]')).toHaveText('今天 · 本机');
  await expect(card.locator('[data-wb="total"]')).not.toHaveText('--');
  /* 没有站长会话：不拉 / 不显示所有设备的数据 */
  await expect(card).not.toHaveAttribute('data-wb-root', /.*/);
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
test('B2-4 settings has no Apps category; no reset-all-settings row anywhere', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/settings/');
  const hrefs = await pg.locator('.set-main [aria-label="分类"] .set-row').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
  expect(hrefs).not.toContain('/settings/apps/');
  await expect(pg.locator('#sg-apps, #row-app-files, #row-app-browser')).toHaveCount(0);
  await expect(pg.locator('#row-reset')).toHaveCount(0);
  await expect(pg.locator('body')).not.toContainText('重置所有设置');
});

test('No top-bar menu; search engine row lives in Security and privacy', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await blockExternalRequests(pg);
  await pg.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(pg.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
  await expect(pg.locator('#brw-more, .sgx-tb-more')).toHaveCount(0);
  await gotoSettings(pg, '/settings/security/');
  const row = pg.locator('#sec-engine');
  const sheet = pg.locator('#sheet-body');
  await expect(async () => {
    await row.click();
    await expect(sheet.getByText('Bing', { exact: true })).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 15000 });
  await sheet.getByText('Bing', { exact: true }).click();
  expect(await pg.evaluate(() => localStorage.getItem('sgx-search-engine'))).toBe('bing');
});

/* 2026-10-24：显示页的行顺序 跟随系统 → 语言 → 布局；分隔线照旧（第一行没有，后面每行上方一条） */
test('display subpage: row order 跟随系统 → 语言 → 布局, dividers intact', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoSettings(pg, '/settings/display/');
  const order = await pg.evaluate(() => {
    const ids = ['row-system', 'row-lang', 'seg-layout'];
    const els = ids.map((id) => document.getElementById(id));
    const rows = els.map((el) => el && el.closest('.set-row'));
    const all = Array.from(document.querySelectorAll('#sg-display .set-row'));
    return {
      idx: rows.map((r) => all.indexOf(r)),
      dividers: all.map((r) => getComputedStyle(r, '::before').content !== 'none' && getComputedStyle(r, '::before').content !== 'normal'),
    };
  });
  expect(order.idx).toEqual([0, 1, 2]);
  expect(order.dividers).toEqual([false, true, true]);
});
