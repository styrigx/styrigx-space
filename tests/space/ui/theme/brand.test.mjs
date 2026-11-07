/**
 * 品牌资源（2026-10-21；2026-11-04 P5-1 字标从抽屉头搬到顶栏左端 logo）：顶栏字标、标签页图标、分享卡片。
 * - 字标 partials/shell-wordmark.html：单行内联 SVG，role=img + aria-label=Styrigx，字母 / 圆点分两条路径，进共享外壳 nav.json
 * - 外壳 CSS：字母跟 --sgx-text-primary、圆点跟 --sgx-primary；顶栏 logo 里字标高 20px（宽高比 5924 / 2010），窄屏换主题色圆点
 * - favicon.svg / favicon.ico（16 / 32 / 48）/ og.png（1200×630）在 space/web/static；baseof.html 引用它们并写分享卡片 meta
 * - shell/favicon.js：换色只换两个 fill，认不出的 SVG 不动
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellFiles, readWordmark } from '../../../../space/scripts/gen-shell.mjs';
import { toHex, recolor } from '../../../../space/web/assets/js/shell/favicon.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const rd = (p) => readFileSync(path.join(REPO, p));

test('字标：单行 SVG、可访问名 Styrigx、字母 / 圆点两条路径、进共享外壳 nav.json（brand 文字保留）', () => {
  const svg = readWordmark();
  assert.match(svg, /^<svg class="sgx-wordmark" xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="70 -1578 5924 2010" role="img" aria-label="Styrigx"><title>Styrigx<\/title>/);
  assert.equal((svg.match(/<path /g) || []).length, 2);
  assert.match(svg, /<path class="wm-letters" fill="currentColor" d="M/);
  assert.match(svg, /<path class="wm-dot" fill="#2f5f86" d="M/);
  assert.ok(svg.length < 2400, '路径已压缩（整数坐标，无 transform）：' + svg.length);
  assert.doesNotMatch(svg, /transform=|<style/);
  const nav = JSON.parse(shellFiles()['nav.json']);
  assert.equal(nav.brand, 'Styrigx');
  assert.equal(nav.wordmark, svg);
  const base = rd('space/web/layouts/_default/baseof.html').toString();
  /* P5-1：字标进顶栏单一来源 shell-topbar 的 logo（主站传 partial 结果，子站传 nav.json 的 wordmark） */
  assert.match(base, /"wordmark" \(partial "shell-wordmark\.html" \.\)/);
  /* 2026-11 顶栏 v3：logo 换成终端字标 ❯ styrigx :~$_（文字，手机也完整显示）；SVG 字标仍在 nav.json / 参数里，顶栏不再渲染 */
  const tb = rd('space/web/layouts/partials/shell-topbar.html').toString();
  assert.match(tb, /<a class="sgx-tb-logo" href="\{\{ \.home \}\}" aria-label="\{\{ \$t\.topbar\.home \}\}"><span class="sgx-tb-ps" aria-hidden="true">❯<\/span><span class="sgx-tb-name" translate="no">styrigx<\/span><span class="sgx-tb-tl" aria-hidden="true">:~\$<\/span><span class="sgx-tb-cu" aria-hidden="true"><\/span><\/a>/);
  assert.doesNotMatch(tb.replace(/\{\{-? \/\*[\s\S]*?\*\/ -?\}\}/g, ''), /\.wordmark \| safeHTML/);
});

test('外壳 CSS（顶栏 v3）：终端字标 ❯ 主题色、:~$ 次要色、光标主题色 1.05 秒步进闪；等宽字体 token；窄屏也是完整字标', () => {
  const s = shellFiles()['shell.css'];
  assert.match(s, /\.sgx-tb-logo \{[^}]*font-family: var\(--sgx-font-mono\); font-size: 18px;/);
  assert.match(s, /\.sgx-tb-ps \{ color: var\(--sgx-primary\);/);
  assert.match(s, /\.sgx-tb-tl \{ color: var\(--sgx-text-tertiary\);/);
  assert.match(s, /\.sgx-tb-cu \{[^}]*background: var\(--sgx-primary\);[^}]*animation: sgx-tb-blink 1\.05s steps\(1\) infinite; \}/);
  assert.match(s, /--sgx-font-mono: ui-monospace,/);
  assert.doesNotMatch(s, /\.sgx-tb-logo \{ display: none; \}|\.sgx-tb-mark/, '没有窄屏藏字标 / 换图标版');
});

