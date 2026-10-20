/**
 * 访客进入（Turnstile）—— PR3 按用户定稿：直接显示 Cloudflare 官方小组件。
 * - 弹层：标题 + Cloudflare 小组件（appearance 'always'、size 'flexible'、主题 / 语言跟随本站），
 *   渲染时容器可见（自己和祖先都不是 display:none / visibility:hidden），没有本站转圈；
 * - 没有本站计时器：小组件一直不回调也不会出「验证时间过长」；重试只来自 Cloudflare 的
 *   timeout-callback / error-callback / expired-callback（或脚本没加载上、/api/verify 不通过）；
 * - 正确性修复：预加载失败的 <script data-sgx-ts> 被摘掉，重试会重新插入并成功；
 *   重渲染前 turnstile.remove 旧小组件；旧小组件迟到的回调被丢弃（不会 POST /api/verify）。
 *
 * 锁屏测试跑在生产构建（SGX_TEST_SUITE=lock）。?test-no-local-bypass=1 强制走线上验证逻辑。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('./helpers');

async function setZh(page) {
  await page.addInitScript(() => {
    try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
  });
}

async function gotoLockOnline(page) {
  await page.goto('/?lock=1&test-no-local-bypass=1', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#sgx-lock')).toBeVisible({ timeout: 15000 });
}

async function openVerifyFlow(page) {
  await page.click('#sgx-lock-avatar');
  await expect(page.locator('#sgx-method-sheet.visible')).toBeVisible({ timeout: 5000 });
  await page.click('#sgx-mopt-visitor');
  await expect(page.locator('#sgx-verify-title')).toHaveText('正在确认你不是机器人', { timeout: 5000 });
}

/* turnstile 桩：记录每次 render 的参数、容器可见性、remove 调用；回调由测试手动触发 */
async function stubTurnstile(page) {
  await page.addInitScript(() => {
    // @ts-ignore
    window.__ts = { renders: [], removed: [] };
    function visible(el) {
      if (!el || !el.isConnected) return false;
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        if (n.hidden) return false;
      }
      return true;
    }
    // @ts-ignore
    window.turnstile = {
      render: function (el, opts) {
        // @ts-ignore
        const st = window.__ts;
        const dlg = el.closest('dialog');
        st.renders.push({ opts: opts, visible: visible(el), dialogOpen: !!(dlg && dlg.open) });
        return 'w' + st.renders.length;
      },
      remove: function (id) {
        // @ts-ignore
        window.__ts.removed.push(id);
      },
      reset: function () {},
    };
  });
}

/** @returns {Promise<{verifies: string[]}>} */
async function mockVerify(page, status) {
  const rec = { verifies: [] };
  await page.route('**/api/verify', async (route) => {
    const b = JSON.parse(route.request().postData() || '{}');
    rec.verifies.push(b.token);
    await route.fulfill({ status: status || 200, contentType: 'application/json', body: JSON.stringify({ ok: (status || 200) === 200 }) });
  });
  return rec;
}

