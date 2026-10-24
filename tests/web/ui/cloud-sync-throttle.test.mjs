/**
 * 账号云同步拉取节流（2026-10-24）：lib/cloud-sync.js initCloudSync。
 * - 普通拉取最多 5 分钟一次（sgx-sync-pull 按账号记上次成功拉取 / 推送时刻）
 * - 回到前台（visibilitychange → visible）超过 5 分钟再拉
 * - 强制（账号页 / 云同步页 / 登录 / 打开开关）不受节流
 * - 401 / 登出清掉时刻；本机修改 1.5 秒防抖推送不变，推送成功刷新时刻
 * 运行：node --test tests/web/ui/cloud-sync-throttle.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/* ---------- 浏览器最小桩 ---------- */
/** @type {Map<string,string>} */
const LS = new Map();
globalThis.localStorage = {
  getItem: (k) => (LS.has(k) ? LS.get(k) : null),
  setItem: (k, v) => { LS.set(k, String(v)); },
  removeItem: (k) => { LS.delete(k); },
  key: (i) => Array.from(LS.keys())[i] || null,
  get length() { return LS.size; },
};
const SS = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (SS.has(k) ? SS.get(k) : null),
  setItem: (k, v) => { SS.set(k, String(v)); },
  removeItem: (k) => { SS.delete(k); },
};

/** 手动计时器：tick(ms) 推进 */
let clock = 1_800_000_000_000;
let timers = [];
let tid = 0;
const realNow = Date.now;
Date.now = () => clock;

const winListeners = {};
const docListeners = {};
let reloads = 0;
globalThis.window = {
  addEventListener(t, fn) { (winListeners[t] = winListeners[t] || []).push(fn); },
  removeEventListener() {},
  dispatchEvent(e) { (winListeners[e.type] || []).forEach((fn) => fn(e)); return true; },
  setTimeout(fn, ms) { tid++; timers.push({ id: tid, at: clock + ms, fn }); return tid; },
  clearTimeout(id) { timers = timers.filter((x) => x.id !== id); },
  location: { reload() { reloads++; } },
};
let role = 'owner';
globalThis.document = {
  getElementById() { return null; },
  documentElement: { getAttribute: (n) => (n === 'data-sgx-role' ? role : null) },
  cookie: '',
  visibilityState: 'visible',
  addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); },
};

/** fetch 桩：记录请求；GET/POST 的回应可按测试改 */
let calls = [];
let getReply = { s: 200, j: { ok: true, items: {} } };
let postReply = { s: 200, j: { ok: true, items: {} } };
globalThis.fetch = (url, init) => {
  const method = (init && init.method) || 'GET';
  calls.push({ url, method, body: init && init.body ? JSON.parse(init.body) : null });
  const r = method === 'GET' ? getReply : postReply;
  return Promise.resolve({ status: r.s, json: () => Promise.resolve(r.j) });
};

const CS = await import('../../../web/assets/js/lib/cloud-sync.js');
const { initCloudSync, clearPullStamp, lastPullAt, pullDue, PULL_KEY, PULL_INTERVAL, PUSH_DEBOUNCE, AUTH_KEY, LAST_KEY, _resetForTest } = CS;

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}
/** 推进时钟并触发到期计时器 */
async function tick(ms) {
  clock += ms;
  const due = timers.filter((x) => x.at <= clock);
  timers = timers.filter((x) => x.at > clock);
  for (const t of due) t.fn();
  await settle();
}
const gets = () => calls.filter((c) => c.method === 'GET').length;
const posts = () => calls.filter((c) => c.method === 'POST');
function foreground(state) {
  document.visibilityState = state || 'visible';
  (docListeners.visibilitychange || []).forEach((fn) => fn({ type: 'visibilitychange' }));
}
/** 模拟「换一页」：模块状态是每页一份，新页面重来（localStorage 保留） */
function newPage() {
  _resetForTest();
  for (const k of Object.keys(winListeners)) delete winListeners[k];
  for (const k of Object.keys(docListeners)) delete docListeners[k];
  timers = [];
}

beforeEach(() => {
  LS.clear();
  SS.clear();
  newPage();
  calls = [];
  role = 'owner';
  document.visibilityState = 'visible';
  getReply = { s: 200, j: { ok: true, items: {} } };
  postReply = { s: 200, j: { ok: true, items: {} } };
  reloads = 0;
});

