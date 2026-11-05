// 日刻首页（手机）：接口用 page.route 假数据，不碰线上。
// - 顶栏：九宫格 · 余响/拾录/百味 分段滑块 · 右圆分享（2026-10-24 留言板撤了）；没有搜索栏、快捷面板、页脚；抽屉只有四个应用（主站 / 奇趣（书签+星）/ 日刻 / 博客）
// - 页签：默认余响，#trove / #flavors 直达，点页签改 hash；英文页 Echo / Trove / Flavors
// - 余响：今日一句；再抽一句 → 回到今日；长按复制；账号已登录（可写）抽到公开句子 → 设为今日（PUT /api/today）→ 回到今日状态 + toast；账号未登录没有设为今日
// - 拾录：全部句子新的在前；账号没登录没有「记一句」、页底「登录账号后可编辑」；能编辑时有，私密句子带锁；写接口 401 account 不刷新、提示登录
// - 百味：自建专题在前（可写时有「＋ 新建」），再是人物（每位作者一组）；点进分组、页内返回；可写时上移 / 移出
// - 记一句：预览、加译文、作者补全 + 最近作者、出处类型 + 名字补全、归入百味（含就地新建）、标签块、随手一笔、公开；
//   保存 → 已拾录；编辑时删除要确认
const { test, expect } = require('@playwright/test');

const QUOTES = [
  { id: 'aaaaaaaaaaa1', text: '世上本没有路，走的人多了，也便成了路。', trans: '', author: '鲁迅', source: '故乡', source_type: 'book', tags: ['人生'], visibility: 'public', created_at: 4, updated_at: 4 },
  { id: 'aaaaaaaaaaa2', text: 'Stay hungry, stay foolish.', trans: '求知若饥，虚心若愚。', author: 'Steve Jobs', source: '', source_type: '', tags: ['English'], visibility: 'private', created_at: 3, updated_at: 3 },
  { id: 'aaaaaaaaaaa3', text: '人生如逆旅，我亦是行人。', trans: '', author: '苏轼', source: '临江仙', source_type: 'poetry', tags: ['人生'], visibility: 'public', created_at: 2, updated_at: 2 },
  { id: 'aaaaaaaaaaa4', text: '回首向来萧瑟处，也无风雨也无晴。', trans: '', author: '苏轼', source: '定风波', source_type: 'poetry', tags: [], visibility: 'public', created_at: 1, updated_at: 1 },
];
const COLS = [{ id: 'cccccccccc01', name: '晨读', intro: '早上读一遍', created_at: 1, sort: 0, quote_ids: ['aaaaaaaaaaa3', 'aaaaaaaaaaa1', 'aaaaaaaaaaa2'] }];

/* signedIn = true：接口回 canWrite / showPrivate 都是 true（账号已登录）；false：都是 false（进门了、账号没登录） */
async function mock(page, signedIn) {
  const list = signedIn
    ? QUOTES.map((q) => ({ ...q, note: '', collections: COLS[0].quote_ids.includes(q.id) ? ['cccccccccc01'] : [] }))
    : QUOTES.filter((q) => q.visibility === 'public');
  let cols = signedIn ? COLS.map((c) => ({ ...c, quote_ids: c.quote_ids.slice() })) : COLS.map((c) => ({ ...c, quote_ids: c.quote_ids.filter((id) => list.some((q) => q.id === id)) }));
  const calls = [];
  await page.route('**/avatar/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>' }));
  await page.route('**/api/lock-session-check', (r) => r.fulfill({ json: { ok: true } }));
  await page.route('**/api/today**', (r) => r.fulfill({ json: { ok: true, day: '2026-10-20', quote: { ...QUOTES[0] } } }));
  await page.route('**/api/collections**', async (r) => {
    const req = r.request();
    calls.push({ method: req.method(), url: req.url(), body: req.postDataJSON ? req.postDataJSON() : null });
    if (req.method() === 'GET') return r.fulfill({ json: { ok: true, canWrite: signedIn, showPrivate: signedIn, collections: cols } });
    if (req.method() === 'POST') {
      const c = { id: 'cccccccccc09', name: req.postDataJSON().name, intro: req.postDataJSON().intro || '', created_at: 9, sort: 9, quote_ids: [] };
      cols = cols.concat(c);
      return r.fulfill({ status: 201, json: { ok: true, collection: c } });
    }
    if (req.method() === 'PUT') {
      const id = new URL(req.url()).searchParams.get('id');
      cols = cols.map((c) => (c.id === id ? { ...c, ...req.postDataJSON() } : c));
      return r.fulfill({ json: { ok: true, collection: cols.find((c) => c.id === id) } });
    }
    return r.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/quotes**', async (r) => {
    const req = r.request();
    if (req.method() === 'GET') return r.fulfill({ json: { ok: true, canWrite: signedIn, showPrivate: signedIn, quotes: list } });
    const body = req.postDataJSON();
    calls.push({ method: req.method(), url: req.url(), body });
    if (req.method() === 'POST') {
      const q = { id: 'bbbbbbbbbbb1', trans: '', author: '', source: '', source_type: '', tags: [], visibility: 'public', note: '', collections: [], created_at: 9, updated_at: 9, ...body };
      return r.fulfill({ status: 201, json: { ok: true, quote: q } });
    }
    if (req.method() === 'PUT') return r.fulfill({ json: { ok: true, quote: { ...list[0], ...body } } });
    return r.fulfill({ json: { ok: true } });
  });
  return calls;
}

