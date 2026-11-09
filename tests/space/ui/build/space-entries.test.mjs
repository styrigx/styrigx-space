/**
 * P4-3 PR-4b §9–11（Gray 2026-11-07）：显示页删除 + 平铺入口组件；2026-11 对齐 PR-B：主页不再有分类入口，旷野独立成 /wild/。
 * - 数据（data/space-cats.yaml）：3 个门内子页，顺序、字段齐全、图标存在、配色在白名单里
 * - 模板：平铺入口组件 partials/sgx-entries.html 在对齐 PR-C2 退役（主页、博客、奇趣、日刻都不用，文件和 @shell entries 样式段都删了）；旷野独立布局；旧页删除
 * - 构建产物（有才跑）：中英主页四节、旷野小卡锚点、旷野页三窗；
 *   /display/ 页面不存在；任何产物（HTML / XML / JSON）里没有 /display/ 链接；搜索索引里没有 /display/
 * 运行：node --test tests/space/ui/build/space-entries.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { strings } from '../../../fixtures/strings.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const rd = (/** @type {string} */ p) => readFileSync(path.join(REPO, p), 'utf8');
const data = /** @type {any} */ (yaml.load(rd('space/web/data/space-cats.yaml')));
const cats = /** @type {any[]} */ (data.cats);
const TR = { en: strings('space', 'en'), zh: strings('space', 'zh') };
const TONES = ['primary', 'secondary', 'tertiary', 'info'];

test('数据：主站门内子页 1 个（旷野；进站 v3 L1 安全页删了），字段齐全（对齐 PR-B：数字健康 / 服务状态 / 关于本站并进旷野；对齐 PR-C：风格页退役）', () => {
  assert.deepEqual(cats.map((c) => c.id), ['wild']);
  /* 语言包化（2026-11-07）：名字 / 副标题在字符串表 spaceCats（数据文件只留 id / icon / tone） */
  assert.deepEqual(cats.map((c) => TR.zh.spaceCats[c.id].title), ['旷野']);
  assert.deepEqual(cats.map((c) => TR.en.spaceCats[c.id].title), ['Wild']);
  const icons = rd('space/web/layouts/partials/icon.html');
  for (const c of cats) {
    for (const k of ['icon', 'tone']) assert.ok(typeof c[k] === 'string' && c[k].trim(), `${c.id}.${k}`);
    for (const k of ['zh', 'en', 'sub_zh', 'sub_en']) assert.equal(c[k], undefined, `${c.id}.${k} 不该在数据文件里`);
    for (const l of ['en', 'zh']) for (const k of ['title', 'sub']) assert.ok(TR[l].spaceCats[c.id][k], `${l} spaceCats.${c.id}.${k}`);
    assert.ok(TONES.includes(c.tone), `${c.id}.tone=${c.tone}`);
    assert.ok(icons.includes(`eq $name "${c.icon}"`), `${c.id}：icon.html 里有图标 ${c.icon}`);
    assert.ok(!c.id.includes('/') && c.id !== 'display', c.id);
  }
  /* 旧入口和主页标题带的文字都删了 */
  for (const l of ['en', 'zh']) for (const k of ['wellbeing', 'status', 'about', 'band', 'theme', 'security']) assert.equal(TR[l].spaceCats[k], undefined, `${l} spaceCats.${k} 应已删除`);
  assert.equal(data.band, undefined, 'space-cats.yaml 不再有 band');
});

