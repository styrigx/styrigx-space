/**
 * 状态页（/status/）渲染 / 格式函数（web/assets/js/lib/status-view.js）：北京时间、时长、可用率、每日色块、
 * 当前状态、横幅、站点卡和故障列表的 HTML。假数据：tests/fixtures/status-summary.cjs（Playwright 同一份）。
 * 运行：node --test tests/web/ui/status-view.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  esc, bjDay, addDays, fmtDay, fmtBjTime, fmtDur, fmtAgo, fmtPct, pctOf, dayLevel, buildSlots, siteState, siteName, hostOf,
  causeText, lastText, isEmptySummary, bannerInfo, sortIncidents, slotText, uptime90, renderSite, renderIncidents, BAR_DAYS,
} from '../../../web/assets/js/lib/status-view.js';
import fx from '../../fixtures/status-summary.cjs';

/* 文案直接读模板里的那份（partials/status-i18n.html 的 dict "key" (dict "zh" … "en" …)），和页面上一致 */
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

test('文案：模板里读到了全部文案键', () => {
  assert.ok(Object.keys(DICT).length >= 40, '只读到 ' + Object.keys(DICT).length + ' 条');
  assert.equal(DICT.allUp.zh, '全部正常');
  assert.equal(DICT.someDown.zh, '有 {n} 个故障');
});

test('北京时间：日期、跨日、时间格式（不看运行环境时区）', () => {
  assert.equal(bjDay(Date.parse('2026-10-21T15:59:00Z')), '2026-10-21');
  assert.equal(bjDay(Date.parse('2026-10-21T16:00:00Z')), '2026-10-22');
  assert.equal(addDays('2026-10-01', -1), '2026-09-30');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(fmtDay('2026-10-09', false), '10月9日');
  assert.equal(fmtDay('2026-10-09', true), 'Oct 9');
  const t = Date.parse('2026-10-21T16:03:00Z'); /* 北京 10-22 00:03 */
  assert.equal(fmtBjTime(t, false), '10月22日 00:03');
  assert.equal(fmtBjTime(t, true), 'Oct 22, 00:03');
  assert.equal(fmtBjTime(t, false, '2026-10-22'), '00:03');
  assert.equal(fmtBjTime(t, false, '2026-10-21'), '10月22日 00:03');
});

test('时长 / 相对时间', () => {
  assert.equal(fmtDur(30 * 1000, ZH.fmt), '不到 1 分钟');
  assert.equal(fmtDur(7 * 60000 + 59000, ZH.fmt), '7 分钟');
  assert.equal(fmtDur(60 * 60000, ZH.fmt), '1 小时');
  assert.equal(fmtDur(65 * 60000, ZH.fmt), '1 小时 5 分钟');
  assert.equal(fmtDur(51 * 3600000, ZH.fmt), '2 天 3 小时');
  assert.equal(fmtDur(48 * 3600000, EN.fmt), '2 d');
  assert.equal(fmtDur(-5, EN.fmt), 'under 1 min');
  assert.equal(fmtAgo(fx.NOW - 40000, fx.NOW, ZH.fmt), '刚刚');
  assert.equal(fmtAgo(fx.NOW - 3 * 60000, fx.NOW, ZH.fmt), '3 分钟前');
  assert.equal(fmtAgo(fx.NOW - 2 * 3600000, fx.NOW, EN.fmt), '2 h ago');
  assert.equal(fmtAgo(fx.NOW - 30 * 3600000, fx.NOW, EN.fmt), '1 d ago');
});

test('可用率：— / 100% / 两位小数，有失败不显示成 100.00%', () => {
  assert.equal(fmtPct(null), '—');
  assert.equal(fmtPct(undefined), '—');
  assert.equal(fmtPct(100), '100%');
  assert.equal(fmtPct(99.951), '99.95%');
  assert.equal(fmtPct(99.999), '99.99%');
  assert.equal(fmtPct(0), '0.00%');
  assert.equal(pctOf(0, 0), null);
  assert.equal(pctOf(1415, 1440), 98.26);
});

test('每日色块：没数据 / 零星失败（< 3 次）算正常 / 部分故障 / 故障（< 95%）', () => {
  assert.equal(dayLevel(null), 'none');
  assert.equal(dayLevel({ total: 0, ok: 0 }), 'none');
  assert.equal(dayLevel({ total: 1440, ok: 1440 }), 'ok');
  assert.equal(dayLevel({ total: 1440, ok: 1438 }), 'ok');
  assert.equal(dayLevel({ total: 1440, ok: 1437 }), 'minor');
  assert.equal(dayLevel({ total: 1440, ok: 1368 }), 'minor'); /* 95% 整 */
  assert.equal(dayLevel({ total: 1440, ok: 1367 }), 'down');
  assert.equal(dayLevel({ total: 10, ok: 0 }), 'down');
});

