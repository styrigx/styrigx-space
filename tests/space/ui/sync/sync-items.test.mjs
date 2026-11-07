/**
 * 账号 → 云同步页（/account/sync/，2026-10-24 PR4）：
 * - data/sync-items.yaml 列出的项 = lib/cloud-sync.js syncKeys() 实际同步的 key，一个不多一个不少、不重复；
 *   语言（sgx-lang）、布局（sgx-layout）不同步、不列；每项都有名字（features.yaml 的 name，或 extra 的 name）。
 * - lib/sync-items.js valueText：enum / bool（与 features.js 同一套存储语义）/ string / json / accent / city / ai-model 的显示。
 * - P4-2d：账号页选的 AI 模型 sgx-ai-model 进云同步（EXTRA + sync-items.yaml extra），AI 窗口历史 sgx-ai-history 仍不进。
 * - 模板 account-sync.html 按 yaml 渲染、有总开关；文案中英都有。
 * 运行：node --test tests/space/ui/sync/sync-items.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strings, jsDict } from '../../../fixtures/strings.mjs';
const TR = { en: strings('space', 'en'), zh: strings('space', 'zh') };
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const rd = (p) => readFileSync(new URL('../../../../' + p, import.meta.url), 'utf8');
const feats = /** @type {any} */ (yaml.load(rd('space/web/data/features.yaml'))).features;
const si = /** @type {any} */ (yaml.load(rd('space/web/data/sync-items.yaml')));

/* features.js 从页面里的 #sgx-features 读定义（baseof 由 features.yaml 生成：id / key / type / default / storage） */
const featDefs = feats.map((f) => Object.assign({ id: f.id, key: f.key, type: f.type, default: f.default }, f.storage ? { storage: f.storage } : {}));
globalThis.window = globalThis.window || { addEventListener() {}, dispatchEvent() {} };
globalThis.document = { getElementById: (id) => (id === 'sgx-features' ? { textContent: JSON.stringify(featDefs) } : null), documentElement: { getAttribute() { return null; } }, cookie: '' };
const { syncKeys } = await import('../../../../space/web/assets/js/lib/cloud-sync.js');
const { valueText, defOf } = await import('../../../../space/web/assets/js/lib/sync-items.js');

const listed = si.groups.flatMap((g) => g.keys);

test('同步项清单 = syncKeys()（实际同步的 key），不重复；不含 sgx-lang / sgx-layout', () => {
  const real = syncKeys();
  assert.ok(real.length >= 5, '读到了 features 定义');
  assert.equal(new Set(listed).size, listed.length, '有重复');
  assert.deepEqual([...listed].sort(), [...real].sort());
  for (const k of ['sgx-lang', 'sgx-layout']) {
    assert.ok(!listed.includes(k), k);
    assert.ok(!real.includes(k), k);
  }
  for (const k of ['sgx-theme-mode', 'sgx-palette', 'sgx-accent']) assert.ok(listed.includes(k), '主题色 / 深色模式要列出：' + k);
});

test('每项都有中英文名字；extra 只放 features.yaml 里没有的 key', () => {
  const byKey = new Map(feats.filter((f) => f.key).map((f) => [f.key, f]));
  for (const k of listed) {
    const f = byKey.get(k);
    const x = si.extra[k];
    assert.ok(!(f && x), k + ' 两边都有');
    /* 语言包化（2026-11-07）：名字在字符串表——features.yaml 里的用 features.<id>.name，EXTRA 用 syncItems.extra.<key>；组名 syncItems.group.<id> */
    for (const l of ['en', 'zh']) {
      const name = f ? (TR[l].features[f.id] || {}).name : TR[l].syncItems.extra[k];
      assert.ok(name, k + ' 缺名字 ' + l);
    }
  }
  for (const g of si.groups) assert.ok(TR.en.syncItems.group[g.id] && TR.zh.syncItems.group[g.id] && g.keys.length, g.id);
});

const T = { syncValOn: '开', syncValOff: '关', syncValDefault: '默认', syncValCustom: '已自定义', syncValUnset: '未设置' };
const t = (k) => T[k];

test('valueText：enum（null = 默认）、不认识的值原样显示', () => {
  const d = { type: 'enum', def: 'system', opts: { system: '跟随系统', light: '浅色', dark: '深色' } };
  assert.equal(valueText(d, null, t), '跟随系统');
  assert.equal(valueText(d, 'dark', t), '深色');
  assert.equal(valueText(d, 'weird', t), 'weird');
});

test('valueText：bool 与 features.js get 同一存储语义', () => {
  /* 默认开，关 = '0'（storage on: null, off: "0"） */
  const a = { type: 'bool', def: 'true', on: null, off: '0' };
  assert.equal(valueText(a, null, t), '开');
  assert.equal(valueText(a, '0', t), '关');
  assert.equal(valueText(a, 'x', t), '开');
  /* 默认关，开 = '1'（没有 storage → on '1'） */
  const b = { type: 'bool', def: 'false', on: '1', off: null };
  assert.equal(valueText(b, null, t), '关');
  assert.equal(valueText(b, '1', t), '开');
});

