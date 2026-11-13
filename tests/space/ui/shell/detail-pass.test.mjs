/**
 * 2026-11-09 细节审查一轮（fix/space-detail-pass，Gray 批的 15 项 + 3 个附带 + 顶栏头像外圈）：锁住几条容易被以后改回去的规则。
 * 运行：node --test tests/space/ui/shell/detail-pass.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (p) => readFileSync(path.join(REPO, p), 'utf8');
const css = read('space/web/assets/common/css/input.css');
const shell = read('space/web/assets/common/css/frame.css');

test('头像外圈：表面色实心环 + 环外沿细线 + 投影；弧压在环外沿（外径 = 环外径 36px，不另起一圈）；平时 2s、.is-busy 0.9s；减弱动效不转；在共享外壳里（四站同一套）', () => {
  for (const s of [css, shell]) {
    assert.match(s, /\.sgx-tb-av > \.sgx-tb-avatar \{[^}]*box-shadow: 0 0 0 2\.5px var\(--sgx-surface\), 0 0 0 3px var\(--sgx-term-line\), 0 1\.5px 3px 3px /);
    const m = s.match(/\.sgx-tb-av::before \{([^}]*)\}/);
    assert.ok(m, '::before');
    const b = m[1];
    /* 弧叠在照片环上面，38px 盒子，环带 16.7–18px（照片半径 15 + 环 2.5 + 细线 0.5 = 18），外侧到 19px 只是虚影 */
    assert.match(b, /z-index: 2;/);
    assert.match(b, /width: 38px; height: 38px; margin: -19px 0 0 -19px;/);
    assert.match(b, /mask: radial-gradient\(closest-side, transparent 16\.3px, var\(--sgx-text-primary\) 16\.7px, var\(--sgx-text-primary\) 18px,/);
    /* 顺时针转：前端（80°）最深、硬切；尾巴渐隐 */
    assert.match(b, /conic-gradient\(from 0deg, transparent 0deg,[^;]*92%, transparent\) 80deg, transparent 80\.5deg\)/);
    assert.match(b, /animation: sgx-av-orbit 2s linear infinite;/);
    assert.match(s, /\.sgx-tb-av\.is-busy::before \{ animation-duration: \.9s; \}/);
    assert.match(s, /@keyframes sgx-av-orbit \{ to \{ transform: rotate\(1turn\); \} \}/);
    assert.match(s, /\.reduced-motion \.sgx-tb-av::before \{ animation: none; \}/);
    assert.match(s, /@media \(prefers-reduced-motion: reduce\) \{ \.sgx-tb-av::before \{ animation: none; \} \}/);
  }
  /* 忙的来源都发 sgx-busy：站内终端等待、AI 回答、主页日刻；顶栏按计数合并 */
  assert.match(read('space/web/assets/common/js/frame/term/terminal.js'), /busyEv\(true\);[\s\S]*busyEv\(false\);/);
  assert.match(read('space/web/assets/common/js/frame/ai/panel.js'), /dispatchEvent\(new CustomEvent\('sgx-busy', \{ detail: v \}\)\)/);
  assert.match(read('space/web/assets/common/js/frame/apps/index.js'), /CustomEvent\('sgx-busy', \{ detail: true \}\)[\s\S]*CustomEvent\('sgx-busy', \{ detail: false \}\)/);
  assert.match(read('space/web/assets/common/js/frame/topbar/panel.js'), /export function mountAvBusy\(d\)[\s\S]*classList\.toggle\('is-busy', on\)/);
});

test('触屏点击区 ≥ 44：透明 ::after 撑到 22px 半径；目录行纵向不裁', () => {
  /* 选择器列表里有嵌套 :is(a, button)，不能用 [^)]* 截；按行匹配到 .sgx-foot-lang :is(a, button))::after（v5 S5：锁屏 zh / en 随锁屏删了） */
  assert.match(css, /@media \(pointer: coarse\) \{\n  :is\(\.sgx-tb-acts \.sgx-tb-btn, \.sgx-tb-av, [^\n]*\.sgx-foot-lang :is\(a, button\)\) \{ position: relative; \}\n  :is\(\.sgx-tb-acts \.sgx-tb-btn, \.sgx-tb-av, [^\n]*\.sgx-foot-lang :is\(a, button\)\)::after \{\n    content: ""; position: absolute;[^}]*top: min\(0px, calc\(50% - 22px\)\)/);
  assert.match(css, /\.sgx-tl \{ overflow-x: clip; overflow-y: visible; \}/);
});

test('字距：标签统一 --sgx-track-label .08em（v5 S5：锁屏标题栏 / 状态胶囊随锁屏删了）', () => {
  assert.match(css, /--sgx-track-label: \.08em;/);
  for (const k of ['.home-sec-k', '.sgx-yr', '.sgx-nav-h, .sgx-nav-f', '.sgx-pop-g']) {
    const i = css.indexOf('\n' + k + ' {');
    assert.ok(i > 0, k);
    assert.match(css.slice(i, css.indexOf('}', i)), /letter-spacing: var\(--sgx-track-label\)/, k);
  }
  assert.ok(!css.includes('.sgx-entry-term-bar') && !css.includes('.sgx-entry-st '), '锁屏的样式删干净');
});

test('主页嵌入终端的样式删了（v5 S8：S7 起主页首屏是 neofetch）；触屏输入行 16px；锁屏输出的样式随锁屏删了（v5 S5）', () => {
  assert.ok(!css.includes('.sgx-term--home'), '主页嵌入终端 .sgx-term--home 删干净');
  assert.match(css, /@media \(pointer: coarse\) \{ \.sgx-term-line \{ font-size: 16px; \} \}/);
  assert.ok(!/\.sgx-entry-(l|log|line|in|ps|term|tail|lang)\b/.test(css), '锁屏终端的样式删干净');
  /* 开机动画（终端里 sudo styrigx 通过后，shell/space/unlock.js）的样式还在 */
  for (const k of ['.sgx-entry-boot {', '.sgx-entry-bout {', '.sgx-entry-cur {', '#sgx-entry.sgx-entry-anim {', '#sgx-entry.sgx-entry-booted {']) assert.ok(css.includes(k), k);
});

test('文案：中文阅读时间「分钟」；奇趣加载失败是终端口吻（en / zh 各分区都有 loadFail）', () => {
  assert.match(read('space/web/i18n/zh.yaml'), /^readMin: '\{\{ \.Minutes \}\} 分钟'$/m);
  for (const l of ['en', 'zh']) {
    const y = read(`space/web/data/curio/i18n/${l}.yaml`);
    const fails = y.match(/^\s+failed: /gm) || [];
    const loads = y.match(/^\s+loadFail: "error: [^"]+  # [^"]+"$/gm) || [];
    assert.equal(loads.length, fails.length, l);
    assert.ok(yaml.load(y), l);
  }
});
