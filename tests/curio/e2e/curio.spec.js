// 奇趣（手机）：接口用 page.route 假数据，不碰线上。2026-11 对齐 PR-C2（设计稿 pg=curio）：首页 /curio/ 就是「发现」；奇趣重组 PR 2 起页头没有分区 tab 行
//   （#cu-tabs 只剩 grep 一行），/curio/finds/ 301 到首页，游戏是第五个子站 /games/（用例在 games.spec.js），音乐是自己的子站 /music/（用例在 curio-music-*.spec.js）；
//   奇趣重组 PR 3 删了设备 / 电影子页：/curio/devices/、/curio/movies/（含中文）直接 404、不跳，首页旧 hash #devices 也不再转跳。
// - 顶栏：字标 · 页名胶囊（首页 = 奇趣）· 外观 · 盾牌 · >_ · 头像；页头没有分区 tab
// - 账号没登录（canManage=false）：命令链里没有「收藏 / 管理分类 / 导入 / 导出」，只有「su · su 登录后可编辑」打开顶栏终端预填 su （2c，v6 割接）；封面卡点开新标签页；图标取不到显示首字母
// - 分类 chips 筛选 + hash；grep 行内过滤；排序；分页条；#c/<分类> 就地生效；左右滑切分区已删
// - 能编辑（canManage + showPrivate）：私密带锁；没有「su 登录后可编辑」；收藏 → 填网址自动补全 → 保存发 link.add；长按卡片编辑、删除要确认；管理分类；导入发原文
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

/* signedIn = true：接口回 canManage / showPrivate 都是 true（有 curio-manage）；false：都是 false（访客 / 没组）；'use'：只有 curio-use（showPrivate true、canManage false） */
async function mock(page, signedIn) {
  /* 组权限 v1.1 §七、§八：'use' = 只有 curio-use（看得到私密行、canManage false，管理入口不画） */
  const show = signedIn === true || signedIn === 'use';
  const manage = signedIn === true;
  let cats = show
    ? JSON.parse(JSON.stringify(CATS))
    : JSON.parse(JSON.stringify(CATS)).filter((c) => !c.private).map((c) => ({ ...c, links: c.links.filter((l) => !l.private) })).filter((c) => c.links.length);
  const calls = [];
  await page.route('**/avatar/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>' }));
  await page.route('**/api/lock-session-check', (r) => r.fulfill({ json: { ok: true } }));
  /* D-3 a′：可写会话按 root 模拟（whoami 回 root），root 档操作不走领票；非 whoami 的身份请求放行给别的路由。 */
  await page.route('**/api/identity', (r) => { const b = r.request().postData() || ''; return (manage) && b.includes('"whoami"') ? r.fulfill({ json: { ok: true, user: { root: true } } }) : r.fallback(); });
  await page.route('**/api/icon**', (r) => (new URL(r.request().url()).searchParams.get('id') === '11'
    ? r.fulfill({ status: 200, contentType: 'image/png', body: PNG })
    : r.fulfill({ status: 404, json: { ok: false } })));
  await page.route('**/api/preview**', (r) => r.fulfill({ json: { ok: true, url: 'https://mdn.dev/', title: 'MDN Web Docs', desc: 'Web 开发文档', icon: '' } }));
  await page.route('**/api/import**', async (r) => {
    calls.push({ url: r.request().url(), body: r.request().postData(), type: r.request().headers()['content-type'] });
    cats = cats.concat({ id: 9, name: { zh: '工具', en: '' }, private: true, links: [{ id: 91, url: 'https://t.example/', name: { zh: 'T', en: '' }, desc: { zh: '', en: '' }, icon: '', private: true }] });
    return r.fulfill({ json: { ok: true, found: 3, added: 1, skipped: 2, invalid: 0, cats_added: 1, backup: 'imports/x.html', canManage: true, showPrivate: true, cats } });
  });
  await page.route('**/api/links**', async (r) => {
    const req = r.request();
    if (req.method() === 'GET') return r.fulfill({ json: { ok: true, canManage: manage, showPrivate: show, cats } });
    const body = req.postDataJSON();
    calls.push(body);
    if (body.op === 'link.add') cats[0].links.push({ id: 99, url: body.url, name: body.name, desc: body.desc, icon: '', private: !!body.private });
    if (body.op === 'link.del') cats.forEach((c) => { c.links = c.links.filter((l) => l.id !== body.id); });
    if (body.op === 'cat.add') cats.push({ id: 50, name: body.name, private: false, links: [] });
    return r.fulfill({ json: { ok: true, canManage: true, showPrivate: true, cats } });
  });
  return calls;
}

test('组权限 v1.1：只有 curio-use（showPrivate true、canManage false）——看得到私密收藏，但不画收藏 / 管理分类 / 导入 / 导出，长按 / E 不开编辑', async ({ page }) => {
  await mock(page, 'use');
  await page.goto('/curio/zh/');
  await expect(page.locator('.cu-cc')).toHaveCount(3);
  await expect(page.locator('.cu-lock').first()).toBeVisible();
  for (const id of ['#cu-fab', '#menu-cats', '#menu-import', '#menu-export']) await expect(page.locator(id)).toBeHidden();
  await expect(page.locator('html')).not.toHaveClass(/cu-can-write/);
  await page.locator('.cu-cc').first().focus();
  await page.keyboard.press('e');
  await expect(page.locator('#edit-title')).toHaveText('');
});

