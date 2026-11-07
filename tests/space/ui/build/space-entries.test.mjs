/**
 * P4-3 PR-4b §9–11（Gray 2026-11-07）：显示页删除 + 旷野页平铺入口。
 * - 数据（data/space-cats.yaml）：标题带 + 5 个入口，顺序、字段齐全、图标存在、配色在白名单里
 * - 模板：旷野页只调用共享入口组件（partials/sgx-entries.html），入口名字不写死在模板里（加入口 = 加一行数据）
 * - CSS：@shell entries 区块（共享外壳）只用 --sgx-* 角色；≥ 760 两栏、≥ 1100 三栏（栏间细竖线）
 * - 构建产物（有才跑）：中英旷野页的入口按数据渲染（数量、顺序、编号、名字、副标题、地址）、标题带；
 *   /display/ 页面不存在；任何产物（HTML / XML / JSON）里没有 /display/ 链接；搜索索引里没有 /display/
 * 运行：node --test tests/space/ui/build/space-entries.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const rd = (/** @type {string} */ p) => readFileSync(path.join(REPO, p), 'utf8');
const data = /** @type {any} */ (yaml.load(rd('space/web/data/space-cats.yaml')));
const cats = /** @type {any[]} */ (data.cats);
const TONES = ['primary', 'secondary', 'tertiary', 'info'];

test('数据：旷野 5 个入口（风格、安全、数字健康、服务状态、关于本站），字段齐全', () => {
  assert.deepEqual(cats.map((c) => c.id), ['theme', 'security', 'wellbeing', 'status', 'about']);
  assert.deepEqual(cats.map((c) => c.zh), ['风格', '安全', '数字健康', '服务状态', '关于本站']);
  assert.deepEqual(cats.map((c) => c.en), ['Style', 'Security', 'Digital wellbeing', 'Service status', 'About']);
  const icons = rd('space/web/layouts/partials/icon.html');
  for (const c of cats) {
    for (const k of ['icon', 'tone', 'zh', 'en', 'sub_zh', 'sub_en']) assert.ok(typeof c[k] === 'string' && c[k].trim(), `${c.id}.${k}`);
    assert.ok(TONES.includes(c.tone), `${c.id}.tone=${c.tone}`);
    assert.ok(icons.includes(`eq $name "${c.icon}"`), `${c.id}：icon.html 里有图标 ${c.icon}`);
    assert.ok(!c.id.includes('/') && c.id !== 'display', c.id);
  }
  assert.equal(data.band.label_en, 'SPACE');
  assert.equal(data.band.label_zh, '空间', '中文版「空间」（Gray 2026-11-07）');
  assert.equal(data.band.zh, '旷野');
  assert.equal(data.band.en, 'Space');
  assert.ok(data.band.sub_zh && data.band.sub_en, '标题带一句话（中英）');
});

