// 日刻首页（手机）：接口用 page.route 假数据，不碰线上。
// - 顶栏：字标 · 页名胶囊（首页 = 日刻，切分区换分区名）· 外观 · 盾牌 · >_ · 头像；顶栏没有分段滑块；没有搜索栏
// - 2026-11 对齐 PR-C2（设计稿 pg=day）：余响居中一屏（cat daymark/<日期> · 日期行 · 引句 · 命令链 · 13 格日期条）+ 三窗（窗标题进拾录 / 百味）+ 前后日卡；
//   平铺入口、段式标签、实心按钮组、右上分享图标删除
// - 分区：默认余响，#trove / #flavors 直达，点窗标题改 hash，拾录 / 百味「cd ..」回余响；#d/<日期> 看那天；英文页 Echo / Trove / Flavors
// - 余响：今日一句；shuf -n1 再抽一句 → cat today 回到今日；长按复制；账号已登录（可写）抽到公开句子 → set today 设为今日（PUT /api/today）→ 回到今日状态 + toast；账号未登录没有设为今日
// - 日期条 / 前后日：/api/days 记下的日子能点（看那天的句子、地址 #d/<日期>），还没到的灰掉；明天是「明天见」
// - 拾录：全部句子新的在前；账号没登录没有「记一句」、命令链「su · su 登录后可编辑」；能编辑时有，私密句子带锁
// - 百味：自建专题在前（可写时有「＋ 新建」），再是人物（每位作者一组）；点进分组、页内返回；可写时上移 / 移出
// - 记一句：预览、加译文、作者补全 + 最近作者、出处类型 + 名字补全、归入百味（含就地新建）、标签块、随手一笔、公开；
//   保存 → 已拾录；编辑时删除要确认
const { test, expect } = require('@playwright/test');

/* 语言清理（2026-11-07）起奇趣 / 日刻也「跟随系统」每页都跳（四站同一份首帧跳转 lang-boot.js），Playwright 默认 en-US 会把 /<站>/zh/… 换到英文页。
   本文件的中文用例按中文浏览器跑（同 ui-cookie.spec.js）；要看英文页的地方先明确选英文（同源 localStorage sgx-lang=en），见 chooseLang。 */
test.use({ locale: 'zh-CN' });
/** 明确选语言（同源 localStorage sgx-lang；'system' = 回到跟随系统）。页面已在本站时用。 @param {import('@playwright/test').Page} page @param {string} l */
const chooseLang = (page, l) => page.evaluate((v) => { localStorage.setItem('sgx-lang', v); }, l);

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