test('账号未登录：首页就是发现（奇趣重组 PR 2：没有分区 tab 行）；没有收藏 / 管理分类 / 导入 / 导出命令、只看公开、图标取不到显示首字母；快捷面板导航页同主站', async ({ page }) => {
  await mock(page, false);
  await page.goto('/curio/zh/');
  /* 对齐 PR-C2：首页 = ls curio/；奇趣重组 PR 2：下划线分区 tab 行（含计数）去掉，#cu-tabs 只剩 grep 一行 */
  await expect(page.locator('.sgx-ph-cmd')).toHaveText('nobody@space:~$ ls curio/', { useInnerText: true });
  await expect(page.locator('#cu-tabs .sgx-ctab-a, #cu-tabs [data-ctab], [data-cu-count]')).toHaveCount(0);
  await expect(page.locator('#cu-tabs [data-cu-grep]')).toBeVisible();
  await expect(page.locator('#cu-entries, #cu-segs, .sgx-ents, .sgx-segs, #cu-menu-btn')).toHaveCount(0);
  await expect(page.locator('#cu-pane-finds')).toBeVisible();
  await expect(page.locator('.sgx-tb-pill .sgx-seg, .sgx-tb-pill [role="tab"]')).toHaveCount(0);
  await expect(page.locator('.sgx-tb-title')).toHaveText('奇趣');
  await expect(page.locator('.sgx-tb-title')).not.toHaveAttribute('data-sgx-titles', /./);
  /* 顶栏 v3 不显示页名（标记留着） */
  await expect(page.locator('.sgx-tb-title')).toBeHidden();
  await expect(page.locator('#cu-q')).toHaveCount(0);
  await expect(page.locator('#cu-chips [data-cat]')).toHaveText([/^全部\s*2$/, /^开发与云\s*1$/, /^网络检测\s*1$/]);
  await expect(page.locator('.cu-cc')).toHaveCount(2);
  for (const id of ['#cu-fab', '#menu-cats', '#menu-import', '#menu-export']) await expect(page.locator(id)).toBeHidden();
  await expect(page.locator('.cu-lock')).toHaveCount(0);
  /* 分页条：-- 2 / 2 --，排序默认「最近收藏」（新收的在前） */
  await expect(page.locator('[data-pg-count]')).toHaveText('-- 2 / 2 --');
  await expect(page.locator('[data-cu-sort]')).toHaveValue('recent');
  expect(await page.locator('.cu-cc').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')))).toEqual(['21', '11']);
  /* 编辑入口（2c，v6 割接）：「su · su 登录后可编辑」，点了打开顶栏终端、没登录预填 su （data-sec-open）；
     href 只是没 JS 的退路（主站本语言首页 #sec）；不再走旧账号入口（data-acct-open / data-acct-app） */
  await expect(page.locator('#cu-signin')).toBeVisible();
  await expect(page.locator('#cu-signin [data-signin-text]')).toHaveText('su 登录后可编辑');
  await expect(page.locator('#cu-signin')).toHaveAttribute('href', 'https://styrigx.com/zh/#sec');
  await expect(page.locator('#cu-signin')).toHaveAttribute('data-sec-open', '');
  await expect(page.locator('#cu-signin')).not.toHaveAttribute('data-acct-open', /.*/);
  await expect(page.locator('#cu-signin')).not.toHaveAttribute('data-acct-app', /./);
  await expect(page.locator('#cu-signin .sgx-cmd-k')).toHaveText('su');
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
  await expect(page.locator('.sgx-tb-logo')).toHaveAttribute('href', '/zh/'); /* 2026-11-12：logo 四站统一回主站首页 */
  await expect(page.locator('.sgx-tb-acts .sgx-tb-quick')).toHaveAttribute('aria-controls', 'sgx-qp');
  await expect(page.locator('#site-nav > .sgx-tb-ai')).toHaveAttribute('aria-controls', 'sgx-ai');
  /* 头像在顶栏最右（也在 AI 窗口头部），去主站账号页（子站单独起服务时也能到主站：绝对地址） */
  expect(await page.locator('.sgx-tb-acts > *').evaluateAll((els) => els.map((e) => e.className.split(' ').filter((c) => c !== 'sgx-tb-btn')[0]))).toEqual(['sgx-tb-quick', 'sgx-tb-grid', 'sgx-tb-music', 'sgx-tb-shield', 'sgx-tb-sep', 'sgx-tb-term', 'sgx-tb-av'] /* 顶栏 v6（Gray 2026-11-13） */);
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
  await expect(page.locator('footer.sgx-foot .sgx-foot-win a[aria-current="page"]')).toHaveAttribute('data-win', 'curio');
  await expect(page.getByText('Powered by')).toHaveCount(0);
  /* NAVIGATE 面板 #sgx-nav（主站共享外壳 nav.json）：00 主页 · 01 博客 · 02 日刻 · 03 音乐 · 04 奇趣 · 05 游戏（Gray 2026-11-21；旧 05 旷野 2026-11-12 删除，奇趣重组 PR 2 追加 05 游戏），奇趣是当前项；主站项绝对地址，子站之间同源相对；没有搜索框 */
  await page.locator('.sgx-tb-grid').click();
  await expect(page.locator('#sgx-nav')).toHaveAttribute('data-state', 'open');
  await expect(page.locator('#sgx-nav .sgx-nav-tile .sgx-nav-name')).toHaveText(['主页', '博客', '日刻', '音乐', '奇趣', '游戏']);
  await expect(page.locator('#sgx-nav [data-nav-count]')).toHaveText('04/05');
  await expect(page.locator('#sgx-nav [data-nav="games"]')).toHaveAttribute('href', '/games/zh/');
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
  await page.goto('/curio/zh/');
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
  await page.route('**/api/links**', (r) => r.fulfill({ json: { ok: true, canManage: false, showPrivate: false, cats: many } }));
  await page.goto('/curio/zh/');
  await expect(page.locator('.cu-cc')).toHaveCount(11);
  await expect(page.locator('.cu-cc:visible')).toHaveCount(8);
  await expect(page.locator('[data-pg-count]')).toHaveText('-- 8 / 11 --');
  await page.locator('[data-cu-pager]').scrollIntoViewIfNeeded();
  await expect(page.locator('[data-pg-count]')).toHaveText('-- 11 / 11 --');
  await expect(page.locator('.cu-cc:visible')).toHaveCount(11);
});

test('账号已登录（可写）：私密带锁、空分类也在；收藏 → 自动填写 → 保存发 link.add', async ({ page }) => {
  const calls = await mock(page, true);
  await page.goto('/curio/zh/');
  for (const id of ['#cu-fab', '#menu-cats', '#menu-import', '#menu-export']) await expect(page.locator(id)).toBeVisible();
  await expect(page.locator('#cu-fab .sgx-cmd-k')).toHaveText('touch curio/ +');
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
  await page.goto('/curio/zh/');
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
  await page.goto('/curio/zh/');
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

test('英文页：分类名、命令说明用英文（英文空时退回中文）；没有分区 tab（奇趣重组 PR 2）', async ({ page }) => {
  await mock(page, true);
  await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'en'); } catch (e) {} });
  await page.goto('/curio/');
  await expect(page.locator('.sgx-tb-title')).toHaveText('Curio');
  await expect(page.locator('#cu-tabs [data-ctab]')).toHaveCount(0);
  await expect(page.locator('#cu-chips [data-cat]')).toHaveText([/^All/, /^Dev & Cloud/, /^Network Tests/, /^私房/]);
  await expect(page.locator('#menu-cats i')).toHaveText('categories');
  await expect(page.locator('.cu-cc[data-id="11"]')).toHaveAttribute('title', /^Code hosting · /);
  await expect(page.locator('.cu-cc .cu-desc')).toHaveCount(0);
  await expect(page.locator('#menu-export')).toHaveAttribute('href', '/curio/api/export?lang=en');
});

