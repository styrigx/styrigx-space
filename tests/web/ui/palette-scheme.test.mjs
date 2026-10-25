/**
 * PR3 主题色角色 token → 2026-10-23 PR-G 七色调色板：22 套（1 背景色 + 6 前景撞色；web/data/palette-roles.json）→ input.css（scripts/gen-palettes.mjs），
 * 自定义 #rrggbb 种子 → 同一套角色（web/assets/js/lib/palette-scheme.js，设计稿 scheme.js 的移植）。
 * 定稿设计稿的数据在 tests/fixtures/palette-v0.3.json（id / 名字 / 背景色 / 6 前景 / 前景色池）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mixHex, presetRoles, rolesFor, rolesCss, roleDecls, toneDecls, contrast, hexToOklch, audit, bgTones, fgTones, PRESETS, DEFAULT_ID, FG_POOL } from '../../../web/assets/js/lib/palette-scheme.js';
import { renderBlock, splice } from '../../../scripts/gen-palettes.mjs';
import { ACCENT_CACHE_VER } from '../../../web/assets/js/lib/accent.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DATA = JSON.parse(readFileSync(path.join(REPO, 'web/data/palette-roles.json'), 'utf8'));
const CSS = readFileSync(path.join(REPO, 'web/assets/css/input.css'), 'utf8');
const V3 = JSON.parse(readFileSync(path.join(REPO, 'tests/fixtures/palette-v0.3.json'), 'utf8'));
const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const hue = (h) => hexToOklch(h).h;

test('22 套七色调色板、亮暗各 108 个角色 + 31 个色调 token（bg-1..7、fg-1..6 及 -tint / -ink / -on）', () => {
  const ids = Object.keys(DATA.presets);
  assert.equal(ids.length, 22);
  assert.equal(ids[0], 'dustyblue');
  assert.equal(DEFAULT_ID, 'dustyblue');
  for (const id of ids) for (const m of ['light', 'dark']) {
    assert.equal(Object.keys(DATA.presets[id][m]).length, 108, id + ' ' + m);
    const t = DATA.presets[id][m + 'Tones'];
    assert.equal(Object.keys(t).length, 31, id + ' ' + m + ' tones');
    for (let i = 1; i <= 7; i++) assert.match(t['bg-' + i], /^#[0-9a-f]{6}$/);
    for (let i = 1; i <= 6; i++) for (const k of ['', '-tint', '-ink', '-on']) assert.match(t['fg-' + i + k], /^#[0-9a-f]{6}$/);
  }
});

test('定稿 palette-v0.3：22 套的 id / 名字 / 背景色 / 6 前景（顺序）和设计稿一致；名字不带「· 新 / · 默认」', () => {
  assert.equal(V3.default, DEFAULT_ID);
  assert.deepEqual(FG_POOL, V3.fgPool);
  assert.equal(PRESETS.length, V3.themes.length);
  for (const t of V3.themes) {
    const p = PRESETS.find((x) => x.id === t.id);
    assert.ok(p, t.id);
    assert.equal(p.zh, t.zh.replace(/ · .*/, ''), t.id);
    assert.ok(!/·/.test(p.zh) && p.en, t.id);
    assert.equal(p.bg, t.bg, t.id);
    assert.deepEqual(p.fgNames, t.fg, t.id);
    assert.deepEqual(p.fg, t.fg.map((n) => V3.fgPool[n]), t.id);
    assert.equal(p.seed, p.fg[0], t.id + ' 种子 = 前景 1');
  }
});

test('JSON 的预设（含 id / 名字 / 种子 / 分组 / 背景 / 前景 / mood、顺序）就是 PRESETS 重建出来的（gen-palettes --roles 可复现）', () => {
  assert.deepEqual(Object.keys(DATA.presets), PRESETS.map((p) => p.id));
  for (const x of PRESETS) {
    const p = DATA.presets[x.id];
    assert.deepEqual([p.id, p.zh, p.en, p.seed, p.group, p.bg, p.fg, p.fgNames, p.mood], [x.id, x.zh, x.en, x.seed, x.group, x.bg, x.fg, x.fgNames, x.mood], x.id);
  }
});