test('buildSlots：固定 90 格，旧 → 新，最后一格是今天，缺的日子补「无数据」', () => {
  const s = buildSlots([{ day: '2026-10-09', total: 720, ok: 720, avg_ms: 100 }, { day: '2026-10-01', total: 1440, ok: 1300, avg_ms: 90 }], '2026-10-09');
  assert.equal(s.length, BAR_DAYS);
  assert.equal(s[89].day, '2026-10-09');
  assert.equal(s[89].level, 'ok');
  assert.equal(s[0].day, addDays('2026-10-09', -89));
  assert.equal(s[0].level, 'none');
  assert.equal(s[81].day, '2026-10-01');
  assert.equal(s[81].level, 'down');
  assert.equal(s.filter((x) => x.level === 'none').length, 88);
  /* 超出 90 天的旧数据不进条 */
  assert.equal(buildSlots([{ day: '2026-06-01', total: 1, ok: 1 }], '2026-10-09').every((x) => x.level === 'none'), true);
  assert.equal(buildSlots(fx.normal().sites[0].days, fx.TODAY).filter((x) => x.level !== 'none').length, 40);
});

test('siteState：等待检查 / 故障 / 波动（失败但没到阈值）/ 正常', () => {
  assert.equal(siteState(fx.empty().sites[0]), 'pending');
  assert.equal(siteState(fx.normal().sites[0]), 'up');
  assert.equal(siteState(fx.oneDown().sites[3]), 'down');
  const flaky = Object.assign({}, fx.normal().sites[1], { fails: 1, last: { at: 1, ok: false, code: 502, ms: 30, err: 'status' } });
  assert.equal(siteState(flaky), 'flaky');
  assert.equal(siteState(null), 'pending');
});

test('站名 / 域名 / 原因 / 最近一次检查', () => {
  assert.deepEqual(fx.normal().sites.map((s) => siteName(s, false)), ['主站', '博客', '日刻', '奇趣', '规则集']);
  assert.deepEqual(fx.normal().sites.map((s) => siteName(s, true)), ['Main site', 'Blog', 'Daymark', 'Curio', 'Proxy rules']);
  assert.equal(siteName({ site: 'new', zh: '新站', en: 'New' }, true), 'New');
  assert.equal(hostOf('https://blog.styrigx.com/robots.txt'), 'blog.styrigx.com');
  assert.equal(hostOf('not a url'), '');
  assert.equal(causeText('timeout', ZH.t), '超时');
  assert.equal(causeText('network', EN.t), 'Connection failed');
  assert.equal(causeText('HTTP 502', ZH.t), 'HTTP 502');
  assert.equal(causeText(null, ZH.t), '原因不明');
  assert.equal(lastText({ ok: true, code: 200, ms: 123.4, err: null }, ZH.t, ZH.fmt), '延迟 123 ms');
  assert.equal(lastText({ ok: false, code: 503, ms: 20, err: 'status' }, ZH.t, ZH.fmt), 'HTTP 503');
  assert.equal(lastText({ ok: false, code: 0, ms: 10000, err: 'timeout' }, ZH.t, ZH.fmt), '超时');
  assert.equal(lastText(null, ZH.t, ZH.fmt), '');
});

test('isEmptySummary：没有站 / 全都没检查过 = 空', () => {
  assert.equal(isEmptySummary(fx.empty()), true);
  assert.equal(isEmptySummary({ sites: [] }), true);
  assert.equal(isEmptySummary(null), true);
  assert.equal(isEmptySummary(fx.normal()), false);
});

test('横幅：全部正常 / 有 1 个故障（列出站名）/ 英文单复数', () => {
  assert.deepEqual(bannerInfo(fx.normal(), ZH), { state: 'up', title: '全部正常', sub: '5 个服务运行正常', down: 0 });
  const d = bannerInfo(fx.oneDown(), ZH);
  assert.equal(d.state, 'down');
  assert.equal(d.title, '有 1 个故障');
  assert.equal(d.sub, '奇趣暂时无法访问');
  assert.equal(bannerInfo(fx.oneDown(), EN).title, '1 service down');
  const two = fx.oneDown();
  two.sites[1].up = false;
  assert.equal(bannerInfo(two, EN).title, '2 services down');
  assert.equal(bannerInfo(two, EN).sub, 'Blog, Curio unreachable right now');
  assert.equal(bannerInfo(two, ZH).sub, '博客、奇趣暂时无法访问');
});

