/**
 * 2026-10-21 v7：全网搜索页底栏 + 抽屉淡出 + 语音搜索整个删掉（源码级检查，行为在 web-search.spec.js / nav-drawer.spec.js）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const rd = (p) => readFileSync(path.join(REPO, p), 'utf8');
/** @param {string} dir @returns {string[]} */
function walk(dir) {
  const out = [];
  for (const n of readdirSync(path.join(REPO, dir))) {
    const p = path.join(dir, n);
    if (statSync(path.join(REPO, p)).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

test('语音搜索删干净：没有 voice.js / voice-sheet.js、SpeechRecognition、麦克风按钮、语音文案和样式', () => {
  assert.equal(existsSync(path.join(REPO, 'web/assets/js/shell/voice.js')), false);
  assert.equal(existsSync(path.join(REPO, 'web/assets/js/shell/voice-sheet.js')), false);
  for (const f of walk('web/assets/js')) {
    const s = rd(f);
    assert.doesNotMatch(s, /SpeechRecognition|voiceSheet|voiceInput|data-mic|#voice/, f);
  }
  for (const f of walk('web/layouts')) assert.doesNotMatch(rd(f), /data-mic|sgx-cap-mic|"vsAria"|"noSr"|eq \$name "mic"/, f);
  const css = rd('web/assets/css/input.css');
  assert.doesNotMatch(css, /sgx-cap-mic|sgx-vs-|sgx-mic-pulse/);
  assert.doesNotMatch(rd('web/data/features.yaml'), /voice|speech|mic/i);
  assert.doesNotMatch(rd('scripts/check-layers.mjs'), /'voice/);
});

test('搜索页底栏：长条药丸（放大镜 · 输入框 · ⓧ 清空）+ 单独的 × 关闭圆，同高同材质', () => {
  const h = rd('web/layouts/partials/sgx-capsule.html');
  assert.match(h, /class="sgx-cap sgx-cap-bar"[\s\S]*class="sgx-cap-bar-in"[\s\S]*class="sgx-cap-pill"[\s\S]*data-cap-clear[\s\S]*<\/div>\s*<button type="button" class="sgx-cap-close" data-cap-close/);
  const css = rd('web/assets/css/input.css');
  const pill = /\n  \.sgx-cap-pill \{([^}]*)\}/.exec(css)[1];
  const close = /\n  \.sgx-cap-close \{([^}]*)/.exec(css)[1];
  for (const d of ['background: var(--sgx-mat)', 'border: 1px solid var(--sgx-mat-line)', 'box-shadow: var(--sgx-mat-shadow)']) {
    assert.ok(pill.includes(d), 'pill ' + d);
    assert.ok(close.includes(d), 'close ' + d);
  }
  assert.match(close, /width: var\(--sgx-bottom-dock-h\); height: var\(--sgx-bottom-dock-h\)/);
  /* 浏览器自带的 type=search ×：不要 */
  assert.match(css, /&::-webkit-search-cancel-button \{ -webkit-appearance: none; appearance: none; display: none; \}/);
});

test('从抽屉进搜索页：首帧挂 .sgx-from-drawer，底栏从左下方升起（translate(-24px, 40px) scale(.92)，原点左下），减弱动效不播', () => {
  const css = rd('web/assets/css/input.css');
  assert.match(css, /@keyframes sgx-bar-pop \{ from \{ opacity: 0; transform: translate\(-24px, 40px\) scale\(\.92\); \} to \{ opacity: 1; transform: none; \} \}/);
  assert.match(css, /\.sgx-cap-bar-in \{[^}]*transform-origin: left bottom;/);
  assert.match(css, /\.reduced-motion \.sgx-cap-bar \.sgx-cap-bar-in \{ animation: none; \}/);
  /* 抽屉原地淡出：只改 opacity，面板不滑出，遮罩一起淡掉 */
  assert.match(css, /\.sgx-drawer\.is-fading \{ opacity: 0; transition: opacity var\(--sgx-drawer-fade-ms\) ease; \}/);
  assert.match(css, /\.sgx-drawer\.is-fading \.sgx-drawer-sheet \{ transform: none; transition: none; \}/);
  assert.match(css, /\.sgx-drawer\.is-fading::backdrop \{ background: transparent;/);
  assert.doesNotMatch(css, /is-curtain|--sgx-curtain/);
  const base = rd('web/layouts/_default/baseof.html');
  assert.match(base, /sessionStorage\.getItem\('sgx-search-from-drawer'\)==='1'&&!rm&&/);
  assert.match(base, /d\.classList\.add\('sgx-from-drawer'\)/);
  assert.match(base, /<hr class="sgx-drawer-sep" aria-hidden="true">/);
  /* modal-sheet 没有为窗帘加的 leave() / closeNow() */
  assert.doesNotMatch(rd('web/assets/js/shell/modal-sheet.js'), /leave|closeNow/);
});
