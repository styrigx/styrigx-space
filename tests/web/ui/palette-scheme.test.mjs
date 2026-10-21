/**
 * PR3 主题色角色 token：33 套色板（单色 17 + 撞色 16）（web/data/palette-roles.json）→ input.css（scripts/gen-palettes.mjs），
 * 自定义 #rrggbb 种子 → 同一套角色（web/assets/js/lib/palette-scheme.js，设计稿 scheme.js 的移植）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { presetRoles, rolesFor, rolesCss, roleDecls, contrast, hexToOklch, swatchTones, PRESETS } from '../../../web/assets/js/lib/palette-scheme.js';
import { renderBlock, splice } from '../../../scripts/gen-palettes.mjs';
import { ACCENT_CACHE_VER } from '../../../web/assets/js/lib/accent.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DATA = JSON.parse(readFileSync(path.join(REPO, 'web/data/palette-roles.json'), 'utf8'));
const CSS = readFileSync(path.join(REPO, 'web/assets/css/input.css'), 'utf8');

test('33 套预设（单色 17 + 撞色 16）、亮暗各 87 个角色', () => {
  const ids = Object.keys(DATA.presets);
  assert.equal(ids.length, 33);
  assert.equal(ids.filter((id) => DATA.presets[id].group === 'mono').length, 17);
  assert.equal(ids.filter((id) => DATA.presets[id].group === 'clash').length, 16);
  for (const id of ids) for (const m of ['light', 'dark']) assert.equal(Object.keys(DATA.presets[id][m]).length, 87, id + ' ' + m);
});

test('JSON 的预设（含 id / 名字 / 种子 / mood、顺序）就是 PRESETS 重建出来的（gen-palettes --roles 可复现）', () => {
  assert.deepEqual(Object.keys(DATA.presets), PRESETS.map((p) => p.id));
  for (const x of PRESETS) {
    const p = DATA.presets[x.id];
    assert.deepEqual([p.id, p.zh, p.en, p.seed, p.group, p.mood], [x.id, x.zh, x.en, x.seed, x.group, x.mood], x.id);
  }
});

test('移植的引擎重算 33 套预设，和 JSON 一字不差（值不是手敲的）', () => {
  for (const id of Object.keys(DATA.presets)) {
    const r = presetRoles(id);
    for (const m of ['light', 'dark']) assert.deepEqual(r[m], DATA.presets[id][m], id + ' ' + m);
    assert.deepEqual(r.lightState, DATA.presets[id].lightState);
    assert.deepEqual(r.darkState, DATA.presets[id].darkState);
  }
});

test('自定义种子：8 个校验种子与设计稿结果一致（最近预设 + 主色）', () => {
  for (const [seed, ref] of Object.entries(DATA.custom)) {
    const r = rolesFor(seed);
    assert.equal(r.derivedFrom, ref.derivedFrom, seed);
    for (const m of ['light', 'dark']) assert.deepEqual(r[m], ref[m], seed + ' ' + m);
  }
});

test('自定义种子：任意颜色的 on-primary / 正文对比度够（≥4.5:1）', () => {
  for (const seed of ['#ffd400', '#00ff00', '#000000', '#ffffff', '#123456', '#e91e63', '#9e9e9e']) {
    const r = rolesFor(seed);
    for (const m of ['light', 'dark']) {
      assert.ok(contrast(r[m]['on-primary'], r[m].primary) >= 4.5, seed + ' ' + m + ' on-primary');
      assert.ok(contrast(r[m]['text-primary'], r[m].surface) >= 4.5, seed + ' ' + m + ' text');
      assert.ok(contrast(r[m]['on-secondary-container'], r[m]['secondary-container']) >= 4.5, seed + ' ' + m + ' tonal btn');
    }
  }
});

test('input.css 里的预设角色就是 gen-palettes 生成的（改 JSON 忘了重跑 → 红）', () => {
  assert.equal(splice(CSS, renderBlock(DATA)), CSS);
});

test('每个预设都有浅色 + 深色（.dark）两段；lake 兜底在 :root / :root.dark', () => {
  for (const id of Object.keys(DATA.presets)) {
    assert.ok(CSS.includes(`:root[data-palette="${id}"]`), id);
    assert.ok(CSS.includes(`:root.dark[data-palette="${id}"]`), id + ' dark');
  }
  assert.match(CSS, /\n {2}:root,\n {2}:root\[data-palette="lake"\] \{/);
  assert.match(CSS, /\n {2}:root\.dark,\n {2}:root\.dark\[data-palette="lake"\] \{/);
});

test('自定义种子运行时写的变量名 = 预设的变量名（亮暗两段，盖过 tokens 层）', () => {
  const names = (decls) => decls.map((d) => d.split(':')[0]).sort();
  const p = DATA.presets.lake;
  const css = rolesCss('#ff6b9d');
  assert.match(css, /^html:root\{--sgx-seed: #ff6b9d;/);
  assert.match(css, /html:root\.dark\{/);
  const r = rolesFor('#ff6b9d');
  assert.deepEqual(names(roleDecls(r.light, r.lightState)), names(roleDecls(p.light, p.lightState)));
  assert.deepEqual(names(roleDecls(r.dark, r.darkState)), names(roleDecls(p.dark, p.darkState)));
});

test('色板列表（palettes.yaml）和角色 JSON 同一组 id / 种子', () => {
  const yaml = readFileSync(path.join(REPO, 'web/data/palettes.yaml'), 'utf8');
  const items = [...yaml.matchAll(/- id: (\w+)\n\s+c: "(#[0-9a-f]{6})"/g)].map((m) => [m[1], m[2]]);
  assert.equal(items.length, 33);
  assert.deepEqual(items.map((x) => x[0]), Object.keys(DATA.presets));
  for (const [id, c] of items) assert.equal(DATA.presets[id].seed, c, id);
});

test('baseof 首屏内联脚本认的缓存前缀 = lib/accent.js 的版本', () => {
  const html = readFileSync(path.join(REPO, 'web/layouts/_default/baseof.html'), 'utf8');
  assert.ok(html.includes(`ach='${ACCENT_CACHE_VER}|'+ac`), 'baseof 的 sgx-accent-css 前缀与 ACCENT_CACHE_VER 不一致');
});

test('C3 进入凭证按钮不再固定深蓝：--sgx-door-btn-* 只在别名层，引用角色', () => {
  const defs = [...CSS.matchAll(/--sgx-door-btn2?-(?:bg|fg):\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.equal(defs.length, 4);
  for (const v of defs) assert.match(v, /^var\(--sgx-btn-(primary|secondary)-(bg|fg)\)$/);
});

test('2026-10-21 搭配微调：抽屉当前项药丸和材质面板拉得开（不糊、不刺眼），文字 ≥ 7:1', () => {
  // 面板 ≈ 主色 10% 混 surface（88% 不透明）叠在 遮罩 × background 上（与 input.css --sgx-mat 同一配方）
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const hex = (a) => '#' + a.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
  const mix = (a, p, b) => hex(rgb(a).map((v, i) => v * p + rgb(b)[i] * (1 - p)));
  const over = (rgba, bg) => { const m = rgba.match(/[\d.]+/g).map(Number); return hex(rgb(bg).map((v, i) => m[i] * m[3] + v * (1 - m[3]))); };
  for (const [id, p] of Object.entries(DATA.presets)) {
    for (const m of ['light', 'dark']) {
      const r = p[m];
      const sheet = mix(mix(r.primary, 0.1, r.surface), 0.88, over(r.scrim, r.background));
      const k = contrast(r['nav-selected'], sheet);
      assert.ok(k >= 1.2 && k <= 1.65, `${id} ${m} nav-selected / sheet = ${k.toFixed(2)}`);
      assert.ok(contrast(r['on-nav-selected'], r['nav-selected']) >= 7, `${id} ${m} on-nav-selected`);
    }
  }
});

/* 2026-10-21：两组色板。单色组 = 原 13 套（cfec8af 规格不动）+ 4 套低饱和；撞色组 16 套，每套至少三个不同色相族 */
const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const hue = (h) => hexToOklch(h).h;
const group = (g) => Object.entries(DATA.presets).filter(([, p]) => p.group === g);
test('撞色组：除石墨×湖蓝外，辅色、第三色和主色各差 ≥ 45°，辅色与第三色也互相分开（亮暗都看）', () => {
  for (const [id, p] of group('clash')) {
    if (id === 'xgraphite') continue;
    for (const m of ['light', 'dark']) {
      const r = p[m], hp = hue(r.primary), hs = hue(r.secondary), ht = hue(r.tertiary);
      assert.ok(hueDist(hp, hs) >= 45, `${id} ${m} primary/secondary ${hueDist(hp, hs).toFixed(0)}°`);
      assert.ok(hueDist(hp, ht) >= 45, `${id} ${m} primary/tertiary ${hueDist(hp, ht).toFixed(0)}°`);
      assert.ok(hueDist(hs, ht) >= 40, `${id} ${m} secondary/tertiary ${hueDist(hs, ht).toFixed(0)}°`);
      assert.ok(hexToOklch(r.secondary).c >= 0.025 && hexToOklch(r.tertiary).c >= 0.025, `${id} ${m} 辅色 / 第三色要有彩度`);
    }
  }
});