test('账号未登录：余响居中一屏（命令行 · 日期行 · 引句 · 命令链 · 日期条）+ 三窗（顶栏没有页签）、没有搜索栏；NAVIGATE 同主站（五项）', async ({ page }) => {
  await mock(page, false);
  await page.goto('/daymark/zh/');
  /* 对齐 PR-C2：没有平铺入口 / 段式标签；三窗 余响 · 拾录 · 百味，拾录 / 百味的窗标题是进完整列表的链接；页名胶囊在首页显示站名 */
  await expect(page.locator('#dm-entries, #dm-segs, .sgx-ents, .sgx-segs, #dm-share')).toHaveCount(0);
  await expect(page.locator('.dm-dcol .sgx-term-title')).toHaveText(['余响', '拾录', '百味']);
  await expect(page.locator('#dm-wt-trove a')).toHaveAttribute('href', '#trove');
  await expect(page.locator('#dm-wt-flavors a')).toHaveAttribute('href', '#flavors');
  await expect(page.locator('#dm-n-trove')).toHaveText('3');
  await expect(page.locator('#dm-w-trove .dm-li')).toHaveCount(3);
  await expect(page.locator('#dm-w-trove .dm-li').first()).toHaveText('书世上本没有路，走的人多了，也便成了路。');
  await expect(page.locator('#dm-w-flavors .dm-li').first()).toContainText('晨读');
  await expect(page.locator('.sgx-tb-pill .sgx-seg, .sgx-tb-pill [role="tab"]')).toHaveCount(0);
  await expect(page.locator('.sgx-tb-title')).toHaveText('日刻');
  await expect(page.locator('#dm-pane-echo')).toBeVisible();
  /* 没有搜索栏（2026-11-04 P5-1 起有快捷面板 + AI 窗口，共享外壳顶栏，下面单独验） */
  await expect(page.locator('#bk-cap, .sgx-tb-search, input[type="search"]:visible, [role="search"]:visible')).toHaveCount(0);
  await expect(page.locator('#dm-cmd-day')).toHaveText('2026-10-20');
  await expect(page.locator('#dm-echo-day')).toHaveText('2026 · 10 · 20 · 星期二'); /* 设计稿日期行；星期交给 Intl */
  await expect(page.locator('#dm-echo-body')).toContainText('鲁迅 · 《故乡》');
  await expect(page.locator('#dm-draw')).toHaveText('shuf -n1 ↻再抽一句');
  await expect(page.locator('#dm-signin')).toBeVisible();
  /* 13 格日期条：今天在中间、主题色描边；后面 6 天还没到（灰、点不了） */
  await expect(page.locator('#dm-dcal .dm-dc')).toHaveCount(13);
  await expect(page.locator('#dm-dcal .dm-dc.is-today')).toHaveText('20');
  await expect(page.locator('#dm-dcal .dm-dc[aria-current="date"]')).toHaveText('20');
  await expect(page.locator('#dm-dcal .dm-dc:disabled')).toHaveCount(6);
  /* 前后日卡：明天是「明天见」（不是链接） */
  await expect(page.locator('#dm-nx a.sgx-nx-a')).toHaveAttribute('href', '#d/2026-10-19');
  await expect(page.locator('#dm-nx .is-off')).toHaveText('cat 2026-10-21 ›明天见');
  /* 2026-11 UI 重设计 PR-1 顶栏 v3（四站同一个）：通栏 字标 · 页名标记（不显示）· 外观 · 盾牌 · | · >_ · 头像 + 底边进度条；AI 浮钮右下角；
     抽屉、右圆分享删除；每页底部 tmux 页脚（当前窗口 3:daymark） */
  expect(await page.locator('.sgx-topbar > *').evaluateAll((els) => els.map((e) => e.className.split(' ')[0]))).toEqual(['sgx-tb-logo', 'sgx-tb-pill', 'sgx-tb-acts', 'sgx-tb-prog']);
  await expect(page.locator('#site-nav .sgx-tb-pill')).toBeHidden();
  await expect(page.locator('.sgx-tb-logo')).toHaveAttribute('href', '/daymark/zh/');
  await expect(page.locator('.sgx-tb-acts .sgx-tb-quick')).toHaveAttribute('aria-controls', 'sgx-qp');
  await expect(page.locator('#site-nav > .sgx-tb-ai')).toHaveAttribute('aria-controls', 'sgx-ai');
  /* 头像在顶栏最右（也在 AI 窗口头部），去主站账号页（子站单独起服务时也能到主站：绝对地址） */
  expect(await page.locator('.sgx-tb-acts > *').evaluateAll((els) => els.map((e) => e.className.split(' ').filter((c) => c !== 'sgx-tb-btn')[0]))).toEqual(['sgx-tb-shield', 'sgx-tb-quick', 'sgx-tb-grid', 'sgx-tb-sep', 'sgx-tb-term', 'sgx-tb-av'] /* v5 S6 顶栏 E */);
  await expect(page.locator('.sgx-tb-acts .sgx-tb-grid')).toHaveAttribute('aria-controls', 'sgx-nav');
  await expect(page.locator('.sgx-tb-acts .sgx-tb-av')).toHaveAttribute('href', 'https://styrigx.com/zh/account/');
  await expect(page.locator('.sgx-tb-acts .sgx-tb-shield')).toHaveAttribute('href', 'https://styrigx.com/zh/#sec');
  /* 2026-11 PR-5：账号入口 = 顶栏头像 → 账号下拉（AI 窗口头部不再有头像）；2026-11-08 账号下拉 = 账号终端，没有去账号页的链接 */
  await expect(page.locator('#sgx-acct')).toHaveCount(1);
  await expect(page.locator('#sgx-acct a[href*="/account/"]')).toHaveCount(0);
  await expect(page.locator('.sgx-tb-acts .sgx-tb-avatar')).toHaveAttribute('src', 'https://styrigx.com/avatar/192.webp');
  await expect(page.locator('#sgx-ai .sgx-ai-me')).toHaveCount(0);
  await expect(page.locator('#site-nav .sgx-tb-me')).toHaveCount(0);
  await expect(page.locator('.sgx-tb-nav, #sgx-drawer, .sgx-tb-end, .sgx-tb-share, .sgx-topbar [data-sgx-share], .sgx-tb-end-group, .sgx-tb-guestbook, a[href*="guestbook"]')).toHaveCount(0);
  await expect(page.locator('footer')).toHaveCount(1);
  await expect(page.locator('footer.sgx-foot .sgx-foot-win a[aria-current="page"]')).toHaveAttribute('data-win', 'daymark');
  await expect(page.getByText('Powered by')).toHaveCount(0);
  /* NAVIGATE 面板 #sgx-nav（主站共享外壳 nav.json）：01 主页 · 02 博客 · 03 奇趣 · 04 日刻 · 05 旷野，日刻是当前项；主站项绝对地址，子站之间同源相对；没有搜索框 */
  await page.locator('.sgx-tb-grid').click();
  await expect(page.locator('#sgx-nav')).toHaveAttribute('data-state', 'open');
  await expect(page.locator('#sgx-nav .sgx-nav-tile .sgx-nav-name')).toHaveText(['主页', '博客', '奇趣', '日刻', '旷野']);
  await expect(page.locator('#sgx-nav [data-nav-count]')).toHaveText('04/05');
  await expect(page.locator('#sgx-nav [data-nav="home"]')).toHaveAttribute('href', 'https://styrigx.com/zh/');
  await expect(page.locator('#sgx-nav [data-nav="curio"]')).toHaveAttribute('href', '/curio/zh/');
  await expect(page.locator('#sgx-nav [data-nav="daymark"]')).toHaveAttribute('href', '/daymark/zh/');
  await expect(page.locator('#sgx-nav [data-nav="blog"]')).toHaveAttribute('href', '/blog/zh/');
  await expect(page.locator('#sgx-nav [aria-current="page"]')).toHaveCount(1);
  await expect(page.locator('#sgx-nav [data-nav="daymark"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#sgx-nav input, #sgx-nav [type="search"], #sgx-nav [role="search"], #sgx-nav a[href*="/search/"]')).toHaveCount(0);
  /* 主站同款：实色面板、当前站「开」态（渐变衬底，和别的站不同） */
  const st = await page.evaluate(() => {
    const cur = getComputedStyle(document.querySelector('#sgx-nav [aria-current="page"]'));
    const other = getComputedStyle(document.querySelector('#sgx-nav .sgx-nav-tile:not([aria-current])'));
    const sh = document.querySelector('#sgx-nav .sgx-qp-sheet');
    return { bg: cur.backgroundImage, other: other.backgroundImage, filter: getComputedStyle(sh).backdropFilter };
  });
  expect(st.bg).not.toBe(st.other);
  expect(st.filter).toBe('none');
  await page.keyboard.press('Escape');
  await expect(page.locator('#sgx-nav')).toBeHidden();
  /* 外观面板：只有 MODE + PALETTE，没有页签、导航列表 */
  await page.locator('.sgx-tb-quick').click();
  await expect(page.locator('#sgx-qp')).toHaveAttribute('data-state', 'open');
  await expect(page.locator('#sgx-qp [role="tab"], #sgx-qp [data-nav], #sgx-qp [data-qp]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('#sgx-qp')).toBeHidden();
});

test('分区：点窗标题改 hash、胶囊换分区名；cd .. / hash 回余响；#trove / #flavors 直达；英文页 Echo / Trove / Flavors', async ({ page }) => {
  await mock(page, false);
  await page.goto('/daymark/zh/');
  await page.locator('#dm-wt-trove a').click();
  await expect(page).toHaveURL(/#trove$/);
  await expect(page.locator('#dm-pane-trove')).toBeVisible();
  await expect(page.locator('#dm-pane-echo')).toBeHidden();
  await expect(page.locator('.sgx-tb-title')).toHaveText('拾录');
  await expect(page.locator('#dm-pane-trove .sgx-ph-cmd')).toHaveText('nobody@space:~$ ls daymark/trove/', { useInnerText: true });
  /* cd .. 回余响 */
  await page.locator('#dm-pane-trove .sgx-cmds a[href="#"]').click();
  await expect(page.locator('#dm-pane-echo')).toBeVisible();
  await expect(page.locator('.sgx-tb-title')).toHaveText('日刻');
  await page.evaluate(() => { location.hash = '#flavors'; });
  await expect(page).toHaveURL(/#flavors$/);
  await expect(page.locator('.sgx-tb-title')).toHaveText('百味');
  await page.evaluate(() => { location.hash = '#echo'; });
  await expect(page.locator('#dm-pane-echo')).toBeVisible();
  await expect(page.locator('.sgx-tb-title')).toHaveText('日刻');
  await page.goto('/daymark/zh/#flavors');
  await expect(page.locator('#dm-pane-flavors')).toBeVisible();
  await expect(page.locator('.sgx-tb-title')).toHaveText('百味');
  await chooseLang(page, 'en');
  await page.goto('/daymark/#trove');
  await expect(page.locator('.dm-dcol .sgx-term-title')).toHaveText(['Echo', 'Trove', 'Flavors']);
  await expect(page.locator('#dm-pane-trove')).toBeVisible();
  await expect(page.locator('.sgx-tb-title')).toHaveText('Trove');
});

test('余响：再抽一句 → 出现回到今日；回到今日恢复今日一句；长按复制', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mock(page, false);
  await page.goto('/daymark/zh/');
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
  await page.goto('/daymark/zh/');
  await expect(page.locator('#dm-echo-body')).toContainText('世上本没有路');
  await expect(page.locator('#dm-wt-trove a')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dm-can-write'))).toBe(true);
  await expect(page.locator('#dm-set-today')).toBeHidden();
  await page.locator('#dm-draw').click();
  await expect(page.locator('#dm-echo-body')).toContainText('也无风雨也无晴');
  await expect(page.locator('#dm-set-today')).toBeVisible();
  await expect(page.locator('#dm-set-today')).toHaveText('set today设为今日');
  await expect(page.locator('#dm-back-today')).toBeVisible();
  /* 与「cat today 回到今日」同一套命令链（虚线细框，取代旧的描边胶囊按钮） */
  const st = await page.evaluate(() => {
    const a = getComputedStyle(document.querySelector('#dm-set-today'));
    const b = getComputedStyle(document.querySelector('#dm-back-today'));
    return { dash: a.borderTopStyle, same: a.borderTopStyle === b.borderTopStyle && a.color === b.color && a.borderRadius === b.borderRadius };
  });
  expect(st).toEqual({ dash: 'dashed', same: true });
  await page.locator('#dm-set-today').click();
  await expect(page.locator('#bk-toast')).toHaveText('已设为今日');
  expect(puts).toEqual([{ id: 'aaaaaaaaaaa4' }]);
  await expect(page.locator('#dm-echo-day')).toHaveText('2026 · 10 · 20 · 星期二');
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
  await page.goto('/daymark/zh/');
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dm-can-write'))).toBe(true);
  await page.locator('#dm-draw').click();
  await expect(page.locator('#dm-echo-body')).toContainText('Stay hungry');
  await expect(page.locator('#dm-back-today')).toBeVisible();
  await expect(page.locator('#dm-set-today')).toBeHidden();
});

test('余响 · 账号未登录：再抽一句后没有设为今日；英文页按钮文案 Set as today', async ({ page }) => {
  await mock(page, false);
  await page.goto('/daymark/zh/');
  await expect(page.locator('#dm-echo-body')).toContainText('世上本没有路');
  for (let i = 0; i < 3; i++) {
    await page.locator('#dm-draw').click();
    await expect(page.locator('#dm-back-today')).toBeVisible();
    await expect(page.locator('#dm-set-today')).toBeHidden();
  }
  await chooseLang(page, 'en');
  await page.goto('/daymark/');
  await expect(page.locator('#dm-set-today')).toHaveText('set todaySet as today');
  await expect(page.locator('#dm-set-today')).toBeHidden();
});

test('拾录 · 账号没登录：只有公开句子、没有记一句和锁；命令链「su · su 登录后可编辑」打开顶栏终端预填 su （2c，v6 割接）', async ({ page }) => {
  await mock(page, false);
  await page.goto('/daymark/zh/#trove');
  await expect(page.locator('#dm-list .dm-card')).toHaveCount(3);
  await expect(page.locator('#dm-fab')).toBeHidden();
  await expect(page.locator('.dm-lock')).toHaveCount(0);
  await expect(page.locator('#dm-signin-trove')).toBeVisible();
  await expect(page.locator('#dm-signin-trove [data-signin-text]')).toHaveText('su 登录后可编辑');
  /* 2c：点了打开顶栏终端（data-sec-open：没登录预填 su ）；href 是没 JS 的退路（主站本语言首页 #sec）；余响那条同一个入口 */
  for (const id of ['#dm-signin-trove', '#dm-signin']) {
    await expect(page.locator(id)).toHaveAttribute('href', 'https://styrigx.com/zh/#sec');
    await expect(page.locator(id)).toHaveAttribute('data-sec-open', '');
    await expect(page.locator(id)).not.toHaveAttribute('data-acct-app', /./);
  }
  await expect(page.locator('#dm-signin-trove .sgx-cmd-k')).toHaveText('su');
});

test('拾录 · 账号已登录（可写）：新的在前、私密带锁、右下角记一句；点句子进入编辑，删除要确认', async ({ page }) => {
  const calls = await mock(page, true);
  await page.goto('/daymark/zh/#trove');
  await expect(page.locator('#dm-list .dm-card')).toHaveCount(4);
  await expect(page.locator('#dm-list .dm-card').first()).toContainText('世上本没有路');
  await expect(page.locator('#dm-list .dm-lock')).toHaveCount(1);
  await expect(page.locator('#dm-fab')).toBeVisible();
  await page.evaluate(() => { location.hash = '#echo'; });
  await expect(page.locator('#dm-pane-echo')).toBeVisible();
  await expect(page.locator('#dm-fab')).toBeHidden();
  await page.locator('#dm-wt-trove a').click();
  await expect(page.locator('#dm-pane-trove')).toBeVisible();
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
  await page.goto('/daymark/zh/#trove');
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
  await page.goto('/daymark/zh/#flavors');
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
  /* 弹层打开 60ms 后才把焦点放到名称框；先等它，否则 fill 简介时焦点被抢回名称框，两段字拼在标题里 */
  await expect(page.locator('#c-name')).toBeFocused();
  await page.locator('#c-name').fill('电影台词');
  await page.locator('#c-intro').fill('看片时记下的');
  await page.locator('#col-save').click();
  await expect(page.locator('#dm-g-title')).toHaveText('电影台词');
  await expect(page.locator('#dm-g-intro')).toHaveText('看片时记下的');
});

test('百味 · 账号未登录：没有新建；专题里只显示看得到的句子', async ({ page }) => {
  await mock(page, false);
  await page.goto('/daymark/zh/#flavors/c/cccccccccc01');
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
  const ind = () => page.evaluate(() => getComputedStyle(document.querySelector('.sgx-tb-ai')).backgroundColor);
  await page.goto('/daymark/zh/');
  const base = await ind(); /* 没有 cookie：默认 terra */
  const matchaSeed = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', '..', 'space/web/data/shell/palettes.json'), 'utf8')).presets.find((p) => p.id === 'matcha').seed;
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

test('余响 · 日期条 / 前后日（/api/days）：记下的日子能点，看那天的句子（地址 #d/<日期>、命令行换日期）；cat today / 点今天格回来；那天没记下的灰掉；余响窗列最近几天', async ({ page }) => {
  await mock(page, false);
  const asked = [];
  await page.route('**/api/days**', (r) => {
    asked.push(new URL(r.request().url()).search);
    return r.fulfill({ json: { ok: true, today: '2026-10-20', days: [
      { day: '2026-10-19', quote: { id: 'aaaaaaaaaaa3', text: '人生如逆旅，我亦是行人。', trans: '', author: '苏轼', source: '临江仙', source_type: 'poetry', tags: [] } },
      { day: '2026-10-17', quote: { id: 'aaaaaaaaaaa4', text: '回首向来萧瑟处，也无风雨也无晴。', trans: '', author: '苏轼', source: '定风波', source_type: 'poetry', tags: [] } },
    ] } });
  });
  await page.goto('/daymark/zh/');
  await expect(page.locator('#dm-w-echo .dm-li')).toHaveText(['10-20世上本没有路，走的人多了，也便成了路。', '10-19人生如逆旅，我亦是行人。', '10-17回首向来萧瑟处，也无风雨也无晴。']);
  await expect(page.locator('#dm-n-echo')).toHaveText('3');
  expect(asked[0]).toBe('?from=2026-10-14&to=2026-10-19');
  /* 10-18 没记下：灰掉 */
  await expect(page.locator('#dm-dcal [data-day="2026-10-18"]')).toBeDisabled();
  await expect(page.locator('#dm-nx a.sgx-nx-a').first()).toHaveText('‹ cat 2026-10-19人生如逆旅，我亦是行人。');
  await page.locator('#dm-dcal [data-day="2026-10-19"]').click();
  await expect(page).toHaveURL(/#d\/2026-10-19$/);
  await expect(page.locator('#dm-cmd-day')).toHaveText('2026-10-19');
  await expect(page.locator('#dm-echo-day')).toHaveText('2026 · 10 · 19 · 星期一');
  await expect(page.locator('#dm-echo-body')).toContainText('人生如逆旅');
  await expect(page.locator('#dm-back-today')).toBeVisible();
  await expect(page.locator('#dm-dcal .dm-dc[aria-current="date"]')).toHaveText('19');
  /* 前后日：往后一天是今天（链接回首页），往前一天 10-18 没记下 */
  await expect(page.locator('#dm-nx a.is-next')).toHaveAttribute('href', '#');
  await expect(page.locator('#dm-nx a.sgx-nx-a').first()).toHaveText('‹ cat 2026-10-18那天没有记下句子。');
  await page.locator('#dm-nx a.sgx-nx-a').first().click();
  await expect(page).toHaveURL(/#d\/2026-10-18$/);
  await expect(page.locator('#dm-echo-body')).toHaveText('那天没有记下句子。');
  /* cat today 回来 */
  await page.locator('#dm-back-today').click();
  await expect(page.locator('#dm-echo-body')).toContainText('世上本没有路');
  await expect(page.locator('#dm-cmd-day')).toHaveText('2026-10-20');
  await expect(page.locator('#dm-back-today')).toBeHidden();
  /* 余响窗的行也能点；点今天格回来 */
  await page.locator('#dm-w-echo .dm-li[href="#d/2026-10-17"]').click();
  await expect(page.locator('#dm-echo-body')).toContainText('也无风雨也无晴');
  await page.locator('#dm-dcal .dm-dc.is-today').click();
  await expect(page.locator('#dm-echo-body')).toContainText('世上本没有路');
  /* 直接打开 #d/<日期> */
  await page.goto('/daymark/zh/#d/2026-10-19');
  await expect(page.locator('#dm-echo-body')).toContainText('人生如逆旅');
  await expect(page.locator('#dm-cmd-day')).toHaveText('2026-10-19');
});