test('故障排序：进行中在前，再按开始时间新 → 旧', () => {
  const l = sortIncidents([
    { id: 1, started_at: 100, ended_at: 200 },
    { id: 2, started_at: 50, ended_at: null },
    { id: 3, started_at: 300, ended_at: 400 },
  ]);
  assert.deepEqual(l.map((x) => x.id), [2, 3, 1]);
});

test('uptime90：用接口的 d90，没有就按 days 算', () => {
  assert.equal(uptime90({ uptime: { d90: 99.5 }, days: [] }), 99.5);
  assert.equal(uptime90({ uptime: { d90: null }, days: [{ total: 100, ok: 99 }] }), 99);
  assert.equal(uptime90({ days: [] }), null);
});

test('slotText：某一天的说明', () => {
  assert.equal(slotText({ day: '2026-09-27', total: 1440, ok: 1415, avg_ms: 90 }, ZH), '9月27日 · 可用率 98.26% · 1440 次检查 · 平均 90 ms');
  assert.equal(slotText({ day: '2026-09-27', total: 0, ok: 0, avg_ms: null }, EN), 'Sep 27 · No data');
});

test('renderSite：正常的卡（站名、域名、正常、延迟、90 格、可用率）', () => {
  const s = fx.normal().sites[0];
  const h = renderSite(s, ZH);
  assert.match(h, /^<article class="widget bg-m-container-lowest st-card" data-site="space" data-state="up">/);
  assert.match(h, /<h2 class="st-name">主站<\/h2><p class="st-host">styrigx\.com<\/p>/);
  assert.match(h, /<span class="st-chip" data-state="up">.*正常<\/span>/);
  assert.match(h, /延迟 123 ms/);
  assert.match(h, /刚刚检查/);
  assert.equal((h.match(/class="st-cell"/g) || []).length, 90);
  assert.equal((h.match(/data-level="none"/g) || []).length, 50);
  assert.match(h, /可用率 100%/);
  assert.match(h, /aria-label="主站近 90 天可用率 100%"/);
  const blog = renderSite(fx.normal().sites[1], EN);
  assert.match(blog, /data-level="minor"/);
  assert.match(blog, /99\.96% uptime/);
  assert.match(blog, /checked just now/);
});

test('renderSite：故障的卡（故障 chip、超时标红）/ 没检查过的卡', () => {
  const h = renderSite(fx.oneDown().sites[3], ZH);
  assert.match(h, /data-site="curio" data-state="down"/);
  assert.match(h, /<span class="st-chip" data-state="down">.*故障<\/span>/);
  assert.match(h, /<span class="st-meta-last" data-ok="0">超时<\/span>/);
  const p = renderSite(fx.empty().sites[0], ZH);
  assert.match(p, /data-state="pending"/);
  assert.match(p, /等待检查/);
  assert.match(p, /还没检查过/);
  assert.match(p, /可用率 —/);
});

test('renderSite：转义接口里的文字', () => {
  const s = Object.assign({}, fx.normal().sites[0], { site: 'x"><img>', zh: '<b>坏</b>', url: 'https://a.example/' });
  const h = renderSite(s, ZH);
  assert.ok(!h.includes('<img>'));
  assert.ok(!h.includes('<b>'));
  assert.match(h, /&lt;b&gt;坏&lt;\/b&gt;/);
  assert.equal(esc(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
});

test('renderIncidents：进行中 / 已恢复，北京时间、同一天恢复只写时分、持续时长', () => {
  const h = renderIncidents(fx.oneDown().incidents, ZH);
  const items = h.split('<li ').slice(1);
  assert.equal(items.length, 3);
  assert.match(items[0], /data-open="1" data-site="curio"/);
  assert.match(items[0], /进行中/);
  assert.match(items[0], /超时/);
  assert.match(items[0], /开始 10月9日 11:53/);
  assert.match(items[0], /已持续 7 分钟/);
  /* 博客：9 月 27 日 09:00 开始，09:25 恢复（同一天，只写时分），持续 25 分钟 */
  assert.match(items[1], /data-site="blog"/);
  assert.match(items[1], /已恢复/);
  assert.match(items[1], /HTTP 502/);
  assert.match(items[1], /开始 9月27日 09:00/);
  assert.match(items[1], /恢复 09:25/);
  assert.match(items[1], /持续 25 分钟/);
  assert.match(items[2], /持续 2 小时/);
  const en = renderIncidents(fx.normal().incidents, EN);
  assert.match(en, /Started Sep 27, 09:00/);
  assert.match(en, /Resolved 09:25/);
  assert.match(en, /Lasted 25 min/);
  assert.equal(renderIncidents([], ZH), '<p class="st-inc-none">没有故障记录</p>');
});
