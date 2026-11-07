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
const EN_ONLY = /^(site\.name|js\.(account|lockmgr)\.pkProv_[a-z0-9_]+)$/;

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
