// 奇趣（手机）：接口用 page.route 假数据，不碰线上。2026-11 对齐 PR-C2（设计稿 pg=curio / citem）：首页 /curio/ 就是「发现」，
//   分区 /curio/finds/、/devices/、/games/、/movies/、/music/（中文 /curio/zh/…）是页头的下划线 tab（#cu-tabs）。电影、音乐的用例在 curio-movies-music.spec.js。
// - 顶栏：字标 · 页名胶囊（首页 = 奇趣，子页 = 子页名）· 外观 · 盾牌 · >_ · 头像；页头 tab 带计数，音乐 tab 仅本人可见
// - 账号没登录（canWrite=false）：命令链里没有「收藏 / 管理分类 / 导入 / 导出」，只有「sudo root · 登录账号后可编辑」打开顶栏账号终端（2026-11-08 账号 UI 改版）；封面卡点开新标签页；图标取不到显示首字母
// - 分类 chips 筛选 + hash；grep 行内过滤；排序；分页条；旧 hash 地址（#devices、#games）在首页转到子页（#c/<分类> 就地生效）；左右滑切分区已删
// - 设备 / 游戏：账号没登录只读；条目页 ?id=（取代详情弹层：面包屑、spec 表、换代互链、cd .. / cd ../next）；能编辑时新建（照片缩图后上传）、条目页里编辑、删除；使用天数
// - 能编辑（canWrite + showPrivate）：私密带锁；没有「登录账号后可编辑」；写接口回 401 account 不刷新页面、提示登录；收藏 → 填网址自动补全 → 保存发 link.add；长按卡片编辑、删除要确认；管理分类；导入发原文
// - 英文页
const { test, expect } = require('@playwright/test');

/* 语言清理（2026-11-07）起奇趣 / 日刻也「跟随系统」每页都跳（四站同一份首帧跳转 lang-boot.js），Playwright 默认 en-US 会把 /<站>/zh/… 换到英文页。
   本文件的中文用例按中文浏览器跑（同 ui-cookie.spec.js）；要看英文页的地方先明确选英文（同源 localStorage sgx-lang=en），见 chooseLang。 */
test.use({ locale: 'zh-CN' });
/** 明确选语言（同源 localStorage sgx-lang；'system' = 回到跟随系统）。页面已在本站时用。 @param {import('@playwright/test').Page} page @param {string} l */
const chooseLang = (page, l) => page.evaluate((v) => { localStorage.setItem('sgx-lang', v); }, l);

const CATS = [
  { id: 1, name: { zh: '开发与云', en: 'Dev & Cloud' }, private: false, links: [
    { id: 11, url: 'https://github.com/', name: { zh: 'GitHub', en: '' }, desc: { zh: '代码托管', en: 'Code hosting' }, icon: '', private: false },
    { id: 12, url: 'https://dash.cloudflare.com/', name: { zh: 'Cloudflare', en: '' }, desc: { zh: '域名、CDN 与 Pages', en: '' }, icon: '', private: true },
  ] },
  { id: 2, name: { zh: '网络检测', en: 'Network Tests' }, private: false, links: [
    { id: 21, url: 'https://ip.sb/', name: { zh: 'IP.SB', en: '' }, desc: { zh: 'IPv4 / IPv6 地址查询', en: '' }, icon: '', private: false },
  ] },
  { id: 3, name: { zh: '私房', en: '' }, private: true, links: [] },
];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/* signedIn = true：接口回 canWrite / showPrivate 都是 true（账号已登录）；false：都是 false（进门了、账号没登录） */
async function mock(page, signedIn) {
  let cats = signedIn
    ? JSON.parse(JSON.stringify(CATS))
    : JSON.parse(JSON.stringify(CATS)).filter((c) => !c.private).map((c) => ({ ...c, links: c.links.filter((l) => !l.private) })).filter((c) => c.links.length);
  const calls = [];
  await page.route('**/api/access', (r) => r.fulfill({ json: { ok: true, canWrite: signedIn, showPrivate: signedIn, music: signedIn } }));
  await page.route('**/avatar/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>' }));
  await page.route('**/api/lock-session-check', (r) => r.fulfill({ json: { ok: true } }));
  await page.route('**/api/icon**', (r) => (new URL(r.request().url()).searchParams.get('id') === '11'
    ? r.fulfill({ status: 200, contentType: 'image/png', body: PNG })
    : r.fulfill({ status: 404, json: { ok: false } })));
  await page.route('**/api/preview**', (r) => r.fulfill({ json: { ok: true, url: 'https://mdn.dev/', title: 'MDN Web Docs', desc: 'Web 开发文档', icon: '' } }));
  await page.route('**/api/import**', async (r) => {
    calls.push({ url: r.request().url(), body: r.request().postData(), type: r.request().headers()['content-type'] });
    cats = cats.concat({ id: 9, name: { zh: '工具', en: '' }, private: true, links: [{ id: 91, url: 'https://t.example/', name: { zh: 'T', en: '' }, desc: { zh: '', en: '' }, icon: '', private: true }] });
    return r.fulfill({ json: { ok: true, found: 3, added: 1, skipped: 2, invalid: 0, cats_added: 1, backup: 'imports/x.html', canWrite: true, showPrivate: true, cats } });
  });
  let devices = [
    { id: 1, name: 'Galaxy S23', kind: 'phone', bought_at: '2023-03-01', retired_at: '2025-03-01', replaced_by: 2, os: 'One UI 6', specs: '8GB / 256GB', accessories: '', notes: '小屏好用', photo: false, private: false },
    { id: 2, name: 'Galaxy S25 Ultra', kind: 'phone', bought_at: '2025-03-01', retired_at: '', replaced_by: 0, os: 'One UI 8', specs: '', accessories: '原装壳', notes: '', photo: true, private: false },
    { id: 3, name: '私密平板', kind: 'tablet', bought_at: '', retired_at: '', replaced_by: 0, os: '', specs: '', accessories: '', notes: '', photo: false, private: true },
  ];
  let games = [
    { id: 7, title: '塞尔达传说 王国之泪', platform: 'Switch', device_id: 0, edition: '实体版', status: 'done', rating: 5, review: '神作', cover: false, private: false },
    { id: 8, title: 'Hades II', platform: 'PC', device_id: 0, edition: '', status: 'playing', rating: 0, review: '', cover: false, private: false },
  ];
  if (!signedIn) devices = devices.filter((d) => !d.private);
  let nextId = 100;
  await page.route('**/api/photo**', async (r) => {
    const req = r.request();
    if (req.method() === 'GET') return r.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    calls.push({ photo: req.method(), url: req.url(), type: req.headers()['content-type'], size: (req.postDataBuffer() || Buffer.alloc(0)).length });
    return r.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/items**', async (r) => {
    const req = r.request();
    if (req.method() === 'GET') return r.fulfill({ json: { ok: true, canWrite: signedIn, showPrivate: signedIn, devices, games } });
    const body = req.postDataJSON();
    calls.push(body);
    let id;
    if (body.op === 'device.add') { id = nextId++; devices.push({ photo: false, ...body, id, op: undefined }); }
    if (body.op === 'device.edit') devices = devices.map((d) => (d.id === body.id ? { ...d, ...body, op: undefined } : d));
    if (body.op === 'device.del') devices = devices.filter((d) => d.id !== body.id);
    if (body.op === 'game.add') { id = nextId++; games.push({ cover: false, ...body, id, op: undefined }); }
    return r.fulfill({ json: { ok: true, canWrite: true, showPrivate: true, id, devices, games } });
  });
  await page.route('**/api/links**', async (r) => {
    const req = r.request();
    if (req.method() === 'GET') return r.fulfill({ json: { ok: true, canWrite: signedIn, showPrivate: signedIn, cats } });
    const body = req.postDataJSON();
    calls.push(body);
    if (body.op === 'link.add') cats[0].links.push({ id: 99, url: body.url, name: body.name, desc: body.desc, icon: '', private: !!body.private });
    if (body.op === 'link.del') cats.forEach((c) => { c.links = c.links.filter((l) => l.id !== body.id); });
    if (body.op === 'cat.add') cats.push({ id: 50, name: body.name, private: false, links: [] });
    return r.fulfill({ json: { ok: true, canWrite: true, showPrivate: true, cats } });
  });
  return calls;
}

