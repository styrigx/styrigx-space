/**
 * B1-4：访客升级层键盘避让功能测试（非视觉，不占基线）。
 * 针对 assets/js/shell/upgrade.js 的 .sgx-upgrade-sheet，
 * 不是 dialog-kb.spec.js 的两扇门验证弹层。
 * - visualViewport 变小时输入框仍然可见
 * - focus 只触发一次（重复打开不叠加订阅）
 * - 弹层关闭后解绑监听
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('./helpers');

test.use({ viewport: { width: 412, height: 915 } });

async function gotoUpgrade(pg) {
  await pg.addInitScript(() => {
    try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {}
  });
  await blockExternalRequests(pg);
  /* 访客访问站长专属路径：middleware 返回 data-sgx-upgrade="1"。
     addInitScript 时 documentElement 还不存在，改用路由直接改 HTML。 */
  await pg.route('http://localhost:8931/', async (route) => {
    const resp = await route.fetch();
    let body = await resp.text();
    body = body.replace('<html', '<html data-sgx-upgrade="1" data-sgx-upgrade-return="/settings/"');
    await route.fulfill({ response: resp, body });
  });
  await pg.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(pg.locator('.sgx-upgrade-sheet')).toBeVisible({ timeout: 15000 });
}

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

async function vvListenerCount(pg, type) {
  return pg.evaluate((t) => (window.__fakeVV._l[t] || []).length, type);
}

/* 点「密码验证」展开输入框 */
async function openInput(pg) {
  await pg.locator('#sgx-upgrade-pw').click();
  const input = pg.locator('#sgx-upgrade-input');
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  return input;
}

test.describe('upgrade keyboard avoidance', () => {
  test('visualViewport 变小：弹层上移，输入框仍然可见', async ({ page: pg }) => {
    await gotoUpgrade(pg);
    await taintViewport(pg);
    await openInput(pg);
    const sheet = pg.locator('.sgx-upgrade-sheet');
    const input = pg.locator('#sgx-upgrade-input');

    const origTransform = await sheet.evaluate((el) => el.style.transform);
    expect(origTransform).toBe('');

    /* 模拟键盘弹出：visualViewport 高度缩小 300（onKeyboardHeight 经 rAF 节流） */
    const kbHeight = 300;
    await pg.evaluate((kb) => window.__fakeVV.__setHeight(window.innerHeight - kb), kbHeight);
    await waitFrames(pg, 3);

    const raised = await pg.evaluate(() => {
      const s = document.querySelector('.sgx-upgrade-sheet');
      const vv = window.__fakeVV;
      const r = s.getBoundingClientRect();
      const inputEl = document.getElementById('sgx-upgrade-input');
      const goEl = document.getElementById('sgx-upgrade-go');
      const ir = inputEl.getBoundingClientRect();
      const gr = goEl.getBoundingClientRect();
      return {
        transform: s.style.transform,
        sheetBottom: r.bottom,
        vvBottom: vv.offsetTop + vv.height,
        inputTop: ir.top,
        inputBottom: ir.bottom,
        goTop: gr.top,
        goBottom: gr.bottom,
      };
    });

    /* followKeyboard 真的被调用：弹层上移了键盘高度 */
    expect(raised.transform).toBe('translateY(' + -kbHeight + 'px)');
    /* 弹层底边不超出 visualViewport */
    expect(raised.sheetBottom).toBeLessThanOrEqual(raised.vvBottom + 1);
    /* 输入框与「验证」按钮都在可见区内 */
    expect(raised.inputTop).toBeGreaterThanOrEqual(0);
    expect(raised.inputBottom).toBeLessThanOrEqual(raised.vvBottom + 1);
    expect(raised.goTop).toBeGreaterThanOrEqual(0);
    expect(raised.goBottom).toBeLessThanOrEqual(raised.vvBottom + 1);

    /* 恢复视口：弹层回到底部 */
    await pg.evaluate(() => window.__fakeVV.__setHeight(window.innerHeight));
    await input.evaluate((el) => el.blur());
    await waitFrames(pg, 3);
    const restored = await sheet.evaluate((el) => el.style.transform);
    expect(restored).toBe('');
  });

  test('focus 只触发一次：重复打开不叠加 visualViewport 订阅', async ({ page: pg }) => {
    await gotoUpgrade(pg);
    await taintViewport(pg);
    const input = await openInput(pg);

    /* 第一次打开：1 个 resize 订阅 */
    expect(await vvListenerCount(pg, 'resize')).toBe(1);

    /* 输入框失焦再聚焦：还是 1 个（start 有 if (stopKb) return 保护） */
    await input.evaluate((el) => el.blur());
    await waitFrames(pg, 2);
    await input.evaluate((el) => el.focus());
    await waitFrames(pg, 2);
    expect(await vvListenerCount(pg, 'resize')).toBe(1);

    /* 返回选项再重新打开：还是 1 个（showInput 先调旧 cleanup） */
    await pg.locator('#sgx-upgrade-back').click();
    await expect(pg.locator('#sgx-upgrade-opts')).toBeVisible();
    await openInput(pg);
    expect(await vvListenerCount(pg, 'resize')).toBe(1);
  });

  test('弹层关闭后解绑监听', async ({ page: pg }) => {
    await gotoUpgrade(pg);
    await taintViewport(pg);
    await openInput(pg);

    expect(await vvListenerCount(pg, 'resize')).toBe(1);
    expect(await vvListenerCount(pg, 'scroll')).toBe(1);

    /* 点「取消」关闭弹层 */
    await pg.locator('#sgx-upgrade-cancel').click();
    await expect(pg.locator('.sgx-upgrade-sheet')).toHaveCount(0);

    /* visualViewport 监听已解绑 */
    expect(await vvListenerCount(pg, 'resize')).toBe(0);
    expect(await vvListenerCount(pg, 'scroll')).toBe(0);
  });
});