test.describe('访客进入：Cloudflare 官方小组件原样显示', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await setZh(page);
  });

  test('渲染时容器可见、弹层已打开；appearance always / size flexible / 语言主题跟随；没有本站转圈', async ({ page }) => {
    await stubTurnstile(page);
    await gotoLockOnline(page);
    await openVerifyFlow(page);
    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__ts.renders.length)).toBe(1);
    const r = await page.evaluate(() => {
      const x = /** @type {any} */ (window).__ts.renders[0];
      return { visible: x.visible, dialogOpen: x.dialogOpen, appearance: x.opts.appearance, size: x.opts.size, language: x.opts.language, theme: x.opts.theme, action: x.opts.action };
    });
    expect(r).toEqual({ visible: true, dialogOpen: true, appearance: 'always', size: 'flexible', language: 'zh-CN', theme: 'light', action: 'sgx-entry' });
    await expect(page.locator('#sgx-verify-title')).toHaveText('正在确认你不是机器人');
    await expect(page.locator('.sgx-verify-dlg .sgx-spinner')).toHaveCount(0);
    await expect(page.locator('#sgx-ts-wrap')).not.toHaveAttribute('hidden', /.*/);
  });

  test('没有本站计时器：小组件一直不回调，60 秒后也不出重试', async ({ page }) => {
    await stubTurnstile(page);
    await gotoLockOnline(page);
    await page.clock.install();
    await openVerifyFlow(page);
    await page.clock.fastForward(60000);
    await expect(page.locator('#sgx-verify-retry')).toHaveCount(0);
    await expect(page.locator('#sgx-ts-wrap')).toBeVisible();
  });

  test('Cloudflare timeout-callback → 「验证时间过长」+ 重试；error-callback → 「验证失败」+ 重试', async ({ page }) => {
    await stubTurnstile(page);
    await gotoLockOnline(page);
    await openVerifyFlow(page);
    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__ts.renders.length)).toBe(1);
    await page.evaluate(() => /** @type {any} */ (window).__ts.renders[0].opts['timeout-callback']());
    await expect(page.locator('.sgx-verify-failtx')).toHaveText('验证时间过长');
    await page.click('#sgx-verify-retry');
    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__ts.renders.length)).toBe(2);
    await page.evaluate(() => /** @type {any} */ (window).__ts.renders[1].opts['error-callback']());
    await expect(page.locator('.sgx-verify-failtx')).toHaveText('验证失败');
    await expect(page.locator('#sgx-verify-retry')).toBeVisible();
  });

  test('重渲染前先 remove 旧小组件；旧小组件迟到的 callback 被丢弃，新小组件的 callback 才提交', async ({ page }) => {
    await stubTurnstile(page);
    const rec = await mockVerify(page);
    await gotoLockOnline(page);
    await openVerifyFlow(page);
    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__ts.renders.length)).toBe(1);
    await page.evaluate(() => /** @type {any} */ (window).__ts.renders[0].opts['error-callback']());
    await page.click('#sgx-verify-retry');
    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__ts.renders.length)).toBe(2);
    expect(await page.evaluate(() => /** @type {any} */ (window).__ts.removed)).toContain('w1');
    /* 旧小组件迟到的回调：不提交、不改界面 */
    await page.evaluate(() => {
      const old = /** @type {any} */ (window).__ts.renders[0].opts;
      old.callback('stale-token');
      old['timeout-callback']();
    });
    await page.waitForTimeout(300);
    expect(rec.verifies).toEqual([]);
    await expect(page.locator('#sgx-verify-retry')).toHaveCount(0);
    /* 新小组件的 token 正常提交 → 成功勾 */
    await page.evaluate(() => /** @type {any} */ (window).__ts.renders[1].opts.callback('fresh-token'));
    await expect(page.locator('.sgx-check')).toBeVisible({ timeout: 5000 });
    expect(rec.verifies).toEqual(['fresh-token']);
  });

  test('关掉弹层后旧小组件的回调也被丢弃（关弹层时 remove）', async ({ page }) => {
    await stubTurnstile(page);
    const rec = await mockVerify(page);
    await gotoLockOnline(page);
    await openVerifyFlow(page);
    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__ts.renders.length)).toBe(1);
    await page.click('.sgx-verify-dlg [data-dlg-close]');
    expect(await page.evaluate(() => /** @type {any} */ (window).__ts.removed)).toContain('w1');
    await page.evaluate(() => /** @type {any} */ (window).__ts.renders[0].opts.callback('late'));
    await page.waitForTimeout(300);
    expect(rec.verifies).toEqual([]);
  });
});

test.describe('访客进入：脚本加载失败可重试', () => {
  test.beforeEach(async ({ page }) => {
    await blockExternalRequests(page);
    await setZh(page);
  });

  test('预加载 + 第一次都加载失败 → 「验证失败」；失败的 <script> 被摘掉，点重试重新插入并成功', async ({ page }) => {
    let n = 0;
    const STUB = 'window.turnstile={render:function(el,o){setTimeout(function(){o.callback("tok-"+Date.now())},30);return "w";},remove:function(){},reset:function(){}};';
    await page.route('**/challenges.cloudflare.com/**', async (route) => {
      n++;
      if (n <= 2) {
        await route.fulfill({ status: 503, contentType: 'text/plain', body: 'down' });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/javascript', body: STUB });
    });
    const rec = await mockVerify(page);
    await gotoLockOnline(page);
    /* 等预加载那次失败（标签被摘掉） */
    await expect.poll(() => n, { timeout: 8000 }).toBeGreaterThanOrEqual(1);
    await expect.poll(() => page.evaluate(() => document.querySelectorAll('script[data-sgx-ts]').length)).toBe(0);
    await openVerifyFlow(page);
    await expect(page.locator('.sgx-verify-failtx')).toHaveText('验证失败', { timeout: 10000 });
    await expect.poll(() => page.evaluate(() => document.querySelectorAll('script[data-sgx-ts]').length)).toBe(0);
    await page.click('#sgx-verify-retry');
    await expect(page.locator('.sgx-check')).toBeVisible({ timeout: 10000 });
    expect(n).toBe(3);
    expect(rec.verifies.length).toBe(1);
  });

  test('脚本返回了但没有 window.turnstile → 同样按失败处理，可重试', async ({ page }) => {
    await page.route('**/challenges.cloudflare.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '/* no global */' }));
    await gotoLockOnline(page);
    await openVerifyFlow(page);
    await expect(page.locator('.sgx-verify-failtx')).toHaveText('验证失败', { timeout: 10000 });
    await expect(page.locator('#sgx-verify-retry')).toBeVisible();
  });
});
