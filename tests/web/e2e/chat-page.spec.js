/**
 * 聊天页（/chat/，2026-10-22）验收。/api/chat 一律 mock（page.route 回一段 SSE；逐段流式的用例在页面里替换 fetch，测试手动推事件）。
 * - 空状态：「问点需要联网查的」+ 3 个示例；新对话 / 发送按钮禁用。
 * - 发送（示例 / 输入框 + 按钮 / 桌面 Enter）→ 请求体 { messages:[{role,text}] }、同源带 cookie；回答流式渲染（安全 Markdown）、来源 chip（域名 + 标题，新标签页）。
 * - 流式中：输入框禁用、发送键变「停止」；点停止 → 保留已收到的部分 +「已停止」。
 * - 对话只在 sessionStorage：刷新还在；「新对话」清空。
 * - 错误：403 owner_only（及访客 data-sgx-role="visitor"）→「聊天仅主人可用」卡；429 / SSE rate_limited →「今天的免费额度用完了，明天再来」；
 *   503 no_key →「聊天还没配置」；502 upstream → 重试按钮（点了重新问）；401 →「会话已过期」+ 重新解锁。
 * - XSS：模型输出里的 <img onerror>、<script>、javascript: 链接都不会变成元素 / 链接。
 * - 手机 412×915：输入栏在底部、不压顶栏、不横向溢出；滚到底最后一条不被输入栏挡住。
 * - 模型切换（2026-10-22）：GET /api/chat 给列表 → 输入栏上方药丸；点开底部面板（标题 + ✕、遮罩 / Esc 关、联网 / 不联网药丸、对勾）；
 *   选不联网模型 → POST 带 model、回答脚注是模型名；存 localStorage sgx-chat-model，刷新还在；列表拿不到 → 药丸藏着、不带 model；
 *   429 / model_unavailable →「换个模型」按钮打开面板；meta web:false → 脚注「· 未联网」；宽屏 = 贴着药丸的浮层。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('./helpers');

const SOURCES = [
  { title: 'gohugo.io', uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc' },
  { title: 'Hugo Releases', uri: 'https://github.com/gohugoio/hugo/releases' },
];
const ANSWER = ['Hugo 的最新版本是 **v0.168.0**。', '\n\n- 发布于 10 月\n- 新增 `hugo.Data`', '\n\n详见 [发布说明](https://github.com/gohugoio/hugo/releases)。'];

/** @param {Array<any>} events */
function sse(events) {
  return events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join('');
}
const MODELS = {
  ok: true,
  default: 'gemini-2.5-flash',
  models: [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', search: true },
    { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', search: true },
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', search: false },
    { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', search: false },
  ],
};
const okBody = (parts = ANSWER, sources = SOURCES) => sse([...parts.map((text) => ({ t: 'delta', text })), ...(sources ? [{ t: 'sources', items: sources }] : []), { t: 'done' }]);

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} path
 * @param {{api?: any, visitor?: boolean, lang?: string, models?: any}} [opt]
 *   api：函数 (n, body) → { status?, body, json? }；不给 = 正常回答（只管 POST）
 *   models：GET /api/chat 的 JSON（200）；'fail' = 500；不给 = 404（同静态服务器：没有模型切换，老用例照旧）
 */
async function go(page, path, opt = {}) {
  const lang = opt.lang || (path.startsWith('/en/') ? 'en' : 'zh');
  await blockExternalRequests(page);
  await freezeTime(page);
  await page.addInitScript((l) => { try { localStorage.setItem('sgx-lang', l); } catch (e) {} }, lang);
  if (opt.visitor) {
    /* 网关给访客的页面注入 <html data-sgx-role="visitor">：这里改 HTML 模拟 */
    await page.route((u) => u.pathname === path, async (route) => {
      const res = await route.fetch();
      const html = (await res.text()).replace(/<html(\s|>)/i, '<html data-sgx-role="visitor"$1');
      await route.fulfill({ response: res, body: html });
    });
  }
  const calls = [];
  /** @type {number[]} */
  const gets = [];
  await page.route('**/api/chat', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      gets.push(1);
      if (opt.models && opt.models !== 'fail') await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(opt.models) });
      else await route.fulfill({ status: opt.models === 'fail' ? 500 : 404, contentType: 'application/json; charset=utf-8', body: '{"ok":false}' });
      return;
    }
    calls.push({ method: req.method(), body: req.postDataJSON(), headers: req.headers() });
    const r = opt.api ? opt.api(calls.length, req.postDataJSON()) : { body: okBody() };
    if (r.json) {
      await route.fulfill({ status: r.status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(r.json) });
    } else {
      await route.fulfill({ status: r.status || 200, contentType: 'text/event-stream; charset=utf-8', body: r.body });
    }
  });
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#chat-root')).not.toHaveAttribute('aria-busy', 'true');
  // @ts-ignore
  calls.gets = gets;
  return calls;
}

