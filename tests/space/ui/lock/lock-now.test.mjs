/**
 * 立即锁屏（进站 v3 L1：shell/space/lock-now.js lockNow；盾牌「立即锁屏」行和盾牌 lock 命令共用）：
 * - 只锁本机、不验证、没有确认层（Gray 2026-11-09 08:03；原 auth/lock-now.js 的「立即锁定？」确认层删了）
 * - 走 api.session.end()（= POST /api/lock-now）；2xx 才回 true（调用方随后去 /?entry=1）
 * - 非 2xx / 网络错误：回 false（调用方不跳锁屏、不假装已锁，终端里报锁定失败）
 * - 顶栏 NAVIGATE 的 lock 自带一份（topbar-panel.js 不 import 任何东西）：POST /api/lock-now 成功才 replace('/?entry=1')
 * 运行：node --test tests/space/ui/lock/lock-now.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const { lockNow } = await import('../../../../space/web/assets/js/shell/space/lock-now.js');

/** @param {any} impl */
function fakeApi(impl) {
  const calls = [];
  return { calls, session: { end: () => { calls.push('end'); return impl(); } } };
}

test('成功（2xx）：调一次 api.session.end，回 true', async () => {
  const api = fakeApi(async () => ({ s: 200, j: { ok: true } }));
  assert.equal(await lockNow(api), true);
  assert.deepEqual(api.calls, ['end']);
});

test('非 2xx：回 false（不跳锁屏）', async () => {
  for (const s of [401, 403, 500, 503]) {
    assert.equal(await lockNow(fakeApi(async () => ({ s, j: { ok: false } }))), false, String(s));
  }
});

test('网络错误：回 false，不抛', async () => {
  assert.equal(await lockNow(fakeApi(async () => { throw new TypeError('Failed to fetch'); })), false);
});

test('没有确认层；旧 auth/lock-now.js（confirmLockNow / doLock）删了；终端 lock 成功后重新取这一页（v5 S5），失败报 shield.lockFail', () => {
  assert.equal(existsSync(path.join(REPO, 'space/web/assets/js/auth/lock-now.js')), false);
  const src = readFileSync(path.join(REPO, 'space/web/assets/js/shell/space/lock-now.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(src, /dialog|confirm/i);
  const layer = readFileSync(path.join(REPO, 'space/web/assets/js/shell/space/layer.js'), 'utf8');
  assert.match(layer, /lockNow\(api\)\.then\(function \(ok\) \{\s*if \(ok\) \{ C\.relocked\(\); return; \}\s*C\.err\(t\('shield\.lockFail'\)\);/);
  assert.match(layer, /C\.relocked = function \(\) \{\s*o\.who\.drop\(\);\s*C\.setMode\('done'\);\s*o\.close\(o\.reload\);/);
  const tp = readFileSync(path.join(REPO, 'space/web/assets/js/shell/topbar-panel.js'), 'utf8');
  assert.ok(!tp.includes('ENTRY_URL') && !tp.includes("'/?entry=1'"), '没有锁屏地址了');
  assert.match(tp, /if \(r && r\.ok\) replace\(cleanHere\(\)\);\s*else if \(lockState\) lockState\.textContent = t\.lockFail;/);
});
