/**
 * 云同步的同步项清单（2026-10-24 PR4 起；2026-11-08 Gray 04:47 删了云同步子页 /account/sync/（301 → /account/）和账号页那一行，只留后台自动同步）：
 * - data/sync-items.yaml 列出的项 = lib/cloud-sync.js syncKeys() 实际同步的 key，一个不多一个不少、不重复（清单留作后台同步了什么的说明，加 key 要同步改它）；
 *   语言（sgx-lang）、布局（sgx-layout）不同步、不列；每项都有名字（features.yaml 的 name，或 extra 的 name）。
 * - P4-2d：AI 模型 sgx-ai-model（AI 窗口右上角切换）进云同步（EXTRA + sync-items.yaml extra），AI 窗口历史 sgx-ai-history 仍不进。
 * - 子页没了：模板 / 入口 / apps/account-sync.js / lib/sync-items.js 都删了，_redirects 有 301。
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
const { syncKeys } = await import('../../../../space/web/assets/shell/js/prefs/cloud-sync.js');

const listed = si.groups.flatMap((g) => g.keys);

test('同步项清单 = syncKeys()（实际同步的 key），不重复；不含 sgx-lang / sgx-layout', () => {
  const real = syncKeys();
  assert.ok(real.length >= 4, '读到了 features 定义');
  assert.equal(new Set(listed).size, listed.length, '有重复');
  assert.deepEqual([...listed].sort(), [...real].sort());
  for (const k of ['sgx-lang', 'sgx-layout']) {
    assert.ok(!listed.includes(k), k);
    assert.ok(!real.includes(k), k);
  }
  assert.ok(listed.includes('sgx-palette'), '调色板要列出');
  for (const k of ['sgx-theme-mode', 'sgx-accent']) {
    assert.ok(!listed.includes(k), 'v4 删了：' + k);
    assert.ok(!real.includes(k), 'v4 删了：' + k);
  }
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


test('P5-1：AI 窗口历史 sgx-ai-history 只存本地，不进云同步白名单（syncKeys / sync-items.yaml / features.yaml 都没有）', async () => {
  const { HISTORY_KEY } = await import('../../../../space/web/assets/shell/js/ai/ai-panel.js');
  assert.equal(HISTORY_KEY, 'sgx-ai-history');
  assert.ok(!syncKeys().includes(HISTORY_KEY), 'syncKeys() 不含 sgx-ai-history');
  assert.ok(!listed.includes(HISTORY_KEY), 'sync-items.yaml 不列 sgx-ai-history');
  assert.ok(!feats.some((f) => f.key === HISTORY_KEY), 'features.yaml 没有这个 key（不然会被 syncKeys 收进去）');
  assert.doesNotMatch(rd('space/web/assets/shell/js/prefs/cloud-sync.js'), /sgx-ai-history/, 'cloud-sync.js 的 EXTRA 不含 AI 历史');
  /* 共享外壳 ai.js（子站用的那份）存同一个 key、同样不走同步 */
  assert.match(rd('space/web/assets/shell/js/ai/ai-panel.js'), /export const HISTORY_KEY = 'sgx-ai-history';/);
});

test('P4-2d：AI 模型 sgx-ai-model 进云同步白名单（syncKeys + sync-items.yaml「其他」组 + extra 类型 ai-model），键名与 ai-panel.js MODEL_KEY 一致', async () => {
  const { MODEL_KEY, HISTORY_KEY } = await import('../../../../space/web/assets/shell/js/ai/ai-panel.js');
  assert.equal(MODEL_KEY, 'sgx-ai-model');
  assert.ok(syncKeys().includes(MODEL_KEY), 'syncKeys() 含 sgx-ai-model');
  assert.ok(si.groups.find((g) => g.id === 'more').keys.includes(MODEL_KEY), '列在「其他」组');
  assert.equal(si.extra[MODEL_KEY].type, 'ai-model');
  assert.deepEqual([TR.zh.syncItems.extra[MODEL_KEY], TR.en.syncItems.extra[MODEL_KEY]], ['AI 模型', 'AI model']);
  assert.ok(!feats.some((f) => f.key === MODEL_KEY), '不在 features.yaml（走 EXTRA）');
  assert.ok(!syncKeys().includes(HISTORY_KEY), '历史仍不同步');
  /* 共享外壳 ai.js（子站用的那份）读同一个键 */
  assert.match(rd('space/web/assets/shell/js/ai/ai-panel.js'), /export const MODEL_KEY = 'sgx-ai-model';/);
});

test('2026-11-08：云同步子页删除——模板 / 入口 / 页面脚本 / content 都没有，_redirects 301 到账号页（中英）；账号页与账号下拉没有云同步一行', () => {
  const ex = (p) => { try { rd(p); return true; } catch (e) { return false; } };
  for (const p of ['space/web/layouts/_default/account-sync.html', 'space/web/assets/shell/js/apps/entries/entry-account-sync.js', 'space/web/assets/shell/js/apps/account-sync.js',
    'space/web/assets/shell/js/lib/sync-items.js', 'space/web/content/account-sync.md', 'space/web/content/zh/account-sync.md']) assert.equal(ex(p), false, p);
  const red = rd('space/web/static/_redirects');
  /* 同日账号整页也删了：/account/sync/ 跟 /account/ 一样 301 到本语言首页 #acct（打开账号终端） */
  assert.match(red, /^\/account\/sync\/\s+\/#acct\s+301$/m);
  assert.match(red, /^\/zh\/account\/sync\/\s+\/zh\/#acct\s+301$/m);
  assert.doesNotMatch(rd('space/web/layouts/_default/baseof.html'), /account-sync/);
  assert.equal(ex('space/web/layouts/_default/account.html'), false);
  assert.doesNotMatch(rd('space/web/layouts/partials/shell/shell-topbar.html'), /"sync\/"|data-acct-v="sync"/);
  assert.doesNotMatch(rd('space/web/assets/shell/js/account/window.js'), /sync/i);
  /* 后台自动同步照旧：外壳 core.js 照常起同步（账号终端登录后清拉取时刻，见 cloud-sync-throttle.test.mjs） */
  assert.match(rd('space/web/assets/shell/js/apps/core.js'), /initCloudSync\(\)\.catch/);
});
