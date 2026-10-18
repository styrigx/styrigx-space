/**
 * 两扇门验证弹层 UI 回归：One UI 列表行 + 取消 + 标题靠左 + 键盘避让。
 * （#68 重做：#64 的实心大按钮已换成 One UI 列表行，旧断言作废。）
 * - 验证方式为列表行（.sgx-door-row：圆形图标底 + 标题/说明 + 右侧 >），不用大实心按钮
 * - 标题靠左，内容左对齐
 * - 默认底部只有居中的「取消」文字按钮；密码/根凭证展开后底部变「取消 / 验证」两个等宽文字按钮
 * - 移动端视口：输入框聚焦后键盘弹出，弹层整体上移不被遮挡
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('./helpers');

test.use({ viewport: { width: 412, height: 915 } });

async function pinLang(pg, lang) {
  await pg.addInitScript((l) => {
    try { localStorage.setItem('sgx-lang', l); } catch (e) {}
  }, lang);
}

async function mockJson(pg, pattern, status, body) {
  await pg.route(pattern, async (route) => {
    await route.fulfill({
      status: status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

async function gotoSecurity(pg) {
  await pinLang(pg, 'zh');
  await blockExternalRequests(pg);
  /* 站长凭证已配置（密码+通行密钥），管理凭证弹层显示两个行 */
  await mockJson(pg, '**/api/owner-status', 200, { ok: true, password: true, passkey: true });
  await pg.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
  await expect(pg.locator('.set-layout').first()).toBeVisible({ timeout: 15000 });
}