test('账号未登录：首页就是发现（页头 tab 带计数、音乐 tab 藏着）；没有收藏 / 管理分类 / 导入 / 导出命令、只看公开、图标取不到显示首字母；快捷面板导航页同主站', async ({ page }) => {
  await mock(page, false);
  await page.goto('/curio/zh/');
  /* 对齐 PR-C2：首页 = ls curio/，下划线 tab finds/ devices/ games/ movies/（music/ 仅本人可见，没权限藏着），当前 finds/ */
  await expect(page.locator('.sgx-ph-cmd')).toHaveText('styrigx@space:~$ ls curio/');
  await expect(page.locator('#cu-tabs .sgx-ctab-a')).toHaveCount(5);
  await expect(page.locator('#cu-tabs .sgx-ctab-a:visible')).toHaveText([/^finds\/\s*2$/, /^devices\/\s*2$/, /^games\/\s*2$/, /^movies\//]);
  await expect(page.locator('#cu-tabs [data-ctab="music"]')).toBeHidden();
  await expect(page.locator('#cu-tabs [data-ctab="finds"]')).toHaveAttribute('aria-current', 'page');
  for (const [id, href] of [['finds', '/curio/zh/finds/'], ['devices', '/curio/zh/devices/'], ['games', '/curio/zh/games/'], ['movies', '/curio/zh/movies/'], ['music', '/curio/zh/music/']]) {
    await expect(page.locator(`#cu-tabs [data-ctab="${id}"]`)).toHaveAttribute('href', href);
  }
  await expect(page.locator('#cu-entries, #cu-segs, .sgx-ents, .sgx-segs, #cu-menu-btn')).toHaveCount(0);
  await expect(page.locator('#cu-pane-finds')).toBeVisible();
  await expect(page.locator('.sgx-tb-pill .sgx-seg, .sgx-tb-pill [role="tab"]')).toHaveCount(0);
  await expect(page.locator('.sgx-tb-title')).toHaveText('奇趣');
  await expect(page.locator('.sgx-tb-title')).not.toHaveAttribute('data-sgx-titles', /./);
  /* 顶栏 v3 不显示页名（标记留着） */
  await expect(page.locator('.sgx-tb-title')).toBeHidden();
  await page.locator('#cu-tabs [data-ctab="finds"]').click();
  await expect(page).toHaveURL(/\/curio\/zh\/finds\/$/);
  await expect(page.locator('.sgx-tb-title')).toHaveText('发现');
  await expect(page.locator('.sgx-ph-cmd')).toHaveText('styrigx@space:~$ ls curio/finds/');
  await expect(page.locator('#cu-pane-finds')).toBeVisible();
  await expect(page.locator('#cu-q')).toHaveCount(0);
  await expect(page.locator('#cu-chips [data-cat]')).toHaveText([/^全部\s*2$/, /^开发与云\s*1$/, /^网络检测\s*1$/]);
  await expect(page.locator('.cu-cc')).toHaveCount(2);
  for (const id of ['#cu-fab', '#menu-cats', '#menu-import', '#menu-export']) await expect(page.locator(id)).toBeHidden();
  await expect(page.locator('.cu-lock')).toHaveCount(0);
  /* 分页条：-- 2 / 2 --，排序默认「最近收藏」（新收的在前） */
  await expect(page.locator('[data-pg-count]')).toHaveText('-- 2 / 2 --');
  await expect(page.locator('[data-cu-sort]')).toHaveValue('recent');
  expect(await page.locator('.cu-cc').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')))).toEqual(['21', '11']);
  /* 编辑入口换成「sudo root · 登录账号后可编辑」：点了打开顶栏账号终端（data-acct-open + data-acct-app=curio：登录 → 判授权 → 关面板回本页）；
     href 只是没 JS 的退路（主站本语言首页 #acct&app=curio，2026-11-08 账号 UI 改版） */
  await expect(page.locator('#cu-signin')).toBeVisible();
  await expect(page.locator('#cu-signin [data-signin-text]')).toHaveText('登录账号后可编辑');
  await expect(page.locator('#cu-signin')).toHaveAttribute('href', 'https://styrigx.com/zh/#acct&app=curio');
  await expect(page.locator('#cu-signin')).toHaveAttribute('data-acct-open', '');
  await expect(page.locator('#cu-signin')).toHaveAttribute('data-acct-app', 'curio');
  await expect(page.locator('#cu-signin .sgx-cmd-k')).toHaveText('sudo root');
  const gh = page.locator('.cu-cc[data-id="11"]');
  await expect(gh).toHaveAttribute('href', 'https://github.com/');
  await expect(gh).toHaveAttribute('target', '_blank');
  await expect(gh.locator('.sgx-cc-m')).toHaveText('finds · github.com');
  await expect(gh.locator('.sgx-cc-k')).toHaveText('#开发与云');
  await expect(gh.locator('img')).toHaveCount(1);
  await expect(page.locator('.cu-cc[data-id="21"] img')).toHaveCount(0);
  await expect(page.locator('.cu-cc[data-id="21"] .cu-ic-letter')).toHaveText('I');
  /* 2026-11 UI 重设计 PR-1 顶栏 v3（四站同一个）：通栏 字标 · 页名标记（不显示）· 外观 · 盾牌 · | · >_ · 头像 + 底边进度条；AI 浮钮右下角；
     抽屉、右圆分享删除；每页底部 tmux 页脚（当前窗口 2:curio） */
  expect(await page.locator('.sgx-topbar > *').evaluateAll((els) => els.map((e) => e.className.split(' ')[0]))).toEqual(['sgx-tb-logo', 'sgx-tb-pill', 'sgx-tb-acts', 'sgx-tb-prog']);
  await expect(page.locator('.sgx-tb-logo')).toHaveAttribute('href', '/curio/zh/');
  await expect(page.locator('.sgx-tb-acts .sgx-tb-quick')).toHaveAttribute('aria-controls', 'sgx-qp');
  await expect(page.locator('#site-nav > .sgx-tb-ai')).toHaveAttribute('aria-controls', 'sgx-ai');
  /* 头像在顶栏最右（也在 AI 窗口头部），去主站账号页（子站单独起服务时也能到主站：绝对地址） */
  expect(await page.locator('.sgx-tb-acts > *').evaluateAll((els) => els.map((e) => e.className.split(' ').filter((c) => c !== 'sgx-tb-btn')[0]))).toEqual(['sgx-tb-quick', 'sgx-tb-shield', 'sgx-tb-sep', 'sgx-tb-grid', 'sgx-tb-av']);
  await expect(page.locator('.sgx-tb-acts .sgx-tb-grid')).toHaveAttribute('aria-controls', 'sgx-nav');
  await expect(page.locator('.sgx-tb-acts .sgx-tb-av')).toHaveAttribute('href', 'https://styrigx.com/zh/account/');
  await expect(page.locator('.sgx-tb-acts .sgx-tb-shield')).toHaveAttribute('href', 'https://styrigx.com/zh/security/');
  /* 2026-11 PR-5：账号入口 = 顶栏头像 → 账号下拉（AI 窗口头部不再有头像）；2026-11-08 账号下拉 = 账号终端，没有去账号页的链接 */
  await expect(page.locator('#sgx-acct')).toHaveCount(1);
  await expect(page.locator('#sgx-acct a[href*="/account/"]')).toHaveCount(0);
  await expect(page.locator('.sgx-tb-acts .sgx-tb-avatar')).toHaveAttribute('src', 'https://styrigx.com/avatar/192.webp');
  await expect(page.locator('#sgx-ai .sgx-ai-me')).toHaveCount(0);
  await expect(page.locator('#site-nav .sgx-tb-me')).toHaveCount(0);
  await expect(page.locator('.sgx-tb-nav, #sgx-drawer, .sgx-tb-end, .sgx-tb-share, .sgx-topbar [data-sgx-share], .sgx-tb-end-group, .sgx-tb-guestbook, a[href*="guestbook"]')).toHaveCount(0);
  await expect(page.locator('footer')).toHaveCount(1);
  await expect(page.locator('footer.sgx-foot .sgx-foot-win a[aria-current="page"]')).toHaveAttribute('data-win', 'curio');
  await expect(page.getByText('Powered by')).toHaveCount(0);
  /* NAVIGATE 面板 #sgx-nav（主站共享外壳 nav.json）：01 主页 · 02 博客 · 03 奇趣 · 04 日刻 · 05 旷野，奇趣是当前项；主站项绝对地址，子站之间同源相对；没有搜索框 */
  await page.locator('.sgx-tb-grid').click();
  await expect(page.locator('#sgx-nav')).toHaveAttribute('data-state', 'open');
  await expect(page.locator('#sgx-nav .sgx-nav-tile .sgx-nav-name')).toHaveText(['主页', '博客', '奇趣', '日刻', '旷野']);
  await expect(page.locator('#sgx-nav [data-nav-count]')).toHaveText('03/05');
  await expect(page.locator('#sgx-nav [data-nav="home"]')).toHaveAttribute('href', 'https://styrigx.com/zh/');
  await expect(page.locator('#sgx-nav [data-nav="curio"]')).toHaveAttribute('href', '/curio/zh/');
  await expect(page.locator('#sgx-nav [data-nav="daymark"]')).toHaveAttribute('href', '/daymark/zh/');
  await expect(page.locator('#sgx-nav [data-nav="blog"]')).toHaveAttribute('href', '/blog/zh/');
  await expect(page.locator('#sgx-nav [aria-current="page"]')).toHaveCount(1);
  await expect(page.locator('#sgx-nav [data-nav="curio"]')).toHaveAttribute('aria-current', 'page');
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

test('分类 chips 筛选并写 hash，刷新还在；grep 行内过滤（Esc 收起）；排序「名称」重排；分页滚动加载更多', async ({ page }) => {
  await mock(page, false);
  await page.goto('/curio/zh/finds/');
  await expect(page.locator('#cu-chips [data-cat]')).toHaveText([/^全部/, /^开发与云/, /^网络检测/]);
  await page.locator('#cu-chips [data-cat="2"]').click();
  await expect(page).toHaveURL(/#c\/2$/);
  await expect(page.locator('.cu-cc')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('#cu-chips [data-cat="2"]')).toHaveAttribute('aria-selected', 'true');
  await page.locator('#cu-chips [data-cat="0"]').click();
  await expect(page.locator('.cu-cc')).toHaveCount(2);
  /* grep：点「grep _」变成行内输入；按名字 / 域名 / #分类过滤；没有匹配时一句提示；Esc 清空收起 */
  await expect(page.locator('#cu-grep-box')).toBeHidden();
  await page.locator('[data-cu-grep]').click();
  await expect(page.locator('#cu-grep')).toBeFocused();
  await page.locator('#cu-grep').fill('#网络');
  await expect(page.locator('.cu-cc:visible')).toHaveCount(1);
  await expect(page.locator('.cu-cc:visible')).toHaveAttribute('data-id', '21');
  await expect(page.locator('[data-pg-count]')).toHaveText('-- 1 / 1 --');
  await page.locator('#cu-grep').fill('nothing-here');
  await expect(page.locator('.cu-cc:visible')).toHaveCount(0);
  await expect(page.locator('[data-cu-nomatch]')).toBeVisible();
  await page.locator('#cu-grep').press('Escape');
  await expect(page.locator('#cu-grep-box')).toBeHidden();
  await expect(page.locator('[data-cu-grep]')).toBeVisible();
  await expect(page.locator('.cu-cc:visible')).toHaveCount(2);
  /* 排序：名称（GitHub < IP.SB） */
  await page.locator('[data-cu-sort]').selectOption('name');
  expect(await page.locator('.cu-cc').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')))).toEqual(['11', '21']);
  await page.locator('[data-cu-sort]').selectOption('recent');
  expect(await page.locator('.cu-cc').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')))).toEqual(['21', '11']);
});

test('分页：先显示一页（手机 8 张），分页条滚进视口再加一页，左边「-- 已显示 / 共 --」', async ({ page }) => {
  await mock(page, false);
  const many = [{ id: 1, name: { zh: '很多', en: '' }, private: false, links: Array.from({ length: 11 }, (_, i) => ({ id: 200 + i, url: `https://s${i}.example/`, name: { zh: '站' + i, en: '' }, desc: { zh: '', en: '' }, icon: '', private: false })) }];
  await page.route('**/api/links**', (r) => r.fulfill({ json: { ok: true, canWrite: false, showPrivate: false, cats: many } }));
  await page.goto('/curio/zh/finds/');
  await expect(page.locator('.cu-cc')).toHaveCount(11);
  await expect(page.locator('.cu-cc:visible')).toHaveCount(8);
  await expect(page.locator('[data-pg-count]')).toHaveText('-- 8 / 11 --');
  await expect(page.locator('#cu-tabs [data-cu-count="finds"]')).toHaveText('11');
  await page.locator('[data-cu-pager]').scrollIntoViewIfNeeded();
  await expect(page.locator('[data-pg-count]')).toHaveText('-- 11 / 11 --');
  await expect(page.locator('.cu-cc:visible')).toHaveCount(11);
});

test('账号已登录（可写）：私密带锁、空分类也在；收藏 → 自动填写 → 保存发 link.add', async ({ page }) => {
  const calls = await mock(page, true);
  await page.goto('/curio/zh/finds/');
  for (const id of ['#cu-fab', '#menu-cats', '#menu-import', '#menu-export']) await expect(page.locator(id)).toBeVisible();
  await expect(page.locator('#cu-fab .sgx-cmd-k')).toHaveText('touch curio/finds/ +');
  await expect(page.locator('#cu-signin')).toBeHidden();
  await expect(page.locator('.cu-cc[data-id="12"] .cu-lock')).toHaveCount(1);
  /* 空的私密分类也有 chip（账号已登录） */
  await expect(page.locator('#cu-chips [data-cat]')).toHaveCount(4);
  await page.locator('#cu-fab').click();
  await expect(page.locator('#edit-wrap')).toHaveClass(/open/);
  await expect(page.locator('#edit-title')).toHaveText('收藏');
  await page.locator('#f-url').fill('mdn.dev');
  await page.locator('#f-fill').click();
  await expect(page.locator('#f-name')).toHaveValue('MDN Web Docs');
  await expect(page.locator('#f-desc')).toHaveValue('Web 开发文档');
  await expect(page.locator('#f-cats .cu-chip[aria-checked="true"]')).toHaveText('开发与云');
  await page.locator('#f-cats .cu-chip[data-cat="2"]').click();
  await page.locator('#edit-save').click();
  await expect(page.locator('#edit-wrap')).not.toHaveClass(/open/);
  const add = calls.find((c) => c.op === 'link.add');
  expect(add).toMatchObject({ url: 'https://mdn.dev/', cat: 2, name: { zh: 'MDN Web Docs', en: '' }, desc: { zh: 'Web 开发文档', en: '' }, private: false });
  await expect(page.locator('#bk-toast')).toHaveText('已保存');
});

test('账号已登录（可写）：长按卡片编辑，删除要确认', async ({ page }) => {
  const calls = await mock(page, true);
  await page.goto('/curio/zh/finds/');
  const tile = page.locator('.cu-cc[data-id="21"]');
  const box = await tile.boundingBox();
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await expect(page.locator('#edit-wrap')).toHaveClass(/open/);
  await expect(page.locator('#f-url')).toHaveValue('https://ip.sb/');
  await expect(page.locator('#f-move')).toBeVisible();
  await page.locator('#edit-del').click();
  await expect(page.locator('#confirm-wrap')).toHaveClass(/open/);
  await page.locator('#confirm-ok').click();
  await expect.poll(() => calls.some((c) => c.op === 'link.del' && c.id === 21)).toBe(true);
  await expect(page.locator('.cu-cc[data-id="21"]')).toHaveCount(0);
});

test('账号已登录（可写）：管理分类新建；导入把文件原文发给 /api/import（默认私密）并显示结果', async ({ page }) => {
  const calls = await mock(page, true);
  await page.goto('/curio/zh/finds/');
  await page.locator('#menu-cats').click();
  await expect(page.locator('#cats-list .cu-catrow')).toHaveCount(3);
  await expect(page.locator('#cats-list .cu-catrow[data-id="1"] [data-act="del"]')).toBeDisabled();
  await expect(page.locator('#cats-list .cu-catrow[data-id="3"] [data-act="del"]')).toBeEnabled();
  await page.locator('#cats-new').fill('读书');
  await page.locator('#cats-add').click();
  await expect(page.locator('#cats-list .cu-catrow')).toHaveCount(4);
  expect(calls.find((c) => c.op === 'cat.add')).toMatchObject({ name: { zh: '读书', en: '' } });
  await page.locator('#cats-wrap [data-close="cats"]').first().click();

  await page.locator('#menu-import').click();
  await expect(page.locator('#imp-go')).toBeDisabled();
  const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><A HREF="https://t.example/">T</A></DL>';
  await page.locator('#imp-file').setInputFiles({ name: 'bookmarks.html', mimeType: 'text/html', buffer: Buffer.from(html) });
  await expect(page.locator('#imp-file-name')).toHaveText('bookmarks.html');
  await page.locator('#imp-go').click();
  await expect(page.locator('#imp-msg')).toHaveText('新增 1 条、1 个分类，2 条已经有了。');
  const imp = calls.find((c) => c.url && c.url.includes('/api/import'));
  expect(imp.body).toBe(html);
  expect(imp.url).not.toContain('private=0');
  await expect(page.locator('.cu-cc[data-id="91"]')).toHaveCount(1);
});

test('写接口回 401 account（账号会话刚过期）不刷新页面、提示登录账号；导入回 401 reauth 提示去账号页验证（带链接）', async ({ page }) => {
  await mock(page, true);
  /* 后注册的路由先匹配：写请求改成账号侧的 401 */
  await page.route('**/api/links**', (r) => (r.request().method() === 'POST'
    ? r.fulfill({ status: 401, json: { ok: false, error: 'account' } })
    : r.fallback()));
  await page.route('**/api/import**', (r) => r.fulfill({ status: 401, json: { ok: false, error: 'reauth' } }));
  let reloads = 0;
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) reloads++; });
  await page.goto('/curio/zh/finds/');
  await expect(page.locator('#cu-fab')).toBeVisible();
  const before = reloads;
  await page.locator('#cu-fab').click();
  /* 与「收藏」用例同一路径：等编辑框打开，用「自动填」带出名字（手机视口下直接 fill #f-name 不稳） */
  await expect(page.locator('#edit-wrap')).toHaveClass(/open/);
  await page.locator('#f-url').fill('mdn.dev');
  await page.locator('#f-fill').click();
  await expect(page.locator('#f-name')).toHaveValue('MDN Web Docs');
  await page.locator('#edit-save').click();
  await expect(page.locator('#edit-err')).toHaveText('登录账号后可编辑。');
  await page.locator('#edit-wrap button[data-close="edit"]').click();

  await page.locator('#menu-import').click();
  const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><A HREF="https://t.example/">T</A></DL>';
  await page.locator('#imp-file').setInputFiles({ name: 'bookmarks.html', mimeType: 'text/html', buffer: Buffer.from(html) });
  await page.locator('#imp-go').click();
  await expect(page.locator('#imp-msg')).toContainText('导入前要再验证一次账号');
  /* 2026-11-08：打开顶栏账号终端只做 sudo root reauth（验过关面板，reauth 票留给导入用） */
  await expect(page.locator('#imp-msg a')).toHaveAttribute('href', 'https://styrigx.com/zh/#acct=reauth');
  await expect(page.locator('#imp-msg a')).toHaveAttribute('data-acct-open', 'reauth');
  await expect(page.locator('#imp-go')).toBeEnabled();
  expect(reloads).toBe(before);
});

test('英文页：tab 提示、分类名、命令说明用英文（英文空时退回中文）', async ({ page }) => {
  await mock(page, true);
  await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'en'); } catch (e) {} });
  await page.goto('/curio/');
  expect(await page.locator('#cu-tabs .sgx-ctab-a').evaluateAll((els) => els.map((e) => e.getAttribute('title')))).toEqual(['Finds', 'Devices', 'Games', 'Movies', 'Music']);
  await expect(page.locator('.sgx-tb-title')).toHaveText('Curio');
  await expect(page.locator('#cu-tabs [data-ctab="finds"]')).toHaveAttribute('href', '/curio/finds/');
  /* 有权限（/curio/api/access music）：音乐 tab 露出来 */
  await expect(page.locator('#cu-tabs [data-ctab="music"]')).toBeVisible();
  await page.goto('/curio/finds/');
  await expect(page.locator('.sgx-tb-title')).toHaveText('Finds');
  await expect(page.locator('#cu-chips [data-cat]')).toHaveText([/^All/, /^Dev & Cloud/, /^Network Tests/, /^私房/]);
  await expect(page.locator('#menu-cats i')).toHaveText('categories');
  await expect(page.locator('.cu-cc[data-id="11"]')).toHaveAttribute('title', /^Code hosting · /);
  await expect(page.locator('.cu-cc .cu-desc')).toHaveCount(0);
  await expect(page.locator('#menu-export')).toHaveAttribute('href', '/curio/api/export?lang=en');
});

/* ================= 子页：设备 / 游戏（P4-3 奇趣拆页） ================= */

test('旧 hash 地址在首页转到子页（客户端兼容，不是 301）：#devices → 设备、#games → 游戏；#c/<分类> 首页就地筛选；子页胶囊 = 子页名，没有左右滑', async ({ page }) => {
  await mock(page, true);
  await page.goto('/curio/zh/#devices');
  await expect(page).toHaveURL(/\/curio\/zh\/devices\/$/);
  await expect(page.locator('.sgx-tb-title')).toHaveText('设备');
  await expect(page.locator('#cu-pane-devices')).toBeVisible();
  await expect(page.locator('#dv-list .it-cc')).toHaveCount(3);
  await expect(page.locator('#dv-fab')).toBeVisible();
  await expect(page.locator('#cu-pane-games, #cu-pane-finds, #gm-fab, #cu-fab, #gm-edit-wrap')).toHaveCount(0);
  await page.goto('/curio/zh/#games');
  await expect(page).toHaveURL(/\/curio\/zh\/games\/$/);
  await expect(page.locator('.sgx-tb-title')).toHaveText('游戏');
  await expect(page.locator('#gm-fab')).toBeVisible();
  await expect(page.locator('#dv-fab, #dv-edit-wrap')).toHaveCount(0);
  await page.goto('/curio/zh/#c/2');
  await expect(page).toHaveURL(/\/curio\/zh\/#c\/2$/);
  await expect(page.locator('#cu-chips [data-cat="2"]')).toHaveAttribute('aria-selected', 'true');
  await chooseLang(page, 'en');
  await page.goto('/curio/#games');
  await expect(page).toHaveURL(/\/curio\/games\/$/);
  await expect(page.locator('.sgx-tb-title')).toHaveText('Games');
  await chooseLang(page, 'system');
  /* 没有 hash / 不认识的 hash：留在首页 */
  await page.goto('/curio/zh/#nope');
  await expect(page).toHaveURL(/\/curio\/zh\/#nope$/);
  await expect(page.locator('#cu-pane-finds')).toBeVisible();
  /* 左右滑切分区已删：子页上横滑不跳页 */
  await page.goto('/curio/zh/devices/');
  const box = await page.locator('#cu-pane-devices').boundingBox();
  const y = box.y + 120;
  await page.locator('#cu-pane-devices').dispatchEvent('touchstart', { touches: [{ identifier: 1, clientX: 300, clientY: y }], changedTouches: [{ identifier: 1, clientX: 300, clientY: y }] });
  await page.locator('#cu-pane-devices').dispatchEvent('touchend', { touches: [], changedTouches: [{ identifier: 1, clientX: 120, clientY: y + 5 }] });
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/\/curio\/zh\/devices\/$/);
});

test('账号未登录：设备 / 游戏只读（没有新建命令、条目页没有编辑）；看不到私密设备；退役的标出来；使用天数算到退役日；条目页 ?id= 换代互链、返回键回列表', async ({ page }) => {
  await mock(page, false);
  await page.goto('/curio/zh/devices/');
  await expect(page.locator('#dv-list .it-name')).toHaveText(['Galaxy S23', 'Galaxy S25 Ultra']);
  await expect(page.locator('#dv-fab')).toBeHidden();
  const s23 = page.locator('#dv-list [data-dev="1"]');
  await expect(s23).toHaveClass(/is-retired/);
  await expect(s23.locator('.sgx-cc-m')).toHaveText('devices · 手机 · One UI 6');
  await expect(s23.locator('.sgx-cc-k')).toHaveText('已退役 · 用了 732 天 · 约 2 年');
  await expect(page.locator('#dv-list [data-dev="2"] img')).toHaveCount(1);
  await page.locator('#dv-chips [data-f="retired"]').click();
  await expect(page.locator('#dv-list .it-cc')).toHaveCount(1);
  await s23.click();
  /* 条目页（设计稿 pg=citem）：地址 ?id=1，列表藏起来；面包屑 cat ~/curio/devices/<名字>；没有编辑命令；体验当短评 */
  await expect(page).toHaveURL(/\/curio\/zh\/devices\/\?id=1$/);
  await expect(page.locator('#cu-item')).toBeVisible();
  await expect(page.locator('#cu-pane-devices')).toBeHidden();
  await expect(page.locator('#cu-tabs')).toBeHidden();
  await expect(page.locator('#cu-item .sgx-crumb')).toHaveText('$cat ~/curio/devices/galaxy-s23');
  await expect(page.locator('#cu-item .sgx-item-t')).toHaveText('Galaxy S23');
  await expect(page.locator('#cu-item .sgx-item-m')).toHaveText('devices · 手机 · 已退役 · 收入于 2023-03');
  await expect(page.locator('#cu-item [data-item-edit]')).toHaveCount(0);
  await expect(page.locator('#cu-item .sgx-item-p')).toHaveText('小屏好用');
  await expect(page.locator('#cu-item .sgx-spec dt')).toContainText(['状态', '用了', '购买', '退役', '系统', '参数', '换成了']);
  /* 第一个：左卡 cd .. 回列表；右卡没有相关文章时 cd ../next（筛选「已退役」下只有它，没有下一个） */
  await expect(page.locator('#cu-item .sgx-nx-a')).toHaveCount(1);
  await expect(page.locator('#cu-item .sgx-nx-a').first()).toContainText('cd ..');
  /* 换代：点「换成了」去新机条目页，那边「换下了」旧机 */
  await page.locator('#cu-item .sgx-spec a[data-item="2"]').click();
  await expect(page).toHaveURL(/\?id=2$/);
  await expect(page.locator('#cu-item .sgx-item-t')).toHaveText('Galaxy S25 Ultra');
  await expect(page.locator('#cu-item .sgx-spec a[data-item="1"]')).toHaveText('Galaxy S23');
  /* 返回键：回到上一个条目，再回到列表 */
  await page.goBack();
  await expect(page.locator('#cu-item .sgx-item-t')).toHaveText('Galaxy S23');
  await page.goBack();
  await expect(page).toHaveURL(/\/curio\/zh\/devices\/$/);
  await expect(page.locator('#cu-item')).toBeHidden();
  await expect(page.locator('#cu-pane-devices')).toBeVisible();
  await expect(page.locator('#cu-signin')).toBeVisible();
  /* 直接打开条目页地址也行；不存在 / 看不到的编号给一句提示 + cd .. */
  await page.goto('/curio/zh/devices/?id=2');
  await expect(page.locator('#cu-item .sgx-item-t')).toHaveText('Galaxy S25 Ultra');
  await page.goto('/curio/zh/devices/?id=3');
  await expect(page.locator('#cu-item .sgx-item-p')).toHaveText('这个条目不存在，或者你看不到它。');
  await page.goto('/curio/zh/games/');
  await expect(page.locator('.sgx-tb-title')).toHaveText('游戏');
  /* 游戏列表默认按「最近」排（编号大的在前，curio-list.js） */
  await expect(page.locator('#gm-list .it-name')).toHaveText(['Hades II', '塞尔达传说 王国之泪']);
  await expect(page.locator('#gm-list [data-game="7"] .it-stars-ro')).toHaveText('★★★★★');
  await page.locator('#gm-chips [data-f="playing"]').click();
  await expect(page.locator('#gm-list .it-name')).toHaveText(['Hades II']);
  await expect(page.locator('#gm-fab')).toBeHidden();
});

test('账号已登录（可写）：添加设备（类型、日期、照片缩图转 webp 上传），详情里编辑成退役并选换成的那台；删除要确认', async ({ page }) => {
  const calls = await mock(page, true);
  await page.goto('/curio/zh/devices/');
  await expect(page.locator('#dv-list .it-cc')).toHaveCount(3);
  await expect(page.locator('#dv-list [data-dev="3"] .cu-lock-inline')).toHaveCount(1);
  await page.locator('#dv-fab').click();
  await expect(page.locator('#dv-edit-wrap')).toHaveClass(/open/);
  await expect(page.locator('#dv-edit-title')).toHaveText('添加设备');
  await page.locator('#dv-save').click();
  await expect(page.locator('#dv-err')).toHaveText('起个名字。');
  await page.locator('#dv-name').fill('Galaxy Watch 8');
  await page.locator('#dv-kind [data-k="watch"]').click();
  await page.locator('#dv-bought').fill('2026-08-01');
  await page.locator('#dv-os').fill('One UI 8 Watch');
  await page.locator('#dv-specs').fill('44mm\n蓝牙版');
  /* 3000×2000 的 PNG：先「移动和缩放」（4:3 框，同卡片），完成后裁成 1200×900、转 webp */
  const big = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 3000; c.height = 2000; const g = c.getContext('2d'); g.fillStyle = '#3a6'; g.fillRect(0, 0, 3000, 2000); return c.toDataURL('image/png').split(',')[1]; });
  await page.locator('#dv-photo').setInputFiles({ name: 'watch.png', mimeType: 'image/png', buffer: Buffer.from(big, 'base64') });
  await expect(page.locator('dialog.cu-crop')).toBeVisible();
  await expect(page.locator('.cu-crop-title')).toHaveText('移动和缩放');
  await page.locator('[data-crop-done]').click();
  await expect(page.locator('dialog.cu-crop')).toBeHidden();
  await expect(page.locator('#dv-photo-prev img')).toHaveCount(1);
  await expect.poll(() => page.locator('#dv-photo-prev img').evaluate((i) => i.naturalWidth + 'x' + i.naturalHeight)).toBe('1200x900');
  await expect(page.locator('#dv-photo-del')).toBeVisible();
  await page.locator('#dv-save').click();
  await expect(page.locator('#dv-edit-wrap')).not.toHaveClass(/open/);
  expect(calls.find((c) => c.op === 'device.add')).toMatchObject({ name: 'Galaxy Watch 8', kind: 'watch', bought_at: '2026-08-01', os: 'One UI 8 Watch', specs: '44mm\n蓝牙版', retired_at: '', replaced_by: 0, private: false });
  await expect.poll(() => calls.find((c) => c.photo === 'POST')).toBeTruthy();
  const up = calls.find((c) => c.photo === 'POST');
  expect(up.url).toContain('kind=device&id=100');
  expect(up.type).toBe('image/webp');
  expect(up.size).toBeGreaterThan(0);
  await expect(page.locator('#bk-toast')).toHaveText('已保存');
  /* 第一次传图：卡片立刻显示照片，不用刷新 */
  await expect(page.locator('#dv-list [data-dev="100"] .sgx-cc-im img')).toHaveCount(1);

  /* 编辑：S25 退役，换成新加的 Watch（只是测选择框）；条目页里的「vim …」编辑 */
  await page.locator('#dv-list [data-dev="2"]').click();
  await expect(page.locator('#cu-item [data-item-edit] .sgx-cmd-k')).toHaveText('vim curio/devices/galaxy-s25-ultra');
  await page.locator('#cu-item [data-item-edit]').click();
  await expect(page.locator('#dv-edit-title')).toHaveText('编辑设备');
  await expect(page.locator('#dv-name')).toHaveValue('Galaxy S25 Ultra');
  await expect(page.locator('#dv-retire-wrap')).toBeHidden();
  await page.locator('label:has(#dv-retired)').click();
  await expect(page.locator('#dv-retire-wrap')).toBeVisible();
  await expect(page.locator('#dv-retired-at')).not.toHaveValue('');
  await expect(page.locator('#dv-replaced option')).toHaveText(['无', 'Galaxy S23', '私密平板', 'Galaxy Watch 8']);
  await page.locator('#dv-retired-at').fill('2026-10-01');
  await page.locator('#dv-replaced').selectOption('100');
  await page.locator('#dv-save').click();
  await expect(page.locator('#dv-edit-wrap')).not.toHaveClass(/open/);
  expect(calls.find((c) => c.op === 'device.edit')).toMatchObject({ id: 2, retired_at: '2026-10-01', replaced_by: 100 });
  await expect(page.locator('#dv-list [data-dev="2"]')).toHaveClass(/is-retired/);
  /* 条目页跟着重画 */
  await expect(page.locator('#cu-item .sgx-item-m')).toContainText('已退役');

  /* 删除：删完回到列表 */
  await page.goBack();
  await page.locator('#dv-list [data-dev="3"]').click();
  await page.locator('#cu-item [data-item-edit]').click();
  await page.locator('#dv-del').click();
  await expect(page.locator('#confirm-msg')).toHaveText('确定删除这台设备吗？');
  await page.locator('#confirm-ok').click();
  await expect.poll(() => calls.some((c) => c.op === 'device.del' && c.id === 3)).toBe(true);
  await expect(page.locator('#dv-list [data-dev="3"]')).toHaveCount(0);
  await expect(page).toHaveURL(/\/curio\/zh\/devices\/$/);
  await expect(page.locator('#cu-pane-devices')).toBeVisible();
});