test('模板：平铺入口组件退役（主页 / 四站都不用，组件和样式段删除）；旷野是独立页；显示页的模板和内容都删了', () => {
  const idx = rd('space/web/layouts/index.html');
  assert.doesNotMatch(idx, /partial "sgx-entries\.html"/, '主页不调用入口组件');
  assert.doesNotMatch(idx, /space-cats/, '主页不读 space-cats');
  for (const c of cats) assert.ok(!idx.includes(TR.zh.spaceCats[c.id].sub), `index.html 不写死 ${c.id} 副标题`);
  /* 对齐 PR-C：博客首页是单一文章列表（pg=blog）；对齐 PR-C2：奇趣首页是 tab + 卡片（pg=curio），日刻首页是居中引句 + 三窗（pg=day） */
  for (const f of ['blog/section.html', 'curio/section.html', 'daymark/section.html', 'partials/curio/page-head.html']) {
    assert.doesNotMatch(rd('space/web/layouts/' + f), /partial "sgx-entries\.html"/, f + ' 不用入口组件');
  }
  assert.ok(!existsSync(path.join(REPO, 'space/web/layouts/partials/sgx-entries.html')), 'sgx-entries.html 已删除');
  assert.doesNotMatch(rd('space/web/assets/css/input.css'), /@shell:begin entries|\.sgx-ent-li \{/, '@shell entries 样式段已删除');
  /* 旷野页：独立布局 + 中英内容 */
  assert.ok(existsSync(path.join(REPO, 'space/web/layouts/_default/wild.html')), 'wild.html');
  for (const f of ['space/web/content/wild.md', 'space/web/content/zh/wild.md']) assert.match(rd(f), /layout:\s*"?wild"?/, f + ' 用 wild 布局');
  /* 旧的三页（并进旷野）内容和模板删除 */
  for (const f of ['space/web/content/display.md', 'space/web/content/zh/display.md', 'space/web/layouts/partials/setcat-display.html',
    'space/web/content/wellbeing.md', 'space/web/content/zh/wellbeing.md', 'space/web/content/status.md', 'space/web/content/zh/status.md',
    'space/web/content/about.md', 'space/web/content/zh/about.md', 'space/web/layouts/_default/status.html',
    'space/web/layouts/partials/setcat-about.html', 'space/web/layouts/partials/setcat-wellbeing.html',
    'space/web/content/theme.md', 'space/web/content/zh/theme.md', 'space/web/layouts/_default/sub.html', 'space/web/layouts/partials/setcat-theme.html']) {
    assert.ok(!existsSync(path.join(REPO, f)), f + ' 应已删除');
  }
  /* 不做 301：_redirects 里没有 /display/ */
  assert.ok(!/\/display\//.test(rd('space/web/static/_redirects')), '_redirects 不跳 /display/');
  /* 功能开关不再指向显示页 */
  const feats = /** @type {any} */ (yaml.load(rd('space/web/data/features.yaml'))).features;
  assert.ok(!feats.some((/** @type {any} */ f) => f.section === 'display'), 'features.yaml 没有 section: display');
});

/* ---- 构建产物（npm run build / hugo 之后才有） ---- */
const BUILT = existsSync(path.join(REPO, 'space/web/public/index.html'));
const PUBS = ['space/web/public', 'space/web/public'].filter((p) => existsSync(path.join(REPO, p)));

/** @param {string} dir @returns {string[]} */
function files(dir) {
  /** @type {string[]} */
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(html|xml|json)$/.test(n)) out.push(p);
  }
  return out;
}

test('构建产物：中英主页四节 [01]–[04]、没有分类入口；[04] 三张小卡指向旷野锚点；旷野页三个窗', { skip: !BUILT && '没构建 space/web/public' }, () => {
  for (const [lang, file, pre] of [['en', 'index.html', '/'], ['zh', 'zh/index.html', '/zh/']]) {
    const html = readFileSync(path.join(REPO, 'space/web/public', file), 'utf8');
    assert.doesNotMatch(html, /class="?sgx-ents/, lang + '：主页没有入口区块');
    const ks = [...html.matchAll(/home-sec-k"? aria-hidden="?true"? translate="?no"?>([^<]+)</g)].map((m) => m[1]);
    assert.deepEqual(ks, ['[01] // BLOG', '[02] // CURIO', '[03] // DAYMARK', '[04] // WILD'], lang + '：四节顺序');
    for (const a of ['screen-time', 'status', 'about']) assert.ok(html.includes(`href="${pre}wild/#${a}"`) || html.includes(`href=${pre}wild/#${a}`), `${lang}：小卡 ${a} → ${pre}wild/#${a}`);
    const cu = lang === 'zh' ? '/curio/zh/' : '/curio/';
    for (const d of ['finds', 'devices', 'games']) assert.match(html, new RegExp(`href="?${cu}${d}/"? data-curio="?${d}"?`), `${lang}：奇趣 ${d}/`);
    /* 名字和屏幕时间小卡保留 */
    assert.match(html, /id="?w-profile"?/);
    assert.match(html, /id="?w-screen"?/);
    const wild = readFileSync(path.join(REPO, 'space/web/public', pre.slice(1) + 'wild/index.html'), 'utf8');
    for (const id of ['screen-time', 'status', 'about']) assert.match(wild, new RegExp(`<section class="?wild-sec"? id="?${id}"?`), `${lang} 旷野 #${id}`);
    for (const id of ['wb-card', 'st-root', 'sg-about']) assert.match(wild, new RegExp(`id="?${id}"?`), `${lang} 旷野 #${id}`);
  }
});

test('构建产物：/display/ 不存在，任何产物里都没有 /display/ 链接', { skip: !BUILT && '没构建 space/web/public' }, () => {
  for (const pub of PUBS) {
    for (const pre of ['', 'zh/', 'en/']) assert.ok(!existsSync(path.join(REPO, pub, pre + 'display')), `${pub}/${pre}display/ 不该存在`);
  }
  /** @type {string[]} */
  const bad = [];
  let n = 0;
  for (const pub of PUBS) {
    for (const f of files(path.join(REPO, pub))) {
      n++;
      if (/(?:https:\/\/styrigx\.com)?\/(?:en\/)?display\//.test(readFileSync(f, 'utf8'))) bad.push(path.relative(REPO, f));
    }
  }
  assert.ok(n > 20, '应扫到一批产物');
  assert.deepEqual(bad, [], '这些产物还有 /display/');
});
