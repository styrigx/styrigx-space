/**
 * PR3 主题色角色 token → 2026-10-23 PR-G 七色调色板：22 套（1 背景色 + 6 前景撞色；space/web/data/common/palette-roles.json）→ input.css（space/scripts/gen/gen-palettes.mjs），
 * 引擎 space/web/assets/common/js/ui/palette-scheme.js（设计稿 scheme.js 的移植）。
 * 2026-11-12 调色板 v4：没有深浅模式和自定义主题色。每套只有一个模式（浅套 / 深套由底色决定），JSON 每套 { mode, roles, state, tones }；
 * 下面的 MODES(id) = [这套的模式]，DATA.presets[id][mode] / [mode + 'Tones'] / [mode + 'State'] 是测试里给 roles / tones / state 起的别名。
 * 定稿设计稿的数据在 tests/fixtures/palette-v0.3.json（id / 名字 / 背景色 / 6 前景 / 前景色池）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mixHex, presetRoles, contrast, hexToOklch, audit, bgTones, fgTones, paletteMode, PRESETS, PINS, DEFAULT_ID, FG_POOL, SEM } from '../../../../space/web/assets/common/js/ui/palette-scheme.js';
import { renderBlock, splice } from '../../../../space/scripts/gen/gen-palettes.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const RAW = readFileSync(path.join(REPO, 'space/web/data/common/palette-roles.json'), 'utf8');
const DATA = JSON.parse(RAW);
/* 测试用别名（不可枚举，不影响和引擎结果的 deepEqual）：p[mode] = roles、p[mode + 'Tones'] = tones、p[mode + 'State'] = state */
for (const p of Object.values(DATA.presets)) {
  Object.defineProperty(p, p.mode, { value: p.roles });
  Object.defineProperty(p, p.mode + 'Tones', { value: p.tones });
  Object.defineProperty(p, p.mode + 'State', { value: p.state });
}
const MODES = (id) => [DATA.presets[id].mode];
/** 同模式的参照套（语义色、danger 等固定色比较用）：浅套 = dustyblue，深套 = terra */
const REF = (m) => DATA.presets[m === 'light' ? 'dustyblue' : 'terra'][m];
const CSS = readFileSync(path.join(REPO, 'space/web/assets/common/css/input.css'), 'utf8');
const V3 = JSON.parse(readFileSync(path.join(REPO, 'tests/fixtures/palette-v0.3.json'), 'utf8'));
const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const hue = (h) => hexToOklch(h).h;