test.describe('door dialog UI', () => {
  test('owner dialog: list rows, cancel, left-aligned title', async ({ page: pg }) => {
    await gotoSecurity(pg);
    await pg.locator('#sec-owner-cred').click();
    const dlg = pg.locator('#sec-verify-dlg');
    await expect(dlg).toBeVisible();

    /* 标题靠左，文案为「进入站长凭证」 */
    await expect(pg.locator('#sec-verify-title')).toContainText('进入站长凭证');
    const titleAlign = await pg.locator('#sec-verify-title').evaluate((el) => getComputedStyle(el).textAlign);
    expect(titleAlign).toBe('left');

    /* 验证方式是列表行：单行「根凭证」，含图标底 + 标题/说明 + 右侧 > */
    const rows = pg.locator('.sgx-door-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('根凭证');
    await expect(rows.first().locator('.sgx-door-ic')).toBeVisible();
    await expect(rows.first().locator('.sgx-door-mid')).toBeVisible();
    await expect(rows.first().locator('.sgx-door-chev')).toBeVisible();

    /* 默认底部只有「取消」文字按钮 */
    const cancel = pg.locator('#sec-verify-foot .sgx-door-btn-secondary');
    await expect(cancel).toBeVisible();
    await expect(cancel).toContainText('取消');
    await expect(pg.locator('#sec-verify-foot .sgx-door-actions')).toHaveCount(0);

    /* 根凭证行展开：单行密码输入框 + 底部变「取消 / 验证」两个等宽文字按钮 */
    await rows.first().click();
    await expect(pg.locator('.sgx-door-expand input[type="password"]')).toBeVisible();
    const actions = pg.locator('#sec-verify-foot .sgx-door-actions .sgx-door-btn');
    await expect(actions).toHaveCount(2);
    await expect(actions.nth(0)).toContainText('取消');
    await expect(actions.nth(1)).toContainText('验证');
  });

  test('mgmt dialog: visitor shows single root row with list styles', async ({ page: pg }) => {
    await gotoSecurity(pg);
    /* 访客假入口：data-sgx-role=visitor 时只显示单个「根凭证」行 */
    await pg.evaluate(() => {
      document.documentElement.dataset.sgxRole = 'visitor';
    });
    await pg.locator('#sec-mgmt-cred').click();
    const dlg = pg.locator('#sec-verify-dlg');
    await expect(dlg).toBeVisible();

    await expect(pg.locator('#sec-verify-title')).toContainText('进入管理凭证');
    const rows = pg.locator('.sgx-door-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('根凭证');
    /* 列表行样式与真入口一致 */
    await expect(rows.first().locator('.sgx-door-ic')).toBeVisible();
    await expect(rows.first().locator('.sgx-door-chev')).toBeVisible();
    await expect(pg.locator('#sec-verify-foot .sgx-door-btn-secondary')).toBeVisible();
  });

  test('mgmt dialog: password row expands inline, dialog stays in viewport', async ({ page: pg }) => {
    await gotoSecurity(pg);
    await pg.locator('#sec-mgmt-cred').click();
    const dlg = pg.locator('#sec-verify-dlg');
    await expect(dlg).toBeVisible();

    /* 两个行：站长通行密钥 + 站长密码 */
    const rows = pg.locator('.sgx-door-row');
    await expect(rows).toHaveCount(2);

    /* 点密码行：弹层内展开输入框，不跳页，自动聚焦 */
    await rows.filter({ hasText: '站长密码' }).click();
    const input = pg.locator('.sgx-door-expand input[type="password"]');
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();

    /* 底部变为「取消 / 验证」两个等宽文字按钮 */
    const actions = pg.locator('#sec-verify-foot .sgx-door-actions .sgx-door-btn');
    await expect(actions).toHaveCount(2);

    /* 展开态弹层整体仍在视口内（键盘避让由本文件的 door keyboard avoidance 功能测试覆盖） */
    const box = await pg.locator('.sgx-door-card').boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(915);
  });
});

test.describe('door keyboard avoidance', () => {
  /**
   * 键盘避让功能测试（非视觉，不占基线）：
   * 污点 window.visualViewport 模拟键盘弹出，验证 followKeyboard 真的把弹层上移、
   * 输入框与「验证」按钮保持在可见区内、视口恢复后弹层回到底部。
   * （visual 的 keyboard 用例已删：headless 下无法触发真实键盘高度变化。）
   */
  async function taintViewport(pg) {
    await pg.evaluate(() => {
      /* 强制走 visualViewport 回退路径：headless Chromium 可能自带 VirtualKeyboard API */
      try {
        Object.defineProperty(Navigator.prototype, 'virtualKeyboard', {
          configurable: true,
          get: () => undefined,
        });
      } catch (e) {}
      const real = window.visualViewport;
      const fake = {
        width: real ? real.width : window.innerWidth,
        height: real ? real.height : window.innerHeight,
        offsetTop: 0,
        offsetLeft: 0,
        scale: 1,
        _l: {},
      };
      fake.addEventListener = function (t, f) {
        (this._l[t] = this._l[t] || []).push(f);
      };
      fake.removeEventListener = function (t, f) {
        const a = this._l[t];
        if (a) {
          const i = a.indexOf(f);
          if (i !== -1) a.splice(i, 1);
        }
      };
      /* 测试用：设置高度并触发 resize（模拟键盘弹出/收起） */
      fake.__setHeight = function (h) {
        this.height = h;
        (this._l.resize || []).slice().forEach((f) => f());
      };
      Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        get: () => fake,
      });
      window.__fakeVV = fake;
    });
  }

  async function waitFrames(pg, n) {
    await pg.evaluate(
      (count) =>
        new Promise((resolve) => {
          const tick = () => {
            if (count <= 1) resolve();
            else {
              count -= 1;
              requestAnimationFrame(tick);
            }
          };
          requestAnimationFrame(tick);
        }),
      n
    );
  }

  /* 两扇门共用的键盘避让断言流程 */
  async function keyboardAvoidance(pg, openDoor, inputSel, kbHeight) {
    await gotoSecurity(pg);
    await taintViewport(pg);
    await openDoor();
    const dlg = pg.locator('#sec-verify-dlg');
    await expect(dlg).toBeVisible();
    const input = pg.locator(inputSel);
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();

    const orig = await dlg.evaluate((el) => ({
      transform: el.style.transform,
      bottom: el.getBoundingClientRect().bottom,
    }));
    expect(orig.transform).toBe('');

    /* 模拟键盘弹出：visualViewport 高度缩小 kbHeight（onKeyboardHeight 经 rAF 节流） */
    await pg.evaluate((kb) => window.__fakeVV.__setHeight(window.innerHeight - kb), kbHeight);
    await waitFrames(pg, 3);

    const raised = await pg.evaluate(() => {
      const sheet = document.getElementById('sec-verify-dlg');
      const vv = window.__fakeVV;
      const r = sheet.getBoundingClientRect();
      const inputEl = document.querySelector('.sgx-door-expand input[type="password"]');
      const btnEl = document.querySelector('#sec-verify-foot .sgx-door-btn-primary');
      const ir = inputEl.getBoundingClientRect();
      const br = btnEl.getBoundingClientRect();
      return {
        transform: sheet.style.transform,
        sheetBottom: r.bottom,
        vvBottom: vv.offsetTop + vv.height,
        inputTop: ir.top,
        inputBottom: ir.bottom,
        btnTop: br.top,
        btnBottom: br.bottom,
      };
    });

    /* followKeyboard 真的被调用：弹层上移了键盘高度 */
    expect(raised.transform).toBe('translateY(' + -kbHeight + 'px)');
    /* 弹层底边不超出 visualViewport */
    expect(raised.sheetBottom).toBeLessThanOrEqual(raised.vvBottom + 1);
    /* 输入框与「验证」按钮都在可见区内 */
    expect(raised.inputTop).toBeGreaterThanOrEqual(0);
    expect(raised.inputBottom).toBeLessThanOrEqual(raised.vvBottom + 1);
    expect(raised.btnTop).toBeGreaterThanOrEqual(0);
    expect(raised.btnBottom).toBeLessThanOrEqual(raised.vvBottom + 1);

    /* 恢复视口 + 失焦：弹层回到底部 */
    await pg.evaluate(() => window.__fakeVV.__setHeight(window.innerHeight));
    await input.evaluate((el) => el.blur());
    await waitFrames(pg, 3);
    const restored = await dlg.evaluate((el) => ({
      transform: el.style.transform,
      bottom: el.getBoundingClientRect().bottom,
    }));
    expect(restored.transform).toBe('');
    expect(Math.abs(restored.bottom - orig.bottom)).toBeLessThanOrEqual(2);
  }

  test('mgmt door: keyboard raises sheet, input and verify stay visible', async ({ page: pg }) => {
    await keyboardAvoidance(
      pg,
      async () => {
        await pg.locator('#sec-mgmt-cred').click();
        await expect(pg.locator('.sgx-door-row')).toHaveCount(2);
        await pg.locator('.sgx-door-row').filter({ hasText: '站长密码' }).click();
      },
      '.sgx-door-expand input[type="password"]',
      300
    );
  });

  test('owner door: keyboard raises sheet, input and verify stay visible', async ({ page: pg }) => {
    await keyboardAvoidance(
      pg,
      async () => {
        await pg.locator('#sec-owner-cred').click();
        await expect(pg.locator('.sgx-door-row')).toHaveCount(1);
        await pg.locator('.sgx-door-row').first().click();
      },
      '.sgx-door-expand input[type="password"]',
      300
    );
  });
});

