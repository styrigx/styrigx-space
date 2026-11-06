/**
 * P4-3 PR-4c（§6.8，§8 第 7 条）：四站英文是默认语言（无前缀），中文在 /zh/；旧 /en/… 删除不 301。
 * - 语言路径唯一函数 space/web/assets/js/lib/lang-path.js：对表（主站、子站、/zh 边界、旧 /en/ 不是前缀）
 * - 共享外壳原样复制了 lang-path.js / lang-path.html；子站的 sgx-lang-path.html 和主站一字不差
 * - 四站 Hugo 配置：defaultContentLanguage en、不生成 /en/ 跳转页；主站内容英文在 content/、中文在 content/zh/（url 带 /zh/）
 * - 构建产物（有才跑；CI 在拼树之后补跑）：任何文件路径都只有 ASCII；没有 en/ 目录；中文页 html lang=zh；
 *   主站 hreflang / 快捷面板导航地址 = langPath()；sitemap 只在站根一份
 * 运行：node --test tests/space/ui/build/lang-default.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { langPath, pathLang, stripLang, langSwitch, systemLang } from '../../../../space/web/assets/js/lib/lang-path.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const rd = (/** @type {string} */ p) => readFileSync(path.join(REPO, p), 'utf8');
const SITES = ['blog', 'curio', 'daymark'];

test('langPath / pathLang / stripLang：英文无前缀，中文 /zh/（子站加在站名后）', () => {
  const table = [
    ['/', '/', '/zh/'],
    ['/zh/', '/', '/zh/'],
    ['/zh', '/', '/zh/'],
    ['/account/', '/account/', '/zh/account/'],
    ['/zh/security/lock/', '/security/lock/', '/zh/security/lock/'],
    ['/blog/', '/blog/', '/blog/zh/'],
    ['/blog/zh/post/x/', '/blog/post/x/', '/blog/zh/post/x/'],
    ['/curio/zh/', '/curio/', '/curio/zh/'],
    ['/daymark', '/daymark/', '/daymark/zh/'],
    /* 旧 /en/ 不是语言前缀：当普通路径（线上 404） */
    ['/en/account/', '/en/account/', '/zh/en/account/'],
    /* 首段只是长得像 */
    ['/zhx/', '/zhx/', '/zh/zhx/'],
    ['/blogs/', '/blogs/', '/zh/blogs/'],
  ];
  for (const [p, en, zh] of table) {
    assert.equal(langPath(p, 'en'), en, p + ' en');
    assert.equal(langPath(p, 'zh'), zh, p + ' zh');
    assert.equal(stripLang(p), en, p + ' strip');
    assert.equal(pathLang(zh), 'zh', zh);
    assert.equal(pathLang(en), 'en', en);
  }
  assert.equal(langPath('/x/', 'fr'), '/x/', '不认识的语言按英文');
});

test('langSwitch：保留查询串和 #；同语言 / 不认识的 want 不跳', () => {
  assert.equal(langSwitch('zh', { pathname: '/theme/', search: '?a=1', hash: '#x' }), '/zh/theme/?a=1#x');
  assert.equal(langSwitch('en', { pathname: '/zh/theme/', search: '', hash: '' }), '/theme/');
  assert.equal(langSwitch('en', { pathname: '/theme/' }), '');
  assert.equal(langSwitch('zh', { pathname: '/blog/zh/' }), '');
  assert.equal(langSwitch('', { pathname: '/' }), '');
  assert.equal(langSwitch('en', { pathname: '/curio/zh/', hash: '#games' }), '/curio/#games');
});

test('systemLang：zh 开头 = 中文，其余（含取不到）= 英文', () => {
  assert.equal(systemLang({ language: 'zh-CN' }), 'zh');
  assert.equal(systemLang({ language: 'en-US' }), 'en');
  assert.equal(systemLang({ language: 'ja' }), 'en');
  assert.equal(systemLang({}), 'en');
});

test('共享外壳：lang-path.js / lang-path.html 原样进外壳，三个子站的副本和主站一致', () => {
  const man = JSON.parse(rd('space/web/shared/shell/manifest.json'));
  assert.ok(man.files['lang-path.js'] && man.files['lang-path.html'], 'manifest 缺 lang-path');
  assert.equal(rd('space/web/shared/shell/lang-path.html'), rd('space/web/layouts/partials/sgx-lang-path.html'));
  for (const s of SITES) {
    assert.equal(rd(`atlas/web/${s}/layouts/partials/sgx-lang-path.html`), rd('space/web/layouts/partials/sgx-lang-path.html'), s);
    assert.match(rd(`atlas/web/${s}/assets/js/sgx/shell/lang-path.js`), /export function langPath\(/, s);
  }
});

test('外壳顶栏的导航前缀和 langPath 同一规则（外壳 partial 不能调别的 partial，只能展开）', () => {
  const tpl = rd('space/web/layouts/partials/shell-topbar.html');
  assert.doesNotMatch(tpl, /printf "\/en%s"|printf "%sen\/"/, '顶栏不许再拼 /en');
  assert.match(tpl, /printf "%szh\/" \.path/);
  assert.match(tpl, /printf "\/zh%s" \.path/);
});

test('四站 Hugo 配置：默认英文、不生成默认语言跳转页', () => {
  for (const f of ['space/web/hugo.yaml', ...SITES.map((s) => `atlas/web/${s}/hugo.yaml`)]) {
    const c = /** @type {any} */ (yaml.load(rd(f)));
    assert.equal(c.defaultContentLanguage, 'en', f);
    assert.equal(c.defaultContentLanguageInSubdir, false, f);
    assert.equal(c.disableDefaultLanguageRedirect, true, f);
    assert.equal(c.languages.en.weight, 1, f);
    assert.equal(c.languages.zh.weight, 2, f);
  }
});

test('主站内容：英文在 content/（url 无前缀），中文在 content/zh/（url 带 /zh/），两边页面一一对应', () => {
  const dir = path.join(REPO, 'space/web/content');
  assert.ok(!existsSync(path.join(dir, 'en')), 'content/en/ 应已对调掉');
  const urlOf = (/** @type {string} */ f) => (readFileSync(f, 'utf8').match(/^url:\s*(\S+)/m) || [])[1];
  const en = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== '_index.md');
  const zh = readdirSync(path.join(dir, 'zh')).filter((f) => f.endsWith('.md') && f !== '_index.md');
  assert.deepEqual(zh.sort(), en.sort());
  for (const f of en) {
    const u = urlOf(path.join(dir, f));
    assert.ok(u && pathLang(u) === 'en' && !u.startsWith('/en/'), f + ' ' + u);
    assert.equal(urlOf(path.join(dir, 'zh', f)), langPath(u, 'zh'), 'zh/' + f);
  }
});

