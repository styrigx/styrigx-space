/**
 * P4-2d 账号侧切换 AI 模型：纯函数部分（DOM 行为见 e2e account.spec.js「AI 模型」、quick-panel.spec.js「AI 窗口」）。
 * - shell/ai-panel.js：loadModel / clearModel（清掉并派发 sgx-settings-changed）/ isBadModel（只认 400 + error bad_model）。
 * - 2026-11-08（Gray 04:45）：账号页「AI 模型」一行与 apps/account-ai.js 删除、账号下拉也没有模型行；模型只在 AI 窗口右上角切换（同一个键 sgx-ai-model）。
 * 运行：node --test tests/space/ui/account/ai-model.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL('../../../../' + p, import.meta.url), 'utf8');

/* 两个模块只在调用时碰 window / localStorage；import 时不需要 DOM */
const events = [];
globalThis.window = globalThis.window || {};
globalThis.window.dispatchEvent = (e) => { events.push(e.type); return true; };
globalThis.Event = globalThis.Event || class { constructor(type) { this.type = type; } };

const AP = await import('../../../../space/web/assets/js/shell/ai-panel.js');

function memStore(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

test('loadModel：有值原样返回；没有 / 太长（>128）/ 读出错 → 空串（不带 model）', () => {
  assert.equal(AP.loadModel(memStore({ 'sgx-ai-model': '@cf/openai/gpt-oss-20b' })), '@cf/openai/gpt-oss-20b');
  assert.equal(AP.loadModel(memStore()), '');
  assert.equal(AP.loadModel(memStore({ 'sgx-ai-model': 'x'.repeat(129) })), '');
  assert.equal(AP.loadModel(/** @type {any} */ ({ getItem() { throw new Error('denied'); } })), '');
});

test('clearModel：删掉 sgx-ai-model，派发 sgx-settings-changed（主站云同步把删除推上去）；别的键不动', () => {
  const s = memStore({ 'sgx-ai-model': 'gone', 'sgx-ai-history': '{"v":1,"msgs":[]}' });
  events.length = 0;
  AP.clearModel(s);
  assert.equal(s.getItem('sgx-ai-model'), null);
  assert.equal(s.getItem('sgx-ai-history'), '{"v":1,"msgs":[]}');
  assert.deepEqual(events, ['sgx-settings-changed']);
});

test('isBadModel：只认 400 + error bad_model', () => {
  assert.equal(AP.isBadModel(400, { ok: false, error: 'bad_model' }), true);
  assert.equal(AP.isBadModel(400, { ok: false, error: 'too-long' }), false);
  assert.equal(AP.isBadModel(400, null), false);
  assert.equal(AP.isBadModel(502, { error: 'bad_model' }), false);
  /* 未认识的码照旧显示「没能拿到回答」 */
  assert.equal(AP.errKey(400, { error: 'bad_model' }), 'fail');
});

const LIST = { ok: true, default: '@cf/google/gemma-4-26b-a4b-it', canChoose: true, models: [
  { id: '@cf/google/gemma-4-26b-a4b-it', label: 'Gemma 4', provider: 'workers-ai' },
  { id: '@cf/openai/gpt-oss-20b', label: 'GPT-OSS 20B', provider: 'workers-ai' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'gemini' },
] };

test('AI 窗口头部模型胶囊（2026-11 PR-5 按设计稿 ai-v1）：GET /api/ai 读列表，选中写同一个键 sgx-ai-model 并派发 sgx-settings-changed；单选不用底部弹出窗口', () => {
  const src = rd('space/web/assets/js/shell/ai-panel.js');
  assert.match(src, /doFetch\('\/api\/ai', \{ method: 'GET'/);
  assert.match(src, /store\(\)\.setItem\(MODEL_KEY, String\(m\.id\)\)/);
  assert.match(src, /setAttribute\('role', 'radio'\)/);
  assert.doesNotMatch(src, /openSheet\s*\(/);
  const tb = rd('space/web/layouts/partials/shell-topbar.html');
  assert.match(tb, /data-ai-model aria-expanded="false" aria-controls="sgx-ai-models"/);
  assert.match(tb, /role="radiogroup"[^>]*data-ai-models hidden/);
});

test('2026-11-08 Gray 04:45：账号页 / 账号下拉都没有 AI 模型行，apps/account-ai.js 删了；模型只在 AI 窗口头部胶囊切换', () => {
  let gone = false;
  try { rd('space/web/assets/js/apps/account-ai.js'); } catch (e) { gone = true; }
  assert.ok(gone, 'account-ai.js 应已删除');
  const tpl = rd('space/web/layouts/_default/account.html');
  assert.doesNotMatch(tpl, /acct-ai-row|acct-ai-list|account\.aiModel/);
  assert.doesNotMatch(rd('space/web/assets/js/apps/account.js'), /account-ai|initAiModelRow/);
  const tb = rd('space/web/layouts/partials/shell-topbar.html');
  const acct = tb.slice(tb.indexOf('<dialog id="sgx-acct"'), tb.indexOf('</dialog>', tb.indexOf('<dialog id="sgx-acct"')));
  assert.doesNotMatch(acct, /\$t\.acct\.ai\b|"k" "ai"|data-acct-v="ai"/);
  assert.doesNotMatch(rd('space/web/assets/js/shell/topbar-panel.js'), /val\('ai'/);
  assert.match(tb, /data-ai-model aria-expanded="false" aria-controls="sgx-ai-models"/);
});
