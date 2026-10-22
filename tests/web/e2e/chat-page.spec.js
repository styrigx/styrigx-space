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
const okBody = (parts = ANSWER, sources = SOURCES) => sse([...parts.map((text) => ({ t: 'delta', text })), ...(sources ? [{ t: 'sources', items: sources }] : []), { t: 'done' }]);

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} path
 * @param {{api?: any, visitor?: boolean, lang?: string}} [opt]
 *   api：函数 (n, body) → { status?, body, json? }；不给 = 正常回答
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
  await page.route('**/api/chat', async (route) => {
    const req = route.request();
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
      if (!url.endsWith('/api/chat')) return real(input, init);
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
});