/** 递归列出目录里的文件（相对路径，/ 分隔） @param {string} root */
function walk(root) {
  /** @type {string[]} */
  const out = [];
  const go = (/** @type {string} */ d) => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) go(p);
      else out.push(path.relative(root, p).split(path.sep).join('/'));
    }
  };
  go(root);
  return out;
}

const OUTS = [
  ['space/web/public', ''],
  ...SITES.map((s) => [`atlas/web/${s}/public`, '/' + s]),
  ['dist/site', ''],
].filter(([d]) => existsSync(path.join(REPO, d, 'index.html')));

test('构建产物：路径只有 ASCII（中文页只多 /zh/，路径段全英文），没有 en/ 目录', { skip: !OUTS.length && '没有构建产物' }, () => {
  for (const [d] of OUTS) {
    const files = walk(path.join(REPO, d));
    const bad = files.filter((f) => /[^\x20-\x7e]/.test(f));
    assert.deepEqual(bad, [], d + ' 有非 ASCII 路径');
    assert.ok(!existsSync(path.join(REPO, d, 'en')), d + '/en/ 不该存在（旧 /en/… 删除不 301）');
    if (d === 'dist/site') for (const s of SITES) assert.ok(!existsSync(path.join(REPO, d, s, 'en')), `dist/site/${s}/en/ 不该存在`);
  }
});

const MAIN = path.join(REPO, 'space/web/public');
const hasMain = existsSync(path.join(MAIN, 'zh', 'index.html'));

test('主站产物：中文页 lang=zh、英文页 lang=en；hreflang = langPath()；只有根上一份 sitemap', { skip: !hasMain && '没有主站构建' }, () => {
  for (const f of walk(MAIN).filter((x) => x.endsWith('index.html'))) {
    const rel = '/' + f.replace(/index\.html$/, '');
    const html = readFileSync(path.join(MAIN, f), 'utf8');
    if (/http-equiv="?refresh/i.test(html)) continue;
    const lang = (html.match(/<html lang="?(\w+)/) || [])[1];
    assert.equal(lang, pathLang(rel), rel + ' html lang');
    const alt = (/** @type {string} */ l) => (html.match(new RegExp(`<link rel="?alternate"? hreflang="?${l}"? href="?([^"\\s>]+)`)) || [])[1];
    assert.equal(alt('en'), 'https://styrigx.com' + langPath(rel, 'en'), rel + ' hreflang en');
    assert.equal(alt('zh'), 'https://styrigx.com' + langPath(rel, 'zh'), rel + ' hreflang zh');
    assert.equal(alt('x-default'), 'https://styrigx.com' + langPath(rel, 'en'), rel + ' x-default');
  }
  assert.ok(existsSync(path.join(MAIN, 'sitemap.xml')));
  assert.ok(!existsSync(path.join(MAIN, 'zh', 'sitemap.xml')), '/zh/sitemap.xml 不该存在');
  const sm = readFileSync(path.join(MAIN, 'sitemap.xml'), 'utf8');
  assert.match(sm, /<urlset/);
  assert.doesNotMatch(sm, /\/en\//);
});

test('主站产物：快捷面板导航 / 账号入口在中文页都带 /zh/（同 langPath）', { skip: !hasMain && '没有主站构建' }, () => {
  const nav = JSON.parse(rd('space/web/data/shell-nav.json'));
  for (const [rel, lang] of [['/', 'en'], ['/zh/', 'zh'], ['/theme/', 'en'], ['/zh/theme/', 'zh']]) {
    const html = readFileSync(path.join(MAIN, rel.slice(1), 'index.html'), 'utf8');
    for (const it of nav.items) {
      assert.ok(html.includes(`href="${langPath(it.path, lang)}"`), `${rel}：导航 ${it.id} 应指向 ${langPath(it.path, lang)}`);
    }
    assert.doesNotMatch(html, /href="\/en\//, rel + ' 不该有 /en/ 链接');
  }
});

test('子站产物：中文首页在 /<站>/zh/，sitemap 只在站根', { skip: !SITES.every((s) => existsSync(path.join(REPO, `atlas/web/${s}/public/zh/index.html`))) && '没有子站构建' }, () => {
  for (const s of SITES) {
    const pub = path.join(REPO, `atlas/web/${s}/public`);
    assert.match(readFileSync(path.join(pub, 'zh', 'index.html'), 'utf8'), /<html[^>]* lang="?zh/, s);
    assert.match(readFileSync(path.join(pub, 'index.html'), 'utf8'), /<html[^>]* lang="?en/, s);
    assert.ok(!existsSync(path.join(pub, 'zh', 'sitemap.xml')), s + ' /zh/sitemap.xml');
  }
});