test('账号未登录：顶栏三页签、没有搜索栏；快捷面板导航页同主站（四个站）；余响今日一句', async ({ page }) => {
  await mock(page, false);
  await page.goto('/daymark/');
  await expect(page.locator('[data-dm-tab]')).toHaveText(['余响', '拾录', '百味']);
  await expect(page.locator('#dm-tab-echo')).toHaveAttribute('aria-selected', 'true');
  /* 没有搜索栏（2026-11-04 P5-1 起有快捷面板 + AI 窗口，共享外壳顶栏，下面单独验） */
  await expect(page.locator('#bk-cap, .sgx-tb-search, input[type="search"]:visible, [role="search"]:visible')).toHaveCount(0);
  await expect(page.locator('#dm-echo-day')).toHaveText('10月20日 星期二');
  await expect(page.locator('#dm-echo-body')).toContainText('鲁迅 · 《故乡》');
  await expect(page.locator('#dm-share')).toBeVisible();
  /* 2026-11-04 P5-1 顶栏全大椭圆（四站同一个）：logo · 长条 · 快捷面板 · AI · 头像；九宫格、抽屉、右圆分享删除；没有版权页脚 */
  expect(await page.locator('.sgx-topbar > *').evaluateAll((els) => els.map((e) => e.className.split(' ')[0]))).toEqual(['sgx-tb-logo', 'sgx-tb-pill', 'sgx-tb-acts']);
  await expect(page.locator('.sgx-tb-logo')).toHaveAttribute('href', '/daymark/');
  await expect(page.locator('.sgx-tb-acts .sgx-tb-quick')).toHaveAttribute('aria-controls', 'sgx-qp');
  await expect(page.locator('.sgx-tb-acts .sgx-tb-ai')).toHaveAttribute('aria-controls', 'sgx-ai');
  /* 头像最右，去主站账号页（子站单独起服务时也能到主站：绝对地址） */
  await expect(page.locator('.sgx-tb-acts > .sgx-tb-me')).toHaveAttribute('href', 'https://styrigx.com/account/');
  await expect(page.locator('.sgx-tb-me img')).toHaveAttribute('src', 'https://styrigx.com/avatar/192.webp');
  await expect(page.locator('.sgx-tb-nav, #sgx-drawer, .sgx-tb-end, .sgx-tb-share, .sgx-topbar [data-sgx-share], .sgx-tb-end-group, .sgx-tb-guestbook, a[href*="guestbook"]')).toHaveCount(0);
  await expect(page.locator('footer')).toHaveCount(0);
  await expect(page.getByText('Powered by')).toHaveCount(0);
  /* 快捷面板第 1 页「导航」= 原抽屉的站点列表（主站共享外壳 nav.json）：日刻是当前项；主站项绝对地址，子站之间同源相对；没有搜索框 */
  await page.locator('.sgx-tb-quick').click();
  await expect(page.locator('#sgx-qp')).toHaveAttribute('data-state', 'open');
  await expect(page.locator('#sgx-qp-tab-nav')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#sgx-qp .sgx-qp-nav-label')).toHaveText(['主站', '奇趣', '日刻', '博客']);
  await expect(page.locator('#sgx-qp [data-nav="home"]')).toHaveAttribute('href', 'https://styrigx.com/');
  await expect(page.locator('#sgx-qp [data-nav="curio"]')).toHaveAttribute('href', '/curio/');
  await expect(page.locator('#sgx-qp [data-nav="daymark"]')).toHaveAttribute('href', '/daymark/');
  await expect(page.locator('#sgx-qp [data-nav="blog"]')).toHaveAttribute('href', '/blog/');
  /* 奇趣图标 = 书签 + 星（同主站 #180） */
  await expect(page.locator('#sgx-qp [data-nav="curio"] path').first()).toHaveAttribute('d', /^M6 4\.5A1\.5/);
  await expect(page.locator('#sgx-qp [aria-current="page"]')).toHaveCount(1);
  await expect(page.locator('#sgx-qp [data-nav="daymark"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#sgx-qp input, #sgx-qp [type="search"], #sgx-qp [role="search"], #sgx-qp a[href*="/search/"]')).toHaveCount(0);
  /* 主站同款：毛玻璃面板、tonal 当前项 */
  const st = await page.evaluate(() => {
    const probe = (v) => { const i = document.createElement('i'); i.style.color = `var(${v})`; document.body.appendChild(i); const c = getComputedStyle(i).color; i.remove(); return c; };
    const cur = getComputedStyle(document.querySelector('#sgx-qp [aria-current="page"]'));
    const sh = document.querySelector('#sgx-qp .sgx-qp-sheet');
    return { bg: cur.backgroundColor, tonal: probe('--sgx-nav-selected'), filter: getComputedStyle(sh).backdropFilter };
  });
  expect(st.bg).toBe(st.tonal);
  expect(st.filter).toContain('blur');
  await page.keyboard.press('Escape');
  await expect(page.locator('#sgx-qp')).toBeHidden();
});

test('页签：点了改 hash，#trove / #flavors 直达；英文页 Echo / Trove / Flavors', async ({ page }) => {
  await mock(page, false);
  await page.goto('/daymark/');
  await page.locator('#dm-tab-trove').click();
  await expect(page).toHaveURL(/#trove$/);
  await expect(page.locator('#dm-pane-trove')).toBeVisible();
  await expect(page.locator('#dm-pane-echo')).toBeHidden();
  await page.locator('#dm-tab-flavors').click();
  await expect(page).toHaveURL(/#flavors$/);
  await page.locator('#dm-tab-echo').click();
  await expect(page).toHaveURL(/\/daymark\/$/);
  await page.goto('/daymark/#flavors');
  await expect(page.locator('#dm-tab-flavors')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#dm-pane-flavors')).toBeVisible();
  await page.goto('/daymark/en/#trove');
  await expect(page.locator('[data-dm-tab]')).toHaveText(['Echo', 'Trove', 'Flavors']);
  await expect(page.locator('#dm-tab-trove')).toHaveAttribute('aria-selected', 'true');
});

test('余响：再抽一句 → 出现回到今日；回到今日恢复今日一句；长按复制', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mock(page, false);
  await page.goto('/daymark/');
  await expect(page.locator('#dm-echo-body')).toContainText('世上本没有路');
  await expect(page.locator('#dm-back-today')).toBeHidden();
  await page.locator('#dm-draw').click();
  await expect(page.locator('#dm-back-today')).toBeVisible();
  await expect(page.locator('#dm-echo-body')).not.toContainText('世上本没有路');
  await expect(page.locator('#dm-echo-day')).toContainText('拾于');
  await page.locator('#dm-back-today').click();
  await expect(page.locator('#dm-echo-body')).toContainText('世上本没有路');
  await expect(page.locator('#dm-back-today')).toBeHidden();
  const box = await page.locator('#dm-echo .dm-text').boundingBox();
  await page.mouse.move(box.x + 20, box.y + 10);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await expect(page.locator('#bk-toast')).toHaveText('已复制');
});

test('余响 · 账号已登录（可写）：再抽一句 → 设为今日 → PUT /api/today，回到今日状态，toast 已设为今日', async ({ page }) => {
  await mock(page, true);
  let todayQ = { ...QUOTES[0] };
  const puts = [];
  await page.route('**/api/today**', async (r) => {
    const req = r.request();
    if (req.method() === 'PUT') {
      const body = req.postDataJSON();
      puts.push(body);
      const q = QUOTES.find((x) => x.id === body.id);
      todayQ = { id: q.id, text: q.text, trans: q.trans, author: q.author, source: q.source, source_type: q.source_type, tags: q.tags };
      return r.fulfill({ json: { ok: true, day: '2026-10-20', quote: todayQ } });
    }
    return r.fulfill({ json: { ok: true, day: '2026-10-20', quote: todayQ } });
  });
  /* 抽签固定：账号已登录能抽的是另外三句（私密的 Jobs 排第一），random 0.99 → 最后一句（苏轼《定风波》，公开） */
  await page.addInitScript(() => { Math.random = () => 0.99; });
  await page.goto('/daymark/');
  await expect(page.locator('#dm-echo-body')).toContainText('世上本没有路');
  await expect(page.locator('#dm-tab-trove')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dm-can-write'))).toBe(true);
  await expect(page.locator('#dm-set-today')).toBeHidden();
  await page.locator('#dm-draw').click();
  await expect(page.locator('#dm-echo-body')).toContainText('也无风雨也无晴');
  await expect(page.locator('#dm-set-today')).toBeVisible();
  await expect(page.locator('#dm-set-today')).toHaveText('设为今日');
  await expect(page.locator('#dm-back-today')).toBeVisible();
  /* 与「回到今日」同一套描边胶囊按钮 */
  const st = await page.evaluate(() => {
    const a = getComputedStyle(document.querySelector('#dm-set-today'));
    const b = getComputedStyle(document.querySelector('#dm-back-today'));
    return { r: a.borderRadius, h: a.height, c: a.color === b.color, bd: a.borderColor === b.borderColor };
  });
  expect(st).toEqual({ r: '999px', h: '48px', c: true, bd: true });
  await page.locator('#dm-set-today').click();
  await expect(page.locator('#bk-toast')).toHaveText('已设为今日');
  expect(puts).toEqual([{ id: 'aaaaaaaaaaa4' }]);
  await expect(page.locator('#dm-echo-day')).toHaveText('10月20日 星期二');
  await expect(page.locator('#dm-echo-body')).toContainText('也无风雨也无晴');
  await expect(page.locator('#dm-set-today')).toBeHidden();
  await expect(page.locator('#dm-back-today')).toBeHidden();
  /* 再抽一句 → 回到今日：回到新设的那句 */
  await page.locator('#dm-draw').click();
  await expect(page.locator('#dm-back-today')).toBeVisible();
  await page.locator('#dm-back-today').click();
  await expect(page.locator('#dm-echo-body')).toContainText('也无风雨也无晴');
  /* 刷新后余响默认就是它（接口记住了） */
  await page.reload();
  await expect(page.locator('#dm-echo-body')).toContainText('也无风雨也无晴');
});

test('余响 · 账号已登录（可写）：抽到私密句子没有设为今日', async ({ page }) => {
  await mock(page, true);
  await page.addInitScript(() => { Math.random = () => 0; });
  await page.goto('/daymark/');
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dm-can-write'))).toBe(true);
  await page.locator('#dm-draw').click();
  await expect(page.locator('#dm-echo-body')).toContainText('Stay hungry');
  await expect(page.locator('#dm-back-today')).toBeVisible();
  await expect(page.locator('#dm-set-today')).toBeHidden();
});

test('余响 · 账号未登录：再抽一句后没有设为今日；英文页按钮文案 Set as today', async ({ page }) => {
  await mock(page, false);
  await page.goto('/daymark/');
  await expect(page.locator('#dm-echo-body')).toContainText('世上本没有路');
  for (let i = 0; i < 3; i++) {
    await page.locator('#dm-draw').click();
    await expect(page.locator('#dm-back-today')).toBeVisible();
    await expect(page.locator('#dm-set-today')).toBeHidden();
  }
  await page.goto('/daymark/en/');
  await expect(page.locator('#dm-set-today')).toHaveText('Set as today');
  await expect(page.locator('#dm-set-today')).toBeHidden();
});

test('拾录 · 账号没登录：只有公开句子、没有记一句和锁；页底「登录账号后可编辑」链到 /account/?return=本页', async ({ page }) => {
  await mock(page, false);
  await page.goto('/daymark/#trove');
  await expect(page.locator('#dm-list .dm-card')).toHaveCount(3);
  await expect(page.locator('#dm-fab')).toBeHidden();
  await expect(page.locator('.dm-lock')).toHaveCount(0);
  await expect(page.locator('#dm-signin')).toBeVisible();
  await expect(page.locator('#dm-signin a')).toHaveText('登录账号后可编辑');
  /* P3-1：带 ?return=本页（同意流程登录完回来） */
  await expect(page.locator('#dm-signin a')).toHaveAttribute('href', 'https://styrigx.com/account/?return=%2Fdaymark%2F%23trove');
});

test('拾录 · 写接口回 401 account（账号会话刚过期）：不刷新页面，编辑弹层提示登录账号', async ({ page }) => {
  await mock(page, true);
  await page.route('**/api/quotes**', (r) => (r.request().method() === 'PUT'
    ? r.fulfill({ status: 401, json: { ok: false, error: 'account' } })
    : r.fallback()));
  let navs = 0;
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs++; });
  await page.goto('/daymark/#trove');
  await expect(page.locator('#dm-signin')).toBeHidden();
  const before = navs;
  await page.locator('#dm-list .dm-card').first().click();
  await expect(page.locator('#edit-wrap')).toHaveClass(/open/);
  await page.locator('#edit-save').click();
  await expect(page.locator('#edit-err')).toHaveText('登录账号后可编辑。');
  expect(navs).toBe(before);
});

test('拾录 · 账号已登录（可写）：新的在前、私密带锁、右下角记一句；点句子进入编辑，删除要确认', async ({ page }) => {
  const calls = await mock(page, true);
  await page.goto('/daymark/#trove');
  await expect(page.locator('#dm-list .dm-card')).toHaveCount(4);
  await expect(page.locator('#dm-list .dm-card').first()).toContainText('世上本没有路');
  await expect(page.locator('#dm-list .dm-lock')).toHaveCount(1);
  await expect(page.locator('#dm-fab')).toBeVisible();
  await page.locator('#dm-tab-echo').click();
  await expect(page.locator('#dm-fab')).toBeHidden();
  await page.locator('#dm-tab-trove').click();
  await page.locator('#dm-list .dm-card').first().click();
  await expect(page.locator('#edit-title')).toHaveText('编辑这一句');
  await expect(page.locator('#f-text')).toHaveValue(QUOTES[0].text);
  await expect(page.locator('#f-stype [data-st="book"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#f-cols [data-col="cccccccccc01"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#f-tagchips .dm-tagchip')).toHaveText(['#人生×']);
  await page.locator('#edit-del').click();
  await expect(page.locator('#confirm-wrap')).toHaveClass(/open/);
  await page.locator('#confirm-cancel').click();
  await expect(page.locator('#edit-wrap')).toHaveClass(/open/);
  await page.locator('#edit-del').click();
  await page.locator('#confirm-ok').click();
  await expect(page.locator('#edit-wrap')).not.toHaveClass(/open/);
  await expect(page.locator('#dm-list .dm-card')).toHaveCount(3);
  expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('id=aaaaaaaaaaa1'))).toBe(true);
});

