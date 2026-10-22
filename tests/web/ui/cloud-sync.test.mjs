/**
 * 账号云同步 lib/cloud-sync.js 的合并规则（plan）：逐项新的赢。
 * 运行：node --test tests/web/ui/cloud-sync.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/* 浏览器全局的最小桩：模块加载时 features.js 会挂 storage 监听 */
globalThis.window = globalThis.window || { addEventListener() {}, dispatchEvent() {} };
globalThis.document = globalThis.document || { getElementById() { return null; }, documentElement: { getAttribute() { return null; } }, cookie: '' };
const { plan } = await import('../../../web/assets/js/lib/cloud-sync.js');
const K = ['sgx-theme-mode', 'sgx-palette', 'sgx-accent'];

test('云端更新 → 应用到本机，本机时间跟上', () => {
  const p = plan(K, { 'sgx-theme-mode': 'light', 'sgx-palette': null, 'sgx-accent': null }, { 'sgx-theme-mode': 100 },
    { 'sgx-theme-mode': { v: 'dark', t: 200 }, 'sgx-palette': { v: 'mint', t: 50 } }, 1000);
  assert.deepEqual(p.apply, { 'sgx-theme-mode': 'dark', 'sgx-palette': 'mint' });
  assert.deepEqual(p.push, {});
  assert.equal(p.meta['sgx-theme-mode'], 200);
});

test('本机更新 → 推上去；相同值不推', () => {
  const p = plan(K, { 'sgx-theme-mode': 'light', 'sgx-palette': 'mint', 'sgx-accent': null }, { 'sgx-theme-mode': 300, 'sgx-palette': 300 },
    { 'sgx-theme-mode': { v: 'dark', t: 200 }, 'sgx-palette': { v: 'mint', t: 200 } }, 1000);
  assert.deepEqual(p.apply, {});
  assert.deepEqual(p.push, { 'sgx-theme-mode': { v: 'light', t: 300 } });
});

test('本机恢复默认（null）比云端新 → 推 null', () => {
  const p = plan(K, { 'sgx-theme-mode': null, 'sgx-palette': null, 'sgx-accent': null }, { 'sgx-accent': 500 },
    { 'sgx-accent': { v: '#ff0000', t: 400 } }, 1000);
  assert.deepEqual(p.push, { 'sgx-accent': { v: null, t: 500 } });
});

test('云端空、本机设过（第一次开同步）→ 用本机时间或现在推上去；默认值不推', () => {
  const p = plan(K, { 'sgx-theme-mode': 'dark', 'sgx-palette': null, 'sgx-accent': '#123456' }, { 'sgx-accent': 77 }, {}, 1000);
  assert.deepEqual(p.push, { 'sgx-theme-mode': { v: 'dark', t: 1000 }, 'sgx-accent': { v: '#123456', t: 77 } });
  assert.equal(p.meta['sgx-theme-mode'], 1000);
});

test('新设备（本机时间全 0）→ 云端全部覆盖本机', () => {
  const p = plan(K, { 'sgx-theme-mode': 'light', 'sgx-palette': null, 'sgx-accent': null }, {},
    { 'sgx-theme-mode': { v: 'dark', t: 5 }, 'sgx-accent': { v: null, t: 5 } }, 1000);
  assert.deepEqual(p.apply, { 'sgx-theme-mode': 'dark' });
  assert.deepEqual(p.push, {});
});
