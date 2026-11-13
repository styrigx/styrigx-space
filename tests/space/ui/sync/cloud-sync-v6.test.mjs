/**
 * 2b（v6 割接后续）：纯 v6 登录的页面（网关标 valid）——前端云同步与名片照常跑。
 * - 云同步 lib/cloud-sync.js：页面 valid → 拉取 /api/prefs；页面 locked → 不请求（v6 过期时网关标 locked）
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

const CS = await import('../../../../space/web/assets/shell/js/prefs/cloud-sync.js');
const P = await import('../../../../space/web/assets/shell/js/prefs/profile.js');
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

beforeEach(() => {
  LS.clear();
  CS._resetForTest();
  P._resetForTest();
  calls = [];
  lockState = 'valid';
  document.cookie = '';
});

test('纯 v6（页面 valid + 登录标记）：拉取 /api/prefs，记下节流时刻', async () => {
  document.cookie = 'sgx-id=1';
  assert.equal(await CS.initCloudSync(), 'ok');
  assert.deepEqual(calls.map((c) => c.url), ['/api/prefs']);
  assert.ok(Number(LS.get(CS.PULL_KEY)) > 0);
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