/** 页面里换掉 fetch：/api/chat 回一个测试手动推的流（window.__chatPush(ev) / window.__chatEnd()） */
async function manualStream(page) {
  await page.addInitScript(() => {
    const real = window.fetch.bind(window);
    // @ts-ignore
    window.__chatCalls = 0;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.endsWith('/api/chat') || !init || init.method !== 'POST') return real(input, init);
      // @ts-ignore
      window.__chatCalls++;
      const enc = new TextEncoder();
      let ctrl;
      const stream = new ReadableStream({ start(c) { ctrl = c; } });
      // @ts-ignore
      window.__chatPush = (ev) => ctrl.enqueue(enc.encode('data: ' + JSON.stringify(ev) + '\n\n'));
      // @ts-ignore
      window.__chatEnd = () => ctrl.close();
      const sig = init && init.signal;
      if (sig) sig.addEventListener('abort', () => { try { ctrl.error(new DOMException('aborted', 'AbortError')); } catch (e) {} });
      return Promise.resolve(new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    };
  });
}

test.describe('聊天页（手机 412×915）', () => {
  test.use({ viewport: { width: 412, height: 915 } });

  test('空状态：提示 + 3 个示例；新对话、发送禁用；输入后发送可点', async ({ page }) => {
    await go(page, '/chat/');
    await expect(page.locator('#chat-empty')).toBeVisible();
    await expect(page.locator('#chat-empty .st-msg-title')).toHaveText('问点需要联网查的');
    await expect(page.locator('.chat-ex')).toHaveCount(3);
    await expect(page.locator('#chat-new')).toBeDisabled();
    await expect(page.locator('#chat-send')).toBeDisabled();
    await page.locator('#chat-input').fill('你好');
    await expect(page.locator('#chat-send')).toBeEnabled();
    await expect(page.locator('#chat-input')).toHaveAttribute('placeholder', '问点什么，联网查…');
  });

  test('点示例发送：请求体、回答 Markdown、来源 chip、气泡左右；刷新还在；新对话清空', async ({ page }) => {
    await page.context().addCookies([{ name: 'sgx-test', value: '1', domain: 'localhost', path: '/' }]);
    const calls = await go(page, '/chat/');
    await page.locator('.chat-ex').nth(2).click();
    const model = page.locator('.chat-msg[data-role="model"]');
    await expect(model).toHaveCount(1);
    await expect(model.locator('strong')).toHaveText('v0.168.0');
    await expect(model.locator('.chat-md li')).toHaveText(['发布于 10 月', '新增 hugo.Data']);
    await expect(model.locator('.chat-md code')).toHaveText('hugo.Data');
    const link = model.locator('.chat-md a');
    await expect(link).toHaveAttribute('href', 'https://github.com/gohugoio/hugo/releases');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    /* 来源 chip：gohugo.io（跳转地址不显示主机名）、github.com · Hugo Releases */
    const chips = model.locator('.chat-src');
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0).locator('.chat-src-host')).toHaveText('gohugo.io');
    await expect(chips.nth(1).locator('.chat-src-host')).toHaveText('github.com');
    await expect(chips.nth(1).locator('.chat-src-title')).toHaveText('Hugo Releases');
    await expect(chips.nth(0)).toHaveAttribute('rel', 'noopener noreferrer');
    /* 请求：POST 同源、带 cookie、一条 user */
    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ messages: [{ role: 'user', text: 'Hugo 最新版本是多少？' }] });
    expect(calls[0].headers.cookie || '').toContain('sgx-test=1');
    /* 用户在右、回答在左 */
    const u = await page.locator('.chat-msg[data-role="user"]').boundingBox();
    const m = await model.boundingBox();
    expect(u.x + u.width).toBeGreaterThan(m.x + m.width - 2);
    expect(u.x).toBeGreaterThan(m.x + 20);
    await expect(page.locator('#chat-empty')).toBeHidden();
    await expect(page.locator('#chat-new')).toBeEnabled();
    /* 第二轮：带上前面的对话 */
    await page.locator('#chat-input').fill('那上一个版本呢？');
    await page.locator('#chat-send').click();
    await expect(model).toHaveCount(2);
    expect(calls[1].body.messages.map((x) => x.role)).toEqual(['user', 'model', 'user']);
    expect(calls[1].body.messages[1].text).toContain('**v0.168.0**');
    /* sessionStorage 里有；刷新后还在 */
    const stored = await page.evaluate(() => JSON.parse(sessionStorage.getItem('sgx-chat-convo') || 'null'));
    expect(stored.msgs.length).toBe(4);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.chat-msg[data-role="model"]')).toHaveCount(2);
    await expect(page.locator('.chat-msg[data-role="model"]').first().locator('.chat-src')).toHaveCount(2);
    /* 新对话：清空 */
    await page.locator('#chat-new').click();
    await expect(page.locator('.chat-msg')).toHaveCount(0);
    await expect(page.locator('#chat-empty')).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('sgx-chat-convo'))).toBeNull();
    await expect(page.locator('#chat-new')).toBeDisabled();
  });

  test('流式：逐段出字；流式中输入框禁用、按钮变停止；done 后恢复', async ({ page }) => {
    await manualStream(page);
    await go(page, '/chat/');
    await page.locator('#chat-input').fill('测试流式');
    await page.locator('#chat-send').click();
    await expect(page.locator('.chat-msg[data-live="1"] .chat-typing')).toBeVisible();
    await expect(page.locator('#chat-send')).toHaveAttribute('data-mode', 'stop');
    await expect(page.locator('#chat-send')).toHaveAttribute('aria-label', '停止');
    await expect(page.locator('#chat-input')).toBeDisabled();
    await page.evaluate(() => window.__chatPush({ t: 'delta', text: '第一段' }));
    await expect(page.locator('.chat-msg[data-role="model"] .chat-md')).toHaveText('第一段');
    await page.evaluate(() => window.__chatPush({ t: 'delta', text: '，第二段' }));
    await expect(page.locator('.chat-msg[data-role="model"] .chat-md')).toHaveText('第一段，第二段');
    await page.evaluate(() => { window.__chatPush({ t: 'sources', items: [{ title: 'example.com', uri: 'https://example.com/a' }] }); window.__chatPush({ t: 'done' }); window.__chatEnd(); });
    await expect(page.locator('#chat-send')).toHaveAttribute('data-mode', 'send');
    await expect(page.locator('#chat-input')).toBeEnabled();
    await expect(page.locator('.chat-msg[data-live]')).toHaveCount(0);
    await expect(page.locator('.chat-src-host')).toHaveText('example.com');
  });

  test('停止：保留已收到的部分 +「已停止」', async ({ page }) => {
    await manualStream(page);
    await go(page, '/chat/');
    await page.locator('#chat-input').fill('长一点的问题');
    await page.locator('#chat-send').click();
    await page.evaluate(() => window.__chatPush({ t: 'delta', text: '答到一半' }));
    await expect(page.locator('.chat-msg[data-role="model"] .chat-md')).toHaveText('答到一半');
    await page.locator('#chat-send').click();
    await expect(page.locator('#chat-send')).toHaveAttribute('data-mode', 'send');
    await expect(page.locator('.chat-msg[data-role="model"] .chat-note')).toHaveText('已停止');
    await expect(page.locator('.chat-msg[data-role="model"] .chat-md')).toHaveText('答到一半');
    await expect(page.locator('.chat-err')).toHaveCount(0);
  });

  test('403 owner_only →「聊天仅主人可用」卡，输入关掉', async ({ page }) => {
    await go(page, '/chat/', { api: () => ({ status: 403, json: { ok: false, error: 'owner_only' } }) });
    await page.locator('#chat-input').fill('hi');
    await page.locator('#chat-send').click();
    await expect(page.locator('#chat-gate')).toBeVisible();
    await expect(page.locator('#chat-gate .st-msg-title')).toHaveText('聊天仅主人可用');
    await expect(page.locator('#chat-gate [data-c="btn"]')).toBeHidden();
    await expect(page.locator('#chat-input')).toBeDisabled();
    await expect(page.locator('#chat-send')).toBeDisabled();
    await expect(page.locator('#chat-list')).toBeHidden();
  });

  test('访客（data-sgx-role="visitor"）：一进来就是「聊天仅主人可用」，不发请求', async ({ page }) => {
    const calls = await go(page, '/chat/', { visitor: true });
    await expect(page.locator('#chat-gate .st-msg-title')).toHaveText('聊天仅主人可用');
    await expect(page.locator('#chat-empty')).toBeHidden();
    await expect(page.locator('#chat-input')).toBeDisabled();
    expect(calls.length).toBe(0);
    // @ts-ignore
    expect(calls.gets.length).toBe(0);
    await expect(page.locator('#chat-model')).toBeHidden();
  });

  test('429 / SSE rate_limited →「今天的免费额度用完了，明天再来」，没有重试', async ({ page }) => {
    await go(page, '/chat/', { api: (n) => (n === 1 ? { status: 429, json: { ok: false, error: 'rate_limited' } } : { body: sse([{ t: 'error', code: 'rate_limited' }]) }) });
    await page.locator('#chat-input').fill('a');
    await page.locator('#chat-send').click();
    await expect(page.locator('.chat-err')).toHaveText('今天的免费额度用完了，明天再来');
    await expect(page.locator('.chat-err [data-action="retry"]')).toHaveCount(0);
    await page.locator('#chat-input').fill('b');
    await page.locator('#chat-send').click();
    await expect(page.locator('.chat-err')).toHaveText('今天的免费额度用完了，明天再来');
    await expect(page.locator('.chat-err')).toHaveAttribute('data-code', 'rate_limited');
  });

  test('503 no_key →「聊天还没配置」', async ({ page }) => {
    await go(page, '/chat/', { api: () => ({ status: 503, json: { ok: false, error: 'no_key' } }) });
    await page.locator('#chat-input').fill('a');
    await page.locator('#chat-send').click();
    await expect(page.locator('.chat-err')).toHaveText('聊天还没配置');
  });

  test('502 upstream → 重试按钮，点了重新问同一个问题', async ({ page }) => {
    const calls = await go(page, '/chat/', { api: (n) => (n === 1 ? { status: 502, json: { ok: false, error: 'upstream' } } : { body: okBody(['好了'], null) }) });
    await page.locator('#chat-input').fill('重试我');
    await page.locator('#chat-send').click();
    await expect(page.locator('.chat-err .chat-err-txt')).toHaveText('出错了，没拿到回答');
    await page.locator('.chat-err [data-action="retry"]').click();
    await expect(page.locator('.chat-msg[data-role="model"] .chat-md')).toHaveText('好了');
    await expect(page.locator('.chat-err')).toHaveCount(0);
    expect(calls[1].body).toEqual({ messages: [{ role: 'user', text: '重试我' }] });
  });

  test('401 →「会话已过期」+ 重新解锁', async ({ page }) => {
    await go(page, '/chat/', { api: () => ({ status: 401, json: { ok: false } }) });
    await page.locator('#chat-input').fill('a');
    await page.locator('#chat-send').click();
    await expect(page.locator('#chat-gate .st-msg-title')).toHaveText('会话已过期');
    await expect(page.locator('#chat-gate [data-c="btn"]')).toHaveText('重新解锁');
  });

  test('XSS：<img onerror> / <script> / javascript: 链接只当文字', async ({ page }) => {
    const evil = '<img src=x onerror="window.__pwned=1"> <script>window.__pwned=2</script> [点我](javascript:window.__pwned=3) **ok**';
    await go(page, '/chat/', { api: () => ({ body: okBody([evil], [{ title: 'x', uri: 'javascript:alert(1)' }]) }) });
    await page.locator('#chat-input').fill('evil');
    await page.locator('#chat-send').click();
    const md = page.locator('.chat-msg[data-role="model"] .chat-md');
    await expect(md.locator('strong')).toHaveText('ok');
    await expect(md.locator('img, script')).toHaveCount(0);
    await expect(md.locator('a')).toHaveCount(0);
    await expect(md).toContainText('<img src=x onerror=');
    await expect(page.locator('.chat-src')).toHaveCount(0);
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  });

  test('布局：输入栏在底部、不压顶栏、不横向溢出；滚到底最后一条在输入栏上方', async ({ page }) => {
    const long = Array.from({ length: 14 }, (_, i) => '第 ' + (i + 1) + ' 段：一段比较长的回答文字，用来把页面撑高，看看滚到底时最后一行会不会被输入栏挡住。').join('\n\n');
    await go(page, '/chat/', { api: () => ({ body: okBody([long]) }) });
    await page.locator('#chat-input').fill('长回答');
    await page.locator('#chat-send').click();
    await expect(page.locator('.chat-src')).toHaveCount(2);
    const bar = await page.locator('.chat-bar').boundingBox();
    const top = await page.locator('.sgx-topbar').boundingBox();
    expect(bar.y + bar.height).toBeLessThanOrEqual(915 - 10);
    expect(bar.y).toBeGreaterThan(top.y + top.height + 400);
    expect(bar.x).toBeGreaterThanOrEqual(15);
    expect(bar.x + bar.width).toBeLessThanOrEqual(412 - 15);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(100);
    const last = await page.locator('.chat-msg[data-role="model"]').last().boundingBox();
    const bar2 = await page.locator('.chat-bar').boundingBox();
    expect(last.y + last.height).toBeLessThanOrEqual(bar2.y);
    const foot = await page.locator('footer .sgx-powered').boundingBox();
    expect(foot.y + foot.height).toBeLessThanOrEqual(bar2.y);
  });

  test('英文：文案、占位符、错误', async ({ page }) => {
    await go(page, '/en/chat/', { api: () => ({ status: 429, json: { ok: false, error: 'rate_limited' } }) });
    await expect(page.locator('#chat-empty .st-msg-title')).toHaveText('Ask something that needs the web');
    await expect(page.locator('#chat-input')).toHaveAttribute('placeholder', 'Search the web…');
    await page.locator('.chat-ex').first().click();
    await expect(page.locator('.chat-err')).toHaveText("Today's free quota is used up. Try again tomorrow.");
  });
});