test.describe('door dialog eye button (批次 A 验收修复 P2)', () => {
  test('password row expand: eye starts eye-off, toggles icon/label/pressed, keeps focus', async ({ page: pg }) => {
    await gotoSecurity(pg);
    await pg.locator('#sec-mgmt-cred').click();
    const dlg = pg.locator('#sec-verify-dlg');
    await expect(dlg).toBeVisible();
    await pg.locator('.sgx-door-row').filter({ hasText: '站长密码' }).click();
    /* locator 不带 type：切换明/密文后仍是同一元素，否则切到 text 后旧 locator 匹配不到 */
    const input = pg.locator('.sgx-door-expand input');
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute('type', 'password');
    const eye = pg.locator('.sgx-door-expand .sgx-pw-eye');
    await expect(eye).toBeVisible();

    /* 初始：eye-off（SVG 含斜线）+ 显示密码 + aria-pressed=false */
    await expect(eye).toHaveAttribute('aria-label', '显示密码');
    await expect(eye).toHaveAttribute('aria-pressed', 'false');
    const offHtml = await eye.evaluate((el) => el.innerHTML);
    expect(offHtml).toContain('<line');

    /* 点一次：eye（无斜线）+ 隐藏密码 + aria-pressed=true + 明文 + 焦点仍在输入框 */
    await eye.click();
    await expect(eye).toHaveAttribute('aria-label', '隐藏密码');
    await expect(eye).toHaveAttribute('aria-pressed', 'true');
    const onHtml = await eye.evaluate((el) => el.innerHTML);
    expect(onHtml).not.toContain('<line');
    await expect(input).toHaveAttribute('type', 'text');
    await expect(input).toBeFocused();

    /* 再点：恢复密文态 */
    await eye.click();
    await expect(eye).toHaveAttribute('aria-label', '显示密码');
    await expect(eye).toHaveAttribute('aria-pressed', 'false');
    await expect(input).toHaveAttribute('type', 'password');
  });
});

