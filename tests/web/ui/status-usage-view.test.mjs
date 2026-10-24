/**
 * 服务状态「用量」区块（PR3，web/assets/js/lib/status-view.js）：数字 / 字节格式、百分比、进度条等级（> 70% 琥珀、> 90% 红）、
 * 条目顺序、某项拿不到、usage = null 的提示、「更新于 N 分钟前（北京时间）」、转义。假数据：tests/fixtures/status-summary.cjs usage()。
 * 运行：node --test tests/web/ui/status-usage-view.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  fmtCount, fmtBytes, usagePct, fmtUsagePct, usageLevel, usageItems, renderUsage, USAGE_WARN, USAGE_CRIT,
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

test('文案：用量相关的键都在模板里', () => {
  for (const k of ['uWorkers', 'uD1', 'uR2', 'uKV', 'uUpdated', 'uNotConfigured', 'uNotConfiguredSub', 'uNotCollected', 'uError', 'uUnavailable']) assert.ok(DICT[k], k);
  assert.equal(DICT.uNotConfigured.zh, '用量未配置');
  assert.equal(DICT.uNotConfigured.en, 'Usage not configured');
});

test('格式：千分位、十进制字节、百分比', () => {
  assert.equal(fmtCount(0), '0');
  assert.equal(fmtCount(73456), '73,456');
  assert.equal(fmtCount(100000), '100,000');
  assert.equal(fmtCount(1234567), '1,234,567');
  assert.equal(fmtBytes(512), '512 B');
  assert.equal(fmtBytes(5300000), '5.3 MB');
  assert.equal(fmtBytes(468000000), '468 MB');
  assert.equal(fmtBytes(5e8), '500 MB');
  assert.equal(fmtBytes(5e9), '5 GB');
  assert.equal(fmtBytes(2010000000), '2 GB');
  assert.equal(fmtBytes(2460000000), '2.5 GB');
  assert.equal(fmtBytes(999600000), '1 GB');
  assert.equal(fmtBytes(null), '—');
  assert.equal(usagePct(73456, 100000), 73.456);
  assert.equal(usagePct(null, 100), null);
  assert.equal(usagePct(1, 0), null);
  assert.equal(fmtUsagePct(73.456), '73.5%');
  assert.equal(fmtUsagePct(9.668), '9.7%');
  assert.equal(fmtUsagePct(0.53), '0.5%');
  assert.equal(fmtUsagePct(0.04), '<0.1%');
  assert.equal(fmtUsagePct(0), '0%');
  assert.equal(fmtUsagePct(20), '20%');
  assert.equal(fmtUsagePct(130.4), '130%');
});

test('进度条等级：> 70% 琥珀，> 90% 红（严格大于）', () => {
  assert.equal(USAGE_WARN, 70);
  assert.equal(USAGE_CRIT, 90);
  assert.equal(usageLevel(null), 'none');
  assert.equal(usageLevel(0), 'ok');
  assert.equal(usageLevel(70), 'ok');
  assert.equal(usageLevel(70.01), 'warn');
  assert.equal(usageLevel(90), 'warn');
  assert.equal(usageLevel(90.5), 'crit');
  assert.equal(usageLevel(140), 'crit');
});

test('usageItems：Workers → D1 合计 → 每个库（缩进）→ R2 → KV；值 / 上限 / 等级 / 说明', () => {
  const it = usageItems(fx.usage(), ZH);
  assert.deepEqual(it.map((x) => [x.key, x.label, x.child]), [
    ['workers', 'Workers 请求（今天）', false],
    ['d1', 'D1 数据库（合计）', false],
    ['d1db', 'styrigx-status', true],
    ['d1db', 'styrigx-auth', true],
    ['d1db', 'styrigx-sgx', true],
    ['r2', 'R2 存储', false],
    ['kv', 'KV 存储', false],
  ]);
  assert.deepEqual(it.map((x) => [x.value, x.limit, x.level]), [
    ['73,456', '100,000', 'warn'],
    ['483 MB', '5 GB', 'ok'],
    ['468 MB', '500 MB', 'crit'],
    ['12 MB', '500 MB', 'ok'],
    ['3.4 MB', '500 MB', 'ok'],
    ['2 GB', '10 GB', 'ok'],
    ['5.3 MB', '1 GB', 'ok'],
  ]);
  assert.equal(it[0].sub, '按 UTC 零点重置（北京时间 08:00）');
  assert.equal(it[1].sub, '3 个库，单库上限 500 MB');
  assert.equal(it[5].sub, '2 个存储桶 · 1,234 个对象');
  assert.equal(it[6].sub, '3 个命名空间 · 420 个键');
  const en = usageItems(fx.usage(), EN);
  assert.equal(en[0].label, 'Workers requests (today)');
  assert.equal(en[5].sub, '2 buckets · 1,234 objects');
});

test('usageItems：某项拿不到 → 「暂时拿不到」、没有百分比；KV 只有命名空间数', () => {
  const it = usageItems(fx.usage({ r2: null, d1: null, kv: { bytes: null, keys: null, namespaces: 3, limit_bytes: 1e9, error: 'graphql' } }), ZH);
  assert.deepEqual(it.map((x) => x.key), ['workers', 'd1', 'r2', 'kv']);
  const r2 = it.find((x) => x.key === 'r2');
  assert.deepEqual([r2.value, r2.pct, r2.level, r2.sub], ['—', null, 'none', '暂时拿不到']);
  const kv = it.find((x) => x.key === 'kv');
  assert.deepEqual([kv.value, kv.pct, kv.level, kv.sub], ['—', null, 'none', '3 个命名空间（存储量暂时拿不到）']);
});

test('renderUsage：有数据 → 每项一行 + 进度条（宽度、等级、aria）+ 「更新于 18 分钟前（北京时间 11:42）」', () => {
  const h = renderUsage(fx.usage(), null, ZH);
  const rows = h.split('<li ').slice(1);
  assert.equal(rows.length, 7);
  assert.match(rows[0], /data-key="workers" data-level="warn"/);
  assert.match(rows[0], /73,456 \/ 100,000/);
  assert.match(rows[0], /<span class="st-u-pct">73\.5%<\/span>/);
  assert.match(rows[0], /role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="73"/);
  assert.match(rows[0], /aria-label="Workers 请求（今天）已用免费额度的 73\.5%"/);
  assert.match(rows[0], /class="st-u-fill" data-level="warn" style="width:73\.5%"/);
  assert.match(rows[2], /data-key="d1db" data-level="crit" data-child="1"/);
  assert.match(rows[2], /width:93\.6%/);
  /* 很小的用量也至少露 1% 的条 */
  assert.match(rows[6], /width:1\.0%/);
  assert.match(h, /<p class="st-usage-foot">更新于 18 分钟前（北京时间 11:42），每小时更新<\/p>/);
  const en = renderUsage(fx.usage(), null, EN);
  assert.match(en, /Updated 18 min ago \(11:42 Beijing time\), hourly/);
});

