/**
 * 继承主站外观和语言：外观交给共享读端（契约见 ui-cookie-contract.test.mjs）；语言是四站同一份首帧跳转（共享外壳 lang-boot.js，
 * 语言清理 2026-11-07：「跟随系统」四站一致，每页都按偏好 / 浏览器语言跳，不只首页）。这里测本站接线和本站地址。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { langBootTarget, readLangPref, cookieLangRaw } from '../../space/web/assets/js/lib/lang-boot.js';

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

test('本站每一页都跳（不只首页）：跟随系统 + 中文浏览器 → /curio/zh/…；英文浏览器不跳；保留查询串和 #页签', () => {
  const zhNav = { nav: { language: 'zh-CN', languages: ['zh-CN', 'en'] } };
  assert.equal(go('system', '/curio/', { ...zhNav, hash: '#trove' }), '/curio/zh/#trove');
  assert.equal(go('system', '/curio/404.html', zhNav), '/curio/zh/404.html');
  assert.equal(go('system', '/curio/', { ...zhNav, search: '?a=1' }), '/curio/zh/?a=1');
  assert.equal(go('system', '/curio/'), '', '英文浏览器');
  assert.equal(go('system', '/curio/zh/', zhNav), '');
  assert.equal(go('en', '/curio/zh/', { hash: '#flavors' }), '/curio/#flavors');
  assert.equal(go('en', '/curio/zh'), '/curio/');
  assert.equal(go('zh', '/curio/', { ua: 'Googlebot/2.1' }), '', '爬虫不跳');
});

test('页面接线：<html data-sgx-langs> 来自 hugo.yaml；baseof 先内联 lang-boot，再内联共享读端和 ui-inherit-run.js（都在样式前）', () => {
  const base = read('space/web/layouts/curio/baseof.html');
  assert.ok(base.includes('data-sgx-langs="{{ range $i, $s := hugo.Sites }}{{ if $i }} {{ end }}{{ $s.Language.Lang }}{{ end }}"'), '语言列表来自 hugo.yaml');
  const iBoot = base.indexOf('resources.Get "js/lib/lang-boot.js" | js.Build');
  const iReader = base.indexOf('resources.Get "js/lib/ui-cookie-read.js" | minify');
  const iRun = base.indexOf('resources.Get "curio/js/sgx/ui-inherit-run.js"');
  assert.ok(iBoot > 0 && iBoot < iReader && iReader < iRun && iRun < base.indexOf('css/main.css'));
  const run = read('space/web/assets/curio/js/sgx/ui-inherit-run.js');
  assert.match(run, /U\.apply\(document\.documentElement, \{ onMiss: loadEngine \}\)/);
  assert.doesNotMatch(run, /location\.replace|langTarget|cookieLang/, '语言跳转只在 lang-boot.js');
  for (const [f, src] of [['ui-inherit-run.js', run], ['shell-accent.js', read('space/web/assets/curio/js/sgx/shell-accent.js')]]) {
    assert.doesNotMatch(src, /atob|data-sgx-seed|'lake'|ui\.theme/, f);
  }
  assert.match(read('space/web/assets/curio/js/sgx/shell-accent.js'), /U\.setRoles\(seed, rolesCss\(seed\)\)/);
});
