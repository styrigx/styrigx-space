/**
 * 立即锁定（auth/lock-now.js doLock）：
 * - 锁定前清掉本标签页 sessionStorage 里的管理内容（sgx-chat-convo），其它键不动
 * - /api/lock-now 成功才 location.replace('/?lock=1')
 * - 请求失败（非 2xx / 网络错误）：不跳锁屏、不假装已锁，toast 提示锁定失败
 * 运行：node --test tests/web/ui/lock-now.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/* ---------- 浏览器最小桩 ---------- */
const SS = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (SS.has(k) ? SS.get(k) : null),
  setItem: (k, v) => { SS.set(k, String(v)); },
  removeItem: (k) => { SS.delete(k); },
};
const toasts = [];
const replaced = [];
globalThis.location = { replace: (u) => { replaced.push(u); } };
globalThis.window = globalThis;
const toastEl = { className: '', textContent: '', classList: { add() {}, remove() {} }, setAttribute() {} };
globalThis.document = {
  documentElement: { lang: 'zh' },
  createElement: () => toastEl,
  body: { appendChild: () => {} },
  addEventListener() {},
};
Object.defineProperty(toastEl, 'textContent', { set(v) { toasts.push(v); }, get() { return toasts[toasts.length - 1] || ''; } });
let fetchImpl = null;
const fetchCalls = [];
globalThis.fetch = (url, opts) => { fetchCalls.push({ url, opts }); return fetchImpl(); };

const { doLock } = await import('../../../web/assets/js/auth/lock-now.js');
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  SS.clear();
  toasts.length = 0;
  replaced.length = 0;
  fetchCalls.length = 0;
});

test('成功：清掉 sgx-chat-convo（其它键保留），POST /api/lock-now 后跳 /?lock=1', async () => {
  SS.set('sgx-chat-convo', '{"v":1,"msgs":[{"role":"user","content":"secret"}]}');
  SS.set('sgx-hist-root', '1');
  fetchImpl = async () => ({ ok: true, status: 200 });
  doLock();
  assert.equal(SS.get('sgx-chat-convo'), undefined, '管理内容在发请求前就清掉');
  await flush();
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, '/api/lock-now');
  assert.equal(fetchCalls[0].opts.method, 'POST');
  assert.deepEqual(replaced, ['/?lock=1']);
  assert.equal(SS.get('sgx-hist-root'), '1');
  assert.equal(toasts.length, 0);
});

test('非 2xx：不跳锁屏，toast 提示锁定失败', async () => {
  fetchImpl = async () => ({ ok: false, status: 500 });
  doLock();
  await flush();
  assert.deepEqual(replaced, []);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /锁定失败/);
});

test('网络错误：不跳锁屏，toast 提示锁定失败（英文页英文）', async () => {
  document.documentElement.lang = 'en';
  fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
  doLock();
  await flush();
  await flush();
  assert.deepEqual(replaced, []);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /Couldn’t lock/);
  document.documentElement.lang = 'zh';
});