test('移植的引擎重算 22 套预设（角色 + 色调 token），和 JSON 一字不差（值不是手敲的）', () => {
  for (const id of Object.keys(DATA.presets)) {
    const r = presetRoles(id);
    for (const m of ['light', 'dark']) {
      assert.deepEqual(r[m], DATA.presets[id][m], id + ' ' + m);
      assert.deepEqual(r[m + 'Tones'], DATA.presets[id][m + 'Tones'], id + ' ' + m + ' tones');
    }
    assert.deepEqual(r.lightState, DATA.presets[id].lightState);
    assert.deepEqual(r.darkState, DATA.presets[id].darkState);
  }
});

test('22 套全部通过对比度审计（正文 ≥4.5:1，控件 ≥3:1；不修正，直接核对 JSON 里的值）', () => {
  for (const x of PRESETS) for (const m of ['light', 'dark']) {
    const r = { ...DATA.presets[x.id][m] };
    Object.defineProperty(r, '__dark', { value: m === 'dark' });
    const bad = audit(r, { ...x.spec, seed: x.seed, seedPrimary: r.primary }, m, false).rows.filter((row) => !row.pass);
    assert.deepEqual(bad.map((b) => `${b.fg}/${b.bg} ${b.ratio}`), [], `${x.id} ${m}`);
  }
});