test.describe('聊天页 · 模型切换（手机 412×915）', () => {
  test.use({ viewport: { width: 412, height: 915 } });
  const sheet = (page) => page.locator('#chat-ms');
  const opts = (page) => page.locator('#chat-ms .chat-ms-opt');

  test('药丸 → 底部面板（标题 + ✕、4 行、联网 / 不联网、对勾）；遮罩 / Esc / ✕ 都能关；面板在顶栏和输入栏上面', async ({ page }) => {
    await go(page, '/chat/', { models: MODELS });
    const btn = page.locator('#chat-model');
    await expect(btn).toBeVisible();
    await expect(btn.locator('.chat-model-lbl')).toHaveText('Gemini 2.5 Flash');
    await expect(btn).toHaveAttribute('aria-haspopup', 'listbox');
    await expect(btn).toHaveAttribute('aria-expanded', 'false');
    /* 药丸在输入栏正上方，不重叠 */
    const pb = await btn.boundingBox();
    const bar = await page.locator('.chat-bar').boundingBox();
    expect(pb.y + pb.height).toBeLessThanOrEqual(bar.y);
    expect(pb.x).toBeGreaterThanOrEqual(bar.x - 1);

    await btn.click();
    await expect(sheet(page)).toHaveAttribute('data-state', 'open');
    await expect(btn).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#chat-ms-title')).toHaveText('选择模型');
    await expect(page.locator('#chat-ms-list')).toHaveAttribute('role', 'listbox');
    await expect(opts(page)).toHaveCount(4);
    await expect(opts(page).locator('.chat-ms-lbl')).toHaveText(['Gemini 2.5 Flash', 'Gemini 2.5 Flash-Lite', 'Gemini 3.8 Flash', 'Gemini 3.5 Flash-Lite']);
    await expect(opts(page).locator('.chat-ms-badge')).toHaveText(['联网', '联网', '不联网', '不联网']);
    await expect(opts(page).nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect(opts(page).nth(0).locator('.chat-ms-check svg')).toHaveCount(1);
    await expect(opts(page).nth(2).locator('.chat-ms-check svg')).toHaveCount(0);
    await expect(opts(page).nth(0)).toBeFocused();
    /* 底部面板：贴底、满宽、行高 ≥ 56 */
    const sb = await page.locator('.chat-ms-sheet').boundingBox();
    expect(Math.round(sb.y + sb.height)).toBe(915);
    expect(Math.round(sb.width)).toBe(412);
    const rb = await opts(page).nth(0).boundingBox();
    expect(rb.height).toBeGreaterThanOrEqual(56);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
    /* 面板盖住输入栏（顶层）；顶栏在遮罩下面点不到 */
    const hitBar = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('#chat-ms'), [bar.x + bar.width / 2, bar.y + bar.height / 2]);
    expect(hitBar).toBe(true);
    const hitTop = await page.evaluate(() => { const el = document.elementFromPoint(206, 30); return el ? el.id || el.className : ''; });
    expect(hitTop).toBe('chat-ms');

    await page.keyboard.press('Escape');
    await expect(sheet(page)).toHaveAttribute('data-state', 'closed');
    await expect(btn).toHaveAttribute('aria-expanded', 'false');
    await expect(btn).toBeFocused();
    /* 点遮罩关 */
    await btn.click();
    await expect(sheet(page)).toHaveAttribute('data-state', 'open');
    await page.mouse.click(206, 120);
    await expect(sheet(page)).toHaveAttribute('data-state', 'closed');
    /* ✕ 关 */
    await btn.click();
    await expect(sheet(page)).toHaveAttribute('data-state', 'open');
    await page.locator('.chat-ms-x').click();
    await expect(sheet(page)).toHaveAttribute('data-state', 'closed');
    await expect(page).toHaveURL(/\/chat\/$/);
  });

  test('选不联网模型：POST 带 model、脚注是模型名；存 localStorage，刷新还在；键盘 ↓ + Enter 也能选', async ({ page }) => {
    const calls = await go(page, '/chat/', { models: MODELS, api: () => ({ body: okBody(['凭记忆回答'], null) }) });
    await page.locator('#chat-model').click();
    await opts(page).nth(2).click();
    await expect(sheet(page)).toHaveAttribute('data-state', 'closed');
    await expect(page.locator('#chat-model .chat-model-lbl')).toHaveText('Gemini 3.8 Flash');
    expect(await page.evaluate(() => localStorage.getItem('sgx-chat-model'))).toBe('gemini-3.8-flash');
    /* 不联网模型：占位符不再说「联网查」 */
    await expect(page.locator('#chat-input')).toHaveAttribute('placeholder', '问点什么…');
    await page.locator('#chat-input').fill('不联网问一下');
    await page.locator('#chat-send').click();
    const ans = page.locator('.chat-msg[data-role="model"]');
    await expect(ans.locator('.chat-md')).toHaveText('凭记忆回答');
    await expect(ans.locator('.chat-foot')).toHaveText('Gemini 3.8 Flash');
    expect(calls[0].body).toEqual({ messages: [{ role: 'user', text: '不联网问一下' }], model: 'gemini-3.8-flash' });
    /* 刷新：选择还在、旧回答的脚注还在 */
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#chat-model .chat-model-lbl')).toHaveText('Gemini 3.8 Flash');
    await expect(page.locator('.chat-msg[data-role="model"] .chat-foot')).toHaveText('Gemini 3.8 Flash');
    /* 键盘：打开 → 焦点在当前（第 3 行）→ ↓ → Enter 选第 4 行 */
    await page.locator('#chat-model').focus();
    await page.keyboard.press('Enter');
    await expect(sheet(page)).toHaveAttribute('data-state', 'open');
    await expect(opts(page).nth(2)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(opts(page).nth(3)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(sheet(page)).toHaveAttribute('data-state', 'closed');
    await expect(page.locator('#chat-model .chat-model-lbl')).toHaveText('Gemini 3.5 Flash-Lite');
    /* 选回默认 → 不存 */
    await page.locator('#chat-model').click();
    await opts(page).nth(0).click();
    expect(await page.evaluate(() => localStorage.getItem('sgx-chat-model'))).toBeNull();
    await expect(page.locator('#chat-input')).toHaveAttribute('placeholder', '问点什么，联网查…');
  });

  test('存的模型已经不在列表里 → 用默认', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('sgx-chat-model', 'gemini-old'); } catch (e) {} });
    await go(page, '/chat/', { models: MODELS });
    await expect(page.locator('#chat-model .chat-model-lbl')).toHaveText('Gemini 2.5 Flash');
  });

  test('列表请求失败 → 不显示模型切换，用服务器默认', async ({ page }) => {
    const calls = await go(page, '/chat/', { models: 'fail', api: () => ({ body: okBody(['好'], null) }) });
    await page.locator('#chat-input').fill('a');
    await page.locator('#chat-send').click();
    await expect(page.locator('.chat-msg[data-role="model"] .chat-md')).toHaveText('好');
    await expect(page.locator('#chat-model')).toBeHidden();
    await expect(page.locator('.chat-foot')).toHaveCount(0);
    expect(calls[0].body).toEqual({ messages: [{ role: 'user', text: 'a' }] });
    // @ts-ignore
    expect(calls.gets.length).toBe(1);
  });

  test('429 →「这个模型的免费额度用完了」+「换个模型」打开面板；model_unavailable 同样；bad_model → 换回默认 + 重试', async ({ page }) => {
    const calls = await go(page, '/chat/', {
      models: MODELS,
      api: (n) => [
        { status: 429, json: { ok: false, error: 'rate_limited' } },
        { status: 502, json: { ok: false, error: 'model_unavailable' } },
        { status: 400, json: { ok: false, error: 'bad_model' } },
        { body: okBody(['默认模型答的'], null) },
      ][n - 1],
    });
    await page.locator('#chat-input').fill('a');
    await page.locator('#chat-send').click();
    await expect(page.locator('.chat-err .chat-err-txt')).toHaveText('这个模型的免费额度用完了，可以换个模型');
    await expect(page.locator('.chat-err [data-action="retry"]')).toHaveCount(0);
    await page.locator('.chat-err [data-action="pick"]').click();
    await expect(sheet(page)).toHaveAttribute('data-state', 'open');
    await opts(page).nth(1).click();
    await expect(sheet(page)).toHaveAttribute('data-state', 'closed');
    await expect(page.locator('#chat-model .chat-model-lbl')).toHaveText('Gemini 2.5 Flash-Lite');
    await page.locator('#chat-input').fill('b');
    await page.locator('#chat-send').click();
    await expect(page.locator('.chat-err .chat-err-txt')).toHaveText('这个模型现在用不了，换一个试试');
    await expect(page.locator('.chat-err [data-action="pick"]')).toHaveText('换个模型');
    expect(calls[1].body.model).toBe('gemini-2.5-flash-lite');
    /* 选 3.8 Flash，服务器说 bad_model（白名单改了）→ 换回默认，重试用默认 */
    await page.locator('.chat-err [data-action="pick"]').click();
    await opts(page).nth(2).click();
    await expect(sheet(page)).toHaveAttribute('data-state', 'closed');
    await page.locator('#chat-input').fill('c');
    await page.locator('#chat-send').click();
    await expect(page.locator('.chat-err .chat-err-txt')).toHaveText('这个模型已经下线了，已换回默认模型');
    await expect(page.locator('#chat-model .chat-model-lbl')).toHaveText('Gemini 2.5 Flash');
    await page.locator('.chat-err [data-action="retry"]').click();
    await expect(page.locator('.chat-msg[data-role="model"] .chat-md').last()).toHaveText('默认模型答的');
    expect(calls[3].body.model).toBe('gemini-2.5-flash');
    await expect(page.locator('.chat-msg[data-role="model"] .chat-foot').last()).toHaveText('Gemini 2.5 Flash');
  });

  test('SSE meta web:false（上游拒了搜索工具、不带工具重试）→ 脚注「Gemini 2.5 Flash · 未联网」', async ({ page }) => {
    await go(page, '/chat/', { models: MODELS, api: () => ({ body: sse([{ t: 'meta', web: false }, { t: 'delta', text: '没联网的回答' }, { t: 'done' }]) }) });
    await page.locator('#chat-input').fill('a');
    await page.locator('#chat-send').click();
    await expect(page.locator('.chat-msg[data-role="model"] .chat-foot')).toHaveText('Gemini 2.5 Flash · 未联网');
    await expect(page.locator('.chat-msg[data-role="model"] .chat-foot')).toHaveAttribute('data-noweb', '1');
  });

  test('英文：Choose model / Web / No web / 额度文案', async ({ page }) => {
    await go(page, '/en/chat/', { models: MODELS, api: () => ({ status: 429, json: { ok: false, error: 'rate_limited' } }) });
    await page.locator('#chat-model').click();
    await expect(page.locator('#chat-ms-title')).toHaveText('Choose model');
    await expect(page.locator('.chat-ms-x')).toHaveAttribute('aria-label', 'Close');
    await expect(opts(page).locator('.chat-ms-badge')).toHaveText(['Web', 'Web', 'No web', 'No web']);
    await page.keyboard.press('Escape');
    await page.locator('.chat-ex').first().click();
    await expect(page.locator('.chat-err .chat-err-txt')).toHaveText("This model's free quota is used up — try another");
    await expect(page.locator('.chat-err [data-action="pick"]')).toHaveText('Switch model');
  });
});

