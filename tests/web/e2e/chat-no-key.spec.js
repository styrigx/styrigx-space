/**
 * 聊天没配钥匙（2026-10-27）：GET /api/chat 回 configured:false（styrigx-chat 没有钥匙绑定，deploy.yml 退一步部署的版本）
 * 或 503 no_key（网关没绑定 CHAT）→ 页面一打开就是「聊天还没配置」卡：输入框 / 发送 / 新对话都关掉，不发 POST。
 * configured:true / 没有这个字段 → 照常。发了问题才回 503 no_key 的情况（绑定在但值读不出来）见 chat-page.spec.js 的错误行用例。
 * /api/chat 一律 mock（同 chat-page.spec.js）。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect } = require('./helpers');

const MODELS = {
  ok: true,
  default: 'gemini-2.5-flash',
  models: [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', search: true },
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', search: false },
  ],
};

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} path
 * @param {{status: number, json: any}} get GET /api/chat 的回答
 */
async function go(page, path, get) {
  const lang = path.startsWith('/en/') ? 'en' : 'zh';
  await blockExternalRequests(page);
  await freezeTime(page);
  await page.addInitScript((l) => { try { localStorage.setItem('sgx-lang', l); } catch (e) {} }, lang);
  /** @type {string[]} */
  const posts = [];
  await page.route('**/api/chat', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      await route.fulfill({ status: get.status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(get.json) });
      return;
    }
    posts.push(req.method());
    await route.fulfill({ status: 503, contentType: 'application/json; charset=utf-8', body: '{"ok":false,"error":"no_key"}' });
  });
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
  return posts;
}

test.describe('聊天没配钥匙：页面一打开就是「聊天还没配置」卡', () => {
  test('configured:false → 卡片（标题 + 说明，没有按钮），输入框 / 发送 / 新对话关掉，模型药丸藏着，不发 POST', async ({ page }) => {
    const posts = await go(page, '/chat/', { status: 200, json: { ...MODELS, configured: false } });
    const gate = page.locator('#chat-gate');
    await expect(gate).toBeVisible();
    await expect(gate).toHaveAttribute('data-kind', 'nokey');
    await expect(gate.locator('[data-c="title"]')).toHaveText('聊天还没配置');
    await expect(gate.locator('[data-c="sub"]')).toHaveText('在 Cloudflare 配好聊天的 API 钥匙后，刷新这一页就能用。');
    await expect(gate.locator('[data-c="btn"]')).toBeHidden();
    await expect(page.locator('#chat-input')).toBeDisabled();
    await expect(page.locator('#chat-send')).toBeDisabled();
    await expect(page.locator('#chat-new')).toBeDisabled();
    await expect(page.locator('#chat-model')).toBeHidden();
    await expect(page.locator('#chat-empty')).toBeHidden();
    expect(posts).toEqual([]);
  });

  test('英文页：网关没绑定 CHAT（GET 503 no_key）→ 英文卡片', async ({ page }) => {
    await go(page, '/en/chat/', { status: 503, json: { ok: false, error: 'no_key' } });
    const gate = page.locator('#chat-gate');
    await expect(gate).toBeVisible();
    await expect(gate.locator('[data-c="title"]')).toHaveText("Chat isn't set up yet");
    await expect(gate.locator('[data-c="sub"]')).toHaveText('Set up the chat API key in Cloudflare, then reload this page.');
    await expect(page.locator('#chat-input')).toBeDisabled();
  });

  test('configured:true → 照常（没有卡片，输入框能用，模型药丸在）', async ({ page }) => {
    await go(page, '/chat/', { status: 200, json: { ...MODELS, configured: true } });
    await expect(page.locator('#chat-model')).toBeVisible();
    await expect(page.locator('#chat-gate')).toBeHidden();
    await expect(page.locator('#chat-input')).toBeEnabled();
  });
});