test.describe('door dialog row feedback (批次 A 验收修复 P2)', () => {
  test('passkey row click: immediate busy (spinner + busy subtitle + disabled), cancel restores, challenge only once', async ({ page: pg }) => {
    await gotoSecurity(pg);
    let challengeCalls = 0;
    await pg.route('**/api/stepup', async (route) => {
      const body = (route.request().postData() || '').toString();
      if (body.includes('challenge')) challengeCalls++;
      if (body.includes('challenge')) {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, challenge: 'AA', mode: 'mgmt' }) });
      } else {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      }
    });
    await pg.locator('#sec-mgmt-cred').click();
    const dlg = pg.locator('#sec-verify-dlg');
    await expect(dlg).toBeVisible();
    const row = pg.locator('.sgx-door-row').filter({ hasText: '站长通行密钥' });
    await expect(row).toBeVisible();
    const origSub = await row.locator('.sgx-door-rowsub').textContent();

    /* credentials.get 挂起（等测试手动取消） */
    await pg.evaluate(() => {
      window.__sgxRejectGet = null;
      navigator.credentials.get = () => new Promise((_, reject) => { window.__sgxRejectGet = reject; });
    });
    await row.click();
    /* 立即 busy：转圈 + busy 副标题 + 行禁用 */
    await expect(row.locator('.sgx-door-spin')).toBeVisible({ timeout: 3000 });
    await expect(row).toBeDisabled();
    await expect(row.locator('.sgx-door-rowsub')).toHaveText('正在唤起通行密钥…');
    expect(challengeCalls).toBe(1);
    /* busy 中合成二次点击：challenge 不再发 */
    await row.evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(challengeCalls).toBe(1);
    /* 取消系统验证：状态恢复、无错误显示、弹层仍在 */
    await pg.evaluate(() => {
      const err = new DOMException('User cancelled', 'NotAllowedError');
      window.__sgxRejectGet(err);
    });
    await expect(row).toBeEnabled({ timeout: 3000 });
    expect(await row.locator('.sgx-door-chev').evaluate((el) => el.innerHTML)).toContain('<svg');
    await expect(row.locator('.sgx-door-rowsub')).toHaveText(origSub || '');
    await expect(dlg).toBeVisible();
    await expect(pg.locator('.sgx-door-err:visible')).toHaveCount(0);
  });

  test('password row expand: selected + chev rotated, collapse restores; click vibrates 10ms', async ({ page: pg }) => {
    await pg.addInitScript(() => {
      window.__vibCalls = [];
      navigator.vibrate = (ms) => { window.__vibCalls.push(ms); return true; };
    });
    await gotoSecurity(pg);
    await pg.locator('#sec-mgmt-cred').click();
    await expect(pg.locator('#sec-verify-dlg')).toBeVisible();
    const row = pg.locator('.sgx-door-row').filter({ hasText: '站长密码' });
    await row.click();
    /* 展开：选中态 + 箭头旋转 + 振动 */
    await expect(row).toHaveClass(/sgx-row-selected/);
    await expect(row.locator('.sgx-door-chev')).toHaveClass(/expanded/);
    expect(await pg.evaluate(() => window.__vibCalls)).toEqual([10]);
    /* 再点收起：选中态 + 旋转清除 */
    await row.click();
    await expect(row).not.toHaveClass(/sgx-row-selected/);
    await expect(row.locator('.sgx-door-chev')).not.toHaveClass(/expanded/);
  });
});

test.describe('security status card wording (批次 A 验收修复 #8)', () => {
  test('missing owner password shows 站长密码 wording (option B), not 解锁密码', async ({ page: pg }) => {
    await pinLang(pg, 'zh');
    await blockExternalRequests(pg);
    /* 卡片数据源是 owner-status（站长层）：密码缺失 → 站长密码文案 */
    await mockJson(pg, '**/api/owner-status', 200, { ok: true, password: false, passkey: true });
    await pg.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
    await expect(pg.locator('#sec-status-title')).toContainText('建议操作', { timeout: 15000 });
    await expect(pg.locator('#sec-status-sub')).toHaveText('未设置站长密码');
  });

  test('missing passkey copy stays layer-neutral（未注册通行密钥）', async ({ page: pg }) => {
    await pinLang(pg, 'zh');
    await blockExternalRequests(pg);
    await mockJson(pg, '**/api/owner-status', 200, { ok: true, password: true, passkey: false });
    await pg.goto('/settings/security/', { waitUntil: 'domcontentloaded' });
    await expect(pg.locator('#sec-status-title')).toContainText('建议操作', { timeout: 15000 });
    await expect(pg.locator('#sec-status-sub')).toHaveText('未注册通行密钥');
  });
});