test.describe('聊天页（桌面 1280×800）', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('Enter 发送、Shift+Enter 换行；输入栏和正文同宽居中', async ({ page }) => {
    const calls = await go(page, '/chat/', { api: () => ({ body: okBody(['收到'], null) }) });
    const input = page.locator('#chat-input');
    await input.click();
    await input.type('第一行');
    await input.press('Shift+Enter');
    await input.type('第二行');
    await expect(input).toHaveValue('第一行\n第二行');
    await input.press('Enter');
    await expect(page.locator('.chat-msg[data-role="model"] .chat-md')).toHaveText('收到');
    expect(calls[0].body.messages[0].text).toBe('第一行\n第二行');
    await expect(page.locator('.chat-msg[data-role="user"] .chat-bubble br')).toHaveCount(1);
    const bar = await page.locator('.chat-composer').boundingBox();
    expect(Math.abs(bar.x + bar.width / 2 - 640)).toBeLessThanOrEqual(1);
    expect(bar.width).toBeLessThanOrEqual(640);
  });

  test('模型切换（宽屏）：贴着药丸上方的浮层，左边对齐药丸', async ({ page }) => {
    await go(page, '/chat/', { models: MODELS });
    const btn = page.locator('#chat-model');
    await btn.click();
    await expect(page.locator('#chat-ms')).toHaveAttribute('data-state', 'open');
    const pb = await btn.boundingBox();
    const sb = await page.locator('.chat-ms-sheet').boundingBox();
    expect(sb.y + sb.height).toBeLessThanOrEqual(pb.y);
    expect(sb.y + sb.height).toBeGreaterThan(pb.y - 20);
    expect(Math.abs(sb.x - pb.x)).toBeLessThanOrEqual(2);
    expect(sb.width).toBeLessThanOrEqual(362);
    await page.keyboard.press('Escape');
    await expect(page.locator('#chat-ms')).toHaveAttribute('data-state', 'closed');
  });
});