test('撞色组每套 = 同名单色的主色（id = x + 单色 id，种子 / 浅色主色相同），只有辅色 / 第三色 / 底色换了色相；默认 lake 是单色', () => {
  for (const [id, p] of group('clash')) {
    const base = DATA.presets[id.slice(1)];
    assert.ok(base && base.group === 'mono', id);
    assert.equal(p.seed, base.seed, id);
    assert.equal(p.light.primary, base.light.primary, id);
  }
  assert.equal(DATA.presets.lake.group, 'mono');
  assert.equal(DATA.presets.lake.light.primary, '#2f5f86');
  assert.equal(Object.keys(DATA.presets)[0], 'lake');
});

test('单色组：辅色、主色容器、抽屉当前项、夜间时钟卡都在主色同一色相族（±40°）', () => {
  for (const [id, p] of group('mono')) {
    if (id === 'graphite') continue;
    for (const m of ['light', 'dark']) {
      const r = p[m], hp = hue(r.primary);
      for (const k of ['secondary', 'primary-container', 'nav-selected', 'night-card'])
        assert.ok(hueDist(hp, hue(r[k])) <= 40, `${id} ${m} ${k} ${hueDist(hp, hue(r[k])).toFixed(0)}°`);
    }
  }
});

test('低饱和四套（单色 + 撞色）：色块显示种子本色，浅色主色按对比度压深（在最深的正文底 surface-container-high 上 ≥ 4.5:1），色相不变', () => {
  for (const id of ['dustyblue', 'mustard', 'sage', 'dustyrose', 'xdustyblue', 'xmustard', 'xsage', 'xdustyrose']) {
    const p = DATA.presets[id], r = p.light;
    assert.notEqual(r.primary, p.seed, id);
    assert.ok(contrast(r.primary, r['surface-container-high']) >= 4.5, id);
    assert.ok(contrast(r['on-primary'], r.primary) >= 4.5, id);
    assert.ok(hueDist(hue(r.primary), hue(p.seed)) <= 3, id + ' hue');
  }
});