test('账号已登录（可写）：添加游戏（状态、评分、平台联想、关联设备）', async ({ page }) => {
  const calls = await mock(page, true);
  await page.goto('/curio/zh/games/');
  await page.locator('#gm-fab').click();
  await expect(page.locator('#gm-edit-title')).toHaveText('添加游戏');
  await expect(page.locator('#gm-status [aria-checked="true"]')).toHaveText('想玩');
  await expect(page.locator('#gm-platforms option')).toHaveCount(2);
  await page.locator('#gm-title').fill('绝区零');
  await page.locator('#gm-status [data-s="playing"]').click();
  await page.locator('#gm-platform').fill('Android');
  await page.locator('#gm-device').selectOption('2');
  await page.locator('#gm-rating [data-r="4"]').click();
  await expect(page.locator('#gm-rating .it-star-btn.on')).toHaveCount(4);
  await page.locator('#gm-rating [data-r="4"]').click();
  await expect(page.locator('#gm-rating .it-star-btn.on')).toHaveCount(0);
  await page.locator('#gm-rating [data-r="3"]').click();
  await page.locator('#gm-review').fill('上头');
  await page.locator('#gm-save').click();
  await expect(page.locator('#gm-edit-wrap')).not.toHaveClass(/open/);
  expect(calls.find((c) => c.op === 'game.add')).toMatchObject({ title: '绝区零', status: 'playing', rating: 3, platform: 'Android', device_id: 2, review: '上头', private: false });
  expect(calls.some((c) => c.photo)).toBe(false);
  /* 列表默认按「最近」排（新加的在前，curio-list.js 排序），按名字找这张卡 */
  const card = page.locator('#gm-list .it-cc').filter({ hasText: '绝区零' });
  await expect(card).toHaveCount(1);
  await expect(card.locator('.sgx-cc-m')).toHaveText('games · Android · Galaxy S25 Ultra');
  await expect(card.locator('.it-status')).toHaveText('在玩');
});

