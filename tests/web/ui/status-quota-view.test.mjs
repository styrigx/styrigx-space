/**
 * 服务状态「免费额度」区块（2026-10-27，web/assets/js/lib/status-view.js quotaItems / renderQuota）：
 * 条目顺序、值 / 上限 / 百分比、等级（≥ 80% 琥珀、≥ 95% 红）、某项拿不到、Pages 拿不到、quota = null 的提示、
 * 「更新于 N 分钟前」+ stale、中英文案齐全且一致、用量卡 skipWorkers、转义。假数据：tests/fixtures/status-summary.cjs quota()。
 * 运行：node --test tests/web/ui/status-quota-view.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  quotaItems, quotaLevel, renderQuota, renderUsage, usageItems, QUOTA_WARN, QUOTA_CRIT,
} from '../../../web/assets/js/lib/status-view.js';
import fx from '../../fixtures/status-summary.cjs';

const SRC = readFileSync(new URL('../../../web/layouts/partials/status-i18n.html', import.meta.url), 'utf8');
const DICT = {};
for (const m of SRC.matchAll(/"(\w+)" \(dict "zh" "([^"]*)" "en" "([^"]*)"\)/g)) DICT[m[1]] = { zh: m[2], en: m[3] };

function mk(en) {
  const t = (k) => {
    assert.ok(DICT[k], 'status-i18n.html 缺文案：' + k);
    return en ? DICT[k].en : DICT[k].zh;
  };
  const fmt = (k, v) => {
    let s = t(k);
    for (const x in v || {}) s = s.split('{' + x + '}').join(String(v[x]));
    return s;
  };
  return { t, fmt, en, now: fx.NOW, today: fx.TODAY };
}
const ZH = mk(false);
const EN = mk(true);

const KEYS = ['qWorkers', 'qWorkersSub', 'qWorkersSubNoPages', 'qKv', 'qKvRead', 'qKvWrite', 'qKvDelete', 'qKvList', 'qD1', 'qD1Read', 'qD1Write',
  'qR2', 'qR2A', 'qR2ASub', 'qR2B', 'qR2BSub', 'qUpdated', 'qNotConfigured', 'qNotConfiguredSub', 'qError', 'qErrorSub'];

test('文案：额度相关的键中英都有，占位符一致', () => {
  for (const k of KEYS) {
    assert.ok(DICT[k], k);
    assert.ok(DICT[k].zh && DICT[k].en, k);
    const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    assert.equal(ph(DICT[k].zh), ph(DICT[k].en), k + ' 占位符');
  }
  assert.equal(DICT.qError.zh, '额度暂时拿不到');
  assert.equal(DICT.qError.en, 'Quota unavailable');
});

test('等级：< 80% ok、≥ 80% 琥珀、≥ 95% 红、没数据 none（边界含等号）', () => {
  assert.equal(QUOTA_WARN, 80);
  assert.equal(QUOTA_CRIT, 95);
  assert.equal(quotaLevel(null), 'none');
  assert.equal(quotaLevel(0), 'ok');
  assert.equal(quotaLevel(79.99), 'ok');
  assert.equal(quotaLevel(80), 'warn');
  assert.equal(quotaLevel(94.9), 'warn');
  assert.equal(quotaLevel(95), 'crit');
  assert.equal(quotaLevel(130), 'crit');
});

test('条目：顺序、值 / 上限（千分位）、百分比、等级；Workers 说明含 Pages Functions', () => {
  const items = quotaItems(fx.quota(), ZH);
  assert.deepEqual(items.map((x) => x.key), ['q-workers', 'q-kv-read', 'q-kv-write', 'q-kv-delete', 'q-kv-list', 'q-d1-read', 'q-d1-write', 'q-r2-a', 'q-r2-b']);
  const by = Object.fromEntries(items.map((x) => [x.key, x]));
  assert.equal(by['q-workers'].value, '82,000');
  assert.equal(by['q-workers'].limit, '100,000');
  assert.equal(by['q-workers'].pct, 82);
  assert.equal(by['q-workers'].level, 'warn');
  assert.equal(by['q-workers'].sub, 'Workers 2,000 · Pages Functions 80,000，合计算免费额度');
  assert.equal(by['q-kv-write'].value, '960');
  assert.equal(by['q-kv-write'].limit, '1,000');
  assert.equal(by['q-kv-write'].level, 'crit');
  assert.equal(by['q-kv-read'].level, 'ok');
  assert.equal(by['q-d1-read'].limit, '5,000,000');
  assert.equal(by['q-d1-write'].limit, '100,000');
  assert.equal(by['q-r2-a'].limit, '1,000,000');
  assert.equal(by['q-r2-b'].limit, '10,000,000');
  assert.equal(by['q-r2-a'].label, 'R2 A 类操作（本月）');
  assert.equal(quotaItems(fx.quota(), EN)[0].label, 'Workers requests (today)');
});

test('某项拿不到：kv / d1 / r2 = null → 各一行「暂时拿不到」无进度条；Pages 拿不到 → 说明写明未计入', () => {
  const q = fx.quota({ kv: null, d1: null, r2: null, workers: { requests: 2000, workers: 2000, pages: null, limit: 100000 } });
  const items = quotaItems(q, ZH);
  assert.deepEqual(items.map((x) => x.key), ['q-workers', 'q-kv', 'q-d1', 'q-r2']);
  for (const x of items.slice(1)) {
    assert.equal(x.pct, null);
    assert.equal(x.level, 'none');
    assert.equal(x.sub, '暂时拿不到');
  }
  assert.equal(items[0].sub, 'Workers 2,000（Pages Functions 暂时拿不到，未计入）');
  const html = renderQuota(q, null, ZH);
  assert.equal((html.match(/role="progressbar"/g) || []).length, 1);
});

test('渲染：每行进度条 + data-level；≥ 80% 的行高亮（warn / crit）；页脚「更新于 3 分钟前」+ UTC 重置说明', () => {
  const html = renderQuota(fx.quota(), null, ZH);
  assert.match(html, /^<ul class="st-usage" data-kind="quota">/);
  assert.equal((html.match(/role="progressbar"/g) || []).length, 9);
  assert.match(html, /data-key="q-workers" data-level="warn"/);
  assert.match(html, /data-key="q-kv-write" data-level="crit"/);
  assert.match(html, /data-key="q-kv-read" data-level="ok"/);
  assert.match(html, /82,000 \/ 100,000<span class="st-u-pct">82%<\/span>/);
  assert.match(html, /更新于 3 分钟前（北京时间 11:57），最多每 5 分钟刷新；每日额度按 UTC 零点（北京时间 08:00）重置/);
  const en = renderQuota(fx.quota(), null, EN);
  assert.match(en, /Updated 3 min ago \(11:57 Beijing time\), at most every 5 min; daily limits reset at 00:00 UTC/);
  const stale = renderQuota(fx.quota({ stale: true, last_error: 'api-error' }), null, ZH);
  assert.match(stale, /<p class="st-usage-foot" data-stale="1">[^<]*；最近一次刷新失败<\/p>/);
});

test('quota = null：没配 / secret-missing →「额度未配置」；api-error / db / 未知 →「额度暂时拿不到」；没有进度条', () => {
  for (const r of ['not-configured', 'secret-missing']) {
    const h = renderQuota(null, r, ZH);
    assert.match(h, new RegExp('data-reason="' + r + '"'));
    assert.match(h, /额度未配置/);
    assert.doesNotMatch(h, /progressbar/);
  }
  for (const r of ['api-error', 'db', null, 'weird']) {
    const h = renderQuota(null, r, ZH);
    assert.match(h, /额度暂时拿不到/);
    assert.match(h, /5 分钟后会再试/);
  }
  assert.match(renderQuota(null, 'api-error', EN), /Quota unavailable/);
});

test('用量卡 skipWorkers：额度卡有 Workers 时不重复那一行；默认（旧行为）不变', () => {
  const u = fx.usage();
  assert.equal(usageItems(u, ZH)[0].key, 'workers');
  assert.ok(!usageItems(u, ZH, { skipWorkers: true }).some((x) => x.key === 'workers'));
  assert.equal(renderUsage(u, null, ZH), renderUsage(u, null, ZH, {}));
  assert.doesNotMatch(renderUsage(u, null, ZH, { skipWorkers: true }), /data-key="workers"/);
});

test('转义：原因短码里的引号 / 尖括号不进 HTML', () => {
  const h = renderQuota(null, '"><img src=x>', ZH);
  assert.doesNotMatch(h, /<img/);
  assert.match(h, /data-reason="&quot;&gt;&lt;img src=x&gt;"/);
});