test('标签页图标 + 分享卡片：静态文件齐全、尺寸对', () => {
  const svg = rd('space/web/static/favicon.svg').toString();
  /* 2026-10-23 PR-G：方块 = 默认色板 dustyblue 的浅色主色（palette-roles.json），和 favicon.js 的 BG 同一个值 */
  const dflt = JSON.parse(rd('space/web/data/palette-roles.json').toString()).presets.dustyblue.light.primary;
  assert.equal(dflt, '#7e6000');
  assert.ok(rd('space/web/assets/js/shell/favicon.js').toString().includes(`const BG = '${dflt}';`));
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 1000 1000"><path fill="#7e6000" d="M[^"]+"\/><path fill="#fff" d="M[^"]+"\/><\/svg>$/);
  assert.ok(svg.length < 2000, 'favicon.svg ' + svg.length);
  const ico = rd('space/web/static/favicon.ico');
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  const n = ico.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < n; i++) sizes.push(ico[6 + i * 16] || 256);
  assert.deepEqual(sizes.sort((a, b) => a - b), [16, 32, 48]);
  const png = rd('space/web/static/og.png');
  assert.equal(png.toString('latin1', 1, 4), 'PNG');
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  /* /favicon.ico 不能再被 _redirects 301 到头像（Pages 的重定向优先于静态文件） */
  assert.doesNotMatch(rd('space/web/static/_redirects').toString(), /^\/favicon\.ico\s/m);
});

test('baseof.html：图标链接 + 分享卡片 meta', () => {
  const b = rd('space/web/layouts/_default/baseof.html').toString();
  assert.match(b, /<link rel="icon" href="\/favicon\.ico" sizes="32x32">\n<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg">\n<link rel="apple-touch-icon" href="\/avatar\/192\.webp">/);
  for (const re of [/property="og:type" content="website"/, /property="og:site_name" content="Styrigx"/, /property="og:title"/, /property="og:description" content="\{\{ \$desc \}\}"/,
    /property="og:url" content="\{\{ \.Permalink \}\}"/, /property="og:image" content="https:\/\/styrigx\.com\/og\.png"/, /og:image:width" content="1200"/, /og:image:height" content="630"/,
    /name="twitter:card" content="summary_large_image"/, /name="twitter:image" content="https:\/\/styrigx\.com\/og\.png"/]) assert.match(b, re);
});

test('favicon.js：颜色转十六进制；只换默认两色，认不出的 SVG 不动', () => {
  assert.equal(toHex('rgb(47, 95, 134)'), '#2f5f86');
  assert.equal(toHex(' #90C4F1 '), '#90c4f1');
  assert.equal(toHex('rgba(1,2,3,0.5)'), '#010203');
  assert.equal(toHex('color(srgb 1 0 0)'), '');
  const svg = rd('space/web/static/favicon.svg').toString();
  const url = recolor(svg, '#2f6b4f', '#f7fcf9');
  assert.ok(url.startsWith('data:image/svg+xml,'));
  const out = decodeURIComponent(url.slice('data:image/svg+xml,'.length));
  assert.match(out, /fill="#2f6b4f"/);
  assert.match(out, /fill="#f7fcf9"/);
  assert.doesNotMatch(out, /#7e6000|fill="#fff"/);
  assert.equal(recolor('<svg><path fill="red"/></svg>', '#000000', '#ffffff'), '');
});

test('PR-4b：PR-4a §6.1 的窄屏图标版 logo 删除（顶栏只用字标；标签页图标 favicon.svg 不受影响）', () => {
  const tb = rd('space/web/layouts/partials/shell-topbar.html').toString();
  assert.doesNotMatch(tb, /sgx-tb-mark|mk-bg|mk-fg/);
  assert.doesNotMatch(shellFiles()['shell.css'], /\.sgx-tb-mark/);
});
