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

test('NAVIGATE #sgx-nav（顶栏 v3；v5 S6 顶栏 E）：四格按钮（类名照旧 sgx-tb-grid，图标 tb-grid）控制它；五项「编号 · 名字 · 路径提示」，当前项 aria-current；JS 接 lang / layout / share / esc', () => {
  assert.match(tb, /<button type="button" class="sgx-tb-btn sgx-tb-grid" aria-label="\{\{ \$t\.topbar\.sites \}\}" title="\{\{ \$t\.topbar\.sites \}\}" aria-haspopup="dialog" aria-controls="sgx-nav" aria-expanded="false">\{\{ index \$i "tb-grid" \| safeHTML \}\}<\/button>/);
  const nav = tb.slice(tb.indexOf('<dialog id="sgx-nav"'), tb.indexOf('</dialog>', tb.indexOf('<dialog id="sgx-nav"')));
  assert.match(nav, /<ul class="sgx-nav-list">/);
  assert.match(nav, /<a class="sgx-nav-tile" href="\{\{ \$p \}\}" data-nav="\{\{ \.id \}\}"\{\{ if eq \.id \$\.site \}\} aria-current="page"\{\{ end \}\}><em class="sgx-nav-no" aria-hidden="true">\{\{ printf "%02d" \(add \$k 1\) \}\}<\/em><span class="sgx-nav-name">\{\{ \(index \$t\.nav \.id\)\.title \}\}<\/span><span class="sgx-nav-hint" aria-hidden="true" translate="no">\{\{ \.hint \}\}<\/span><\/a>/);
  const js = rd('space/web/assets/js/shell/topbar-panel.js');
  assert.match(js, /wire\(navBtn, navDlg, 'sgxNav'/);
  assert.match(js, /tg\.closest\('\[data-nav-close\]'\)/);
  assert.match(js, /tg\.closest\('\[data-qp-lang\]'\)/);
  assert.match(js, /tg\.closest\('\[data-qp-seg="layout"\] button'\)/);
  /* v5 S5：盾牌下拉删了（sec / openShield 没了），终端视图 termView、身份 who 交出去 */
  assert.match(js, /return \{ nav: nav && nav\.ms, qp: qp && qp\.ms, ai: ai && ai\.ms, acct: acct && acct\.ms, openAccount: function \(\) \{ openAcct\(\); \}, term: termSheet, termShell: term, termView: view, who: who, paint: paint, paintNav: paintNav \};/);
  /* 2026-11 PR-2：NAVIGATE「$ terminal」→ 关面板后打开终端 */
  assert.match(js, /if \(id === 'term'\) \{ ms\.close\(function \(\) \{ window\.setTimeout\(openTerm, 0\); \}\); return; \}/);
});

test('立即锁屏（v5 S6）：NAVIGATE 的 lock 按钮删了，顶栏不再自己 POST /api/lock-now；上锁走终端 lock、已进站点盾牌（[y/N]）；四站同一套', () => {
  const js = rd('space/web/assets/js/shell/topbar-panel.js');
  assert.doesNotMatch(js, /LOCK_ARM_MS|LOCK_NOW_API|lockState|onLock/);
  /* 盾牌：v6 P4 起旧的「退出进站会话 [y/N]」（钥匙层 lockAsk）随旧会话删除（定稿 v5.2 §十三 P4）；访客预填 su ，已登录只打开终端 */
  assert.doesNotMatch(js, /lockAsk|layers\(\)\.space/);
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

test('v5 S6 顶栏 E：头像访客态（v6 割接起点了预填 su ，不再是死按钮；有网关标记才判）、>_ 开合终端、盾牌分两态；v5 S7 主页 neofetch 提示符跟身份', () => {
  const js = rd('space/web/assets/js/shell/topbar-panel.js');
  /* 头像：同步看终端身份；页面没有网关标记（本地 / 测试构建）不当访客；v6 普通用户（u:<名>）不算访客 */
  assert.match(js, /const avGuest = function \(\) \{\s*if \(!who\) return false;\s*const pg = doc\.documentElement\.getAttribute\('data-sgx-lock-session'\);\s*if \(pg !== 'valid' && pg !== 'locked'\) return false;\s*return who\.get\(\)\.indexOf\('u:'\) !== 0;\s*\};/, 'v6：只有 v6 身份（u:<名>）不算访客（v6 P4 旧身份删了）');
  assert.match(js, /e\.preventDefault\(\);\s*e\.stopImmediatePropagation\(\);\s*termPrefill\(c\);\s*\}, true\);/);
  assert.doesNotMatch(js, /avDead/, '割接：访客头像不再是死按钮');
  assert.match(js, /if \(avDecor\(\)\) acctBtn\.setAttribute\('aria-disabled', 'true'\);/, 'P4-3：只有普通用户的头像是装饰（定稿 v5.5 §七）');
  /* >_：开合终端（同 Ctrl / ⌘ K）；终端窗口的 opener 是它 */
  assert.match(js, /const termBtn = \/\*\* @type \{HTMLElement\|null\} \*\/ \(doc\.querySelector\('#site-nav \.sgx-tb-term'\)\);/);
  assert.match(js, /const opener = termBtn \|\| navBtn \|\|/);
  /* 盾牌 = 身份徽章（P4-3，定稿 v5.5 §七）：按档预填；旧地址 #sec / [data-sec-open] 走 openShield（不问退出） */
  assert.match(js, /const c = shieldCmd\(tierOf\(\)\);\s*if \(c && !view\.input\.value\) view\.prefill\(c\);\s*\}\);\s*\}\);\s*\};/);
  assert.match(js, /window\.setTimeout\(openShield, 0\);/);
  /* 主页 neofetch 的提示符：[data-sgx-ps] = ps1(身份, '~') */
  assert.match(js, /el\.textContent = T\.ps1\(who\.get\(\), '~'\);/);
  assert.match(rd('space/web/assets/js/shell/terminal.js'), /export \{ DIRS, normDir, cwdPath, fill, parse, createWho, ps1 \};/);
  const home = rd('space/web/layouts/index.html');
  assert.match(home, /<div id="about" class="sgx-term sgx-term--static trm-win home-about"/);
  assert.match(home, /<span class="sgx-term-pp" data-sgx-ps>nobody@space:~\$<\/span> neofetch/);
  assert.doesNotMatch(home, /data-sgx-term="home"/, '主页不再嵌终端');
  /* 子站图标表（nav.json）里有 tb-grid */
  assert.match(rd('space/web/data/shell/nav.json'), /"tb-grid": "<svg/);
});