test('自定义种子：8 个校验种子与 JSON 一致（最近预设 + 主色 + 色调 token）', () => {
  for (const [seed, ref] of Object.entries(DATA.custom)) {
    const r = rolesFor(seed);
    assert.equal(r.derivedFrom, ref.derivedFrom, seed);
    assert.ok(PRESETS.some((p) => p.id === r.derivedFrom), seed + ' 从 22 套里派生');
    for (const m of ['light', 'dark']) {
      assert.deepEqual(r[m], ref[m], seed + ' ' + m);
      assert.deepEqual(r[m + 'Tones'], ref[m + 'Tones'], seed + ' ' + m + ' tones');
    }
    assert.equal(r.lightTones['fg-1'], seed, seed + ' 前景 1 = 种子');
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

test('每个预设都有浅色 + 深色（.dark）两段；默认 dustyblue 兜底在 :root / :root.dark；x* 撞色段已删除', () => {
  for (const id of Object.keys(DATA.presets)) {
    assert.ok(CSS.includes(`:root[data-palette="${id}"]`), id);
    assert.ok(CSS.includes(`:root.dark[data-palette="${id}"]`), id + ' dark');
  }
  assert.match(CSS, /\n {2}:root,\n {2}:root\[data-palette="dustyblue"\] \{/);
  assert.match(CSS, /\n {2}:root\.dark,\n {2}:root\.dark\[data-palette="dustyblue"\] \{/);
  assert.doesNotMatch(CSS, /data-palette="x[a-z]+"/);
  assert.doesNotMatch(CSS, /:root,\n {2}:root\[data-palette="lake"\]/);
});

test('自定义种子运行时写的变量名 = 预设的变量名（角色 + 色调 token，亮暗两段，盖过 tokens 层）', () => {
  const names = (decls) => decls.map((d) => d.split(':')[0]).sort();
  const p = DATA.presets.dustyblue;
  const css = rolesCss('#ff6b9d');
  assert.match(css, /^html:root\{--sgx-seed: #ff6b9d;/);
  assert.match(css, /html:root\.dark\{/);
  assert.match(css, /--sgx-bg-7: #[0-9a-f]{6};/);
  const r = rolesFor('#ff6b9d');
  assert.deepEqual(names([...roleDecls(r.light, r.lightState), ...toneDecls(r.lightTones)]), names([...roleDecls(p.light, p.lightState), ...toneDecls(p.lightTones)]));
  assert.deepEqual(names([...roleDecls(r.dark, r.darkState), ...toneDecls(r.darkTones)]), names([...roleDecls(p.dark, p.darkState), ...toneDecls(p.darkTones)]));
});

test('色板列表（palettes.yaml）和角色 JSON 同一组 id / 背景色', () => {
  const yaml = readFileSync(path.join(REPO, 'web/data/palettes.yaml'), 'utf8');
  const items = [...yaml.matchAll(/- id: (\w+)\n\s+c: "(#[0-9a-f]{6})"/g)].map((m) => [m[1], m[2]]);
  assert.equal(items.length, 22);
  assert.deepEqual(items.map((x) => x[0]), Object.keys(DATA.presets));
  for (const [id, c] of items) assert.equal(DATA.presets[id].bg, c, id);
  // 单一数据源：颜色只在 palette-scheme.js 的 THEMES / FG_POOL；palettes.yaml 的 c / 名字 / 分组和定稿夹具都只是被核对的副本
  for (const x of PRESETS) {
    const blk = yaml.split(`- id: ${x.id}\n`)[1].split('\n  - id:')[0];
    assert.ok(blk.includes(`zh: ${x.zh}\n`), x.id + ' zh');
    assert.ok(blk.includes(`en: ${x.en}\n`), x.id + ' en');
    assert.ok(blk.includes(`group: ${x.group}`), x.id + ' group');
  }
});

test('baseof 首屏内联脚本认的缓存前缀 = lib/accent.js 的版本', () => {
  const html = readFileSync(path.join(REPO, 'web/layouts/_default/baseof.html'), 'utf8');
  assert.ok(html.includes(`ach='${ACCENT_CACHE_VER}|'+ac`), 'baseof 的 sgx-accent-css 前缀与 ACCENT_CACHE_VER 不一致');
});

test('C3 进入凭证按钮不再固定深蓝：--sgx-credential-btn-* 只在别名层，引用角色', () => {
  const defs = [...CSS.matchAll(/--sgx-credential-btn(?:-secondary)?-(?:bg|fg):\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.equal(defs.length, 4);
  for (const v of defs) assert.match(v, /^var\(--sgx-btn-(primary|secondary)-(bg|fg)\)$/);
});

test('三层规则：材质 --sgx-mat 只用中性表面色（不混主题色）；抽屉当前项药丸和材质面板拉得开（不糊、不刺眼），文字 ≥ 7:1', () => {
  assert.match(CSS, /--sgx-mat: color-mix\(in srgb, var\(--sgx-surface\) 88%, transparent\);/);
  assert.match(CSS, /--sgx-mat-solid: var\(--sgx-surface\);/);
  // 面板 = 表面色（88% 不透明）叠在 遮罩 × background 上（与 input.css --sgx-mat 同一配方）
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const hex = (a) => '#' + a.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
  const mix = (a, p, b) => hex(rgb(a).map((v, i) => v * p + rgb(b)[i] * (1 - p)));
  const over = (rgba, bg) => { const m = rgba.match(/[\d.]+/g).map(Number); return hex(rgb(bg).map((v, i) => m[i] * m[3] + v * (1 - m[3]))); };
  for (const [id, p] of Object.entries(DATA.presets)) {
    for (const m of ['light', 'dark']) {
      const r = p[m];
      const sheet = mix(r.surface, 0.88, over(r.scrim, r.background));
      const k = contrast(r['nav-selected'], sheet);
      assert.ok(k >= 1.2 && k <= 1.65, `${id} ${m} nav-selected / sheet = ${k.toFixed(2)}`);
      assert.ok(contrast(r['on-nav-selected'], r['nav-selected']) >= 7, `${id} ${m} on-nav-selected`);
    }
  }
});

test('三层规则：中性色只带一点背景色相（n.c ≤ 0.012，石墨用冷灰）；danger 固定红色族、不随主题变', () => {
  for (const x of PRESETS) {
    assert.ok(x.spec.n.c >= 0.004 && x.spec.n.c <= 0.012, `${x.id} n.c ${x.spec.n.c}`);
    const B = hexToOklch(x.bg);
    if (B.c >= 0.01) assert.ok(hueDist(x.spec.n.h, B.h) < 0.5, x.id + ' 中性色相 = 背景色相');
    for (const m of ['light', 'dark']) assert.equal(DATA.presets[x.id][m].danger, DATA.presets.dustyblue[m].danger, x.id + ' ' + m + ' danger');
  }
});

test('背景 7 档：浅色从页面底往深走、深色往亮走，色相 = 背景色；页面底 = bg-1', () => {
  for (const x of PRESETS) for (const m of ['light', 'dark']) {
    const t = DATA.presets[x.id][m + 'Tones'];
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((i) => t['bg-' + i]), bgTones(x.bg, m), x.id + ' ' + m);
    const L = [1, 2, 3, 4, 5, 6, 7].map((i) => hexToOklch(t['bg-' + i]).l);
    for (let i = 1; i < 7; i++) assert.ok(m === 'light' ? L[i] < L[i - 1] : L[i] > L[i - 1], `${x.id} ${m} bg-${i + 1}`);
    if (hexToOklch(x.bg).c >= 0.03) assert.ok(hueDist(hue(t['bg-7']), hue(x.bg)) <= 6, `${x.id} ${m} bg hue`);
  }
});

test('前景 6 色：本色 base（浅色 = 色池原值）/ tint / ink 三档；ink 在 tint 上 ≥ 4.5:1（标签 / chip 可读）', () => {
  for (const x of PRESETS) for (const m of ['light', 'dark']) {
    const t = DATA.presets[x.id][m + 'Tones'];
    x.fg.forEach((hex, i) => {
      const f = fgTones(hex, m);
      assert.deepEqual([t[`fg-${i + 1}`], t[`fg-${i + 1}-tint`], t[`fg-${i + 1}-ink`]], [f.base, f.tint, f.ink], `${x.id} ${m} fg-${i + 1}`);
      if (m === 'light') assert.equal(f.base, hex);
      assert.ok(contrast(f.ink, f.tint) >= 4.5, `${x.id} ${m} fg-${i + 1} ink/tint ${contrast(f.ink, f.tint).toFixed(2)}`);
    });
  }
});

test('前景接进语义角色：primary ← 前景 1（浅色按对比度压深、色相不变），secondary ← 前景 2，tertiary ← 前景 3', () => {
  for (const x of PRESETS) {
    const r = DATA.presets[x.id].light, d = DATA.presets[x.id].dark;
    assert.ok(contrast(r.primary, r['surface-container-high']) >= 4.5, x.id + ' 浅色主色');
    assert.ok(contrast(r['on-primary'], r.primary) >= 4.5, x.id + ' on-primary');
    assert.ok(contrast(d['on-primary'], d.primary) >= 4.5, x.id + ' dark on-primary');
    for (const [k, i] of [['primary', 0], ['secondary', 1], ['tertiary', 2]]) {
      const f = hexToOklch(x.fg[i]);
      if (f.c < 0.03) continue;
      for (const m of ['light', 'dark']) assert.ok(hueDist(hue(DATA.presets[x.id][m][k]), f.h) <= 6, `${x.id} ${m} ${k} hue`);
    }
    assert.ok(hueDist(hue(r['primary-container']), hexToOklch(x.fg[0]).h) <= 8, x.id + ' 选中底 = 前景 1 浅底');
  }
});

test('首页夜间时钟卡 night-card（特殊功能卡，克制的局部撞色）：第三色浅底、低彩度，不是饱和深色块；字 on-night-card ≥ 7:1，和卡片材质拉得开', () => {
  for (const [id, p] of Object.entries(DATA.presets)) for (const m of ['light', 'dark']) {
    const r = p[m], o = hexToOklch(r['night-card']);
    assert.ok(contrast(r['on-night-card'], r['night-card']) >= 7, `${id} ${m} on-night-card ${contrast(r['on-night-card'], r['night-card']).toFixed(2)}`);
    assert.ok(o.c <= 0.052, `${id} ${m} night-card 彩度 ${o.c.toFixed(3)}`);
    if (m === 'light') assert.ok(o.l >= 0.88, `${id} light night-card 不是深色块（L ${o.l.toFixed(3)}）`);
    else assert.ok(contrast(r['night-card'], r.surface) >= 1.25, `${id} dark night-card / surface`);
    const t = hexToOklch(r.tertiary);
    if (t.c >= 0.03 && o.c >= 0.01) assert.ok(hueDist(o.h, t.h) <= 10, `${id} ${m} night-card 色相 = 第三色`);
  }
});

test('填充 vs ink 分工：primary-fill = 前景 1 本色（--sgx-fg-1，不压深），on-primary-fill ≥ 4.5:1（22 套 × 亮暗）；primary（ink）在表面上仍 ≥ 4.5:1', () => {
  const SURF = ['background', 'surface', 'surface-container-lowest', 'surface-container-low', 'surface-container', 'surface-container-high'];
  for (const [id, p] of Object.entries(DATA.presets)) for (const m of ['light', 'dark']) {
    const r = p[m];
    assert.equal(r['primary-fill'], p[m + 'Tones']['fg-1'], `${id} ${m} primary-fill = fg-1 本色`);
    const k = contrast(r['on-primary-fill'], r['primary-fill']);
    assert.ok(k >= 4.5, `${id} ${m} on-primary-fill / primary-fill ${k.toFixed(2)}`);
    // 自动挑：深墨 vs 白里对比度高的那个
    const L = hexToOklch(r['on-primary-fill']).l;
    assert.ok(L < 0.3 || L > 0.95, `${id} ${m} on-primary-fill 是深墨或白（L ${L.toFixed(2)}）`);
    for (const s of SURF) assert.ok(contrast(r.primary, r[s]) >= 4.5, `${id} ${m} primary ink / ${s}`);
  }
  assert.equal(DATA.presets.dustyblue.light['primary-fill'], '#d4a72c', '默认主题按钮 = 芥末本色');
  assert.ok(hexToOklch(DATA.presets.dustyblue.light['on-primary-fill']).l < 0.3, '芥末上是深色字');
  for (const seed of ['#ffd400', '#00ff00', '#000000', '#ffffff', '#123456', '#e91e63', '#9e9e9e', '#536dfa']) {
    const r = rolesFor(seed);
    for (const m of ['light', 'dark']) assert.ok(contrast(r[m]['on-primary-fill'], r[m]['primary-fill']) >= 4.5, `${seed} ${m} on-primary-fill`);
  }
});

test('状态色：success 族固定绿色（不随主题变，和 danger 一样），亮暗都过对比度', () => {
  for (const [id, p] of Object.entries(DATA.presets)) for (const m of ['light', 'dark']) {
    const r = p[m], d = DATA.presets.dustyblue[m];
    for (const k of ['success', 'on-success', 'success-container', 'on-success-container']) assert.equal(r[k], d[k], `${id} ${m} ${k}`);
    assert.ok(contrast(r['on-success'], r.success) >= 4.5, `${id} ${m} on-success`);
    assert.ok(contrast(r['on-success-container'], r['success-container']) >= 4.5, `${id} ${m} on-success-container`);
    assert.ok(contrast(r.success, r['surface-container-lowest']) >= 4.5, `${id} ${m} success / card`);
  }
  const h = hexToOklch(DATA.presets.dustyblue.light.success).h;
  assert.ok(h > 130 && h < 165, 'success 是绿色 ' + h);
});

test('22 套亮 / 暗全部由公式生成：规格里没有逐套手调的深色值（p.hd / tune / slider 覆盖），cd = min(前景 1 彩度, 0.13)', () => {
  for (const x of PRESETS) {
    const sp = x.spec;
    assert.equal(sp.tune, undefined, x.id + ' tune');
    assert.equal(sp.slider, undefined, x.id + ' slider');
    assert.equal(sp.p.hd, undefined, x.id + ' p.hd');
    assert.equal(sp.pc && sp.pc.hd, undefined, x.id + ' pc.hd');
    assert.equal(sp.p.cd, Math.min(hexToOklch(x.fg[0]).c, 0.13), x.id + ' p.cd = 公式');
    assert.equal(sp.night, 't', x.id + ' night');
    assert.equal(sp.accent, 'primary', x.id + ' accent');
  }
});

test('滑块 / 进度 / 开关 = 填充档（primary-fill）；焦点环 / 滑块圆点 = ink（primary）', () => {
  for (const [id, p] of Object.entries(DATA.presets)) for (const m of ['light', 'dark']) {
    const r = p[m];
    assert.equal(r['slider-active'], r['primary-fill'], `${id} ${m}`);
    assert.equal(r['switch-track-on'], r['primary-fill'], `${id} ${m}`);
    assert.equal(r['switch-thumb-on'], r['on-primary-fill'], `${id} ${m}`);
    assert.equal(r['lock-unlock'], r['primary-fill'], `${id} ${m}`);
    assert.equal(r['slider-thumb'], r.primary, `${id} ${m}`);
    assert.equal(r['focus-ring'], r.primary, `${id} ${m}`);
  }
});

test('按钮 / 开关 / 进度在 CSS 里读填充档：--sgx-btn-primary-* = primary-fill；不再有「primary 当底 + on-primary 字」的组件', () => {
  assert.match(CSS, /--sgx-btn-primary-bg: var\(--sgx-primary-fill\);/);
  assert.match(CSS, /--sgx-btn-primary-fg: var\(--sgx-on-primary-fill\);/);
  assert.match(CSS, /\.chat-send \{ background-color: var\(--sgx-primary-fill\); color: var\(--sgx-on-primary-fill\); \}/);
  assert.match(CSS, /background: var\(--m-primary-fill\); border-color: var\(--m-primary-fill\);/);
  assert.doesNotMatch(CSS.slice(CSS.indexOf('/* @gen-palettes:end */')), /background(?:-color)?: var\(--(?:sgx|m)-primary\); color: var\(--(?:sgx|m)-on-primary\)/);
});

test('大面积块中性化：首页名片 = 中性玻璃卡（不是 primary-container）；夜间时钟不是渐变深色块；状态页 / 安全状态的「正常」读 success 不读 tertiary', () => {
  const home = readFileSync(path.join(REPO, 'web/layouts/index.html'), 'utf8');
  const prof = home.match(/<div id="w-profile" class="([^"]+)"/)[1];
  assert.match(prof, /\bbg-m-container-lowest\b/);
  assert.doesNotMatch(prof, /primary-container|secondary-container|tertiary-container/);
  assert.doesNotMatch(CSS, /\.clock-night \{[^}]*linear-gradient/);
  assert.match(CSS, /\.st-banner\[data-state="up"\] \{ background-color: var\(--sgx-success-container\)/);
  assert.match(CSS, /\.st-chip\[data-state="up"\] \.st-dot \{ background-color: var\(--sgx-success\); \}/);
  assert.match(CSS, /&\.is-ok \{ background: var\(--sgx-success-container\); color: var\(--sgx-on-success-container\); \}/);
  assert.doesNotMatch(CSS, /data-state="up"[^}]*tertiary/);
});

test('不带字的填充 *-fill 在卡片上 ≥ 3:1（亮色比文字色亮，暗色 = 辅 / 第三色本身）', () => {
  for (const x of PRESETS) for (const m of ['light', 'dark']) for (const f of ['secondary', 'tertiary']) {
    const r = DATA.presets[x.id][m];
    assert.ok(contrast(r[f + '-fill'], r['surface-container-lowest']) >= 3, `${x.id} ${m} ${f}-fill`);
    if (m === 'dark') assert.equal(r[f + '-fill'], r[f], `${x.id} dark ${f}-fill`);
    else assert.ok(hexToOklch(r[f + '-fill']).l > hexToOklch(r[f]).l, `${x.id} light ${f}-fill 比文字色亮`);
    assert.ok(contrast(r['on-' + f], r[f]) >= 4.5, `${x.id} ${m} on-${f}`);
  }
});

test('光晕只用背景 7 档（--sgx-bg-*），不再取 primary / secondary / tertiary；页面底 = --sgx-bg-1', () => {
  const halo = CSS.slice(CSS.indexOf('    --sgx-halo:'), CSS.indexOf('--sgx-halo-mask:'));
  assert.match(halo, /var\(--sgx-bg-7\)/);
  assert.doesNotMatch(halo, /--sgx-(primary|secondary|tertiary)/);
  assert.equal((halo.match(/radial-gradient\(/g) || []).length, 7);
  assert.match(CSS, /--m-wallpaper: var\(--sgx-bg-1\);/);
  assert.doesNotMatch(CSS, /--sgx-chart-1: var\(--sgx-fg-1\);/); // chart 是生成的角色，不再是 CSS 别名
});

test('前景去重（2026-10-23）：每套 6 个前景里，有彩色（OKLCH C > 0.05）的任意两色色相差 ≥ 22°', () => {
  for (const x of PRESETS) {
    const o = x.fg.map((h, i) => ({ i, ...hexToOklch(h) })).filter((f) => f.c > 0.05);
    for (let a = 0; a < o.length; a++) for (let b = a + 1; b < o.length; b++) {
      const d = hueDist(o[a].h, o[b].h);
      assert.ok(d >= 22, `${x.id} 前景 ${o[a].i + 1}（${x.fgNames[o[a].i]}）/ 前景 ${o[b].i + 1}（${x.fgNames[o[b].i]}）色相只差 ${d.toFixed(1)}°`);
    }
  }
});

/* ---------- 2026-10-23 PR-G 修订：静态（构建期）合成底审计 + 完整导出 token 的对比度 ---------- */
const TXT = ['text-primary', 'text-secondary', 'primary', 'link'];
// 玻璃卡 / 顶栏 / 抽屉 = --sgx-mat（surface 88%）叠在光晕上；光晕最浅 / 最深都可能在下面 → 7 档全量过一遍（含最浅 bg-1、最深 bg-7）
const glassOver = (r, t) => [1, 2, 3, 4, 5, 6, 7].map((k) => mixHex(r.surface, 0.88, t['bg-' + k]));
test('合成底审计：正文 / 次要文字 / primary ink / 链接在玻璃卡、顶栏、抽屉（材质 88% 叠在光晕 bg-1..7 任一档上）≥ 4.5:1', () => {
  for (const [id, p] of Object.entries(DATA.presets)) for (const m of ['light', 'dark']) {
    const r = p[m], t = p[m + 'Tones'];
    for (const g of glassOver(r, t)) for (const k of TXT) assert.ok(contrast(r[k], g) >= 4.5, `${id} ${m} ${k} / glass ${g} ${contrast(r[k], g).toFixed(2)}`);
    // 快捷面板磁贴玻璃（亮 = 最浅表面 62%、暗 = 高层容器 70%，叠在面板材质上）
    for (const g of glassOver(r, t)) {
      const tile = m === 'light' ? mixHex(r['surface-container-lowest'], 0.62, g) : mixHex(r['surface-container-high'], 0.7, g);
      for (const k of ['text-primary', 'text-secondary', 'primary']) assert.ok(contrast(r[k], tile) >= 4.5, `${id} ${m} ${k} / qp tile`);
      const night = mixHex(r['night-card'], 0.88, g);
      assert.ok(contrast(r['on-night-card'], night) >= 7, `${id} ${m} on-night-card / 合成夜间卡`);
    }
  }
});

test('焦点环 / 选中描边 ≥ 3:1：焦点环在所有表面和合成玻璃上；选中色块描边（text-primary）在材质上', () => {
  const S = ['background', 'surface', 'surface-container-lowest', 'surface-container-low', 'surface-container', 'surface-container-high', 'surface-container-highest', 'primary-container', 'nav-selected'];
  for (const [id, p] of Object.entries(DATA.presets)) for (const m of ['light', 'dark']) {
    const r = p[m], t = p[m + 'Tones'];
    for (const s of S) assert.ok(contrast(r['focus-ring'], r[s]) >= 3, `${id} ${m} focus-ring / ${s} ${contrast(r['focus-ring'], r[s]).toFixed(2)}`);
    for (const g of glassOver(r, t)) {
      assert.ok(contrast(r['focus-ring'], g) >= 3, `${id} ${m} focus-ring / glass`);
      assert.ok(contrast(r['text-primary'], g) >= 3, `${id} ${m} 选中描边 / glass`);
    }
  }
});

test('图表 chart-1..6：卡片和合成玻璃上 ≥ 3:1（回退顺序 fill → ink），两两分得开（都有彩色且色相差 ≥ 22°，或 OKLab ΔE ≥ 0.08）', () => {
  const lab = (h) => { const o = hexToOklch(h); return [o.l, o.c * Math.cos(o.h * Math.PI / 180), o.c * Math.sin(o.h * Math.PI / 180)]; };
  const dE = (a, b) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));
  for (const [id, p] of Object.entries(DATA.presets)) for (const m of ['light', 'dark']) {
    const r = p[m], t = p[m + 'Tones'], card = r['surface-container-lowest'], page = mixHex(r.surface, 0.88, t['bg-1']);
    const ch = [1, 2, 3, 4, 5, 6].map((i) => r['chart-' + i]);
    ch.forEach((c, i) => {
      assert.ok(contrast(c, card) >= 3 && contrast(c, page) >= 3, `${id} ${m} chart-${i + 1} ${contrast(c, card).toFixed(2)}`);
      const base = t['fg-' + (i + 1)];
      // 回退顺序 fill → ink：不是本色就必须是 ink 档（同色相；撞了前面的图表色才再挪一档）；本色够且不撞时一定用本色
      if (c !== base) {
        const ink = hexToOklch(t['fg-' + (i + 1) + '-ink']), o = hexToOklch(c);
        assert.ok(c === t['fg-' + (i + 1) + '-ink'] || (ink.c < 0.02 || hueDist(o.h, ink.h) <= 3), `${id} ${m} chart-${i + 1} 回退到 ink 档`);
      }
      const prev = ch.slice(0, i);
      const distinct = (x, y) => { const A = hexToOklch(x), B = hexToOklch(y); return (A.c > 0.05 && B.c > 0.05 && hueDist(A.h, B.h) >= 22) || dE(x, y) >= 0.08; };
      if (contrast(base, card) >= 3 && contrast(base, page) >= 3 && prev.every((y) => distinct(base, y))) assert.equal(c, base, `${id} ${m} chart-${i + 1} = 本色`);
    });
    for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) {
      const A = hexToOklch(ch[a]), B = hexToOklch(ch[b]);
      const ok = (A.c > 0.05 && B.c > 0.05 && hueDist(A.h, B.h) >= 22) || dE(ch[a], ch[b]) >= 0.08;
      assert.ok(ok, `${id} ${m} chart-${a + 1} / chart-${b + 1} 分不开（ΔE ${dE(ch[a], ch[b]).toFixed(3)}）`);
    }
  }
});

test('固定语义色 danger / success / warning / info：22 套相同；on 色 / 容器字 ≥ 4.5:1，本色在表面上 ≥ 4.5:1', () => {
  const S = ['background', 'surface', 'surface-container-lowest', 'surface-container-low', 'surface-container', 'surface-container-high'];
  for (const [id, p] of Object.entries(DATA.presets)) for (const m of ['light', 'dark']) {
    const r = p[m], d = DATA.presets.dustyblue[m];
    for (const f of ['danger', 'success', 'warning', 'info']) {
      for (const k of [f, 'on-' + f, f + '-container', 'on-' + f + '-container']) assert.equal(r[k], d[k], `${id} ${m} ${k}`);
      assert.ok(contrast(r['on-' + f], r[f]) >= 4.5, `${id} ${m} on-${f}`);
      assert.ok(contrast(r['on-' + f + '-container'], r[f + '-container']) >= 4.5, `${id} ${m} on-${f}-container`);
      for (const s of S) assert.ok(contrast(r[f], r[s]) >= 4.5, `${id} ${m} ${f} / ${s}`);
    }
  }
  const h = (k) => hexToOklch(DATA.presets.dustyblue.light[k]).h;
  assert.ok(h('warning') > 40 && h('warning') < 90, 'warning 是琥珀 ' + h('warning'));
  assert.ok(h('info') > 220 && h('info') < 275, 'info 是蓝 ' + h('info'));
});

test('完整导出的前景四档：base 上 on 色 ≥ 4.5:1（fill / on-fill）；ink 在 tint 和所有表面上 ≥ 4.5:1；tag-fg / tag-bg ≥ 4.5:1', () => {
  const S = ['background', 'surface', 'surface-container-lowest', 'surface-container-low', 'surface-container', 'surface-container-high'];
  for (const [id, p] of Object.entries(DATA.presets)) for (const m of ['light', 'dark']) {
    const r = p[m], t = p[m + 'Tones'];
    for (let i = 1; i <= 6; i++) {
      assert.ok(contrast(t[`fg-${i}-on`], t[`fg-${i}`]) >= 4.5, `${id} ${m} fg-${i}-on / fg-${i} ${contrast(t[`fg-${i}-on`], t[`fg-${i}`]).toFixed(2)}`);
      for (const s of S) assert.ok(contrast(t[`fg-${i}-ink`], r[s]) >= 4.5, `${id} ${m} fg-${i}-ink / ${s} ${contrast(t[`fg-${i}-ink`], r[s]).toFixed(2)}`);
    }
  }
});
