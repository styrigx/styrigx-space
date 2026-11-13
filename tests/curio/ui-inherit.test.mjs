/**
 * 继承主站外观和语言：外观交给共享读端（契约见 ui-cookie-contract.test.mjs）；语言是四站同一份首帧跳转（共享外壳 lang-boot.js，
 * 语言清理 2026-11-07：「跟随系统」四站一致，每页都按偏好 / 浏览器语言跳，不只首页）。这里测本站接线和本站地址。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { langBootTarget, readLangPref, cookieLangRaw } from '../../space/web/assets/shell/js/i18n/lang-boot.js';

const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const enc = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const go = (pref, pathname, extra = {}) => langBootTarget({ pref, loc: { pathname, ...extra }, nav: extra.nav || { language: 'en-US' }, ua: extra.ua || 'Mozilla/5.0' });

test('偏好：明确语言 / system / 旧版的空 → 跟随系统；localStorage 没有明确值才看 cookie', () => {
  assert.equal(readLangPref('zh', ''), 'zh');
  assert.equal(readLangPref('en', 'zh'), 'en', 'localStorage 优先');
  assert.equal(readLangPref('system', 'zh'), 'system', '明确的跟随系统不被旧 cookie 盖掉');
  assert.equal(readLangPref(null, 'zh'), 'zh');
  assert.equal(readLangPref(null, ''), 'system', '旧版跟随系统存的空');
  assert.equal(readLangPref('', 'system'), 'system');
  assert.equal(readLangPref('klingon', 'xx'), 'system');
});

test('cookie × 主站契约夹具：首帧要的语言 = 夹具 read.lang（是配置里的语言才算明确选择，其余跟随系统）', () => {
  const fx = JSON.parse(read('tests/fixtures/ui-cookie-contract.json'));
  for (const c of fx.cases) {
    const lang = c.read && c.read.lang;
    const want = lang === 'zh' || lang === 'en' ? lang : 'system';
    assert.equal(readLangPref(null, cookieLangRaw('sgx-space-session=x; sgx-ui=' + c.cookie + '; other=1')), want, c.name);
  }
  assert.equal(cookieLangRaw('sgx-ui=' + enc({ v: 3, lang: 'en' })), '', '未知版本 = 没有 cookie');
});

test('跟随系统（Auto）在子站不跳（2026-11-09：只在进主站首页 / ↔ /zh/ 时跳，深链 / 分享地址不动）；明确选择每页都跳、保留查询串和 #页签', () => {
  const zhNav = { nav: { language: 'zh-CN', languages: ['zh-CN', 'en'] } };
  assert.equal(go('system', '/curio/', { ...zhNav, hash: '#x' }), '');
  assert.equal(go('system', '/curio/404.html', zhNav), '');
  assert.equal(go('system', '/curio/zh/'), '', '英文浏览器也不跳回');
  assert.equal(go('zh', '/curio/', { hash: '#x' }), '/curio/zh/#x');
  assert.equal(go('zh', '/curio/', { search: '?a=1' }), '/curio/zh/?a=1');
  assert.equal(go('en', '/curio/zh/', { hash: '#y' }), '/curio/#y');
  assert.equal(go('en', '/curio/zh'), '/curio/');
  assert.equal(go('zh', '/curio/', { ua: 'Googlebot/2.1' }), '', '爬虫不跳');
});

test('页面接线：<html data-sgx-langs> 来自 hugo.yaml；baseof 先内联 lang-boot，再内联共享读端和 ui-inherit-run.js（都在样式前）', () => {
  const base = read('space/web/layouts/curio/baseof.html');
  assert.ok(base.includes('data-sgx-langs="{{ range $i, $s := hugo.Sites }}{{ if $i }} {{ end }}{{ $s.Language.Lang }}{{ end }}"'), '语言列表来自 hugo.yaml');
  const iBoot = base.indexOf('resources.Get "shell/js/i18n/lang-boot.js" | js.Build');
  const iReader = base.indexOf('resources.Get "shell/js/prefs/ui-cookie-read.js" | minify');
  const iRun = base.indexOf('resources.Get "curio/js/sgx/ui-inherit-run.js"');
  assert.ok(iBoot > 0 && iBoot < iReader && iReader < iRun && iRun < base.indexOf('css/main.css'));
  const run = read('space/web/assets/curio/js/sgx/ui-inherit-run.js');
  assert.match(run, /U\.apply\(document\.documentElement\)/);
  assert.ok(!base.includes('shell-accent') && !base.includes('data-sgx-accent-js'), '调色板 v4：自定义色引擎删了');
  assert.doesNotMatch(run, /location\.replace|langTarget|cookieLang/, '语言跳转只在 lang-boot.js');
  assert.doesNotMatch(run, /atob|data-sgx-seed|'lake'|ui\.theme|onMiss|loadEngine/, 'ui-inherit-run.js');
});