test('模板：旷野页用共享入口组件，入口不写死在模板里；显示页的模板和内容都删了', () => {
  const idx = rd('space/web/layouts/index.html');
  assert.match(idx, /partial "sgx-entries\.html"/);
  for (const c of cats) assert.ok(!idx.includes(`/${c.id}/`) && !idx.includes(c.sub_zh), `index.html 不写死 ${c.id}`);
  const part = rd('space/web/layouts/partials/sgx-entries.html');
  assert.match(part, /range \$i, \$e := \.items/, '组件按数据行渲染');
  assert.match(part, /printf "%02d" \(add \$i 1\)/, '编号 01… 按行序生成');
  for (const f of ['space/web/content/display.md', 'space/web/content/zh/display.md', 'space/web/layouts/partials/setcat-display.html']) {
    assert.ok(!existsSync(path.join(REPO, f)), f + ' 应已删除');
  }
  /* 不做 301：_redirects 里没有 /display/ */
  assert.ok(!/\/display\//.test(rd('space/web/static/_redirects')), '_redirects 不跳 /display/');
  /* 功能开关不再指向显示页 */
  const feats = /** @type {any} */ (yaml.load(rd('space/web/data/features.yaml'))).features;
  assert.ok(!feats.some((/** @type {any} */ f) => f.section === 'display'), 'features.yaml 没有 section: display');
});

test('CSS：@entries 区块只用变量、≥ 760 两栏、≥ 1100 三栏', () => {
  const css = rd('space/web/assets/css/input.css');
  const m = css.match(/\/\* @shell:begin entries[\s\S]*?\/\* @shell:end entries \*\//);
  assert.ok(m, '@shell entries 区块（共享外壳）');
  const blk = m[0];
  assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(blk.replace(/\/\*[\s\S]*?\*\//g, '')), '不写死颜色');
  assert.match(blk, /@media \(min-width: 760px\) \{[\s\S]*?grid-template-columns: repeat\(2,/);
  assert.match(blk, /@media \(min-width: 1100px\) \{[\s\S]*?grid-template-columns: repeat\(3,/);
  assert.match(blk, /\.sgx-ent-li \{[^}]*border-bottom: 1px solid/, '行间细线');
});

/* ---- 构建产物（npm run build / hugo 之后才有） ---- */
const BUILT = existsSync(path.join(REPO, 'space/web/public/index.html'));
const PUBS = ['space/web/public', 'dist/site'].filter((p) => existsSync(path.join(REPO, p)));

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

test('构建产物：中英旷野页入口按数据渲染（数量、顺序、编号、名字、副标题、地址）+ 标题带', { skip: !BUILT && '没构建 space/web/public' }, () => {
  for (const [lang, file, pre] of [['en', 'index.html', '/'], ['zh', 'zh/index.html', '/zh/']]) {
    const html = readFileSync(path.join(REPO, 'space/web/public', file), 'utf8');
    const sec = (html.match(/<section class="?sgx-ents"?[\s\S]*?<\/section>/) || [''])[0];
    assert.ok(sec, lang + '：有入口区块');
    const label = lang === 'en' ? 'Categories' : '分类';
    assert.match(sec, new RegExp(`<ul class="?sgx-ent-list"? role="?list"? aria-label="?${label}"?>`));
    assert.match(sec, new RegExp(`class="?sgx-ent-label"?>${lang === 'en' ? data.band.label_en : data.band.label_zh}<`));
    assert.match(sec, new RegExp(`class="?sgx-ent-title"? id="?space-entries-title"?>${lang === 'en' ? data.band.en : data.band.zh}<`));
    assert.ok(sec.includes(lang === 'en' ? data.band.sub_en : data.band.sub_zh), lang + '：标题带一句话');
    const items = [...sec.matchAll(/<a class="?sgx-ent"? href="?([^" >]+)"? data-entry="?([a-z-]+)"?>([\s\S]*?)<\/a>/g)];
    assert.equal(items.length, cats.length, lang + '：入口数 = 数据行数');
    items.forEach((m, i) => {
      const c = cats[i];
      assert.equal(m[2], c.id, `${lang} 第 ${i + 1} 个`);
      assert.equal(m[1], pre + c.id + '/');
      assert.match(m[3], new RegExp(`sgx-ent-no"? aria-hidden="?true"?>${String(i + 1).padStart(2, '0')}<`));
      assert.match(m[3], new RegExp(`sgx-ent-ic sgx-ent-ic--${c.tone}`));
      assert.ok(m[3].includes('>' + (lang === 'en' ? c.en : c.zh) + '<'), `${lang} ${c.id} 名字`);
      assert.ok(m[3].includes('>' + (lang === 'en' ? c.sub_en : c.sub_zh) + '<'), `${lang} ${c.id} 副标题`);
    });
    /* 名片和屏幕时间卡保留 */
    assert.match(html, /id="?w-profile"?/);
    assert.match(html, /id="?w-screen"?/);
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