test('22 套七色调色板、每套一个模式：108 个角色 + 31 个色调 token（bg-1..7、fg-1..6 及 -tint / -ink / -on）；schema styrigx-palette/3，没有 custom', () => {
  const ids = Object.keys(DATA.presets);
  assert.equal(DATA.schema, 'styrigx-palette/3');
  assert.equal(DATA.custom, undefined);
  assert.equal(ids.length, 25);
  /* 2026-11-12 选择器排序（Gray）：先深后浅、段内按色相（底色只有深 L≈0.20 / 浅 L≈0.955 两档，只跳一次是唯一单调排法） */
  assert.deepEqual(ids, ['cherry', 'tangerine', 'terra', 'amber', 'matcha', 'forest', 'teal', 'lake', 'indigo', 'violet', 'orchid', 'berry', 'rose', 'graphite', 'dustyrose', 'coral', 'cream', 'champagne', 'mustard', 'lime', 'sage', 'aqua', 'glacier', 'dustyblue', 'lilac']);
  assert.equal(DEFAULT_ID, 'terra'); // 2026-11 PR-A 照设计稿：默认赤陶（之前 dustyblue；2026-11-12 起列表先深后浅，cherry 第一）
  for (const id of ids) {
    const p = DATA.presets[id];
    assert.deepEqual(Object.keys(p).filter((k) => /light|dark/i.test(k)), [], id + ' 没有亮 / 暗两套');
    assert.equal(Object.keys(p.roles).length, 108, id);
    assert.equal(Object.keys(p.tones).length, 31, id + ' tones');
    for (let i = 1; i <= 7; i++) assert.match(p.tones['bg-' + i], /^#[0-9a-f]{6}$/);
    for (let i = 1; i <= 6; i++) for (const k of ['', '-tint', '-ink', '-on']) assert.match(p.tones['fg-' + i + k], /^#[0-9a-f]{6}$/);
  }
});

test('浅套 / 深套由底色决定（OKLCH L ≥ 0.6 = 浅套）：8 浅 14 深，默认 terra 是深套', () => {
  const light = Object.keys(DATA.presets).filter((id) => DATA.presets[id].mode === 'light');
  assert.deepEqual(light, ['dustyrose', 'coral', 'cream', 'champagne', 'mustard', 'lime', 'sage', 'aqua', 'glacier', 'dustyblue', 'lilac']);
  assert.equal(Object.keys(DATA.presets).length - light.length, 14);
  assert.equal(DATA.presets.terra.mode, 'dark');
  for (const [id, p] of Object.entries(DATA.presets)) {
    assert.equal(paletteMode(p.roles.background), p.mode, id + ' 底色决定模式');
    assert.equal(p.mode === 'dark', hexToOklch(p.roles.background).l < 0.6, id);
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

test('移植的引擎重算 22 套预设（角色 + 状态层 + 色调 token），和 JSON 一字不差（值不是手敲的）', () => {
  for (const id of Object.keys(DATA.presets)) {
    const r = presetRoles(id), p = DATA.presets[id];
    assert.equal(r.mode, p.mode, id);
    assert.deepEqual(r.roles, p.roles, id);
    assert.deepEqual(r.tones, p.tones, id + ' tones');
    assert.deepEqual(r.state, p.state, id + ' state');
  }
});
test('22 套全部通过对比度审计（正文 ≥4.5:1，控件 ≥3:1；不修正，直接核对 JSON 里的值）', () => {
  for (const x of PRESETS) for (const m of MODES(x.id)) {
    const r = { ...DATA.presets[x.id][m] };
    Object.defineProperty(r, '__dark', { value: m === 'dark' });
    const bad = audit(r, { ...x.spec, seed: x.seed, seedPrimary: r.primary }, m, false).rows.filter((row) => !row.pass);
    assert.deepEqual(bad.map((b) => `${b.fg}/${b.bg} ${b.ratio}`), [], `${x.id} ${m}`);
  }
});

test('input.css 里的预设角色就是 gen-palettes 生成的（改 JSON 忘了重跑 → 红）', () => {
  assert.equal(splice(CSS, renderBlock(DATA)), CSS);
});

test('每个预设一段 :root[data-palette]（没有 .dark 段）；默认 terra 兜底在 :root；x* 撞色段已删除', () => {
  for (const id of Object.keys(DATA.presets)) assert.ok(CSS.includes(`:root[data-palette="${id}"]`), id);
  const gen = CSS.slice(CSS.indexOf('@gen-palettes:begin'), CSS.indexOf('@gen-palettes:end'));
  assert.doesNotMatch(gen, /:root\.dark/);
  assert.match(CSS, /\n {2}:root,\n {2}:root\[data-palette="terra"\] \{/);
  assert.doesNotMatch(CSS, /data-palette="x[a-z]+"/);
  assert.doesNotMatch(CSS, /:root,\n {2}:root\[data-palette="lake"\]/);
});
test('色板列表（palette-source.yaml）和角色 JSON 同一组 id / 背景色', () => {
  const yaml = readFileSync(path.join(REPO, 'space/web/data/common/palette-source.yaml'), 'utf8');
  const items = [...yaml.matchAll(/- id: (\w+)\n\s+c: "(#[0-9a-f]{6})"/g)].map((m) => [m[1], m[2]]);
  assert.equal(items.length, 25);
  assert.deepEqual(items.map((x) => x[0]), Object.keys(DATA.presets));
  for (const [id, c] of items) assert.equal(DATA.presets[id].bg, c, id);
  // 单一数据源：颜色只在 palette-scheme.js 的 THEMES / FG_POOL；palette-source.yaml 的 c / 名字 / 分组和定稿夹具都只是被核对的副本
  for (const x of PRESETS) {
    const blk = yaml.split(`- id: ${x.id}\n`)[1].split('\n  - id:')[0];
    assert.ok(blk.includes(`zh: ${x.zh}\n`), x.id + ' zh');
    assert.ok(blk.includes(`en: ${x.en}\n`), x.id + ' en');
    assert.ok(blk.includes(`group: ${x.group}`), x.id + ' group');
  }
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
    for (const m of MODES(id)) {
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
    for (const m of MODES(x.id)) assert.equal(DATA.presets[x.id][m].danger, SEM[m].danger, x.id + ' ' + m + ' danger');
  }
});

test('背景 7 档：浅套从页面底往深走、深套往亮走，色相 = 背景色；页面底 bg-1 = 七色的底（= background）', () => {
  for (const x of PRESETS) for (const m of MODES(x.id)) {
    const t = DATA.presets[x.id][m + 'Tones'], r = DATA.presets[x.id][m];
    const pt = (x.pin && x.pin[m] && x.pin[m].tones) || {}; // 设计稿钉死的档（terra bg-1 = #161412）
    assert.equal(t['bg-1'], r.background, x.id + ' bg-1 = 底');
    assert.deepEqual([2, 3, 4, 5, 6, 7].map((i) => t['bg-' + i]), bgTones(x.bg, m).slice(1).map((c, i) => pt['bg-' + (i + 2)] || c), x.id + ' ' + m);
    const L = [2, 3, 4, 5, 6, 7].map((i) => hexToOklch(t['bg-' + i]).l);
    for (let i = 1; i < 6; i++) assert.ok(m === 'light' ? L[i] < L[i - 1] : L[i] > L[i - 1], `${x.id} ${m} bg-${i + 2}`);
    if (hexToOklch(x.bg).c >= 0.03) assert.ok(hueDist(hue(t['bg-7']), hue(x.bg)) <= 6, `${x.id} ${m} bg hue`);
  }
});
test('前景 6 色：1–4 = 色池本色 base（浅套 = 色池原值）/ tint / ink 三档；5 / 6 由七色派生（背景色相中间调 / 底→字中性灰）；ink 同色相、在 tint 和所有正文表面上 ≥ 4.5:1', () => {
  const S = ['background', 'surface', 'surface-container-lowest', 'surface-container-low', 'surface-container', 'surface-container-high'];
  for (const x of PRESETS) for (const m of MODES(x.id)) {
    const t = DATA.presets[x.id][m + 'Tones'], r = DATA.presets[x.id][m];
    x.fg.slice(0, 4).forEach((hex, i) => {
      const f = fgTones(hex, m), pb = x.pin && x.pin[m] && x.pin[m].tones && x.pin[m].tones[`fg-${i + 1}`];
      assert.deepEqual([t[`fg-${i + 1}`], t[`fg-${i + 1}-tint`]], [pb || f.base, f.tint], `${x.id} ${m} fg-${i + 1}`);
      if (m === 'light') assert.equal(f.base, hex);
      const ink = hexToOklch(t[`fg-${i + 1}-ink`]), o = hexToOklch(f.ink);
      if (o.c >= 0.02) assert.ok(hueDist(ink.h, o.h) <= 3, `${x.id} fg-${i + 1}-ink 同色相`);
    });
    for (let i = 1; i <= 6; i++) {
      const ink = t[`fg-${i}-ink`];
      assert.ok(contrast(ink, t[`fg-${i}-tint`]) >= 4.5, `${x.id} ${m} fg-${i} ink/tint ${contrast(ink, t[`fg-${i}-tint`]).toFixed(2)}`);
      for (const s of S) assert.ok(contrast(ink, r[s]) >= 4.5, `${x.id} fg-${i}-ink / ${s}`);
    }
  }
});
test('前景接进语义角色：primary ← 前景 1（浅套按对比度压深、色相不变），secondary ← 前景 2，tertiary ← 前景 3', () => {
  for (const x of PRESETS) {
    const m = DATA.presets[x.id].mode, r = DATA.presets[x.id].roles;
    if (m === 'light') assert.ok(contrast(r.primary, r['surface-container-high']) >= 4.5, x.id + ' 浅套主色');
    assert.ok(contrast(r['on-primary'], r.primary) >= 4.5, x.id + ' on-primary');
    for (const [k, i] of [['primary', 0], ['secondary', 1], ['tertiary', 2]]) {
      const f = hexToOklch(x.fg[i]);
      if (f.c < 0.03) continue;
      assert.ok(hueDist(hue(r[k]), f.h) <= 6, `${x.id} ${k} hue`);
    }
    if (m === 'light') assert.ok(hueDist(hue(r['primary-container']), hexToOklch(x.fg[0]).h) <= 8, x.id + ' 选中底 = 前景 1 浅底');
  }
});
test('首页夜间时钟卡 night-card（特殊功能卡，克制的局部撞色）：第三色浅底、低彩度，不是饱和深色块；字 on-night-card ≥ 7:1，和卡片材质拉得开', () => {
  for (const [id, p] of Object.entries(DATA.presets)) for (const m of MODES(id)) {
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
  for (const [id, p] of Object.entries(DATA.presets)) for (const m of MODES(id)) {
    const r = p[m];
    assert.equal(r['primary-fill'], p[m + 'Tones']['fg-1'], `${id} ${m} primary-fill = fg-1 本色`);
    const k = contrast(r['on-primary-fill'], r['primary-fill']);
    assert.ok(k >= 4.5, `${id} ${m} on-primary-fill / primary-fill ${k.toFixed(2)}`);
    // 自动挑：深墨 vs 白里对比度高的那个
    const L = hexToOklch(r['on-primary-fill']).l;
    assert.ok(L < 0.3 || L > 0.95, `${id} ${m} on-primary-fill 是深墨或白（L ${L.toFixed(2)}）`);
    for (const s of SURF) assert.ok(contrast(r.primary, r[s]) >= 4.5, `${id} ${m} primary ink / ${s}`);
  }
  assert.equal(DATA.presets.dustyblue.light['primary-fill'], '#d4a72c', '雾霾蓝的按钮 = 芥末本色');
  assert.ok(hexToOklch(DATA.presets.dustyblue.light['on-primary-fill']).l < 0.3, '芥末上是深色字');
});

test('22 套全部由公式生成：规格里没有逐套手调的深色值（p.hd / tune / slider 覆盖），cd = min(前景 1 彩度, 0.13)；唯一例外是设计稿钉死的 PINS（只有 terra，深套）', () => {
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
  for (const [id, p] of Object.entries(DATA.presets)) for (const m of MODES(id)) {
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
  /* P4-2b 删 /chat/ 页后，发送按钮看 AI 窗口的 .sgx-ai-send */
  assert.match(CSS, /\.sgx-ai-send \{[^}]*background: var\(--sgx-primary-fill\); color: var\(--sgx-on-primary-fill\); \}/);
  assert.match(CSS, /background: var\(--m-primary-fill\); border-color: var\(--m-primary-fill\);/);
  assert.doesNotMatch(CSS.slice(CSS.indexOf('/* @gen-palettes:end */')), /background(?:-color)?: var\(--(?:sgx|m)-primary\); color: var\(--(?:sgx|m)-on-primary\)/);
});

test('大面积块中性化：首页名片 = 中性玻璃卡（不是 primary-container）；夜间时钟不是渐变深色块；状态（旷野 #status）的「正常」读 success 不读 tertiary', () => {
  const home = readFileSync(path.join(REPO, 'space/web/layouts/index.html'), 'utf8');
  /* 2026-11 PR-2：名片并进首屏 hero（不再是卡片，直接铺在页面底上），仍不用任何 *-container 大色块 */
  const prof = home.match(/<div id="w-profile" class="([^"]+)"/)[1];
  assert.equal(prof, 'home-id');
  assert.doesNotMatch(home.slice(home.indexOf('id="home-hero"'), home.indexOf('id="home-term"')), /primary-container|secondary-container|tertiary-container/);
  assert.doesNotMatch(CSS, /\.clock-night \{[^}]*linear-gradient/);
  /* 对齐 PR-B：服务状态改成 systemctl 文字风——横幅不再铺色块，「正常」的圆点（● 字符）和 Active 字读 success */
  assert.match(CSS, /\.st-banner\[data-state="up"\] \.st-dot, \.st-unit\[data-state="up"\] \.st-dot, \.st-chip\[data-state="up"\] \.st-dot \{ color: var\(--sgx-success\); \}/);
  assert.match(CSS, /\.st-banner\[data-state="up"\] \.st-banner-active \{ color: var\(--sgx-success\); \}/);
  assert.doesNotMatch(CSS, /\.st-banner\[data-state="[a-z]+"\] \{[^}]*-container/, '横幅不铺 *-container 色块');
  /* 进站 v3 L1：安全页（.sec-status 状态卡）删了，盾牌是终端文字 */
  assert.doesNotMatch(CSS, /\.sec-status \{/);
  assert.doesNotMatch(CSS, /data-state="up"[^}]*tertiary/);
});

test('不带字的填充 *-fill 在卡片上 ≥ 3:1（亮色比文字色亮，暗色 = 辅 / 第三色本身）', () => {
  for (const x of PRESETS) for (const m of MODES(x.id)) for (const f of ['secondary', 'tertiary']) {
    const r = DATA.presets[x.id][m];
    assert.ok(contrast(r[f + '-fill'], r['surface-container-lowest']) >= 3, `${x.id} ${m} ${f}-fill`);
    if (m === 'dark') assert.equal(r[f + '-fill'], r[f], `${x.id} dark ${f}-fill`);
    else assert.ok(hexToOklch(r[f + '-fill']).l > hexToOklch(r[f]).l, `${x.id} light ${f}-fill 比文字色亮`);
    assert.ok(contrast(r['on-' + f], r[f]) >= 4.5, `${x.id} ${m} on-${f}`);
  }
});

test('页面底（2026-11 PR-A 照设计稿去光晕）：--sgx-bg-1 纯色 + 44px 网格，不再有 --sgx-halo；页面底 = --sgx-bg-1', () => {
  assert.doesNotMatch(CSS, /--sgx-halo:|var\(--sgx-halo/);
  assert.match(CSS, /--sgx-grid: linear-gradient\(var\(--sgx-grid-line\) 1px, transparent 1px\) 0 0 \/ 44px 44px/);
  assert.match(CSS, /body::before \{ content: ""; position: fixed; inset: 0; z-index: -1; pointer-events: none; background: var\(--sgx-grid\); \}/);
  assert.match(CSS, /--m-wallpaper: var\(--sgx-bg-1\);/);
  assert.doesNotMatch(CSS, /--sgx-chart-1: var\(--sgx-fg-1\);/); // chart 是生成的角色，不再是 CSS 别名
});

test('默认色板 terra（深套）= 设计稿钉值：底 #161412、面 #1d1b19、字 #ece6dc、强调赤陶 #de7a58（PINS）；稿的 --mut / --dim 低于 4.5:1 时由审计提亮（可读性底线）', () => {
  const p = DATA.presets.terra, d = p.roles, t = p.tones;
  assert.equal(p.mode, 'dark');
  assert.equal(d.primary, '#de7a58');
  assert.equal(d['primary-fill'], '#de7a58');
  assert.equal(t['fg-1'], '#de7a58');
  assert.equal(t['bg-1'], '#161412');
  assert.equal(d.background, '#161412');
  assert.equal(d['surface-container-lowest'], '#1d1b19', '面 = 卡片');
  assert.equal(d['outline-variant'], '#2c2825');
  assert.equal(d['text-primary'], '#ece6dc');
  assert.ok(contrast(d['text-tertiary'], d['surface-container-high']) >= 4.5);
  assert.deepEqual(Object.keys(PINS), ['terra']);
  assert.deepEqual(Object.keys(PINS.terra), ['dark']);
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
  for (const [id, p] of Object.entries(DATA.presets)) for (const m of MODES(id)) {
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
  for (const [id, p] of Object.entries(DATA.presets)) for (const m of MODES(id)) {
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
  for (const [id, p] of Object.entries(DATA.presets)) for (const m of MODES(id)) {
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

test('固定语义四色（v4，Gray 2026-11-12 定稿）：浅 / 深各 4 个值写死（SEM），22 套同模式相同；on 色 / 容器字 ≥ 4.5:1，本色在表面上 ≥ 4.5:1', () => {
  assert.deepEqual(SEM, {
    light: { success: '#097334', danger: '#be2423', warning: '#864e00', info: '#1666aa' },
    dark: { success: '#39e175', danger: '#ff6f69', warning: '#ffa521', info: '#5aa5ff' },
  });
  const S = ['background', 'surface', 'surface-container-lowest', 'surface-container-low', 'surface-container', 'surface-container-high'];
  for (const [id, p] of Object.entries(DATA.presets)) for (const m of MODES(id)) {
    const r = p[m], d = REF(m);
    for (const f of ['danger', 'success', 'warning', 'info']) {
      assert.equal(r[f], SEM[m][f], `${id} ${f} = 写死的值（审计不挪）`);
      for (const k of ['on-' + f, f + '-container', 'on-' + f + '-container']) assert.equal(r[k], d[k], `${id} ${m} ${k}`);
      assert.ok(contrast(r['on-' + f], r[f]) >= 4.5, `${id} ${m} on-${f}`);
      assert.ok(contrast(r['on-' + f + '-container'], r[f + '-container']) >= 4.5, `${id} ${m} on-${f}-container`);
      for (const s of S) assert.ok(contrast(r[f], r[s]) >= 4.5, `${id} ${m} ${f} / ${s} ${contrast(r[f], r[s]).toFixed(2)}`);
    }
    assert.equal(r.badge, r.danger, id + ' badge = danger');
  }
  const h = (m, k) => hexToOklch(SEM[m][k]).h;
  for (const m of ['light', 'dark']) {
    assert.ok(h(m, 'success') > 130 && h(m, 'success') < 165, m + ' success 是绿色 ' + h(m, 'success'));
    assert.ok(h(m, 'warning') > 40 && h(m, 'warning') < 90, m + ' warning 是琥珀 ' + h(m, 'warning'));
    assert.ok(h(m, 'info') > 220 && h(m, 'info') < 275, m + ' info 是蓝 ' + h(m, 'info'));
  }
});

test('完整导出的前景四档：base 上 on 色 ≥ 4.5:1（fill / on-fill）；ink 在 tint 和所有表面上 ≥ 4.5:1；tag-fg / tag-bg ≥ 4.5:1', () => {
  const S = ['background', 'surface', 'surface-container-lowest', 'surface-container-low', 'surface-container', 'surface-container-high'];
  for (const [id, p] of Object.entries(DATA.presets)) for (const m of MODES(id)) {
    const r = p[m], t = p[m + 'Tones'];
    for (let i = 1; i <= 6; i++) {
      assert.ok(contrast(t[`fg-${i}-on`], t[`fg-${i}`]) >= 4.5, `${id} ${m} fg-${i}-on / fg-${i} ${contrast(t[`fg-${i}-on`], t[`fg-${i}`]).toFixed(2)}`);
      for (const s of S) assert.ok(contrast(t[`fg-${i}-ink`], r[s]) >= 4.5, `${id} ${m} fg-${i}-ink / ${s} ${contrast(t[`fg-${i}-ink`], r[s]).toFixed(2)}`);
    }
  }
});
