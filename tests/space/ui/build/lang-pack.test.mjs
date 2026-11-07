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
const PUB = { space: 'space/web/public', blog: 'atlas/web/blog/public', curio: 'atlas/web/curio/public', daymark: 'atlas/web/daymark/public' };
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

test('三站外壳字符串表是主站那份的原样副本（sync-shell）', () => {
  for (const s of ['blog', 'curio', 'daymark']) {
    for (const l of tableLangs('space', 'sgx-shell-i18n')) {
      assert.equal(rd(`atlas/web/${s}/data/sgx-shell-i18n/${l}.yaml`), rd(`space/web/data/sgx-shell-i18n/${l}.yaml`), `${s} ${l}`);
    }
  }
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
  assert.equal(fr.spaceCats.band.title, 'Space');
});

test('模板不再按语言二选一：主站 / 奇趣 / 日刻模板没有 $isEn、cond … "zh"、(dict "zh" … "en" …) 文案对子', () => {
  /** @param {string} dir @returns {string[]} */
  const walk = (dir) => readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.html') || p.endsWith('.json') ? [p] : [];
  });
  const bad = [];
  for (const d of ['space/web/layouts', 'atlas/web/curio/layouts', 'atlas/web/daymark/layouts', 'atlas/web/blog/layouts']) {
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

test('英文页没有中文：四站英文页的可见文字和读屏文字里没有 CJK（个人信息 / translate="no" 节点除外；博客文章正文是内容，不查）', { skip: !built && '没构建' }, () => {
  const bad = [];
  for (const [site, pub] of Object.entries(PUB)) {
    for (const f of pages(path.join(REPO, pub), (r) => !isZh(r) && !(site === 'blog' && r.startsWith('post/')))) {
      for (const t of visible(readFileSync(f, 'utf8'))) if (CJK.test(t)) bad.push(`${site}/${path.relative(path.join(REPO, pub), f)}: ${t.slice(0, 60)}`);
    }
  }
  assert.deepEqual(bad, []);
});

/* 中文页上允许的纯英文：品牌 / 产品 / 技术名、版本号、博客标签（内容） */
const ZH_ALLOW = /^(#?(AI|Astro|Cloudflare|Ed25519|GitHub|Muse|Passkey|Hugo|Tailwind CSS|Styrigx( UI( [0-9.]+)?)?|Gray AI)|SGX [0-9.]+|[0-9.:\- x]+)$/;

test('中文页没有漏翻：四站中文页的可见文字里没有成句的英文（白名单：Gray AI、Styrigx、技术名、个人信息节点）', { skip: !built && '没构建' }, () => {
  const bad = [];
  for (const [site, pub] of Object.entries(PUB)) {
    for (const f of pages(path.join(REPO, pub), (r) => isZh(r) && !(site === 'blog' && r.startsWith('zh/post/')))) {
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
  assert.ok(en.length >= 3, '名字、签名、头像替代文字：' + en.length);
  assert.deepEqual(zh, en);
  for (const n of en) assert.match(n, /translate="?no"?/);
  assert.ok(en.some((n) => n.includes('prof-motto')), '签名在个人信息节点里');
});

test('标签页标题（Gray 2026-11-07）：四站「页名 | 站名」，站名走字符串表；页名就是站名时只显示站名', { skip: !built && '没构建' }, () => {
  const title = (/** @type {string} */ f) => {
    const m = readFileSync(path.join(REPO, f), 'utf8').match(/<title>([^<]*)<\/title>/);
    return m ? m[1].replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, '’') : '';
  };
  const sp = { en: strings('space', 'en'), zh: strings('space', 'zh') };
  /* 主站：站名 Styrigx（品牌名不翻） */
  assert.equal(title('space/web/public/index.html'), `${sp.en.spaceCats.band.title} | Styrigx`);
  assert.equal(title('space/web/public/zh/index.html'), `${sp.zh.spaceCats.band.title} | Styrigx`);
  assert.match(title('space/web/public/theme/index.html'), /^[^|]+ \| Styrigx$/);
  assert.match(title('space/web/public/zh/theme/index.html'), /^[^|]+ \| Styrigx$/);
  assert.equal(title('space/web/public/404.html'), `${sp.en.baseof.pageNotFound} | Styrigx`);
  assert.equal(title('space/web/public/zh/404.html'), `${sp.zh.baseof.pageNotFound} | Styrigx`);
  /* 奇趣 / 日刻：首页只有站名，子页「页名 | 站名」 */
  for (const s of ['curio', 'daymark']) {
    for (const l of ['en', 'zh']) {
      const t = strings(s, l);
      const pre = `atlas/web/${s}/public/${l === 'en' ? '' : l + '/'}`;
      assert.equal(title(pre + 'index.html'), t.site.name, `${s} ${l} 首页`);
      assert.equal(title(pre + '404.html'), `${t.baseof.pageNotFound} | ${t.site.name}`, `${s} ${l} 404`);
    }
  }
  assert.equal(title('atlas/web/curio/public/finds/index.html'), 'Finds | Curio');
  assert.equal(title('atlas/web/curio/public/zh/finds/index.html'), '发现 | 奇趣');
  /* 博客：站名 = i18n blogTitle；首页只有站名；文章、标签页、404 都带「| 博客站名」 */
  const blog = { en: /** @type {any} */ (rd('atlas/web/blog/i18n/en.yaml')).match(/^blogTitle: (.+)$/m)[1], zh: /** @type {any} */ (rd('atlas/web/blog/i18n/zh.yaml')).match(/^blogTitle: (.+)$/m)[1] };
  assert.equal(title('atlas/web/blog/public/index.html'), blog.en);
  assert.equal(title('atlas/web/blog/public/zh/index.html'), blog.zh);
  for (const [l, dir] of [['en', 'atlas/web/blog/public/post'], ['zh', 'atlas/web/blog/public/zh/post']]) {
    const posts = readdirSync(path.join(REPO, dir));
    assert.ok(posts.length > 0, l + ' 有文章');
    for (const p of posts) assert.match(title(`${dir}/${p}/index.html`), new RegExp(` \\| ${blog[l]}$`), `${l} ${p}`);
  }
  assert.match(title('atlas/web/blog/public/tags/ai/index.html'), new RegExp(` \\| ${blog.en}$`));
  assert.match(title('atlas/web/blog/public/404.html'), new RegExp(` \\| ${blog.en}$`));
  assert.match(title('atlas/web/blog/public/zh/404.html'), new RegExp(` \\| ${blog.zh}$`));
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
    ['curio', 'atlas/web/curio/assets/js/curio.js', 'curio'],
    ['curio', 'atlas/web/curio/assets/js/curio-items.js', 'curioItems'],
    ['curio', 'atlas/web/curio/assets/js/curio-movies.js', 'curioMovies'],
    ['curio', 'atlas/web/curio/assets/js/curio-music.js', 'curioMusic'],
    ['daymark', 'atlas/web/daymark/assets/js/daymark.js', 'daymark'],
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
    const tpl = rd(`atlas/web/${s}/layouts/_default/baseof.html`);
    assert.ok(tpl.indexOf('<script id="sgx-i18n-{{ $tbl }}"') !== -1 && tpl.indexOf('sgx-i18n-{{ $tbl }}') < tpl.indexOf('{{ block "main" . }}'), s + ' baseof 在 main 前输出文案表');
  }
  /* 博客话题筛选标题：模板给 one / other 两种，脚本按 Intl.PluralRules 选 */
  const tabs = rd('atlas/web/blog/assets/js/blog/app-tabs.ts');
  assert.doesNotMatch(tabs, /\ben \?/);
  assert.match(rd('atlas/web/blog/layouts/index.html'), /data-tpl-one="\{\{ i18n "topicResults" 1 \}\}"/);
});

test('构建产物：奇趣 / 日刻中文页的页面文案表是中文、英文页是英文（缺键回退英文）', { skip: !built && '没构建' }, () => {
  const read = (/** @type {string} */ p) => readFileSync(path.join(REPO, p), 'utf8');
  const dict = (/** @type {string} */ html, /** @type {string} */ id) => {
    const m = new RegExp('<script id="?sgx-i18n-' + id + '"? type="?application/json"?>(.*?)</script>').exec(html);
    return m ? JSON.parse(m[1]) : null;
  };
  const cases = [['atlas/web/curio/public', 'finds/index.html', 'curio', 'count'], ['atlas/web/daymark/public', 'index.html', 'daymark', 'count']];
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
  /* 数字健康区域名（lib/wb-view.js COLORS 的键 = 区域） */
  const wb = rd('space/web/assets/js/lib/wb-view.js');
  const areas = [...(/const COLORS = \{([\s\S]*?)\};/.exec(wb) || ['', ''])[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
  assert.ok(areas.length >= 5);
  for (const a of areas) assert.ok(en.space['wbArea_' + a] && zh.space['wbArea_' + a], 'js.space.wbArea_' + a);
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
  const SKIP = /^(tests\/|dist\/)|\/vendor\/|\/public\/|\/node_modules\/|^atlas\/web\/[a-z]+\/assets\/js\/sgx\/|^space\/web\/shared\/shell\//;
  const TERN = /(?<![\w.$])(?:en|isEn|isZh|zh|ctx\.en|opts\.en)\s*\?(?![.?])/;
  const ZHOBJ = /\{\s*zh\s*:/;
  /** @param {string} d @returns {string[]} */
  const walk = (d) => readdirSync(path.join(REPO, d)).flatMap((f) => {
    const p = d + '/' + f;
    if (SKIP.test(p + '/') || f === 'node_modules' || f === 'public') return [];
    return statSync(path.join(REPO, p)).isDirectory() ? walk(p) : (/\.(m?js|cjs|ts)$/.test(f) ? [p] : []);
  });
  const bad = [];
  for (const f of ['space/web/assets/js', 'space/scripts', 'atlas/web/blog/assets/js', 'atlas/web/curio/assets/js', 'atlas/web/daymark/assets/js', 'workers'].flatMap(walk)) {
    if (ALLOW.test(f) || SKIP.test(f)) continue;
    const src = rd(f).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:\\'"])\/\/.*$/gm, '$1');
    src.split('\n').forEach((line, i) => {
      if (TERN.test(line) || ZHOBJ.test(line)) bad.push(f + ':' + (i + 1) + ': ' + line.trim().slice(0, 100));
    });
  }
  assert.deepEqual(bad, [], '还有按语言二选一的文案');
});
