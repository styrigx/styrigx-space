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
test('kb 300->0 without blur closes: panel hidden+empty, --sgx-kb 0px, no.open, width empty', async ({
page: pg,
}) => {
const cap = await gotoSettings(pg);
const scrollBefore = await pg.evaluate(() => window.scrollY);
const { input, panel} = await openCapsule(pg, 300);

/* 键盘弹出时：--sgx-kb=300px，胶囊加宽 */
expect(
(await pg.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--sgx-kb'))).trim()
).toBe('300px');
expect(await cap.evaluate((el) => el.style.width)).not.toBe('');

/* 键盘高度回到 0，input 不 blur（焦点仍在输入框） */
await pg.evaluate(() => window.__fakeVV.__setHeight(window.innerHeight));
await waitFrames(pg, 4);
expect(await pg.evaluate(() => document.activeElement && document.activeElement.id)).toBe(
'sgx-cap-input-settings'
);
await pg.waitForTimeout(600); /* 120ms 去抖 + 余量 */

/* 结束状态 = 点空白：面板 hidden 且清空、--sgx-kb 0px、无.open、width 清空、已 blur */
await expect(panel).toBeHidden();
expect(await panel.evaluate((el) => el.innerHTML)).toBe('');
expect(
(await pg.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--sgx-kb'))).trim()
).toBe('0px');
await expect(cap).not.toHaveClass(/open/);
expect(await cap.evaluate((el) => el.style.width)).toBe('');
expect(await pg.evaluate(() => document.activeElement && document.activeElement.tagName)).toBe('BODY');

/* scrollY 前后差为 0 */
expect(await pg.evaluate(() => window.scrollY)).toBe(scrollBefore);
});

test('kb 300->0->300 within 120ms does not close (debounce cancelled)', async ({ page: pg}) => {
await gotoSettings(pg);
const { cap} = await openCapsule(pg, 300);

/* 300→0 后 50ms（<120ms）又弹回 300：去抖取消，胶囊不关 */
await pg.evaluate(() => window.__fakeVV.__setHeight(window.innerHeight));
await pg.waitForTimeout(50);
await pg.evaluate((kb) => window.__fakeVV.__setHeight(window.innerHeight - kb), 300);
await waitFrames(pg, 4);
await pg.waitForTimeout(400); /* 远超 120ms：若去抖没取消，早就关了 */
await expect(cap).toHaveClass(/open/);
expect(
(await pg.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--sgx-kb'))).trim()
).toBe('300px');
});

test('popstate fallback closes an opened capsule', async ({ page: pg}) => {
await gotoSettings(pg);
const { cap, panel} = await openCapsule(pg, 300);

/* 键盘已收起后的返回手势 → popstate：兜底 blur + close */
await pg.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate')));
await pg.waitForTimeout(400);
await expect(cap).not.toHaveClass(/open/);
await expect(panel).toBeHidden();
expect(await panel.evaluate((el) => el.innerHTML)).toBe('');
});

test('brw-overlay: kb 300->0 without blur closes overlay (same rule)', async ({ page: pg}) => {
await pg.addInitScript((l) => {
try { localStorage.setItem('sgx-lang', l);} catch (e) {}
}, 'zh');
await freezeTime(pg);
await blockExternalRequests(pg);
await pg.goto('/browser/', { waitUntil: 'domcontentloaded'});
await taintViewport(pg);
const overlay = pg.locator('#brw-overlay');
const input = pg.locator('#brw-input');
await expect(overlay).toBeAttached();

/* 点地址栏打开弹层（180ms 后聚焦输入框，键盘订阅启动） */
await pg.locator('#brw-addrbar').click();
await expect(overlay).toHaveClass(/open/);
await expect(input).toBeFocused({ timeout: 5000});
await pg.evaluate((kb) => window.__fakeVV.__setHeight(window.innerHeight - kb), 300);
await waitFrames(pg, 4);
expect(
(await pg.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--sgx-kb'))).trim()
).toBe('300px');

/* 键盘收起、input 不 blur → 120ms 去抖后弹层关闭 */
await pg.evaluate(() => window.__fakeVV.__setHeight(window.innerHeight));
await waitFrames(pg, 4);
await pg.waitForTimeout(800);
await expect(overlay).not.toHaveClass(/open/);
expect(
(await pg.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--sgx-kb'))).trim()
).toBe('0px');
expect(await pg.evaluate(() => document.activeElement && document.activeElement.id)).not.toBe('brw-input');
});

test('final frames: back gesture vs tap-blank are identical (412)', async ({ page: pg}) => {
/* 阈值像素对比：在页内 canvas 上逐像素比较，单通道差值 >16 才计为差异；
 * 允许上限 120 像素（与 visual.spec.js 的 maxDiffPixels 一致），过滤跨
 * 页面加载的亚像素抗锯齿噪声（实测最大差值 9/255）。 */
async function countDiff(bufA, bufB, threshold) {
return pg.evaluate(
async ([b64a, b64b, th]) => {
const load = (b64) =>
new Promise((res, rej) => {
const img = new Image();
img.onload = () => res(img);
img.onerror = rej;
img.src = 'data:image/png;base64,' + b64;
});
const [i1, i2] = await Promise.all([load(b64a), load(b64b)]);
const w = Math.min(i1.width, i2.width),
h = Math.min(i1.height, i2.height);
const c = document.createElement('canvas');
c.width = w;
c.height = h;
const x = c.getContext('2d');
x.drawImage(i1, 0, 0);
const a = x.getImageData(0, 0, w, h).data;
x.clearRect(0, 0, w, h);
x.drawImage(i2, 0, 0);
const d = x.getImageData(0, 0, w, h).data;
let n = 0,
maxDelta = 0;
for (let k = 0; k < w * h; k++) {
const m = Math.max(
Math.abs(a[k * 4] - d[k * 4]),
Math.abs(a[k * 4 + 1] - d[k * 4 + 1]),
Math.abs(a[k * 4 + 2] - d[k * 4 + 2])
);
if (m > maxDelta) maxDelta = m;
if (m > th) n++;
}
return { n, maxDelta, total: w * h };
},
[bufA.toString('base64'), bufB.toString('base64'), threshold]
);
}
async function endFrameBackGesture() {
const cap = await gotoSettings(pg);
const input = pg.locator('#sgx-cap-input-settings');
await input.evaluate((el) => {
el.dispatchEvent(new TouchEvent('touchstart', { cancelable: true, bubbles: true }));
});
await expect(cap).toHaveClass(/open/);
await pg.evaluate((kb) => window.__fakeVV.__setHeight(window.innerHeight - kb), 300);
await waitFrames(pg, 4);
/* 返回手势：键盘收起，input 不 blur */
await pg.evaluate(() => window.__fakeVV.__setHeight(window.innerHeight));
await waitFrames(pg, 4);
await pg.waitForTimeout(800); /* 去抖 120ms + 收尾 */
return {
cap: await cap.screenshot({ animations: 'disabled'}),
full: await pg.screenshot({ animations: 'disabled'}),
};
}
async function endFrameTapBlank() {
const cap = await gotoSettings(pg);
const input = pg.locator('#sgx-cap-input-settings');
await input.evaluate((el) => {
el.dispatchEvent(new TouchEvent('touchstart', { cancelable: true, bubbles: true }));
});
await expect(cap).toHaveClass(/open/);
await pg.evaluate((kb) => window.__fakeVV.__setHeight(window.innerHeight - kb), 300);
await waitFrames(pg, 4);
/* 点页面空白：焦点离开输入框 → blur → 180ms 后 close */
await pg.mouse.click(206, 120);
expect(await pg.evaluate(() => document.activeElement && document.activeElement.id)).not.toBe(
'sgx-cap-input-settings'
);
await pg.waitForTimeout(800);
return {
cap: await cap.screenshot({ animations: 'disabled'}),
full: await pg.screenshot({ animations: 'disabled'}),
};
}
const shotBack = await endFrameBackGesture();
const shotBlank = await endFrameTapBlank();
const capDiff = await countDiff(shotBack.cap, shotBlank.cap, 16);
const fullDiff = await countDiff(shotBack.full, shotBlank.full, 16);
/* eslint-disable-next-line no-console */
console.log(
'D2 frame compare (412): capsule diffPixels=%d maxDelta=%d | full diffPixels=%d maxDelta=%d (threshold 16, allow <=120)',
capDiff.n,
capDiff.maxDelta,
fullDiff.n,
fullDiff.maxDelta
);
expect(capDiff.n).toBeLessThanOrEqual(120);
expect(fullDiff.n).toBeLessThanOrEqual(120);
});
});
