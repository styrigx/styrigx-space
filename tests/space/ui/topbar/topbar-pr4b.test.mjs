/**
 * P4-3 PR-4b 顶栏定稿（Gray 2026-11-07）：九宫格导航面板、快捷面板四站同一套、AI 窗口头部头像 + 底部联系我。
 * 浏览器里的行为在 tests/space/e2e/topbar/topbar-pr4b.spec.js（主站）与 tests/curio/e2e/topbar-pr4b.spec.js（四站 DOM 一致）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveLang } from '../../../../space/web/assets/js/shell/topbar-panel.js';

const rd = (p) => readFileSync(new URL('../../../../' + p, import.meta.url), 'utf8');
const tb = rd('space/web/layouts/partials/shell-topbar.html');

test('语言偏好 → 实际语言：zh / en 原样；跟随系统看浏览器语言（zh* → zh，其余 → en）', () => {
  assert.equal(resolveLang('zh', 'en-US'), 'zh');
  assert.equal(resolveLang('en', 'zh-CN'), 'en');
  assert.equal(resolveLang('system', 'zh-CN'), 'zh');
  assert.equal(resolveLang('system', 'zh'), 'zh');
  assert.equal(resolveLang('system', 'en-GB'), 'en');
  assert.equal(resolveLang('', ''), 'en');
});

test('导航面板 #sgx-nav：九宫格按钮控制它；2×2 站点磁贴复用快捷面板磁贴（图标 + 站名 + 副标题），当前站 aria-current', () => {
  assert.match(tb, /<button type="button" class="sgx-tb-btn sgx-tb-grid" aria-label="[^"]*" aria-haspopup="dialog" aria-controls="sgx-nav" aria-expanded="false">\{\{ index \$i "tb-grid" \| safeHTML \}\}<\/button>/);
  const nav = tb.slice(tb.indexOf('<dialog id="sgx-nav"'), tb.indexOf('</dialog>', tb.indexOf('<dialog id="sgx-nav"')));
  assert.match(nav, /<ul class="sgx-qp-grid sgx-nav-grid">/);
  assert.match(nav, /<a class="sgx-qp-tile sgx-nav-tile" href="\{\{ \$p \}\}" data-nav="\{\{ \.id \}\}"\{\{ if eq \.id \$\.site \}\} aria-current="page"\{\{ end \}\}><span class="sgx-qp-ic">/);
  assert.match(nav, /<span class="sgx-qp-state">\{\{ cond \$en \.suben \.subzh \}\}<\/span>/);
  const js = rd('space/web/assets/js/shell/topbar-panel.js');
  assert.match(js, /wire\(navBtn, navDlg, 'sgxNav'/);
  assert.match(js, /return \{ nav: nav && nav\.ms, qp: qp && qp\.ms, ai: ai && ai\.ms, paint: paint \};/);
});

test('子站立即锁定：不传 onLock 时点两下确认（3 秒内），POST /api/lock-now 成功后回锁屏 /?lock=1；主站传确认层', () => {
  const js = rd('space/web/assets/js/shell/topbar-panel.js');
  assert.match(js, /const LOCK_ARM_MS = 3000;/);
  assert.match(js, /f\('\/api\/lock-now', \{ method: 'POST', credentials: 'include' \}\)/);
  assert.match(js, /if \(r && r\.ok\) replace\('\/\?lock=1'\);/);
  assert.match(rd('space/web/assets/js/shell/quick-panel.js'), /onLock: confirmLockNow,/);
  for (const s of ['curio', 'daymark']) assert.doesNotMatch(rd(`atlas/web/${s}/assets/js/sgx/topbar-host.js`), /onLock:/, s);
});

test('子站布局 / 语言写端（prefs-write.js）：四个入口都把 langPref / layoutPref / setLayout 传给 mountTopbar（layoutNarrow 不再传：桌面任何时候都能选）', () => {
  const pw = rd('space/web/assets/js/lib/prefs-write.js');
  for (const f of ['langPref', 'layoutPref', 'setLayout']) assert.match(pw, new RegExp('export function ' + f + '\\('), f);
  assert.match(pw, /lsSet\('sgx-layout', n\);/);
  for (const f of ['atlas/web/curio/assets/js/sgx/topbar-host.js', 'atlas/web/daymark/assets/js/sgx/topbar-host.js', 'atlas/web/blog/assets/js/entries/topnav.ts']) {
    const s = rd(f);
    for (const k of ['langPref', 'layoutPref', 'setLayout']) assert.match(s, new RegExp(k + ': prefs\\.' + k), f + ' ' + k);
    assert.doesNotMatch(s, /layoutNarrow/, f);
  }
});