test('pullDue：没拉过 / 超过 5 分钟 / 时钟回拨 → 要拉；窗口内不拉', () => {
  assert.equal(pullDue(0, 1000), true);
  assert.equal(pullDue(1000, 1000 + PULL_INTERVAL - 1), false);
  assert.equal(pullDue(1000, 1000 + PULL_INTERVAL), true);
  assert.equal(pullDue(5000, 1000), true);
  assert.equal(PULL_INTERVAL, 5 * 60 * 1000);
});

test('第一次拉取成功 → 记下按账号的时刻；5 分钟内换页不再 GET', async () => {
  assert.equal(await initCloudSync(), 'ok');
  assert.equal(gets(), 1);
  assert.equal(lastPullAt(), clock);
  assert.deepEqual(JSON.parse(LS.get(PULL_KEY)), { owner: clock });
  for (let i = 0; i < 5; i++) {
    clock += 50_000;
    newPage();
    assert.equal(await initCloudSync(), 'fresh');
  }
  assert.equal(gets(), 1);
});

test('超过窗口 → 普通拉取再 GET 一次', async () => {
  await initCloudSync();
  clock += PULL_INTERVAL + 1;
  newPage();
  assert.equal(await initCloudSync(), 'ok');
  assert.equal(gets(), 2);
});

test('拉取失败（网络 / 5xx）不记时刻，下一页还会拉', async () => {
  getReply = { s: 500, j: { ok: false } };
  assert.equal(await initCloudSync(), 'error');
  assert.equal(lastPullAt(), 0);
  newPage();
  getReply = { s: 200, j: { ok: true, items: {} } };
  assert.equal(await initCloudSync(), 'ok');
  assert.equal(gets(), 2);
});

test('回到前台：窗口内不拉，超过 5 分钟拉；切到后台不拉', async () => {
  await initCloudSync();
  foreground('visible');
  await settle();
  assert.equal(gets(), 1, '窗口内回前台不拉');
  clock += PULL_INTERVAL + 10;
  foreground('hidden');
  await settle();
  assert.equal(gets(), 1, '变成 hidden 不拉');
  foreground('visible');
  await settle();
  assert.equal(gets(), 2, '超过窗口回前台拉一次');
  foreground('visible');
  await settle();
  assert.equal(gets(), 2, '刚拉过再回前台不拉');
});

test('bfcache 恢复（pageshow persisted）同样按节流', async () => {
  await initCloudSync();
  clock += PULL_INTERVAL + 10;
  (winListeners.pageshow || []).forEach((fn) => fn({ type: 'pageshow', persisted: false }));
  await settle();
  assert.equal(gets(), 1);
  (winListeners.pageshow || []).forEach((fn) => fn({ type: 'pageshow', persisted: true }));
  await settle();
  assert.equal(gets(), 2);
});

test('强制（账号页 / 云同步页 / 打开开关）不受节流', async () => {
  await initCloudSync();
  clock += 10_000;
  newPage();
  assert.equal(await initCloudSync(), 'fresh');
  assert.equal(await initCloudSync({ force: true }), 'ok');
  assert.equal(gets(), 2);
});

test('同一页：普通拉取还在路上 / 刚拉完，强制就复用，不重复 GET（账号页 core.js + account.js）', async () => {
  const a = initCloudSync();
  const b = initCloudSync({ force: true });
  assert.equal(await a, 'ok');
  assert.equal(await b, 'ok');
  assert.equal(gets(), 1);
  clock += 1000;
  assert.equal(await initCloudSync({ force: true }), 'ok');
  assert.equal(gets(), 1, '3 秒内刚成功拉过，复用');
  clock += 5000;
  assert.equal(await initCloudSync({ force: true }), 'ok');
  assert.equal(gets(), 2, '过了复用窗口，强制照拉');
});

test('刚登录：之前标了没登录（out）也拉，成功后记 in 和时刻', async () => {
  LS.set(AUTH_KEY, 'out');
  assert.equal(await initCloudSync(), 'out');
  assert.equal(gets(), 0);
  assert.equal(await initCloudSync({ force: true }), 'ok');
  assert.equal(gets(), 1);
  assert.equal(LS.get(AUTH_KEY), 'in');
  assert.ok(lastPullAt() > 0);
});