test('valueText：string / json / accent / city', () => {
  assert.equal(valueText({ type: 'string', def: 'America/Los_Angeles' }, null, t), 'America/Los_Angeles');
  assert.equal(valueText({ type: 'string', def: 'America/Los_Angeles' }, 'Asia/Shanghai', t), 'Asia/Shanghai');
  assert.equal(valueText({ type: 'json' }, null, t), '默认');
  assert.equal(valueText({ type: 'json' }, '{"layout":"grid"}', t), '已自定义');
  assert.equal(valueText({ type: 'accent' }, '#3d7bd9', t), '#3D7BD9');
  assert.equal(valueText({ type: 'accent' }, null, t), '未设置');
  assert.equal(valueText({ type: 'accent' }, 'red', t), '未设置');
  assert.equal(valueText({ type: 'city' }, '{"name":"Shanghai","lat":1,"lon":2}', t), 'Shanghai');
  assert.equal(valueText({ type: 'city' }, '{bad', t), '未设置');
  assert.equal(valueText({ type: 'city' }, null, t), '未设置');
});

test('defOf：从行的 data-* 读定义', () => {
  const attrs = { 'data-sync-type': 'enum', 'data-sync-default': '24', 'data-sync-opts': '{"12":"12 小时制","24":"24 小时制"}' };
  const d = defOf({ getAttribute: (n) => (n in attrs ? attrs[n] : null) });
  assert.deepEqual(d, { type: 'enum', def: '24', on: null, off: null, opts: { 12: '12 小时制', 24: '24 小时制' } });
  assert.equal(valueText(d, null, t), '24 小时制');
});

test('模板：按 sync-items.yaml 渲染、有总开关；文案（account-i18n）中英都有', () => {
  const tpl = rd('space/web/layouts/_default/account-sync.html');
  assert.match(tpl, /index site\.Data "sync-items"/);
  assert.match(tpl, /id="acct-sync-sw" role="switch"/);
  assert.match(tpl, /data-sync-key="\{\{ \$k \}\}"/);
  const acc = jsDict('account');
  for (const k of Object.keys(T)) assert.ok(acc[k] && acc[k].zh && acc[k].en, k);
});

test('P5-1：AI 窗口历史 sgx-ai-history 只存本地，不进云同步白名单（syncKeys / sync-items.yaml / features.yaml 都没有）', async () => {
  const { HISTORY_KEY } = await import('../../../../space/web/assets/js/shell/ai-panel.js');
  assert.equal(HISTORY_KEY, 'sgx-ai-history');
  assert.ok(!syncKeys().includes(HISTORY_KEY), 'syncKeys() 不含 sgx-ai-history');
  assert.ok(!listed.includes(HISTORY_KEY), 'sync-items.yaml 不列 sgx-ai-history');
  assert.ok(!feats.some((f) => f.key === HISTORY_KEY), 'features.yaml 没有这个 key（不然会被 syncKeys 收进去）');
  assert.doesNotMatch(rd('space/web/assets/js/lib/cloud-sync.js'), /sgx-ai-history/, 'cloud-sync.js 的 EXTRA 不含 AI 历史');
  /* 共享外壳 ai.js（子站用的那份）存同一个 key、同样不走同步 */
  assert.match(rd('space/web/shared/shell/ai.js'), /export const HISTORY_KEY = 'sgx-ai-history';/);
});

test('P4-2d：AI 模型 sgx-ai-model 进云同步白名单（syncKeys + sync-items.yaml「其他」组 + extra 类型 ai-model），键名与 ai-panel.js MODEL_KEY 一致', async () => {
  const { MODEL_KEY, HISTORY_KEY } = await import('../../../../space/web/assets/js/shell/ai-panel.js');
  assert.equal(MODEL_KEY, 'sgx-ai-model');
  assert.ok(syncKeys().includes(MODEL_KEY), 'syncKeys() 含 sgx-ai-model');
  assert.ok(si.groups.find((g) => g.id === 'more').keys.includes(MODEL_KEY), '列在「其他」组');
  assert.equal(si.extra[MODEL_KEY].type, 'ai-model');
  assert.deepEqual([TR.zh.syncItems.extra[MODEL_KEY], TR.en.syncItems.extra[MODEL_KEY]], ['AI 模型', 'AI model']);
  assert.ok(!feats.some((f) => f.key === MODEL_KEY), '不在 features.yaml（走 EXTRA）');
  assert.ok(!syncKeys().includes(HISTORY_KEY), '历史仍不同步');
  /* 共享外壳 ai.js（子站用的那份）读同一个键 */
  assert.match(rd('space/web/shared/shell/ai.js'), /export const MODEL_KEY = 'sgx-ai-model';/);
});

test('valueText：ai-model 没设 →「默认」，设了 → 原样显示模型 id', () => {
  assert.equal(valueText({ type: 'ai-model' }, null, t), '默认');
  assert.equal(valueText({ type: 'ai-model' }, '', t), '默认');
  assert.equal(valueText({ type: 'ai-model' }, '@cf/openai/gpt-oss-20b', t), '@cf/openai/gpt-oss-20b');
});
