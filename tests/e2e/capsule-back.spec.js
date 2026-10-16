/**
* D2｜搜索胶囊：返回手势 = 点页面空白
*
* 根因（实测确认）：Android 返回手势只收起键盘、不触发 input 的 blur，
* capsule.js 的 close() 只接在 blur（180ms）/Escape/面板点击三条路径上，
* 所以返回手势后胶囊沉底但建议栏仍显示。修法：kbUpdate 在 opened 且键盘
* 曾弹出（kbMaxSeen>0）、高度回到 0（≤2px）时启动 120ms 去抖，去抖结束
* h 仍为 0 → input.blur() + close()；中途 h 变大取消；close() 结束清
* kbMaxSeen.v；popstate 兜底。宽度插值与键盘跟随算法未动。
*
* 本文件用污点 visualViewport 模拟键盘高度（headless 下无真实键盘），
* 高度 300→0 且 input 不 blur 即等价于 Android 返回手势。
*/
const { test} = require('@playwright/test');
const { blockExternalRequests, freezeTime, expect} = require('./helpers');

test.use({ viewport: { width: 412, height: 915}});

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
width: real? real.width: window.innerWidth,
height: real? real.height: window.innerHeight,
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
if (i!== -1) a.splice(i, 1);
}
};
/* 测试用：设置高度并触发 resize（模拟键盘弹出/收起），不触发 blur */
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

async function gotoSettings(pg) {
await pg.addInitScript((l) => {
try { localStorage.setItem('sgx-lang', l);} catch (e) {}
}, 'zh');
await freezeTime(pg);
await blockExternalRequests(pg);
await pg.goto('/settings/', { waitUntil: 'domcontentloaded'});
await taintViewport(pg);
const cap = pg.locator('#sgx-cap-settings');
await expect(cap).toBeVisible({ timeout: 15000});
return cap;
}

/** 打开胶囊：走真机路径——合成 touchstart（handler 里 preventDefault +
 * focus({preventScroll:true})，页面不滚动）→ focus 事件 → open()；
 * 再把键盘弹到 kbH。Playwright 的 input.focus() 会滚动页面，不用。 */
async function openCapsule(pg, kbH) {
const cap = pg.locator('#sgx-cap-settings');
const input = pg.locator('#sgx-cap-input-settings');
await input.evaluate((el) => {
el.dispatchEvent(new TouchEvent('touchstart', { cancelable: true, bubbles: true }));
});
await expect(cap).toHaveClass(/open/);
await pg.evaluate((kb) => window.__fakeVV.__setHeight(window.innerHeight - kb), kbH);
await waitFrames(pg, 4);
return { cap, input, panel: pg.locator('#sgx-cap-results-settings')};
}

test.describe('D2 capsule: back gesture equals tap-blank', () => {
/* B1-6a：设置胶囊不再弹浮层，点一下跳搜索页。D2 的浮层行为测试不再适用，跳过。 */
test.skip('D2 skipped: settings capsule now navigates to search page', async () => {});
});