/* 一张左右两半不同色的图：裁剪后看缩略图左上角的颜色就知道框住了哪一块 */
async function halves(page, w, h) {
  const b64 = await page.evaluate(([w, h]) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.fillStyle = '#d33'; g.fillRect(0, 0, w / 2, h); g.fillStyle = '#33d'; g.fillRect(w / 2, 0, w / 2, h); return c.toDataURL('image/png').split(',')[1]; }, [w, h]);
  return Buffer.from(b64, 'base64');
}
const frameBox = (page) => page.locator('.cu-crop-frame').boundingBox();

test('账号已登录（可写）：游戏封面「移动和缩放」——框是卡片的 3:4；拖动换位置；取消不改；点缩略图重新调整；Esc 只关裁剪', async ({ page }) => {
  const calls = await mock(page, true);
  await page.goto('/curio/zh/games/');
  await page.locator('#gm-list [data-game="8"]').click();
  await page.locator('#cu-item [data-item-edit]').click();
  await expect(page.locator('#gm-photo-prev')).toBeDisabled();
  const png = await halves(page, 2000, 1000); /* 3:4 框按高盖满：框住 750×1000，只占一半宽 */
  await page.locator('#gm-photo').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('dialog.cu-crop')).toBeVisible();
  const fb = await frameBox(page);
  expect(Math.abs(fb.width / fb.height - 3 / 4)).toBeLessThan(0.01);
  /* 往右拖到头 → 框住左边（红） */
  const cx = fb.x + fb.width / 2, cy = fb.y + fb.height / 2;
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 300, cy, { steps: 6 }); await page.mouse.up();
  await page.locator('[data-crop-done]').click();
  await expect(page.locator('dialog.cu-crop')).toBeHidden();
  const px = (sel) => page.locator(sel).evaluate((i) => new Promise((ok) => {
    const go = () => { const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight; const g = c.getContext('2d'); g.drawImage(i, 0, 0);
      const d = g.getImageData(2, 2, 1, 1).data, e = g.getImageData(c.width - 3, 2, 1, 1).data; ok({ size: c.width + 'x' + c.height, left: d[0] > d[2] ? 'red' : 'blue', right: e[0] > e[2] ? 'red' : 'blue' }); };
    i.complete && i.naturalWidth ? go() : (i.onload = go);
  }));
  expect(await px('#gm-photo-prev img')).toEqual({ size: '750x1000', left: 'red', right: 'red' });
  await expect(page.locator('#gm-photo-prev')).toBeEnabled();
  await expect(page.locator('#gm-photo-prev')).toHaveAttribute('aria-label', '调整照片');
  const before = await page.locator('#gm-photo-prev img').getAttribute('src');
  /* 重新调整：点缩略图回到裁剪，拖到另一头再取消 → 不变 */
  await page.locator('#gm-photo-prev').click();
  await expect(page.locator('dialog.cu-crop')).toBeVisible();
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx - 300, cy, { steps: 6 }); await page.mouse.up();
  await page.getByRole('button', { name: '取消' }).click();
  await expect(page.locator('dialog.cu-crop')).toBeHidden();
  expect(await page.locator('#gm-photo-prev img').getAttribute('src')).toBe(before);
  /* 再点一次，拖到右边，Esc：裁剪关了，编辑弹层还开着，图也不变 */
  await page.locator('#gm-photo-prev').click();
  await expect(page.locator('dialog.cu-crop')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.cu-crop')).toBeHidden();
  await expect(page.locator('#gm-edit-wrap')).toHaveClass(/open/);
  expect(await page.locator('#gm-photo-prev img').getAttribute('src')).toBe(before);
  /* 第三次：接着上次位置往左拖两下到头（框住右半边）完成 → 全蓝 */
  await page.locator('#gm-photo-prev').click();
  await expect(page.locator('dialog.cu-crop')).toBeVisible();
  for (let i = 0; i < 2; i++) { await page.mouse.move(cx + 100, cy); await page.mouse.down(); await page.mouse.move(cx - 200, cy, { steps: 6 }); await page.mouse.up(); }
  await page.locator('[data-crop-done]').click();
  await expect.poll(() => px('#gm-photo-prev img')).toEqual({ size: '750x1000', left: 'blue', right: 'blue' });
  /* 选新图后取消：还是上一张 */
  const now = await page.locator('#gm-photo-prev img').getAttribute('src');
  await page.locator('#gm-photo').setInputFiles({ name: 'other.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('dialog.cu-crop')).toBeVisible();
  await page.locator('[data-crop-cancel]').click();
  expect(await page.locator('#gm-photo-prev img').getAttribute('src')).toBe(now);
  /* 保存才上传 */
  expect(calls.some((c) => c.photo)).toBe(false);
  await page.locator('#gm-save').click();
  await expect.poll(() => calls.find((c) => c.photo === 'POST')).toBeTruthy();
  expect(calls.find((c) => c.photo === 'POST').url).toContain('kind=game&id=8');
  await expect(page.locator('#gm-list [data-game="8"] .sgx-cc-im img')).toHaveCount(1);
  await expect(page.locator('#cu-item .sgx-item-im img')).toHaveCount(1);
  /* 已保存的照片：缩略图不能点（只有刚选、还没保存的图能重新调整） */
  await page.locator('#cu-item [data-item-edit]').click();
  await expect(page.locator('#gm-photo-prev')).toBeDisabled();
});

test('P3-1 账号已登录但奇趣未获授权（canWrite=false、showPrivate=true）：命令链「sudo root · 奇趣未获账号授权」打开账号终端的应用授权层；写接口 403 scope 提示同一句', async ({ page }) => {
  await mock(page, true);
  await page.route('**/api/links**', (r) => (r.request().method() === 'GET'
    ? r.fulfill({ json: { ok: true, canWrite: false, showPrivate: true, cats: [] } })
    : r.fulfill({ status: 403, json: { ok: false, error: 'scope', scope: 'curio.write' } })));
  await page.goto('/curio/zh/finds/');
  await expect(page.locator('#cu-signin')).toBeVisible();
  await expect(page.locator('#cu-signin [data-signin-text]')).toHaveText('奇趣未获账号授权');
  await expect(page.locator('#cu-signin')).toHaveAttribute('href', 'https://styrigx.com/zh/#acct=apps');
  await expect(page.locator('#cu-signin')).toHaveAttribute('data-acct-open', 'apps');
  await expect(page.locator('#cu-signin')).not.toHaveAttribute('data-acct-app', /./);
  await expect(page.locator('#cu-fab')).toBeHidden();
});
