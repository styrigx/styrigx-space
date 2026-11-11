/**
 * 2c（v6 割接后续）：当前页 su / exit / lock 之后页面标记就地切（window 'sgx:session' { ok, live: true }）——云同步与名片接住。
 * - 云同步 lib/cloud-sync.js bindSessionSync：切成 valid → 立即强制拉一次（忽略节流 / 旧 out 标记 / FORCE_REUSE_MS）；切成 locked → 丢掉没推的改动；
 *   守卫首帧那次（没有 live）不管；页面 locked 时本机改设置不排队
 * - 名片 lib/profile.js：切成 valid → 重新问 /api/profile（之前没进门没问过）；locked / 首帧事件不问
 * 运行：node --test tests/space/ui/sync/cloud-sync-2c.test.mjs
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
/** window 事件：按类型记监听，dispatch 时调 */
let listeners = {};
globalThis.window = {
  addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); }, removeEventListener() {},
  dispatchEvent(e) { (listeners[e.type] || []).forEach((f) => f(e)); return true; },
  setTimeout() { return 1; }, clearTimeout() {}, location: { reload() {} },
};
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
let lockState = 'locked';
globalThis.document = {
  getElementById: () => null,
  querySelector: (sel) => (sel === '[data-sgx-profile]' ? {} : null),
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
const fire = (ok, live = true) => window.dispatchEvent(new CustomEvent('sgx:session', { detail: live ? { ok, live } : { ok } }));

beforeEach(() => {
  LS.clear();
  listeners = {};
  CS._resetForTest();
  P._resetForTest();
  calls = [];
  lockState = 'locked';
  document.cookie = '';
});

test('访客页（locked）su 成功 → 标记就地切 valid → 云同步立即强制拉一次；名片重新问', async () => {
  P.initProfile();
  CS.bindSessionSync();
  assert.equal(await CS.initCloudSync(), 'skip', '首帧访客：不拉');
  await settle();
  assert.equal(calls.length, 0);
  document.cookie = 'sgx-id=1';
  lockState = 'valid';
  fire(true);
  await settle();
  assert.deepEqual(calls.map((c) => c.method + ' ' + c.url).sort(), ['GET /api/prefs', 'GET /api/profile']);
});

test('切成 valid 时忽略旧 out 标记与节流（可能刚换了身份）；守卫首帧事件（没有 live）不触发', async () => {
  CS.bindSessionSync();
  localStorage.setItem('sgx-sync-auth', 'out');
  lockState = 'valid';
  fire(true, false);
  await settle();
  assert.equal(calls.length, 0, '没有 live 不管');
  fire(true);
  await settle();
  assert.deepEqual(calls.map((c) => c.url), ['/api/prefs']);
  calls = [];
  fire(true);
  await settle();
  assert.deepEqual(calls.map((c) => c.url), ['/api/prefs'], '再切一次（换身份）照样拉，不复用上次结果');
});

test('切成 locked（exit / lock 回访客）→ 不拉、名片不问；之后本机改设置不排队推', async () => {
  P.initProfile();
  CS.bindSessionSync();
  lockState = 'valid';
  document.cookie = 'sgx-id=1';
  await CS.initCloudSync();
  await settle();
  calls = [];
  lockState = 'locked';
  fire(false);
  await settle();
  assert.equal(calls.length, 0);
  (listeners['sgx-settings-changed'] || []).forEach((f) => f());
  await settle();
  assert.equal(calls.length, 0, '访客改设置不推');
});

test('bindSessionSync 幂等：挂一次监听', () => {
  CS.bindSessionSync();
  CS.bindSessionSync();
  assert.equal((listeners['sgx:session'] || []).length, 1);
});
