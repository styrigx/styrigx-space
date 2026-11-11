/**
 * 2b（v6 割接后续）：纯 v6 登录的页面（网关标 valid）——前端云同步与名片照常跑。
 * - 云同步 lib/cloud-sync.js：页面 valid + v6 登录标记 sgx-id=1 → 拉取 /api/prefs；旧账号会话留下的 'out' 标记不挡 v6；
 *   节流时刻按 'v6' 记，和旧会话的 'account' 互不影响；页面 locked → 不请求（v6 过期时网关标 locked）
 * - 名片 lib/profile.js：页面 valid（纯 v6）→ initProfile 发 GET /api/profile；locked 不发
 * 运行：node --test tests/space/ui/sync/cloud-sync-v6.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const LS = new Map();
globalThis.localStorage = {
  getItem: (k) => (LS.has(k) ? LS.get(k) : null),
  setItem: (k, v) => { LS.set(k, String(v)); },
  removeItem: (k) => { LS.delete(k); },
  key: (i) => Array.from(LS.keys())[i] || null,
  get length() { return LS.size; },
};
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  setTimeout() { return 1; }, clearTimeout() {}, location: { reload() {} },
};
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
let lockState = 'valid';
let hasProfileEl = true;
globalThis.document = {
  getElementById: () => null,
  querySelector: (sel) => (sel === '[data-sgx-profile]' && hasProfileEl ? {} : null),
  querySelectorAll: () => [],
  documentElement: { getAttribute: (n) => (n === 'data-sgx-lock-session' ? lockState : null) },
  cookie: '',
  visibilityState: 'visible',
  addEventListener() {},
};
let calls = [];
globalThis.fetch = (url, init) => {
  const method = (init && init.method) || 'GET';
  calls.push({ url, method });
  const j = url === '/api/profile' ? { ok: true, profile: { name: null, nickname: null, motto: null, email: null }, avatar: '' } : { ok: true, items: {}, updatedAt: 0 };
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(j) });
};

const CS = await import('../../../../space/web/assets/js/lib/cloud-sync.js');
const P = await import('../../../../space/web/assets/js/lib/profile.js');
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

beforeEach(() => {
  LS.clear();
  CS._resetForTest();
  P._resetForTest();
  calls = [];
  lockState = 'valid';
  document.cookie = '';
});

test('v6Marked：只认 sgx-id=1', () => {
  assert.equal(CS.v6Marked(), false);
  document.cookie = 'a=b; sgx-id=1';
  assert.equal(CS.v6Marked(), true);
  document.cookie = 'sgx-id=10';
  assert.equal(CS.v6Marked(), false);
});

test('纯 v6（页面 valid + 登录标记）：拉取 /api/prefs，节流时刻记在 v6 名下', async () => {
  document.cookie = 'sgx-id=1';
  assert.equal(await CS.initCloudSync(), 'ok');
  assert.deepEqual(calls.map((c) => c.url), ['/api/prefs']);
  assert.deepEqual(Object.keys(JSON.parse(LS.get(CS.PULL_KEY))), ['v6']);
  assert.equal(LS.get(CS.AUTH_KEY), 'in');
});

test('旧账号会话留下的 out 不挡 v6；没有 v6 标记时照旧挡', async () => {
  LS.set(CS.AUTH_KEY, 'out');
  assert.equal(await CS.initCloudSync(), 'out');
  assert.equal(calls.length, 0);
  document.cookie = 'sgx-id=1';
  CS._resetForTest();
  assert.equal(await CS.initCloudSync(), 'ok');
  assert.equal(calls.length, 1);
});

test('旧会话的节流时刻不挡 v6（两种身份各记各的）', async () => {
  LS.set(CS.PULL_KEY, JSON.stringify({ account: Date.now() }));
  assert.equal(await CS.initCloudSync(), 'fresh', '旧会话 5 分钟内拉过');
  document.cookie = 'sgx-id=1';
  CS._resetForTest();
  assert.equal(await CS.initCloudSync(), 'ok', 'v6 自己没拉过');
});

test('页面 locked（v6 过期 / 没登录）→ 不请求', async () => {
  document.cookie = 'sgx-id=1';
  lockState = 'locked';
  assert.equal(await CS.initCloudSync(), 'skip');
  assert.equal(calls.length, 0);
});

test('名片：页面 valid（纯 v6）→ initProfile 发 GET /api/profile；locked 不发', async () => {
  document.cookie = 'sgx-id=1';
  P.initProfile();
  await settle();
  assert.deepEqual(calls.map((c) => c.url), ['/api/profile']);
  P._resetForTest();
  calls = [];
  lockState = 'locked';
  P.initProfile();
  await settle();
  assert.equal(calls.length, 0);
});