test('首页夜间时钟卡 night-card：白字 ≥ 7:1，并且比页面底亮 / 有色（深色模式下也看得出是块）', () => {
  for (const [id, p] of Object.entries(DATA.presets)) for (const m of ['light', 'dark']) {
    const r = p[m];
    assert.ok(contrast('#ffffff', r['night-card']) >= 7, `${id} ${m} ${contrast('#ffffff', r['night-card']).toFixed(2)}`);
    if (m === 'dark') assert.ok(contrast(r['night-card'], r.background) >= 1.25, `${id} dark night-card / bg`);
  }
});

test('滑块 / 进度：单色组 = 强调色（和 cfec8af 一样），撞色组 = 辅色族（石墨×湖蓝 = 湖蓝 tertiary），和开关（主色）分开', () => {
  for (const [id, p] of Object.entries(DATA.presets)) for (const m of ['light', 'dark']) {
    const r = p[m], tert = id === 'graphite' || id === 'xgraphite';
    const fam = p.group === 'clash' ? (tert ? 'tertiary' : 'secondary') : (tert ? 'tertiary' : 'primary');
    assert.equal(r['slider-active'], r[fam], `${id} ${m}`);
    assert.equal(r['switch-track-on'], r[tert ? 'tertiary' : 'primary'], `${id} ${m}`);
  }
});

test('撞色色块色带 = 种子 + 辅 / 第三色本色中间调（不是压深的文字色）；不带字的填充 *-fill 在卡片上 ≥ 3:1，文字色不变', () => {
  for (const x of PRESETS) {
    const p = DATA.presets[x.id], sw = p.swatch;
    assert.deepEqual(sw, swatchTones(x.id), x.id);
    assert.equal(sw.p, x.seed, x.id);
    for (const [k, F] of [['s', x.spec.s], ['t', x.spec.t]]) {
      const o = hexToOklch(sw[k]);
      assert.ok(o.l >= 0.62 && o.l <= 0.80, `${x.id} ${k} L ${o.l.toFixed(3)}`);
      if (F.c >= 0.03) assert.ok(hueDist(o.h, F.h) <= 8, `${x.id} ${k} hue`);
      // 比亮色的文字色（4.5:1 压深）明显亮
      assert.ok(o.l - hexToOklch(p.light[k === 's' ? 'secondary' : 'tertiary']).l >= 0.1, `${x.id} ${k} vs text tone`);
    }
    for (const m of ['light', 'dark']) for (const f of ['secondary', 'tertiary']) {
      const r = p[m];
      assert.ok(contrast(r[f + '-fill'], r['surface-container-lowest']) >= 3, `${x.id} ${m} ${f}-fill`);
      if (m === 'dark') assert.equal(r[f + '-fill'], r[f], `${x.id} dark ${f}-fill`);
      else assert.ok(hexToOklch(r[f + '-fill']).l > hexToOklch(r[f]).l, `${x.id} light ${f}-fill 比文字色亮`);
      assert.ok(contrast(r['on-' + f], r[f]) >= 4.5, `${x.id} ${m} on-${f}`);
    }
  }
});
