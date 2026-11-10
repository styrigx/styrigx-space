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

test('NAVIGATE #sgx-nav（顶栏 v3）：>_ 按钮（类名照旧 sgx-tb-grid）控制它；五项「编号 · 名字 · 路径提示」，当前项 aria-current；JS 接 lang / layout / share / lock / esc', () => {
  assert.match(tb, /<button type="button" class="sgx-tb-btn sgx-tb-grid" aria-label="\{\{ \$t\.topbar\.sites \}\}" title="\{\{ \$t\.topbar\.sites \}\}" aria-haspopup="dialog" aria-controls="sgx-nav" aria-expanded="false">\{\{ index \$i "tb-term" \| safeHTML \}\}<\/button>/);
  const nav = tb.slice(tb.indexOf('<dialog id="sgx-nav"'), tb.indexOf('</dialog>', tb.indexOf('<dialog id="sgx-nav"')));
  assert.match(nav, /<ul class="sgx-nav-list">/);
  assert.match(nav, /<a class="sgx-nav-tile" href="\{\{ \$p \}\}" data-nav="\{\{ \.id \}\}"\{\{ if eq \.id \$\.site \}\} aria-current="page"\{\{ end \}\}><em class="sgx-nav-no" aria-hidden="true">\{\{ printf "%02d" \(add \$k 1\) \}\}<\/em><span class="sgx-nav-name">\{\{ \(index \$t\.nav \.id\)\.title \}\}<\/span><span class="sgx-nav-hint" aria-hidden="true" translate="no">\{\{ \.hint \}\}<\/span><\/a>/);
  const js = rd('space/web/assets/js/shell/topbar-panel.js');
  assert.match(js, /wire\(navBtn, navDlg, 'sgxNav'/);
  assert.match(js, /tg\.closest\('\[data-nav-close\]'\)/);
  assert.match(js, /tg\.closest\('\[data-qp-lang\]'\)/);
  assert.match(js, /tg\.closest\('\[data-qp-seg="layout"\] button'\)/);
  /* v5 S5：盾牌下拉删了（sec / openShield 没了），终端视图 termView、身份 who 交出去 */
  assert.match(js, /return \{ nav: nav && nav\.ms, qp: qp && qp\.ms, ai: ai && ai\.ms, acct: acct && acct\.ms, openAccount: function \(\/\*\* @type \{any\} \*\/ x\) \{ openAcct\(x\); \}, term: termSheet, termShell: term, termView: view, who: who, paint: paint, paintNav: paintNav \};/);
  /* 2026-11 PR-2：NAVIGATE「$ terminal」→ 关面板后打开终端 */
  assert.match(js, /if \(id === 'term'\) \{ ms\.close\(function \(\) \{ window\.setTimeout\(openTerm, 0\); \}\); return; \}/);
});

test('立即锁屏（进站 v3 L1，Gray 2026-11-09 08:03）：只锁本机、不验证、点一下就锁（原点两下确认 / 确认层删了）；POST /api/lock-now 成功后重新取这一页（v5 S5）；四站都用 topbar-panel 自带的', () => {
  const js = rd('space/web/assets/js/shell/topbar-panel.js');
  assert.doesNotMatch(js, /LOCK_ARM_MS/);
  assert.match(js, /const LOCK_NOW_API = '\/api\/lock-now';/);
  assert.match(js, /f\(LOCK_NOW_API, \{ method: 'POST', credentials: 'include' \}\)/);
  /* v5 S5：没有锁屏界面了，锁上后重新取这一页（服务端画访客态） */
  assert.match(js, /if \(r && r\.ok\) replace\(cleanHere\(\)\);/);
  assert.doesNotMatch(js, /ENTRY_URL/);
  assert.doesNotMatch(rd('space/web/assets/js/shell/quick-panel.js'), /confirmLockNow/);
  for (const s of ['curio', 'daymark']) assert.doesNotMatch(rd(`space/web/assets/${s}/js/sgx/topbar-host.js`), /onLock:/, s);
});

test('子站布局 / 语言写端（prefs-write.js）：四个入口都把 langPref / layoutPref / setLayout 传给 mountTopbar（layoutNarrow 不再传：桌面任何时候都能选）', () => {
  const pw = rd('space/web/assets/js/lib/prefs-write.js');
  for (const f of ['langPref', 'layoutPref', 'setLayout']) assert.match(pw, new RegExp('export function ' + f + '\\('), f);
  assert.match(pw, /lsSet\('sgx-layout', n\);/);
  for (const f of ['space/web/assets/curio/js/sgx/topbar-host.js', 'space/web/assets/daymark/js/sgx/topbar-host.js', 'space/web/assets/blog/js/entries/topnav.ts']) {
    const s = rd(f);
    for (const k of ['langPref', 'layoutPref', 'setLayout']) assert.match(s, new RegExp(k + ': prefs\\.' + k), f + ' ' + k);
    assert.doesNotMatch(s, /layoutNarrow/, f);
  }
});