/* ================= 删掉的子页（奇趣重组 PR 3）：设备 / 电影 ================= */

test('设备 / 电影子页删了：/curio/devices/、/curio/movies/（含中文）直接 404、不跳；首页旧 hash #devices、#games 不再转跳；#c/<分类> 首页就地筛选', async ({ page }) => {
  await mock(page, true);
  for (const p of ['/curio/devices/', '/curio/zh/devices/', '/curio/movies/', '/curio/zh/movies/']) {
    const res = await page.goto(p);
    assert404(res, p);
    await expect(page.locator('#cu-pane-devices, #cu-pane-movies, #dv-list, #mv-list, #dv-fab, #mv-fab')).toHaveCount(0);
  }
  await page.goto('/curio/zh/#devices');
  await expect(page).toHaveURL(/\/curio\/zh\/#devices$/);
  await expect(page.locator('#cu-pane-finds')).toBeVisible();
  await page.goto('/curio/zh/#games');
  await expect(page).toHaveURL(/\/curio\/zh\/#games$/);
  await expect(page.locator('#cu-pane-finds')).toBeVisible();
  await expect(page.locator('#gm-fab, #gm-edit-wrap, #dv-edit-wrap, #mv-edit-wrap, #cu-item')).toHaveCount(0);
  await page.goto('/curio/zh/#c/2');
  await expect(page).toHaveURL(/\/curio\/zh\/#c\/2$/);
  await expect(page.locator('#cu-chips [data-cat="2"]')).toHaveAttribute('aria-selected', 'true');
});

/** 删掉的页：Pages（本地静态服务器同规则）回最近一级 404.html、状态 404 @param {import('@playwright/test').Response|null} res @param {string} p */
function assert404(res, p) {
  expect(res, p).not.toBeNull();
  expect(res.status(), p).toBe(404);
}

/* 游戏的添加 / 封面裁剪用例奇趣重组 PR 2 起在 games.spec.js（/games/、/games/api/*） */
