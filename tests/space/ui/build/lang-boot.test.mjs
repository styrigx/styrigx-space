/**
 * 语言清理（2026-11-07）：「跟随系统」四站一致。
 * - 四站 <head> 内联同一份首帧跳转 lib/lang-boot.js（共享外壳 lang-boot.js，sync-shell 同步）；主站 baseof 不再另写一段跳转
 * - 偏好明确存 'system'（prefs.js setLang / prefs-write.js setLangPref），旧版存的空 / 没有也按跟随系统
 * - 每一页都跳（不只首页）；保留 sgx-lang-hop（返回一次回主页）
 * - 语言列表来自 hugo.yaml languages（<html data-sgx-langs>），不写死
 * 运行：node --test tests/space/ui/build/lang-boot.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLangPref, langBootTarget, bootLang, cookieLangRaw } from '../../../../space/web/assets/js/lib/lang-boot.js';
import { setLangs, langPath, systemLang, langs } from '../../../../space/web/assets/js/lib/lang-path.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const rd = (/** @type {string} */ p) => readFileSync(path.join(REPO, p), 'utf8');
const SITES = ['blog', 'curio', 'daymark'];
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

test('四站内联同一份 lang-boot.js（共享外壳原样同步），主站 baseof 不再另写语言跳转', () => {
  const src = rd('space/web/assets/js/lib/lang-boot.js');
  const shell = rd('space/web/shared/shell/lang-boot.js');
  assert.equal(shell, src, '共享外壳 = 主站源');
  for (const s of SITES) {
    const copy = rd(`atlas/web/${s}/assets/js/sgx/shell/lang-boot.js`);
    assert.ok(copy.includes(src.trim().split('\n').slice(0, 40).join('\n')), s + ' 副本来自主站源');
  }
  const base = rd('space/web/layouts/_default/baseof.html');
  assert.match(base, /resources\.Get "js\/lib\/lang-boot\.js" \| js\.Build/);
  assert.doesNotMatch(base, /localStorage\.getItem\('sgx-lang'\)/, '主站不再自己读 sgx-lang 跳转');
  assert.match(rd('atlas/web/blog/layouts/partials/sgx-inherit.html'), /resources\.Get "js\/sgx\/shell\/lang-boot\.js" \| js\.Build/);
  for (const s of ['curio', 'daymark']) assert.match(rd(`atlas/web/${s}/layouts/_default/baseof.html`), /resources\.Get "js\/sgx\/shell\/lang-boot\.js" \| js\.Build/, s);
  /* 四站 <html> 都带语言列表（来自 hugo.yaml languages） */
  const LANGS_ATTR = 'data-sgx-langs="{{ range $i, $s := hugo.Sites }}{{ if $i }} {{ end }}{{ $s.Language.Lang }}{{ end }}"';
  for (const f of ['space/web/layouts/_default/baseof.html', 'atlas/web/blog/layouts/_default/baseof.html', 'atlas/web/curio/layouts/_default/baseof.html', 'atlas/web/daymark/layouts/_default/baseof.html']) {
    assert.ok(rd(f).includes(LANGS_ATTR), f);
  }
});

test('偏好：明确存 system；旧版的空 / 没有 = 跟随系统（兼容）；写端不再删 key', () => {
  assert.equal(readLangPref('system', 'zh'), 'system');
  assert.equal(readLangPref(null, ''), 'system');
  assert.equal(readLangPref('', ''), 'system');
  assert.equal(readLangPref(null, 'system'), 'system');
  assert.equal(readLangPref('zh', ''), 'zh');
  const prefs = rd('space/web/assets/js/lib/prefs.js');
  assert.match(prefs, /sset\('sgx-lang', pick\)/, 'prefs.js 明确写 system');
  assert.doesNotMatch(prefs, /sremove\('sgx-lang'\)/);
  const pw = rd('space/web/assets/js/lib/prefs-write.js');
  assert.match(pw, /lsSet\('sgx-lang', configuredLangs\(\)\.indexOf\(v\) >= 0 \? v : 'system'\)/);
  assert.equal(cookieLangRaw('sgx-ui=' + b64({ v: 2, lang: 'system' })), 'system');
});

test('跟随系统每页都跳（主站 / 子站同一规则），爬虫不跳；明确选择优先', () => {
  const zh = { language: 'zh-CN', languages: ['zh-CN'] };
  const t = (pref, pathname, nav = zh) => langBootTarget({ pref, nav, loc: { pathname, search: '', hash: '' }, ua: 'Mozilla/5.0' });
  for (const p of ['/', '/about/', '/blog/', '/curio/', '/daymark/', '/security/lock/']) assert.equal(t('system', p), langPath(p, 'zh'), p);
  assert.equal(t('system', '/about/', { language: 'en-US' }), '');
  assert.equal(t('en', '/zh/about/'), '/about/');
  assert.equal(t('zh', '/zh/about/'), '');
  assert.equal(langBootTarget({ pref: 'system', nav: zh, loc: { pathname: '/' }, ua: 'Googlebot' }), '');
});

test('bootLang：跳前记 sgx-lang-hop {go, ref}（navhistory 还原「直接打开子页」，返回一次回主页）', () => {
  const session = {};
  const replaced = [];
  const w = {
    localStorage: { getItem: () => null },
    sessionStorage: { setItem: (k, v) => (session[k] = v) },
    navigator: { userAgent: 'Mozilla/5.0', language: 'zh-CN', languages: ['zh-CN'] },
    location: { pathname: '/about/', search: '?x=1', hash: '#a', replace: (u) => replaced.push(u) },
    document: { cookie: '', referrer: 'https://example.com/', querySelectorAll: () => [], querySelector: () => null },
  };
  assert.equal(bootLang(w), '/zh/about/?x=1#a');
  assert.deepEqual(replaced, ['/zh/about/?x=1#a']);
  assert.deepEqual(JSON.parse(session['sgx-lang-hop']), { go: '/zh/about/?x=1#a', ref: 'https://example.com/' });
  assert.equal(w.__sgxLangGo, 1);
});

test('语言列表来自配置：加一种语言不用改 lang-path / lang-boot', () => {
  try {
    setLangs(['en', 'zh', 'ja']);
    assert.deepEqual(langs(), ['en', 'zh', 'ja']);
    assert.equal(langPath('/blog/post/x/', 'ja'), '/blog/ja/post/x/');
    assert.equal(langPath('/ja/about/', 'zh'), '/zh/about/');
    assert.equal(systemLang({ languages: ['ja-JP', 'en'] }), 'ja');
    assert.equal(langBootTarget({ pref: 'system', nav: { languages: ['ja'] }, loc: { pathname: '/curio/' }, ua: '' }), '/curio/ja/');
    assert.equal(readLangPref('ja', ''), 'ja');
  } finally {
    setLangs(null);
  }
  assert.equal(langPath('/x/', 'ja'), '/x/', '没配置的语言按英文');
});
