/**
 * 语言清理（2026-11-07）：「跟随系统」四站一致。
 * - 四站 <head> 内联同一份首帧跳转 lib/lang-boot.js（2026-11 合站后子站直接用主站这份，没有副本）；主站 baseof 不再另写一段跳转
 * - 偏好明确存 'system'（prefs.js setLang / prefs-write.js setLangPref），旧版存的空 / 没有也按跟随系统
 * - 每一页都跳（不只首页）；保留 sgx-lang-hop（返回一次回主页）
 * - 语言列表来自 hugo.yaml languages（<html data-sgx-langs>），不写死
 * 运行：node --test tests/space/ui/build/lang-boot.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLangPref, langBootTarget, bootLang, cookieLangRaw } from '../../../../space/web/assets/shell/js/lib/lang-boot.js';
import { setLangs, langPath, systemLang, langs, isHomePath } from '../../../../space/web/assets/shell/js/lib/lang-path.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const rd = (/** @type {string} */ p) => readFileSync(path.join(REPO, p), 'utf8');
const SITES = ['blog', 'curio', 'daymark'];
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

test('四站内联同一份 lang-boot.js（合站后子站直接用主站源文件），主站 baseof 不再另写语言跳转', () => {
  assert.equal(existsSync(path.join(REPO, 'space/web/shared/shell')), false, '没有外壳副本目录');
  for (const s of SITES) assert.equal(existsSync(path.join(REPO, 'space/web/assets', s, 'js/sgx/shell')), false, s + ' 没有外壳 JS 副本');
  const base = rd('space/web/layouts/_default/baseof.html');
  assert.match(base, /resources\.Get "js\/lib\/lang-boot\.js" \| js\.Build/);
  assert.doesNotMatch(base, /localStorage\.getItem\('sgx-lang'\)/, '主站不再自己读 sgx-lang 跳转');
  assert.match(rd('space/web/layouts/partials/blog/sgx-inherit.html'), /resources\.Get "js\/lib\/lang-boot\.js" \| js\.Build/);
  for (const s of ['curio', 'daymark']) assert.match(rd(`space/web/layouts/${s}/baseof.html`), /resources\.Get "js\/lib\/lang-boot\.js" \| js\.Build/, s);
  /* 四站 <html> 都带语言列表（来自 hugo.yaml languages） */
  const LANGS_ATTR = 'data-sgx-langs="{{ range $i, $s := hugo.Sites }}{{ if $i }} {{ end }}{{ $s.Language.Lang }}{{ end }}"';
  for (const f of ['space/web/layouts/_default/baseof.html', 'space/web/layouts/blog/baseof.html', 'space/web/layouts/curio/baseof.html', 'space/web/layouts/daymark/baseof.html']) {
    assert.ok(rd(f).includes(LANGS_ATTR), f);
  }
});

test('偏好：明确存 system；旧版的空 / 没有 = 跟随系统（兼容）；写端不再删 key', () => {
  assert.equal(readLangPref('system', 'zh'), 'system');
  assert.equal(readLangPref(null, ''), 'system');
  assert.equal(readLangPref('', ''), 'system');
  assert.equal(readLangPref(null, 'system'), 'system');
  assert.equal(readLangPref('zh', ''), 'zh');
  const prefs = rd('space/web/assets/shell/js/lib/prefs.js');
  assert.match(prefs, /sset\('sgx-lang', pick\)/, 'prefs.js 明确写 system');
  assert.doesNotMatch(prefs, /sremove\('sgx-lang'\)/);
  const pw = rd('space/web/assets/shell/js/lib/prefs-write.js');
  assert.match(pw, /lsSet\('sgx-lang', configuredLangs\(\)\.indexOf\(v\) >= 0 \? v : 'system'\)/);
  assert.equal(cookieLangRaw('sgx-ui=' + b64({ v: 2, lang: 'system' })), 'system');
});

