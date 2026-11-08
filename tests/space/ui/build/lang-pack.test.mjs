// 语言包化回归测试（2026-11-07，Gray 定的原则）：
// - 网站以英文为基底，中文是汉化层；加语言 = 加一份语言包，文案集中在字符串表，缺键回退英文；
// - 「Gray AI」品牌名不翻；个人信息类（名字、签名、头像替代文字……）不走语言组，原样渲染并标 translate="no" data-sgx-personal；
// - 标签页标题四站统一「页名 | 站名」，站名走字符串表；页名就是站名时只显示站名。
// 构建产物部分要先 build（没构建就跳过，同 topbar-four-sites）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { REPO, rawTable, tableLangs, strings, flatKeys, deepMerge } from '../../../fixtures/strings.mjs';

const rd = (/** @type {string} */ p) => readFileSync(path.join(REPO, p), 'utf8');
const SITES = ['space', 'curio', 'daymark'];
const PUB = { space: 'space/web/public', blog: 'space/web/public/blog', curio: 'space/web/public/curio', daymark: 'space/web/public/daymark' };
const built = Object.values(PUB).every((d) => existsSync(path.join(REPO, d, 'index.html')));

/* 只在英文表里、不需要译文的键（品牌 / 产品名，回退英文就是对的） */
/* 复数形式（键_one / _two / _few / _many / _zero，按 Intl.PluralRules 选；没有就用键本身）：只有用得上的语言写，比如中文不分单复数 */
const EN_ONLY = /^(site\.name|js\.(account|lockmgr)\.pkProv_[a-z0-9_]+|js\.[\w]+\.[\w]+_(zero|one|two|few|many))$/;

/* ---------------- 字符串表本身 ---------------- */

test('各站字符串表：每种语言的键都是英文表的子集；英文以外缺的键只能是品牌名（其余都要有译文）', () => {
  for (const site of SITES) {
    for (const kind of ['i18n', 'sgx-shell-i18n']) {
      const langs = tableLangs(site, kind);
      assert.ok(langs.includes('en'), `${site} ${kind} 必须有 en.yaml（英文是源文本）`);
      const en = new Set(flatKeys(rawTable(site, 'en', kind)));
      for (const lang of langs.filter((l) => l !== 'en')) {
        const keys = flatKeys(rawTable(site, lang, kind));
        const extra = keys.filter((k) => !en.has(k));
        assert.deepEqual(extra, [], `${site} ${kind} ${lang}.yaml 有英文表里没有的键`);
        const have = new Set(keys);
        const missing = [...en].filter((k) => !have.has(k) && !EN_ONLY.test(k));
        assert.deepEqual(missing, [], `${site} ${kind} ${lang}.yaml 缺译文`);
      }
    }
  }
});

test('外壳字符串表只有主站一份（2026-11 合站后子站直接读 data/sgx-shell-i18n，没有副本）', () => {
  for (const s of ['blog', 'curio', 'daymark']) assert.ok(!existsSync(path.join(REPO, 'space/web/data', s, 'sgx-shell-i18n')), s);
  assert.ok(tableLangs('space', 'sgx-shell-i18n').includes('en'));
});

test('缺键回退英文：sgx-tr.html 是「英文表 ← 页面语言表」的合并，测试工具同一规则；不认识的语言整份回退英文', () => {
  const tpl = rd('space/web/layouts/partials/sgx-tr.html');
  assert.match(tpl, /merge \(index \$d "en" \| default dict\) \(index \$d \$lang \| default dict\)/);
  assert.match(tpl, /merge \(index \$s "en" \| default dict\) \(index \$s \$lang \| default dict\)/);
  /* 合并规则本身 */
  assert.deepEqual(deepMerge({ a: { x: 'X', y: 'Y' }, b: 'B' }, { a: { x: '叉' } }), { a: { x: '叉', y: 'Y' }, b: 'B' });
  /* 中文表缺的品牌键拿到英文 */
  assert.equal(strings('space', 'zh').site.name, 'Styrigx');
  assert.equal(strings('space', 'zh').js.account.pkProv_samsung_pass, 'Samsung Pass');
  /* 没有语言包的语言（假设 fr）= 全英文 */
  const fr = strings('space', 'fr');
  assert.deepEqual(flatKeys(fr).sort(), flatKeys(strings('space', 'en')).sort());
  assert.equal(fr.spaceCats.wild.title, 'Wild');
});