test('GET 401 → 标 out、清掉时刻；之后普通拉取不再请求', async () => {
  await initCloudSync();
  assert.ok(lastPullAt() > 0);
  clock += PULL_INTERVAL + 1;
  newPage();
  getReply = { s: 401, j: { ok: false, error: 'account' } };
  assert.equal(await initCloudSync(), 'out');
  assert.equal(LS.get(AUTH_KEY), 'out');
  assert.equal(LS.has(PULL_KEY), false);
  newPage();
  assert.equal(await initCloudSync(), 'out');
  assert.equal(gets(), 2);
});

test('POST 401 → 同样清掉时刻', async () => {
  await initCloudSync();
  postReply = { s: 401, j: { ok: false } };
  LS.set('sgx-accent', '#123456');
  window.dispatchEvent({ type: 'sgx-settings-changed' });
  await tick(PUSH_DEBOUNCE);
  assert.equal(posts().length, 1);
  assert.equal(LS.get(AUTH_KEY), 'out');
  assert.equal(LS.has(PULL_KEY), false);
});

test('登出：clearPullStamp 清掉，重新登录后第一次普通拉取也会拉', async () => {
  await initCloudSync();
  clearPullStamp();
  assert.equal(lastPullAt(), 0);
  newPage();
  assert.equal(await initCloudSync(), 'ok');
  assert.equal(gets(), 2);
});

test('本机修改：1.5 秒防抖合并推送（不受节流）；推送成功刷新上次同步和节流时刻', async () => {
  await initCloudSync();
  const t0 = lastPullAt();
  clock += 60_000;
  LS.set('sgx-accent', '#111111');
  window.dispatchEvent({ type: 'sgx-settings-changed' });
  await tick(1000);
  LS.set('sgx-weather-loc', 'city');
  window.dispatchEvent({ type: 'sgx-settings-changed' });
  await tick(400);
  assert.equal(posts().length, 0, '1.5 秒内不推');
  await tick(100);
  assert.equal(posts().length, 1, '第一次改动后 1.5 秒推一次，两项合并');
  assert.deepEqual(Object.keys(posts()[0].body.changes).sort(), ['sgx-accent', 'sgx-weather-loc']);
  assert.equal(lastPullAt(), clock);
  assert.ok(lastPullAt() > t0);
  assert.equal(LS.get(LAST_KEY), String(clock));
  /* 推送刚成功：接下来 5 分钟内换页不拉 */
  clock += PULL_INTERVAL - 1000;
  newPage();
  assert.equal(await initCloudSync(), 'fresh');
  assert.equal(gets(), 1);
});

test('离开页面（pagehide）立刻推掉未推的改动', async () => {
  await initCloudSync();
  LS.set('sgx-accent', '#222222');
  (winListeners.pagehide || []).forEach((fn) => fn({ type: 'pagehide' }));
  await settle();
  assert.equal(posts().length, 1);
});

test('拉下来的值不同 → 应用并刷新一次页面（行为不变）', async () => {
  getReply = { s: 200, j: { ok: true, items: { 'sgx-accent': { v: '#abcdef', t: clock - 10 } } } };
  assert.equal(await initCloudSync(), 'ok');
  assert.equal(LS.get('sgx-accent'), '#abcdef');
  assert.equal(reloads, 1);
});

test('访客 / 开关关：不请求', async () => {
  role = 'visitor';
  assert.equal(await initCloudSync({ force: true }), 'skip');
  role = 'owner';
  LS.set('sgx-cloud-sync', '0');
  assert.equal(await initCloudSync({ force: true }), 'off');
  assert.equal(calls.length, 0);
});

test('强制入口：账号页、云同步页（进页 + 打开开关）都用 force；登出清时刻', () => {
  const acct = readFileSync(path.join(ROOT, 'web/assets/js/apps/account.js'), 'utf8');
  const sync = readFileSync(path.join(ROOT, 'web/assets/js/apps/account-sync.js'), 'utf8');
  const dev = readFileSync(path.join(ROOT, 'web/assets/js/apps/account-devices.js'), 'utf8');
  const core = readFileSync(path.join(ROOT, 'web/assets/js/shell/core.js'), 'utf8');
  assert.match(acct, /initCloudSync\(\{ force: true \}\)/);
  assert.equal((sync.match(/initCloudSync\(\{ force: true \}\)/g) || []).length, 2);
  assert.match(dev, /clearPullStamp\(\)/);
  assert.match(core, /initCloudSync\(\)\.catch/);
});

test.after(() => { Date.now = realNow; });