test('跟随系统（Auto）只在从站外进主站首页时跳（/ ↔ /zh/），深链 / 子站 / 站内点回首页不跳；明确选择每页都跳；爬虫不跳', () => {
  const zh = { language: 'zh-CN', languages: ['zh-CN'] };
  const en = { language: 'en-US', languages: ['en-US'] };
  const t = (pref, pathname, nav = zh, internal = false) => langBootTarget({ pref, nav, internal, loc: { pathname, search: '?q=1', hash: '#x' }, ua: 'Mozilla/5.0' });
  assert.equal(t('system', '/'), '/zh/?q=1#x');
  assert.equal(t('system', '/zh/', en), '/?q=1#x');
  assert.equal(t('system', '/zh/'), '');
  assert.equal(t('system', '/', en), '');
  assert.equal(t('system', '/', zh, true), '', '站内点回首页不跳');
  for (const p of ['/about/', '/zh/about/', '/blog/', '/blog/zh/', '/curio/', '/daymark/', '/security/lock/', '/blog/post/x/']) {
    assert.equal(t('system', p), '', p);
    assert.equal(t('system', p, en), '', p + ' en');
  }
  assert.equal(t('en', '/zh/about/'), '/about/?q=1#x');
  assert.equal(t('zh', '/about/', en), '/zh/about/?q=1#x');
  assert.equal(t('zh', '/blog/post/x/', en, true), '/blog/zh/post/x/?q=1#x');
  assert.equal(t('zh', '/zh/about/'), '');
  assert.equal(langBootTarget({ pref: 'system', nav: zh, loc: { pathname: '/' }, ua: 'Googlebot' }), '');
  assert.equal(readLangPref('auto', ''), 'system');
  assert.equal(readLangPref(null, ''), 'system');
  assert.equal(readLangPref(null, 'zh'), 'zh');
});

test('isHomePath：只认主站首页 / 和 /<语言>/', () => {
  for (const p of ['/', '/zh/', '/zh', '']) assert.equal(isHomePath(p), true, p);
  for (const p of ['/about/', '/zh/about/', '/blog/', '/blog/zh/', '/curio/', '/daymark/zh/', '/en/']) assert.equal(isHomePath(p), false, p);
});

test('bootLang：跳前记 sgx-lang-hop {go, ref}（navhistory 还原「直接打开子页」，返回一次回主页）', () => {
  const mk = (pathname, referrer, stored = null) => {
    const session = {};
    const replaced = [];
    const w = {
      localStorage: { getItem: () => stored },
      sessionStorage: { setItem: (k, v) => (session[k] = v) },
      navigator: { userAgent: 'Mozilla/5.0', language: 'en-US', languages: ['en-US', 'zh-CN'] },
      location: { origin: 'https://styrigx.com', pathname, search: '?x=1', hash: '#a', replace: (u) => replaced.push(u) },
      document: { cookie: '', referrer, querySelectorAll: () => [], querySelector: () => null },
    };
    return { w, session, replaced };
  };
  const a = mk('/', 'https://example.com/');
  assert.equal(bootLang(a.w), '/zh/?x=1#a');
  assert.deepEqual(a.replaced, ['/zh/?x=1#a']);
  assert.deepEqual(JSON.parse(a.session['sgx-lang-hop']), { go: '/zh/?x=1#a', ref: 'https://example.com/' });
  assert.equal(a.w.__sgxLangGo, 1);
  const b = mk('/', 'https://styrigx.com/zh/blog/');
  assert.equal(bootLang(b.w), '');
  assert.deepEqual(b.replaced, []);
  assert.equal(bootLang(mk('/about/', 'https://example.com/').w), '');
  const d = mk('/about/', 'https://example.com/', 'zh');
  assert.equal(bootLang(d.w), '/zh/about/?x=1#a');
  assert.deepEqual(JSON.parse(d.session['sgx-lang-hop']), { go: '/zh/about/?x=1#a', ref: 'https://example.com/' });
});

test('语言列表来自配置：加一种语言不用改 lang-path / lang-boot', () => {
  try {
    setLangs(['en', 'zh', 'ja']);
    assert.deepEqual(langs(), ['en', 'zh', 'ja']);
    assert.equal(langPath('/blog/post/x/', 'ja'), '/blog/ja/post/x/');
    assert.equal(langPath('/ja/about/', 'zh'), '/zh/about/');
    assert.equal(systemLang({ languages: ['ja-JP', 'en'] }), 'ja');
    assert.equal(langBootTarget({ pref: 'system', nav: { languages: ['ja'] }, loc: { pathname: '/' }, ua: '' }), '/ja/');
    assert.equal(langBootTarget({ pref: 'ja', nav: {}, loc: { pathname: '/curio/' }, ua: '' }), '/curio/ja/');
    assert.equal(readLangPref('ja', ''), 'ja');
  } finally {
    setLangs(null);
  }
  assert.equal(langPath('/x/', 'ja'), '/x/', '没配置的语言按英文');
});