test('记一句：预览、加译文、作者补全 + 最近作者、出处类型、归入百味（含新建）、标签块、随手一笔 → 已拾录', async ({ page }) => {
  const calls = await mock(page, true);
  await page.goto('/daymark/#trove');
  await page.locator('#dm-fab').click();
  await expect(page.locator('#edit-wrap')).toHaveClass(/open/);
  await expect(page.locator('#edit-title')).toHaveText('记一句');
  await expect(page.locator('#edit-del')).toBeHidden();
  await page.locator('#edit-save').click();
  await expect(page.locator('#edit-err')).toBeVisible();

  await page.locator('#f-text').fill('人生如逆旅，我亦是行人。');
  await expect(page.locator('#ed-preview .dm-text')).toHaveText('人生如逆旅，我亦是行人。');
  await expect(page.locator('#f-trans-wrap')).toBeHidden();
  await page.locator('#f-trans-toggle').click();
  await page.locator('#f-trans').fill('Life is a journey.');
  await expect(page.locator('#ed-preview .dm-trans')).toHaveText('Life is a journey.');

  await expect(page.locator('#f-author-recent [data-author]').first()).toHaveText('鲁迅');
  await page.locator('#f-author').fill('苏');
  await expect(page.locator('#f-author-ac .dm-ac-item')).toHaveText(['苏轼']);
  await page.locator('#f-author-ac .dm-ac-item').click();
  await expect(page.locator('#f-author')).toHaveValue('苏轼');

  await page.locator('#f-stype [data-st="poetry"]').click();
  await expect(page.locator('#f-stype [data-st="poetry"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#f-source').fill('临');
  await expect(page.locator('#f-source-ac .dm-ac-item')).toHaveText(['临江仙']);
  await page.locator('#f-source-ac .dm-ac-item').click();
  await expect(page.locator('#ed-preview .dm-attr')).toHaveText('苏轼 · 《临江仙》');

  await page.locator('#f-cols [data-col="cccccccccc01"]').click();
  await page.locator('#f-col-new').click();
  await page.locator('#f-col-name').fill('夜读');
  await page.locator('#f-col-add').click();
  await expect(page.locator('#f-cols [data-col="cccccccccc09"]')).toHaveAttribute('aria-pressed', 'true');
  expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/collections') && c.body.name === '夜读')).toBe(true);

  await page.locator('#f-tag-input').fill('旅行');
  await page.locator('#f-tag-input').press('Enter');
  await page.locator('#f-tag-input').fill('#宋词,');
  await expect(page.locator('#f-tagchips .dm-tagchip')).toHaveCount(2);
  await page.locator('#f-tag-sugg [data-addtag="人生"]').click();
  await expect(page.locator('#f-tagchips .dm-tagchip')).toHaveCount(3);
  await page.locator('#f-tagchips [data-untag="1"]').click();
  await expect(page.locator('#f-tagchips .dm-tagchip')).toHaveCount(2);

  await page.locator('#f-note').fill('在旧书店读到');
  await page.locator('#f-public').evaluate((el) => { el.checked = false; });
  const [req] = await Promise.all([
    page.waitForRequest((r) => r.url().endsWith('/api/quotes') && r.method() === 'POST'),
    page.locator('#edit-save').click(),
  ]);
  const b = req.postDataJSON();
  expect(b).toMatchObject({ text: '人生如逆旅，我亦是行人。', trans: 'Life is a journey.', author: '苏轼', source: '临江仙', source_type: 'poetry', note: '在旧书店读到', visibility: 'private' });
  expect(b.tags).toEqual(['旅行', '人生']);
  expect(b.collections).toEqual(['cccccccccc01', 'cccccccccc09']);
  await expect(page.locator('#bk-toast')).toHaveText('已拾录');
  await expect(page.locator('#edit-wrap')).not.toHaveClass(/open/);
  await expect(page.locator('#dm-list .dm-card').first()).toContainText('人生如逆旅');
});

test('百味 · 账号已登录（可写）：专题在前带新建、人物每位作者一组；进分组页内返回；上移和移出走 PUT', async ({ page }) => {
  const calls = await mock(page, true);
  await page.goto('/daymark/#flavors');
  await expect(page.locator('#dm-cols .dm-fcard')).toHaveCount(2);
  await expect(page.locator('#dm-cols .dm-fcard').first()).toContainText('晨读');
  await expect(page.locator('#dm-cols .dm-fcard').first()).toContainText('3 句');
  await expect(page.locator('#dm-col-new')).toBeVisible();
  await expect(page.locator('#dm-authors .dm-fcard')).toHaveCount(3);
  await expect(page.locator('#dm-authors .dm-fcard').first()).toContainText('苏轼');
  await expect(page.locator('#dm-authors .dm-fcard').first()).toContainText('2 句');
  await expect(page.locator('#dm-pane-flavors')).not.toContainText('出处');
  await expect(page.locator('#dm-pane-flavors')).not.toContainText('标签');

  await page.locator('#dm-cols [data-key="cccccccccc01"]').click();
  await expect(page).toHaveURL(/#flavors\/c\/cccccccccc01$/);
  await expect(page.locator('#dm-g-title')).toHaveText('晨读');
  await expect(page.locator('#dm-g-list .dm-card')).toHaveCount(3);
  await expect(page.locator('#dm-g-list .dm-card').first()).toContainText('人生如逆旅');
  await page.locator('#dm-g-edit').click();
  await page.locator('#dm-g-list [data-move="-1"][data-i="1"]').click();
  await expect(page.locator('#dm-g-list .dm-card').first()).toContainText('世上本没有路');
  let put = calls.filter((c) => c.method === 'PUT' && c.url.includes('/api/collections')).pop();
  expect(put.body.quote_ids).toEqual(['aaaaaaaaaaa1', 'aaaaaaaaaaa3', 'aaaaaaaaaaa2']);
  await page.locator('#dm-g-list [data-remove="2"]').click();
  await expect(page.locator('#dm-g-list .dm-card')).toHaveCount(2);
  put = calls.filter((c) => c.method === 'PUT' && c.url.includes('/api/collections')).pop();
  expect(put.body.quote_ids).toEqual(['aaaaaaaaaaa1', 'aaaaaaaaaaa3']);
  await page.locator('#dm-fl-back').click();
  await expect(page).toHaveURL(/#flavors$/);
  await expect(page.locator('#dm-fl-home')).toBeVisible();

  await page.locator('#dm-authors [data-key="苏轼"]').click();
  await expect(page.locator('#dm-g-title')).toHaveText('苏轼');
  await expect(page.locator('#dm-g-list .dm-card')).toHaveCount(2);
  await expect(page.locator('#dm-g-tools')).toBeHidden();

  await page.locator('#dm-fl-back').click();
  await page.locator('#dm-col-new').click();
  await page.locator('#c-name').fill('电影台词');
  await page.locator('#c-intro').fill('看片时记下的');
  await page.locator('#col-save').click();
  await expect(page.locator('#dm-g-title')).toHaveText('电影台词');
  await expect(page.locator('#dm-g-intro')).toHaveText('看片时记下的');
});

test('百味 · 账号未登录：没有新建；专题里只显示看得到的句子', async ({ page }) => {
  await mock(page, false);
  await page.goto('/daymark/#flavors/c/cccccccccc01');
  await expect(page.locator('#dm-g-title')).toHaveText('晨读');
  await expect(page.locator('#dm-g-list .dm-card')).toHaveCount(2);
  await expect(page.locator('#dm-g-tools')).toBeHidden();
  await page.locator('#dm-fl-back').click();
  await expect(page.locator('#dm-col-new')).toHaveCount(0);
});

test('主题跟主站 sgx-ui cookie：pal 换预设；accent 是自定义种子 → 按需加载共享外壳引擎算整套角色，第二次首帧直接用缓存', async ({ page, context, baseURL }) => {
  await mock(page, false);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const set = (ui) => context.addCookies([{ name: 'sgx-ui', value: enc(ui), url: baseURL }]);
  const ind = () => page.evaluate(() => getComputedStyle(document.querySelector('.sgx-seg-ind')).backgroundColor);
  await page.goto('/daymark/');
  const base = await ind(); /* 没有 cookie：默认 dustyblue */
  const matchaSeed = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', '..', '..', 'web/daymark/assets/sgx-shell/palettes.json'), 'utf8')).presets.find((p) => p.id === 'matcha').seed;
  await set({ v: 2, mode: 'dark', pal: 'matcha', accent: matchaSeed });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'matcha');
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(page.locator('#sgx-accent-roles')).toHaveCount(0);
  expect(await ind()).not.toBe(base);
  await set({ v: 2, mode: 'light', pal: 'lake', accent: '#ff8800' });
  await page.reload();
  /* 自定义色的种子内联在 --sgx-seed（共享读端；不再用 data-sgx-seed） */
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--sgx-seed'))).toBe('#ff8800');
  await expect(page.locator('html')).not.toHaveAttribute('data-sgx-seed', /./);
  await expect(page.locator('#sgx-accent-roles')).toHaveCount(1);
  const custom = await ind();
  expect(custom).not.toBe(base);
  /* 第二次：缓存命中，不再加载引擎脚本 */
  await page.reload();
  await expect(page.locator('#sgx-accent-roles')).toHaveCount(1);
  await expect(page.locator('#sgx-accent-js')).toHaveCount(0);
  expect(await ind()).toBe(custom);
});

test('P3-1 账号已登录但日刻未获授权（canWrite=false、showPrivate=true）：页底「日刻未获账号授权」链到 /account/apps/', async ({ page }) => {
  await mock(page, true);
  await page.route('**/api/quotes**', (r) => (r.request().method() === 'GET'
    ? r.fulfill({ json: { ok: true, canWrite: false, showPrivate: true, quotes: [] } })
    : r.fulfill({ status: 403, json: { ok: false, error: 'scope', scope: 'daymark.write' } })));
  await page.goto('/daymark/#trove');
  await expect(page.locator('#dm-signin')).toBeVisible();
  await expect(page.locator('#dm-signin a')).toHaveText('日刻未获账号授权');
  await expect(page.locator('#dm-signin a')).toHaveAttribute('href', 'https://styrigx.com/account/apps/');
});
