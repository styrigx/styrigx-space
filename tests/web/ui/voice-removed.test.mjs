/**
 * 2026-10-21：语音搜索整个删掉（源码级检查；原在 web-search-bar.test.mjs，/search/ 页 2026-10-22 删了，这一条留着）。
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