test('模板不再按语言二选一：主站 / 奇趣 / 日刻模板没有 $isEn、cond … "zh"、(dict "zh" … "en" …) 文案对子', () => {
  /** @param {string} dir @returns {string[]} */
  const walk = (dir) => readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.html') || p.endsWith('.json') ? [p] : [];
  });
  const bad = [];
  for (const d of ['space/web/layouts', 'space/web/layouts/curio', 'space/web/layouts/daymark', 'space/web/layouts/blog']) {
    for (const f of walk(path.join(REPO, d))) {
      const s = readFileSync(f, 'utf8').replace(/\{\{-? ?\/\*[\s\S]*?\*\/ ?-?\}\}/g, '');
      if (/\$isEn\b|\(dict "zh" "|"zh" "[^"]*" "en" "/.test(s)) bad.push(path.relative(REPO, f));
    }
  }
  assert.deepEqual(bad, []);
});

test('数据文件不带中英文字段（文案在字符串表）；签名 motto 是个人资料单一值（Gray 2026-11-07）', () => {
  for (const f of ['features.yaml', 'space-cats.yaml', 'sites.yaml', 'sync-items.yaml']) {
    const s = rd('space/web/data/' + f).replace(/^\s*#.*$/gm, '');
    assert.doesNotMatch(s, /\b(zh|en|sub_zh|sub_en|label_zh|label_en|motto_zh|motto_en):/, f);
  }
  assert.ok(!existsSync(path.join(REPO, 'space/web/data/en/sites.yaml')), 'en/sites.yaml 合进 sites.yaml');
  const prof = rd('space/web/data/profile.yaml');
  assert.match(prof, /^motto: .+$/m);
  assert.doesNotMatch(prof, /motto_(zh|en)/);
});

/* ---------------- 构建产物 ---------------- */

const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;
/** 去掉脚本 / 样式 / 注释 / SVG，以及个人信息、不翻译、另一种语言标注的节点（语言名「中文」、Gray AI 等） */
function visible(/** @type {string} */ html) {
  let s = html.replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<style\b[\s\S]*?<\/style>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<svg\b[\s\S]*?<\/svg>/g, '');
  s = s.replace(/<(\w+)\b[^>]*(?:translate="?no"?|data-sgx-personal)[^>]*>[\s\S]*?<\/\1>/g, '');
  s = s.replace(/<img\b[^>]*(?:translate="?no"?|data-sgx-personal)[^>]*>/g, '');
  const attrs = [...s.matchAll(/\b(?:aria-label|title|placeholder|alt|label)="([^"]*)"/g)].map((m) => m[1]);
  const text = s.replace(/<[^>]+>/g, '\n').split('\n');
  return [...text, ...attrs].map((t) => t.replace(/&[a-z#0-9]+;/g, ' ').trim()).filter(Boolean);
}
/** @param {string} dir @param {(rel: string) => boolean} keep */
function pages(dir, keep) {
  /** @type {string[]} */
  const out = [];
  const go = (/** @type {string} */ d) => {
    for (const f of readdirSync(d)) {
      const p = path.join(d, f);
      if (statSync(p).isDirectory()) go(p);
      else if (f.endsWith('.html') && keep(path.relative(dir, p))) out.push(p);
    }
  };
  go(dir);
  return out;
}
const isZh = (/** @type {string} */ rel) => rel.startsWith('zh/');
/* 2026-11 合站：子站页面和主站同在 space/web/public/，主站这一组跳过 /<站>/ 目录（子站各自一组） */
const ownPage = (/** @type {string} */ site, /** @type {string} */ rel) => site !== 'space' || !/^(blog|curio|daymark)\//.test(rel);

test('英文页没有中文：四站英文页的可见文字和读屏文字里没有 CJK（个人信息 / translate="no" 节点除外；博客文章正文是内容，不查）', { skip: !built && '没构建' }, () => {
  const bad = [];
  for (const [site, pub] of Object.entries(PUB)) {
    for (const f of pages(path.join(REPO, pub), (r) => ownPage(site, r) && !isZh(r) && !(site === 'blog' && r.startsWith('post/')))) {
      for (const t of visible(readFileSync(f, 'utf8'))) if (CJK.test(t)) bad.push(`${site}/${path.relative(path.join(REPO, pub), f)}: ${t.slice(0, 60)}`);
    }
  }
  assert.deepEqual(bad, []);
});

/* 中文页上允许的纯英文：品牌 / 产品 / 技术名、版本号、博客标签（内容） */
/* https://：奇趣「发现」网址输入框的 placeholder（合站前奇趣的 HTML 被压缩成不带引号的属性，这里的提取没读到它） */
/* 顶栏 v3（2026-11 UI 重设计 PR-1，Gray 定稿设计稿 nav-v2 / tb4）：终端风短标签中英都写英文（NAVIGATE / STATUS / MODE / PALETTE / lang / layout / share / lock / Auto / Mobile / DeX），
   仍在字符串表里（zh.yaml 同值），这里放行 */
/* 对齐 PR-C（设计稿 tb4.html pg=blog / tree）：博客的终端输出中英都照稿写英文——阅读分钟「6 min」、less 分页条「-- less (1/6) --」、
   tree 的「blog/」「… 12 more」「4 directories, 36 files」、chip「tree blog/ →」 */
const ZH_ALLOW = /^(\d+ min|-- less \(\d+\/\d+\) --|blog\/|tree blog\/ →|… \d+ more|\d+ directories, \d+ files|#?(AI|Astro|Cloudflare|Ed25519|GitHub|Muse|Passkey|Hugo|Tailwind CSS|Styrigx( UI( [0-9.]+)?)?|Gray AI)|SGX [0-9.]+|[0-9.:\- x]+|https:\/\/|NAVIGATE|STATUS|MODE|PALETTE|lang|layout|share|lock|Auto|Mobile|DeX)$/;

test('中文页没有漏翻：四站中文页的可见文字里没有成句的英文（白名单：Gray AI、Styrigx、技术名、个人信息节点）', { skip: !built && '没构建' }, () => {
  const bad = [];
  for (const [site, pub] of Object.entries(PUB)) {
    for (const f of pages(path.join(REPO, pub), (r) => ownPage(site, r) && isZh(r) && !(site === 'blog' && r.startsWith('zh/post/')))) {
      for (const t of visible(readFileSync(f, 'utf8'))) {
        if (/[A-Za-z]{2,}/.test(t) && !CJK.test(t) && !ZH_ALLOW.test(t)) bad.push(`${site}/${path.relative(path.join(REPO, pub), f)}: ${t.slice(0, 60)}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test('个人信息节点中英输出相同：主站首页名片（名字、签名）两种语言一字不差，并且都标了 translate="no" data-sgx-personal', { skip: !built && '没构建' }, () => {
  const nodes = (/** @type {string} */ f) => [...readFileSync(path.join(REPO, f), 'utf8').matchAll(/<(\w+)\b[^>]*data-sgx-personal[^>]*>([\s\S]*?)<\/\1>|<img\b[^>]*data-sgx-personal[^>]*>/g)].map((m) => m[0].replace(/\s+/g, ' '));
  const en = nodes('space/web/public/index.html');
  const zh = nodes('space/web/public/zh/index.html');
  assert.ok(en.length >= 1, '名字：' + en.length);
  assert.deepEqual(zh, en);
  for (const n of en) assert.match(n, /translate="?no"?/);
  assert.ok(en.some((n) => n.includes('home-name')), '名字在个人信息节点里');
  /* 对齐 PR-B（设计稿 tb4.html）：hero 不再有头像和签名（头像在顶栏右上、签名只在账号下拉） */
  assert.ok(!en.some((n) => /home-motto|home-av\b/.test(n)), '主页 hero 没有签名 / 头像节点');
});

test('标签页标题（Gray 2026-11-07）：四站「页名 | 站名」，站名走字符串表；页名就是站名时只显示站名', { skip: !built && '没构建' }, () => {
  const title = (/** @type {string} */ f) => {
    const m = readFileSync(path.join(REPO, f), 'utf8').match(/<title>([^<]*)<\/title>/);
    return m ? m[1].replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, '’') : '';
  };
  const sp = { en: strings('space', 'en'), zh: strings('space', 'zh') };
  /* 主站：站名 Styrigx（品牌名不翻） */
  /* 对齐 PR-B：主页页名 = NAVIGATE 01「主页 / Home」（旷野是独立页 /wild/，页名 = front matter title） */
  assert.equal(title('space/web/public/index.html'), `${sp.en.shell.nav.home.title} | Styrigx`);
  assert.equal(title('space/web/public/zh/index.html'), `${sp.zh.shell.nav.home.title} | Styrigx`);
  assert.equal(title('space/web/public/wild/index.html'), `${sp.en.spaceCats.wild.title} | Styrigx`);
  assert.equal(title('space/web/public/zh/wild/index.html'), `${sp.zh.spaceCats.wild.title} | Styrigx`);
  /* 对齐 PR-C：风格页 /theme/ 退役（_redirects 301 到主页） */
  assert.ok(!existsSync(path.join(REPO, 'space/web/public/theme/index.html')) && !existsSync(path.join(REPO, 'space/web/public/zh/theme/index.html')));
  assert.equal(title('space/web/public/404.html'), `${sp.en.baseof.pageNotFound} | Styrigx`);
  assert.equal(title('space/web/public/zh/404.html'), `${sp.zh.baseof.pageNotFound} | Styrigx`);
  /* 奇趣 / 日刻：首页只有站名，子页「页名 | 站名」 */
  for (const s of ['curio', 'daymark']) {
    for (const l of ['en', 'zh']) {
      const t = strings(s, l);
      const pre = `space/web/public/${s}/${l === 'en' ? '' : l + '/'}`;
      assert.equal(title(pre + 'index.html'), t.site.name, `${s} ${l} 首页`);
      assert.equal(title(pre + '404.html'), `${t.baseof.pageNotFound} | ${t.site.name}`, `${s} ${l} 404`);
    }
  }
  assert.equal(title('space/web/public/curio/finds/index.html'), 'Finds | Curio');
  assert.equal(title('space/web/public/curio/zh/finds/index.html'), '发现 | 奇趣');
  /* 博客：站名 = i18n blogTitle；首页只有站名；文章、标签页、404 都带「| 博客站名」 */
  const blog = { en: /** @type {any} */ (rd('space/web/i18n/en.yaml')).match(/^blogTitle: (.+)$/m)[1], zh: /** @type {any} */ (rd('space/web/i18n/zh.yaml')).match(/^blogTitle: (.+)$/m)[1] };
  assert.equal(title('space/web/public/blog/index.html'), blog.en);
  assert.equal(title('space/web/public/blog/zh/index.html'), blog.zh);
  for (const [l, dir] of [['en', 'space/web/public/blog/post'], ['zh', 'space/web/public/blog/zh/post']]) {
    const posts = readdirSync(path.join(REPO, dir));
    assert.ok(posts.length > 0, l + ' 有文章');
    for (const p of posts) assert.match(title(`${dir}/${p}/index.html`), new RegExp(` \\| ${blog[l]}$`), `${l} ${p}`);
  }
  assert.match(title('space/web/public/blog/tags/ai/index.html'), new RegExp(` \\| ${blog.en}$`));
  assert.match(title('space/web/public/blog/404.html'), new RegExp(` \\| ${blog.en}$`));
  assert.match(title('space/web/public/blog/zh/404.html'), new RegExp(` \\| ${blog.zh}$`));
  /* 四站标题都不会出现「站名 | 站名」 */
  for (const pub of Object.values(PUB)) {
    for (const f of pages(path.join(REPO, pub), () => true)) {
      const t = title(path.relative(REPO, f));
      if (!t.includes(' | ')) continue;
      const [a, b] = t.split(' | ');
      assert.notEqual(a, b, path.relative(REPO, f));
    }
  }
});

test('JS 字符串表（语言包化 2026-11-07）：i18nTable(表) 的 tx(键) 在英文表 js.<表> 里都有；键名不带语言代码、不靠表选语言（语言用 pageLang() / Intl）', () => {
  const en = strings('space', 'en').js || {};
  /** @param {string} d @returns {string[]} */
  const walk = (d) => readdirSync(d).flatMap((f) => {
    const p = path.join(d, f);
    return statSync(p).isDirectory() ? walk(p) : (/\.js$/.test(f) ? [p] : []);
  });
  const bad = [];
  for (const f of walk(path.join(REPO, 'space/web/assets/js'))) {
    const src = readFileSync(f, 'utf8');
    const m = /const (\w+) = i18nTable\('([\w-]+)'\)/.exec(src);
    if (!m || f.endsWith(path.join('lib', 'i18n.js'))) continue;
    const [, fn, table] = m;
    const re = new RegExp('\\b' + fn + "\\('([\\w.-]+)'[,)]", 'g');
    for (const [, key] of src.matchAll(re)) {
      if (!en[table] || en[table][key] == null) bad.push(path.relative(REPO, f) + ': ' + table + '.' + key);
    }
  }
  assert.deepEqual(bad, [], '缺键');
  for (const [table, t] of Object.entries(en)) {
    for (const [k, v] of Object.entries(t || {})) {
      assert.ok(!/^(en|zh|zh-CN|en-US)$/.test(String(v)), 'js.' + table + '.' + k + ' 是语言代码（应改用 pageLang()）');
    }
  }
});

test('奇趣 / 日刻页面脚本（语言包化第二部分）：文案只读 #sgx-i18n-<表>，T.键 / tr(键) 都在英文表 js.<表> 里；脚本不再按语言二选一', () => {
  const FILES = [
    ['curio', 'space/web/assets/curio/js/curio.js', 'curio'],
    ['curio', 'space/web/assets/curio/js/curio-items.js', 'curioItems'],
    ['curio', 'space/web/assets/curio/js/curio-movies.js', 'curioMovies'],
    ['curio', 'space/web/assets/curio/js/curio-music.js', 'curioMusic'],
    ['daymark', 'space/web/assets/daymark/js/daymark.js', 'daymark'],
  ];
  const bad = [];
  for (const [site, file, table] of FILES) {
    const src = rd(file);
    assert.match(src, new RegExp("readDict\\(doc, '" + table + "'\\)"), file + ' 读 #sgx-i18n-' + table);
    assert.doesNotMatch(src, /\bisEn\b|\ben \?/, file + ' 不按语言二选一');
    const t = (strings(site, 'en').js || {})[table] || {};
    /* T.kinds / T.status / ST_LABEL 由 sub('前缀') 从同一张表展开 */
    const built = new Set([...src.matchAll(/T\.(\w+) = sub\(/g)].map((m) => m[1]));
    for (const [, key] of src.matchAll(/\bT\.(\w+)/g)) if (!built.has(key) && t[key] == null) bad.push(file + ': T.' + key);
    for (const [, key] of src.matchAll(/\btr\('(\w+)'/g)) if (t[key] == null) bad.push(file + ": tr('" + key + "')");
    for (const [, pre] of src.matchAll(/sub\('(\w+)'\)/g)) if (!Object.keys(t).some((k) => k.startsWith(pre))) bad.push(file + ': sub ' + pre);
  }
  assert.deepEqual(bad, [], '缺键');
  /* 两站模板把整张 js 表按表名输出（页面脚本运行前） */
  for (const s of ['curio', 'daymark']) {
    const tpl = rd(`space/web/layouts/${s}/baseof.html`);
    assert.ok(tpl.indexOf('<script id="sgx-i18n-{{ $tbl }}"') !== -1 && tpl.indexOf('sgx-i18n-{{ $tbl }}') < tpl.indexOf('{{ block "main" . }}'), s + ' baseof 在 main 前输出文案表');
  }
  /* 博客首页筛选提示（对齐 PR-C）：模板从字符串表给 data-tpl，脚本只填 {label} {n}，不按语言二选一 */
  const list = rd('space/web/assets/blog/js/blog/blog-list.js');
  assert.doesNotMatch(list, /\ben \?|\bisEn\b/);
  assert.match(rd('space/web/layouts/blog/section.html'), /data-tpl="\{\{ i18n "filterNote" \}\}"/);
});

test('构建产物：奇趣 / 日刻中文页的页面文案表是中文、英文页是英文（缺键回退英文）', { skip: !built && '没构建' }, () => {
  const read = (/** @type {string} */ p) => readFileSync(path.join(REPO, p), 'utf8');
  const dict = (/** @type {string} */ html, /** @type {string} */ id) => {
    const m = new RegExp('<script id="?sgx-i18n-' + id + '"? type="?application/json"?>(.*?)</script>').exec(html);
    return m ? JSON.parse(m[1]) : null;
  };
  const cases = [['space/web/public/curio', 'finds/index.html', 'curio', 'count'], ['space/web/public/daymark', 'index.html', 'daymark', 'count']];
  for (const [pub, page, id, key] of cases) {
    const en = dict(read(`${pub}/${page}`), id), zh = dict(read(`${pub}/zh/${page}`), id);
    assert.ok(en && zh, pub + ' 有 #sgx-i18n-' + id);
    assert.doesNotMatch(en[key], /[\u3400-\u9fff]/, pub + ' 英文页');
    assert.match(zh[key], /[\u3400-\u9fff]/, pub + ' 中文页');
  }
});

test('Worker 名字（语言包化第二部分）：服务状态站名、授权应用名接口只回英文原文，中文层在主站字符串表；每个站 / 应用两种语言都有', async () => {
  const { TARGETS } = await import('../../../../workers/status/src/targets.js');
  const { SCOPES } = await import('../../../../workers/account/src/core/scopes.js');
  const en = strings('space', 'en').js, zh = rawTable('space', 'zh').js;
  for (const t of TARGETS) {
    assert.equal(typeof t.name, 'string', 'targets.js ' + t.site + ' name 是英文字符串');
    assert.doesNotMatch(t.name, /[\u3400-\u9fff]/, 'targets.js ' + t.site + ' 英文原文');
    assert.ok(en.status['site_' + t.site] && zh.status['site_' + t.site], 'js.status.site_' + t.site + ' 两种语言都有');
  }
  for (const s of SCOPES) {
    assert.equal(typeof s.name, 'string', 'scopes.js ' + s.id + ' name 是英文字符串');
    assert.doesNotMatch(s.name, /[\u3400-\u9fff]/, 'scopes.js ' + s.id + ' 英文原文');
    assert.equal(en.account['app_' + s.app], s.name, 'js.account.app_' + s.app + ' 英文 = 接口原文');
    assert.ok(zh.account['app_' + s.app], 'js.account.app_' + s.app + ' 有中文');
  }
  /* 数字健康区域（对齐 PR-B 起终端字符条形式）：行首直接显示区域键（space / blog / book …，等宽、不翻译），旧的本语言区域名 wbArea_* 和彩色圆点 COLORS 删除 */
  const wb = rd('space/web/assets/js/lib/wb-view.js');
  assert.doesNotMatch(wb, /const COLORS|wbArea_/);
  assert.ok(!Object.keys(en.space).some((k) => k.startsWith('wbArea_')) && !Object.keys(zh.space || {}).some((k) => k.startsWith('wbArea_')), '字符串表里不留 wbArea_*');
  assert.match(wb, /<span class="wb-k" translate="no">/, '区域键标 translate="no"');
  /* 奇趣搜索索引的页签 / 类型标签：英文底 + 中文层，缺键回退英文 */
  const { labels } = await import('../../../../workers/curio-core/src/search-index.js');
  assert.equal(labels('zh').kinds.phone, '手机');
  assert.equal(labels('en').status.done, 'Finished');
  assert.deepEqual(labels('fr'), labels('en'), '没有语言层的语言整份英文');
});

test('全仓不再按语言二选一写文案（语言包化第二部分）：没有 en ? / isEn ? 三元、没有 {zh: …} 文案对象（内容数据与语言路由除外，见白名单）', () => {
  /* 白名单（不是界面文案）：
     - workers/curio-core/src/api：收藏的名字 / 简介是内容，库里本来就是 name_zh / name_en 两列（导入导出照列取；导入的「未归类」分类名两列都写）
     - workers/daymark-core/src/search-index.js：按语言拼地址和索引 id（语言路由，不是文案）
     - workers/ai/src/core/prompt.js：AI 的系统提示词按语言各一份（提示词是给模型的，不是界面）
     - space/web/assets/js/lib/palette-scheme.js：调色板名 / 情绪描述（调色板数据，与 gen-palettes 同一份，另行整理） */
  const ALLOW = /^(workers\/curio-core\/src\/api\/|workers\/daymark-core\/src\/search-index\.js$|workers\/ai\/src\/core\/prompt\.js$|space\/web\/assets\/js\/lib\/palette-scheme\.js$)/;
  const SKIP = /^(tests\/|dist\/)|\/vendor\/|\/public\/|\/node_modules\//;
  const TERN = /(?<![\w.$])(?:en|isEn|isZh|zh|ctx\.en|opts\.en)\s*\?(?![.?])/;
  const ZHOBJ = /\{\s*zh\s*:/;
  /** @param {string} d @returns {string[]} */
  const walk = (d) => readdirSync(path.join(REPO, d)).flatMap((f) => {
    const p = d + '/' + f;
    if (SKIP.test(p + '/') || f === 'node_modules' || f === 'public') return [];
    return statSync(path.join(REPO, p)).isDirectory() ? walk(p) : (/\.(m?js|cjs|ts)$/.test(f) ? [p] : []);
  });
  const bad = [];
  for (const f of ['space/web/assets/js', 'space/scripts', 'space/web/assets/blog/js', 'space/web/assets/curio/js', 'space/web/assets/daymark/js', 'workers'].flatMap(walk)) {
    if (ALLOW.test(f) || SKIP.test(f)) continue;
    const src = rd(f).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:\\'"])\/\/.*$/gm, '$1');
    src.split('\n').forEach((line, i) => {
      if (TERN.test(line) || ZHOBJ.test(line)) bad.push(f + ':' + (i + 1) + ': ' + line.trim().slice(0, 100));
    });
  }
  assert.deepEqual(bad, [], '还有按语言二选一的文案');
});
