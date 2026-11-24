/**
 * AI 窗口（重设计 PR-5 ai-v1；原 topbar/acct-sec-pop.spec.js AI 那一组，2026-11-08 按功能拆文件）：× 关窗、桌面浮在浮钮上方、模型胶囊、来源卡片；
 * 2026-11-24 分档·索引直出（设计稿 v1.0）：401 / 403 索引档、胶囊纯放大镜 + 说明、0 条 / degraded / 429、会话中途 403、按地址去重、头部头像。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, nextFrames, expect } = require('../helpers/helpers');

async function go(page, path, opts = {}) {
  await blockExternalRequests(page);
  await freezeTime(page);
  /* 中文页：先存语言偏好，免得按浏览器语言跳回英文页（同 topbar-spec.spec.js） */
  if (path.indexOf('/zh/') === 0) await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
  if (opts.route) await opts.route(page);
  if (opts.account !== undefined) {
    await page.route('**/api/account**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.account) }));
  }
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-sgx-layout'));
}
const settled = (page, id) => page.waitForFunction((i) => document.getElementById(i).getAnimations({ subtree: true }).every((a) => a.playState !== 'running' || (a.effect && a.effect.getTiming().iterations === Infinity)), id);
/* 页面时钟被 freezeTime 冻住：接口替身里的时间按页面的 Date.now() 算 */
const pageNow = (page) => page.evaluate(() => Date.now());

const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

