/**
 * P4-2d 账号侧切换 AI 模型：纯函数部分（DOM 行为见 e2e account.spec.js「AI 模型」、quick-panel.spec.js「AI 窗口」）。
 * - shell/ai-panel.js：loadModel / clearModel（清掉并派发 sgx-settings-changed）/ isBadModel（只认 400 + error bad_model）。
 * - apps/account-ai.js：normalizeList（GET /api/ai 结果）/ currentModel（与 styrigx-ai core/models.js pickModel 同一规则）/ modelName。
 * - 账号总览模板有「AI 模型」一行（在 #acct-main 里，登录区没有）；account-i18n 文案中英都有。
 * 运行：node --test tests/space/ui/account/ai-model.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strings, jsDict } from '../../../fixtures/strings.mjs';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL('../../../../' + p, import.meta.url), 'utf8');

/* 两个模块只在调用时碰 window / localStorage；import 时不需要 DOM */
const events = [];
globalThis.window = globalThis.window || {};
globalThis.window.dispatchEvent = (e) => { events.push(e.type); return true; };
globalThis.Event = globalThis.Event || class { constructor(type) { this.type = type; } };

const AP = await import('../../../../space/web/assets/js/shell/ai-panel.js');
const AA = await import('../../../../space/web/assets/js/apps/account-ai.js');
const { pickModel } = await import('../../../../workers/ai/src/core/models.js');

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

test('normalizeList：ok + models 才算；坏条目去掉；没有 default 用第一条；canChoose 只认 true', () => {
  assert.equal(AA.normalizeList(null), null);
  assert.equal(AA.normalizeList({ ok: false, error: 'unauthorized' }), null);
  assert.equal(AA.normalizeList({ ok: true, models: [] }), null);
  assert.equal(AA.normalizeList({ ok: true, models: [{ label: 'no id' }, null] }), null);
  const n = AA.normalizeList({ ok: true, models: [null, { id: 'a', label: 'A' }, { id: '' }], canChoose: 'yes' });
  assert.deepEqual(n, { ok: true, default: 'a', models: [{ id: 'a', label: 'A' }], canChoose: false });
  assert.equal(AA.normalizeList(LIST).canChoose, true);
});

test('currentModel：与 styrigx-ai pickModel 同一规则（能切 + 在列表里 → 选的；否则默认）', () => {
  const l = AA.normalizeList(LIST);
  const reg = { def: LIST.default, models: LIST.models };
  for (const [stored, canChoose] of [[null, true], ['@cf/openai/gpt-oss-20b', true], ['@cf/openai/gpt-oss-20b', false], ['gone', true], ['', true]]) {
    const cur = AA.currentModel({ ...l, canChoose }, stored);
    const srv = pickModel(reg, stored || undefined, canChoose);
    /* 服务端对不在登记里的 id 回 bad_model（AI 窗口清掉后用默认重发），账号页这时按默认显示 */
    const want = srv.ok ? srv.model.id : LIST.default;
    assert.equal(cur.id, want, `stored=${stored} canChoose=${canChoose}`);
  }
  assert.equal(AA.currentModel(null, 'x'), null);
  /* 默认不在列表里 → 第一条 */
  assert.equal(AA.currentModel({ ...l, default: 'nope' }, null).id, LIST.models[0].id);
});

test('modelName：label，没有就 id', () => {
  assert.equal(AA.modelName({ id: 'a', label: 'A' }), 'A');
  assert.equal(AA.modelName({ id: 'a' }), 'a');
});

test('模板：「AI 模型」一行在 #acct-main（登录后的总览）里，不在登录区；文案中英都有', () => {
  const tpl = rd('space/web/layouts/_default/account.html');
  const main = tpl.indexOf('<div id="acct-main" hidden>');
  const row = tpl.indexOf('id="acct-ai-row"');
  const loginEnd = tpl.indexOf('SGX-ACCT-LOGIN-END');
  assert.ok(main > 0 && row > main && row > loginEnd, '在总览里');
  /* P4-3 §6.7：不做底部弹出窗口 → 行下方展开单选列表（aria-expanded / aria-controls），不再 aria-haspopup="dialog" */
  assert.match(tpl, /id="acct-ai-row" role="button" tabindex="0" aria-expanded="false" aria-controls="acct-ai-list"/);
  assert.match(tpl, /<div class="acct-ai-list" id="acct-ai-list" role="radiogroup" aria-labelledby="acct-ai-title" hidden><\/div>/);
  assert.ok(tpl.indexOf('id="acct-ai-list"') > row, '列表在行后面（行下方展开）');
  assert.match(tpl, /\{\{ \$tr\.account\.aiModel \}\}/);
  assert.deepEqual([strings('space', 'en').account.aiModel, strings('space', 'zh').account.aiModel], ['AI model', 'AI 模型']);
  assert.match(tpl, /id="acct-ai-sub"/);
  const acc = jsDict('account');
  for (const k of ['aiModelTitle', 'aiModelDefault', 'aiModelSelf', 'aiModelExternal', 'aiModelErr', 'aiModelLocked']) {
    assert.ok(acc[k] && acc[k].zh && acc[k].en && acc[k].zh !== acc[k].en, k);
  }
});

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

test('AI 模型选择不用底部弹出窗口（P4-3 §6.7）：account-ai.js 不引 shell/sheet.js、不调 openSheet；选项是 role=radio、选中即保存并收起', () => {
  const src = rd('space/web/assets/js/apps/account-ai.js');
  assert.doesNotMatch(src, /shell\/sheet\.js/);
  assert.doesNotMatch(src, /openSheet\s*\(/);
  assert.match(src, /role="radio" aria-checked="/);
  assert.match(src, /setAttribute\('aria-expanded', 'true'\)/);
  /* pick：先存（sset MODEL_KEY）再收起 */
  const pick = src.slice(src.indexOf('function pick('), src.indexOf('function togglePicker('));
  assert.ok(pick.indexOf('sset(MODEL_KEY, id)') >= 0 && pick.indexOf('sset(MODEL_KEY, id)') < pick.indexOf('collapse(true)'));
});