test('renderUsage：超过 100% 条封顶；stale → 页脚提示最近一次失败；没进度条的项不出 progressbar', () => {
  const h = renderUsage(fx.usage({ workers: { requests: 130000, limit: 100000 }, stale: true, last_error: 'api-error', r2: null }), null, ZH);
  assert.match(h, /data-key="workers" data-level="crit"/);
  assert.match(h, /width:100\.0%/);
  assert.match(h, /aria-valuenow="100"/);
  assert.match(h, /<p class="st-usage-foot" data-stale="1">更新于 18 分钟前（北京时间 11:42），每小时更新；最近一次刷新失败<\/p>/);
  const r2 = h.split('<li ').find((x) => x.includes('data-key="r2"'));
  assert.ok(!r2.includes('progressbar'));
  assert.match(r2, /暂时拿不到/);
});

test('renderUsage：usage = null → 一行提示（未配置 / 还没收过 / 出错）', () => {
  const nc = renderUsage(null, 'not-configured', ZH);
  assert.match(nc, /data-reason="not-configured"/);
  assert.match(nc, /<p class="st-usage-none-title">用量未配置<\/p>/);
  assert.ok(!nc.includes('st-u-track'));
  assert.match(renderUsage(null, null, EN), /Usage not configured/);
  assert.match(renderUsage(null, 'secret-missing', ZH), /用量未配置/);
  assert.match(renderUsage(null, 'not-collected', ZH), /还没有用量数据/);
  assert.match(renderUsage(null, 'api-error', ZH), /用量暂时拿不到/);
  assert.match(renderUsage(null, 'db', EN), /Usage unavailable/);
});

test('renderUsage：转义库名和原因', () => {
  const h = renderUsage(fx.usage({ d1: { total_bytes: 1, limit_bytes: 5e9, per_db_limit_bytes: 5e8, databases: [{ name: '<img src=x>', bytes: 1 }] } }), null, ZH);
  assert.ok(!h.includes('<img'));
  assert.match(h, /&lt;img src=x&gt;/);
  assert.ok(!renderUsage(null, '"><b>', ZH).includes('<b>'));
});
