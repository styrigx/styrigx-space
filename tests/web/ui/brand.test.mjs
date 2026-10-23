/**
 * 品牌资源（2026-10-21）：抽屉头字标、标签页图标、分享卡片。
 * - 字标 partials/shell-wordmark.html：单行内联 SVG，role=img + aria-label=Styrigx，字母 / 圆点分两条路径，进共享外壳 nav.json
 * - 外壳 CSS：字母跟 --sgx-text-primary、圆点跟 --sgx-primary
 * - favicon.svg / favicon.ico（16 / 32 / 48）/ og.png（1200×630）在 web/static；baseof.html 引用它们并写分享卡片 meta
 * - shell/favicon.js：换色只换两个 fill，认不出的 SVG 不动
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAll, readWordmark } from '../../../scripts/gen-shell.mjs';
import { toHex, recolor } from '../../../web/assets/js/shell/favicon.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const rd = (p) => readFileSync(path.join(REPO, p));

test('字标：单行 SVG、可访问名 Styrigx、字母 / 圆点两条路径、进共享外壳 nav.json（brand 文字保留）', () => {
  const svg = readWordmark();
  assert.match(svg, /^<svg class="sgx-wordmark" xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="70 -1578 5924 2010" role="img" aria-label="Styrigx"><title>Styrigx<\/title>/);
  assert.equal((svg.match(/<path /g) || []).length, 2);
  assert.match(svg, /<path class="wm-letters" fill="currentColor" d="M/);
  assert.match(svg, /<path class="wm-dot" fill="#2f5f86" d="M/);
  assert.ok(svg.length < 2400, '路径已压缩（整数坐标，无 transform）：' + svg.length);
  assert.doesNotMatch(svg, /transform=|<style/);
  const nav = JSON.parse(renderAll()['nav.json']);
  assert.equal(nav.brand, 'Styrigx');
  assert.equal(nav.wordmark, svg);
  const base = rd('web/layouts/_default/baseof.html').toString();
  assert.match(base, /<span class="sgx-drawer-brand">\{\{ partial "shell-wordmark\.html" \. \}\}<\/span>/);
});

test('外壳 CSS：字标高 = 站名字号 × 2010/2048，字母跟 text-primary，圆点跟 primary', () => {
  const s = renderAll()['shell.css'];
  assert.match(s, /\.sgx-wordmark \{ --wm-ink: var\(--sgx-text-primary\); --wm-accent: var\(--sgx-primary\);[^}]*height: calc\(var\(--sgx-drawer-brand-size\) \* 2010 \/ 2048\);/);
  assert.match(s, /\.sgx-wordmark \.wm-letters \{ fill: var\(--wm-ink\); \}/);
  assert.match(s, /\.sgx-wordmark \.wm-dot \{ fill: var\(--wm-accent\); \}/);
});

test('标签页图标 + 分享卡片：静态文件齐全、尺寸对', () => {
  const svg = rd('web/static/favicon.svg').toString();
  /* 2026-10-23 PR-G：方块 = 默认色板 dustyblue 的浅色主色（palette-roles.json），和 favicon.js 的 BG 同一个值 */
  const dflt = JSON.parse(rd('web/data/palette-roles.json').toString()).presets.dustyblue.light.primary;
  assert.equal(dflt, '#7e6000');
  assert.ok(rd('web/assets/js/shell/favicon.js').toString().includes(`const BG = '${dflt}';`));
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 1000 1000"><path fill="#7e6000" d="M[^"]+"\/><path fill="#fff" d="M[^"]+"\/><\/svg>$/);
  assert.ok(svg.length < 2000, 'favicon.svg ' + svg.length);
  const ico = rd('web/static/favicon.ico');
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  const n = ico.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < n; i++) sizes.push(ico[6 + i * 16] || 256);
  assert.deepEqual(sizes.sort((a, b) => a - b), [16, 32, 48]);
  const png = rd('web/static/og.png');
  assert.equal(png.toString('latin1', 1, 4), 'PNG');
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  /* /favicon.ico 不能再被 _redirects 301 到头像（Pages 的重定向优先于静态文件） */
  assert.doesNotMatch(rd('web/static/_redirects').toString(), /^\/favicon\.ico\s/m);
});

test('baseof.html：图标链接 + 分享卡片 meta', () => {
  const b = rd('web/layouts/_default/baseof.html').toString();
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
  const svg = rd('web/static/favicon.svg').toString();
  const url = recolor(svg, '#2f6b4f', '#f7fcf9');
  assert.ok(url.startsWith('data:image/svg+xml,'));
  const out = decodeURIComponent(url.slice('data:image/svg+xml,'.length));
  assert.match(out, /fill="#2f6b4f"/);
  assert.match(out, /fill="#f7fcf9"/);
  assert.doesNotMatch(out, /#7e6000|fill="#fff"/);
  assert.equal(recolor('<svg><path fill="red"/></svg>', '#000000', '#ffffff'), '');
});