test.describe('AI 窗口（ai-v1，按设计稿）', () => {
  test('× 关窗，焦点回 AI 浮钮；桌面浮在 AI 浮钮上方、不压暗页面', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await go(page, '/status/');
    await page.locator('.sgx-tb-ai').click();
    const ai = page.locator('#sgx-ai');
    await expect(ai).toHaveAttribute('data-state', 'open');
    await settled(page, 'sgx-ai');
    const g = await page.evaluate(() => {
      const sh = document.querySelector('#sgx-ai .sgx-qp-sheet').getBoundingClientRect();
      const fab = document.querySelector('.sgx-tb-ai').getBoundingClientRect();
      return { shR: sh.right, shB: sh.bottom, fabR: fab.right, fabT: fab.top, bg: getComputedStyle(document.getElementById('sgx-ai')).backgroundColor };
    });
    expect(Math.abs(g.shR - g.fabR)).toBeLessThanOrEqual(1);
    expect(g.shB).toBeLessThan(g.fabT);
    expect(g.bg).toBe('rgba(0, 0, 0, 0)');
    await ai.locator('[data-ai-close]').click();
    await expect(ai).toBeHidden();
    await expect(page.locator('.sgx-tb-ai')).toBeFocused();
  });

  /* ---- 分档·索引直出（2026-11-24 设计稿 v1.0）：GET /api/ai 401 / 403 → 索引档，发问走 GET /api/find?…&mode=recall ---- */
  const FIND = [
    { title: '太阳之子', url: 'https://styrigx.com/music/zh/', site: 'curio', snippet: '奇趣 · 音乐' },
    { title: '伟大的渺小', url: 'https://styrigx.com/music/zh/', site: 'curio', snippet: '奇趣 · 音乐' },
    { title: '晴天', url: 'https://styrigx.com/music/zh/', site: 'curio', snippet: '奇趣 · 音乐' },
    { title: '网站改版：把整个站做成一个终端', url: 'https://styrigx.com/blog/zh/post/terminal/', site: 'blog', snippet: '博客' },
    { title: '动物森友会', url: 'https://styrigx.com/curio/zh/games/acnh/', site: 'curio', snippet: '' },
    { title: 'v5：一个终端', url: 'https://styrigx.com/blog/zh/post/v5/', site: 'blog', snippet: '博客' },
    { title: '身份统一 v6', url: 'https://styrigx.com/blog/zh/post/v6/', site: 'blog', snippet: '博客' },
    { title: '第六条', url: 'https://styrigx.com/blog/zh/post/six/', site: 'blog', snippet: '博客' },
  ];
  /** GET /api/ai 回 status；/api/find 回 findBody（函数：按 URL 给回答）；记下 POST /api/ai 和 /api/find 的请求 */
  async function tiered(page, status, findBody) {
    const log = { posts: 0, finds: [] };
    await page.route('**/api/ai', (r) => {
      if (r.request().method() !== 'GET') log.posts++;
      return r.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ ok: false, error: status === 401 ? 'unauthorized' : 'forbidden' }) });
    });
    await page.route('**/api/find?**', (r) => {
      const u = new URL(r.request().url());
      log.finds.push(u);
      return r.fulfill(findBody ? findBody(u) : json({ ok: true, q: u.searchParams.get('q'), results: FIND }));
    });
    return log;
  }
  async function openAi(page) {
    await page.locator('.sgx-tb-ai').click();
    await expect(page.locator('#sgx-ai')).toHaveAttribute('data-state', 'open');
  }
  const askIn = async (page, q) => {
    const ai = page.locator('#sgx-ai');
    await ai.locator('[data-ai-in]').fill(q);
    await ai.locator('[data-ai-in]').press('Enter');
  };

  for (const [status, who] of [[401, '访客'], [403, '已登录但没有 ai-use']]) {
    test(`索引档 · ${who}：GET /api/ai ${status} → 胶囊是纯放大镜图标（不空、无文字）；发问走 /api/find?mode=recall、不问 AI；按地址去重后前 5 条、整条可点`, async ({ page }) => {
      await go(page, '/zh/status/');
      const log = await tiered(page, status);
      await openAi(page);
      const ai = page.locator('#sgx-ai');
      const chip = ai.locator('[data-ai-model]');
      await expect(chip).toHaveClass(/is-find/);
      await expect(chip).toBeVisible();
      await expect(chip.locator('[data-ai-model-find] svg')).toBeVisible();
      await expect(chip.locator('[data-ai-model-name]')).toBeHidden();
      await expect(chip).toHaveText('', { useInnerText: true });
      await expect(chip).toHaveAttribute('aria-label', '站内搜索（不经 AI）');
      await expect(ai.locator('[data-ai-model-lock]')).toHaveCount(0);
      /* 建议问题换成关键词 */
      await expect(ai.locator('.sgx-ai-sug')).toHaveText(['音乐', '博客', '游戏']);
      await askIn(page, '最近在听什么');
      const items = ai.locator('.sgx-ai-msg[data-find] .sgx-ai-find');
      await expect(items).toHaveCount(5);
      expect(log.posts).toBe(0);
      expect(log.finds.length).toBe(1);
      expect(log.finds[0].searchParams.get('q')).toBe('最近在听什么');
      expect(log.finds[0].searchParams.get('lang')).toBe('zh');
      expect(log.finds[0].searchParams.get('mode')).toBe('recall');
      /* 同一个 /music/zh/ 三条只留第一条 */
      await expect(ai.locator('.sgx-ai-find-t')).toHaveText(['太阳之子', '网站改版：把整个站做成一个终端', '动物森友会', 'v5：一个终端', '身份统一 v6']);
      await expect(items.first().locator('.sgx-ai-find-p')).toHaveText('/music/zh/');
      await expect(items.first().locator('.sgx-ai-find-s')).toHaveText('奇趣 · 音乐');
      await expect(items.nth(1)).toHaveAttribute('href', '/blog/zh/post/terminal/');
      await expect(ai.locator('[data-ai-find-login]')).toHaveCount(0);
      await expect(ai.locator('.sgx-ai-msg[data-state="error"]')).toHaveCount(0);
      /* 整条可点：站内同窗打开（关窗口后跳转） */
      await items.nth(1).click();
      await expect(page).toHaveURL(/\/blog\/zh\/post\/terminal\/$/);
    });
  }

  test('索引档胶囊说明：401 一行说明 + su 按钮（点了打开终端预填 su ）；403 一行说明、没有 su', async ({ page }) => {
    await go(page, '/zh/status/');
    await tiered(page, 401);
    await openAi(page);
    const ai = page.locator('#sgx-ai');
    const chip = ai.locator('[data-ai-model]');
    const info = ai.locator('[data-ai-finfo]');
    await expect(chip).toHaveClass(/is-find/);
    await chip.click();
    await expect(chip).toHaveAttribute('aria-expanded', 'true');
    await expect(info).toBeVisible();
    await expect(info.locator('.sgx-ai-finfo-t')).toHaveText('站内搜索，不经 AI。su 登录后可问 AI');
    await expect(ai.locator('[data-ai-models]')).toBeHidden();
    await info.locator('[data-ai-finfo-su]').click();
    await expect(page.locator('#sgx-term')).toHaveAttribute('open', '');
    await expect(page.locator('#sgx-term [data-term-in]')).toHaveValue('su ');
  });

  test('索引档胶囊说明 · 403：没有 su 按钮', async ({ page }) => {
    await go(page, '/zh/status/');
    await tiered(page, 403);
    await openAi(page);
    const ai = page.locator('#sgx-ai');
    const chip = ai.locator('[data-ai-model]');
    await expect(chip).toHaveClass(/is-find/);
    await chip.click();
    const info = ai.locator('[data-ai-finfo]');
    await expect(info).toBeVisible();
    await expect(info.locator('.sgx-ai-finfo-t')).toHaveText('站内搜索，不经 AI。这个账号没有 AI 权限');
    await expect(info.locator('[data-ai-finfo-su]')).toHaveCount(0);
    await chip.click();
    await expect(info).toBeHidden();
  });

  test('索引档 0 条：一行固定文案 + 「登录后可问 AI」入口（askSudo）；degraded / 429 各一行固定文案；历史里标成搜索', async ({ page }) => {
    await go(page, '/zh/status/');
    await tiered(page, 401, (u) => {
      const q = u.searchParams.get('q');
      if (q === '没有的东西') return json({ ok: true, q, results: [] });
      if (q === '降级') return json({ ok: true, q, results: [], degraded: true });
      if (q === '太快') return { status: 429, contentType: 'application/json', body: '{"ok":false,"error":"cooldown"}' };
      return json({ ok: true, q, results: FIND });
    });
    await openAi(page);
    const ai = page.locator('#sgx-ai');
    await askIn(page, '没有的东西');
    const none = ai.locator('.sgx-ai-msg[data-find]').last();
    await expect(none.locator('.sgx-ai-find-none')).toHaveText('站里没找到相关内容，换个说法试试');
    await expect(none.locator('[data-ai-find-login]')).toHaveText('登录后可问 AI');
    await askIn(page, '降级');
    await expect(ai.locator('.sgx-ai-msg[data-state="error"]').last()).toHaveText('搜索暂时不可用 · 稍后再试');
    await askIn(page, '太快');
    await expect(ai.locator('.sgx-ai-msg[data-state="error"]').last()).toHaveText('搜得太频繁了 · 一分钟后再试');
    /* 点「登录后可问 AI」= 终端预填 su */
    await none.locator('[data-ai-find-login]').click();
    await expect(page.locator('#sgx-term [data-term-in]')).toHaveValue('su ');
    await page.keyboard.press('Escape');
    await expect(page.locator('#sgx-term')).not.toHaveAttribute('open', '');
    /* 历史：这份对话带「搜索」小标记；找回来不重新请求 */
    await page.locator('.sgx-tb-ai').click();
    await expect(ai).toHaveAttribute('data-state', 'open');
    await ai.locator('[data-ai-history]').click();
    await expect(ai.locator('.sgx-ai-hist-item').first().locator('[data-ai-hist-find]')).toHaveText('搜索');
  });

  test('模型档会话中途 POST /api/ai 回 403 forbidden：这一问不显示一般错误，当场切索引档、用同一句重问 /api/find，胶囊换成放大镜', async ({ page }) => {
    await go(page, '/zh/status/');
    const finds = [];
    let posts = 0;
    await page.route('**/api/ai', (r) => {
      if (r.request().method() === 'GET') return r.fulfill(json({ ok: true, default: 'g4', canChoose: false, models: [{ id: 'g4', label: 'Gemma 4' }] }));
      posts++;
      return r.fulfill({ status: 403, contentType: 'application/json', body: '{"ok":false,"error":"forbidden"}' });
    });
    await page.route('**/api/find?**', (r) => {
      const u = new URL(r.request().url());
      finds.push(u);
      return r.fulfill(json({ ok: true, q: u.searchParams.get('q'), results: FIND }));
    });
    await openAi(page);
    const ai = page.locator('#sgx-ai');
    const chip = ai.locator('[data-ai-model]');
    await expect(chip).toHaveText(/Gemma 4/);
    await expect(chip).not.toHaveClass(/is-find/);
    await askIn(page, '在用什么设备');
    await expect(ai.locator('.sgx-ai-msg[data-find] .sgx-ai-find')).toHaveCount(5);
    await expect(ai.locator('.sgx-ai-msg[data-state="error"]')).toHaveCount(0);
    await expect(ai).not.toContainText('当前用户没有 AI 窗口的权限');
    expect(posts).toBe(1);
    expect(finds.map((u) => u.searchParams.get('q'))).toEqual(['在用什么设备']);
    await expect(chip).toHaveClass(/is-find/);
    await expect(chip).toHaveAttribute('aria-label', '站内搜索（不经 AI）');
    /* 之后的问都走索引档 */
    await askIn(page, '游戏');
    await expect(ai.locator('.sgx-ai-msg[data-find]')).toHaveCount(2);
    expect(posts).toBe(1);
    expect(finds.length).toBe(2);
  });

  test('头部头像：/avatar/96.webp（圆形、alt 空、没有 #/$ 角标）；加载失败回落 G', async ({ page }) => {
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    await go(page, '/zh/status/', { route: (p) => p.route('**/avatar/96.webp', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG })) });
    await page.route('**/api/ai', (r) => r.fulfill(json({ ok: true, default: 'g4', canChoose: false, models: [{ id: 'g4', label: 'Gemma 4' }] })));
    await openAi(page);
    const badge = page.locator('#sgx-ai [data-ai-badge]');
    const img = badge.locator('img');
    await expect(img).toHaveAttribute('src', '/avatar/96.webp');
    await expect(img).toHaveAttribute('alt', '');
    await expect(img).toBeVisible();
    expect(await img.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('50%');
    await expect(badge.locator('.sgx-ai-badge-g')).toBeHidden();
    await expect(page.locator('#sgx-ai .sgx-tb-av-mark')).toHaveCount(0);
    await expect(badge).not.toHaveAttribute('data-fallback', '');
  });

  test('头部头像加载失败（404）：回落 G 徽标', async ({ page }) => {
    await go(page, '/zh/status/', { route: (p) => p.route('**/avatar/96.webp', (r) => r.fulfill({ status: 404, body: '' })) });
    await page.route('**/api/ai', (r) => r.fulfill(json({ ok: true, default: 'g4', canChoose: false, models: [{ id: 'g4', label: 'Gemma 4' }] })));
    await openAi(page);
    const badge = page.locator('#sgx-ai [data-ai-badge]');
    await expect(badge).toHaveAttribute('data-fallback', '');
    await expect(badge.locator('img')).toHaveCount(0);
    await expect(badge.locator('.sgx-ai-badge-g')).toBeVisible();
    await expect(badge).toHaveText('G');
  });

  test('R-28：AI 窗口索引档（访客）→ 胶囊说明里的 su → 终端 su 成功（sgx:session live ok）→ 收终端、回 AI 窗口并切回模型档；没登录就关终端不算', async ({ page }) => {
    let authed = false;
    await go(page, '/zh/status/');
    await page.route('**/api/ai', (r) => authed
      ? r.fulfill(json({ ok: true, default: 'g4', canChoose: false, models: [{ id: 'g4', label: 'Gemma 4' }] }))
      : r.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false,"error":"unauthorized"}' }));
    await page.locator('.sgx-tb-ai').click();
    const ai = page.locator('#sgx-ai');
    const chip = ai.locator('[data-ai-model]');
    const term = page.locator('#sgx-term');
    const su = () => page.evaluate(() => window.dispatchEvent(new CustomEvent('sgx:session', { detail: { ok: true, live: true } })));
    const viaSu = async () => { await chip.click(); await ai.locator('[data-ai-finfo-su]').click(); };
    /* 没登录就 Esc 关终端：之后别处 su 成功不回 AI */
    await expect(chip).toHaveClass(/is-find/);
    await viaSu();
    await expect(term).toHaveAttribute('open', '');
    await page.keyboard.press('Escape');
    await expect(term).not.toHaveAttribute('open', '');
    await su();
    /* 没有「从 AI 锁来」那一笔：sgx:session 的处理同步返回（不收终端、不退历史哨兵），没有迟到的重开；两帧后看 */
    await nextFrames(page, 2);
    await expect(ai).not.toHaveAttribute('open', '');
    /* 从 AI 索引档来、su 成功：终端收起，AI 窗口重开、放大镜没了 */
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('sgx:session', { detail: { ok: false, live: true } })));
    await page.locator('.sgx-tb-ai').click();
    await expect(chip).toHaveClass(/is-find/);
    await viaSu();
    await expect(term).toHaveAttribute('open', '');
    await expect(page.locator('#sgx-term [data-term-in]')).toHaveValue('su ');
    authed = true;
    /* 终端滑入走完（modalSheet data-state 到 open）再 su，收终端走正常的滑出 + 退哨兵 */
    await expect(term).toHaveAttribute('data-state', 'open');
    await su();
    await expect(term).not.toHaveAttribute('open', '');
    await expect(ai).toHaveAttribute('open', '');
    await expect(chip).not.toHaveClass(/is-find/);
    await expect(chip).toHaveText(/Gemma 4/);
    /* AI 窗口重开走完（data-state 到 open）、历史里是它自己的哨兵（终端那次 history.back() 的 popstate 已经过去），停住不被关掉 */
    await expect(ai).toHaveAttribute('data-state', 'open');
    await expect.poll(() => page.evaluate(() => !!(history.state && history.state.sgxAi))).toBe(true);
    await expect(ai).toHaveAttribute('open', '');
  });

  test('模型胶囊：登了账号能在窗口里换（写 sgx-ai-model，发问带上）；站内链接只在正文里（不另列来源卡片，ADR-0004 C7）、建议问题点了就问', async ({ page }) => {
    let body = null;
    await go(page, '/zh/status/');
    await page.route('**/api/ai', (r) => {
      if (r.request().method() === 'GET') return r.fulfill(json({ ok: true, default: 'g4', canChoose: true, models: [{ id: 'g4', label: 'Gemma 4' }, { id: 'gf', label: 'Gemini Flash' }] }));
      body = r.request().postDataJSON();
      const sse = 'event: delta\ndata: ' + JSON.stringify({ text: '写过：[AI 代理协作开发规范白皮书](/blog/post/2026-10-11-agent-collaboration-whitepaper-v2/)' }) + '\n\nevent: done\ndata: {}\n\n';
      return r.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: sse });
    });
    await page.locator('.sgx-tb-ai').click();
    const ai = page.locator('#sgx-ai');
    const chip = ai.locator('[data-ai-model]');
    await expect(chip).toHaveText(/Gemma 4/);
    await chip.click();
    await expect(chip).toHaveAttribute('aria-expanded', 'true');
    await ai.locator('.sgx-ai-mopt', { hasText: 'Gemini Flash' }).click();
    await expect(chip).toHaveText(/Gemini Flash/);
    expect(await page.evaluate(() => localStorage.getItem('sgx-ai-model'))).toBe('gf');
    await ai.locator('.sgx-ai-sug').first().click();
    const link = ai.locator('.sgx-ai-md a', { hasText: 'AI 代理协作开发规范白皮书' });
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute('href', '/blog/post/2026-10-11-agent-collaboration-whitepaper-v2/');
    await expect(ai.locator('.sgx-ai-srcs, .sgx-ai-src')).toHaveCount(0);
    expect(body.q).toBe('最近在听什么');
    expect(body.model).toBe('gf');
  });
});
