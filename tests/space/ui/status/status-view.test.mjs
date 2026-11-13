/**
 * 服务状态（/status/，之前在账号页，2026-10-24 PR4 前是 /status/）渲染 / 格式函数（space/web/assets/common/js/status/status-view.js）：北京时间、时长、可用率、每日色块、
 * 当前状态、横幅、站点卡和故障列表的 HTML。假数据：tests/fixtures/status-summary.cjs（Playwright 同一份）。
 * 运行：node --test tests/space/ui/status/status-view.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsDict } from '../../../fixtures/strings.mjs';
import { readFileSync } from 'node:fs';
import {
  esc, bjDay, addDays, fmtDay, fmtBjTime, fmtDur, fmtAgo, fmtPct, pctOf, dayLevel, buildSlots, siteState, siteName, hostOf,
  causeText, lastText, isEmptySummary, bannerInfo, sortIncidents, slotText, uptime90, renderSite, renderIncidents, BAR_DAYS,
  UNITS, unitList, renderUnits,
} from '../../../../space/web/assets/common/js/status/status-view.js';
import fx from '../../../fixtures/status-summary.cjs';

/* 文案读主站字符串表 js.status（语言包化 2026-11-07：partials/common/status-i18n.html 输出 $tr.js.status），和页面上一致 */
const DICT = jsDict('status');

function mk(en) {
  const t = (k) => {
    /* 站名 site_<站 id> 按站查，没有的站返回空（同页面 loadI18n 的 t），其余键必须在表里 */
    if (/^site_/.test(k) && !DICT[k]) return '';
    assert.ok(DICT[k], '字符串表 js.status 缺文案：' + k);
    return en ? DICT[k].en : DICT[k].zh;
  };
  const fmt = (k, v) => {
    let s = t(k);
    for (const x in v || {}) s = s.split('{' + x + '}').join(String(v[x]));
    return s;
  };
  return { t, fmt, lang: en ? 'en' : 'zh', now: fx.NOW, today: fx.TODAY };
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
  assert.equal(fmtDay('2026-10-09', 'zh'), '10月9日');
  assert.equal(fmtDay('2026-10-09', 'en'), 'Oct 9');
  const t = Date.parse('2026-10-21T16:03:00Z'); /* 北京 10-22 00:03 */
  assert.equal(fmtBjTime(t, 'zh'), '10月22日 00:03');
  assert.equal(fmtBjTime(t, 'en'), 'Oct 22, 00:03');
  assert.equal(fmtBjTime(t, 'zh', '2026-10-22'), '00:03');
  assert.equal(fmtBjTime(t, 'zh', '2026-10-21'), '10月22日 00:03');
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
  assert.equal(siteState(fx.oneDown().sites[2]), 'down');
  const flaky = Object.assign({}, fx.normal().sites[1], { fails: 1, last: { at: 1, ok: false, code: 502, ms: 30, err: 'status' } });
  assert.equal(siteState(flaky), 'flaky');
  assert.equal(siteState(null), 'pending');
});

test('站名 / 域名 / 原因 / 最近一次检查', () => {
  assert.deepEqual(fx.normal().sites.map((s) => siteName(s, ZH.t)), ['主站', '规则集', 'AI 助手']);
  assert.deepEqual(fx.normal().sites.map((s) => siteName(s, EN.t)), ['Space', 'Proxy rules', 'AI']);
  assert.equal(siteName({ site: 'new', name: 'New' }, ZH.t), 'New', '表里没有的站：接口回的英文名（缺键回退英文）');
  /* 退役站不再有固定站名，只按接口给的 zh / en / site 兜底 */
  assert.equal(siteName({ site: 'blog' }, ZH.t), 'blog');
  /* AI 助手走服务绑定：域名显示成 Worker 名 */
  assert.equal(hostOf('https://styrigx-ai/healthz'), 'styrigx-ai');
  assert.equal(hostOf('https://styrigx.com/robots.txt'), 'styrigx.com');
  assert.equal(hostOf('https://proxy-rules.styrigx.com/healthz'), 'proxy-rules.styrigx.com');
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
  assert.deepEqual(bannerInfo(fx.normal(), ZH), { state: 'up', title: '全部正常', sub: '3 个服务运行正常', down: 0 });
  const d = bannerInfo(fx.oneDown(), ZH);
  assert.equal(d.state, 'down');
  assert.equal(d.title, '有 1 个故障');
  assert.equal(d.sub, 'AI 助手暂时无法访问');
  assert.equal(bannerInfo(fx.oneDown(), EN).title, '1 service down');
  const two = fx.oneDown();
  two.sites[1].up = false;
  assert.equal(bannerInfo(two, EN).title, '2 services down');
  assert.equal(bannerInfo(two, EN).sub, 'Proxy rules, AI unreachable right now');
  assert.equal(bannerInfo(two, ZH).sub, '规则集、AI 助手暂时无法访问');
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
  /* 对齐 PR-B：卡在旷野页 #status 终端窗里——去掉 widget 卡片底；站名降为 h3（窗标题是 h2）；chip 以 ● 开头 */
  assert.match(h, /^<article class="st-card" data-site="space" data-state="up">/);
  assert.match(h, /<h3 class="st-name">主站<\/h3><p class="st-host" translate="no">styrigx\.com<\/p>/);
  assert.match(h, /<span class="st-chip" data-state="up"><span class="st-dot" aria-hidden="true">●<\/span> 正常<\/span>/);
  assert.match(h, /延迟 123 ms/);
  assert.match(h, /刚刚检查/);
  assert.equal((h.match(/class="st-cell"/g) || []).length, 90);
  assert.equal((h.match(/data-level="none"/g) || []).length, 50);
  assert.match(h, /可用率 100%/);
  assert.match(h, /aria-label="主站近 90 天可用率 100%"/);
  const rules = renderSite(fx.normal().sites[1], EN);
  assert.match(rules, /data-level="minor"/);
  assert.match(rules, /99\.96% uptime/);
  assert.match(rules, /checked just now/);
});

test('renderSite：故障的卡（故障 chip、超时标红）/ 没检查过的卡', () => {
  const h = renderSite(fx.oneDown().sites[2], ZH);
  assert.match(h, /data-site="ai" data-state="down"/);
  assert.match(h, /<span class="st-chip" data-state="down">.*故障<\/span>/);
  assert.match(h, /<span class="st-meta-last" data-ok="0">超时<\/span>/);
  const p = renderSite(fx.empty().sites[0], ZH);
  assert.match(p, /data-state="pending"/);
  assert.match(p, /等待检查/);
  assert.match(p, /还没检查过/);
  assert.match(p, /可用率 —/);
});

test('renderSite：转义接口里的文字', () => {
  const s = Object.assign({}, fx.normal().sites[0], { site: 'x"><img>', name: '<b>坏</b>', url: 'https://a.example/' });
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
  assert.match(items[0], /data-open="1" data-site="ai"/);
  assert.match(items[0], /进行中/);
  assert.match(items[0], /超时/);
  assert.match(items[0], /开始 10月9日 11:53/);
  assert.match(items[0], /已持续 7 分钟/);
  /* 规则集：9 月 27 日 09:00 开始，09:25 恢复（同一天，只写时分），持续 25 分钟 */
  assert.match(items[1], /data-site="proxy-rules"/);
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

/* ===== 六个 unit（对齐 PR-B：systemctl status space.target） ===== */
test('UNITS：六个 unit 顺序和来源（四站 = 主站那项，gray-ai = ai，auth = 网关往返）', () => {
  assert.deepEqual(UNITS.map((u) => u.id), ['space', 'blog', 'curio', 'daymark', 'gray-ai', 'auth']);
  assert.deepEqual(UNITS.map((u) => u.src), ['space', 'space', 'space', 'space', 'ai', '']);
});

test('unitList：正常数据 → 六个 up，延迟取最近一次检查（取整），auth 用往返；没数据 → pending', () => {
  const l = unitList(fx.normal(), 87.6);
  assert.equal(l.length, 6);
  assert.deepEqual(l.map((u) => u.state), ['up', 'up', 'up', 'up', 'up', 'up']);
  assert.deepEqual(l.map((u) => u.ms), [123, 123, 123, 123, 140, 88]);
  assert.equal(l[1].host, 'styrigx.com/blog');
  const none = unitList(null, null);
  assert.deepEqual(none.map((u) => u.state), ['pending', 'pending', 'pending', 'pending', 'pending', 'pending']);
  assert.deepEqual(none.map((u) => u.ms), [null, null, null, null, null, null]);
});

test('unitList：AI 故障 → gray-ai down 且没有延迟，其余照常；还没检查过 → 站点 pending、auth up', () => {
  const l = unitList(fx.oneDown(), null);
  const by = Object.fromEntries(l.map((u) => [u.id, u]));
  assert.equal(by['gray-ai'].state, 'down');
  assert.equal(by['gray-ai'].ms, null);
  assert.equal(by.space.state, 'up');
  assert.equal(by.auth.state, 'up');
  assert.equal(by.auth.ms, null, '拿不到往返时延迟为空');
  const e = unitList(fx.empty(), 40);
  assert.deepEqual(e.map((u) => u.state), ['pending', 'pending', 'pending', 'pending', 'pending', 'up']);
});

test('renderUnits：每行 ● name.service · 状态 · 延迟 · 域名；状态文案中英；转义；空列表为空串', () => {
  const h = renderUnits(unitList(fx.oneDown(), 52), ZH);
  assert.equal((h.match(/<li class="st-unit"/g) || []).length, 6);
  assert.match(h, /<li class="st-unit" data-unit="space" data-state="up"><span class="st-dot" aria-hidden="true">●<\/span><span class="st-unit-n" translate="no">space\.service<\/span><span class="st-unit-s" translate="no">[^<]+<\/span><span class="st-unit-ms" translate="no">123ms<\/span><span class="st-unit-h" translate="no">styrigx\.com<\/span><\/li>/);
  assert.match(h, /data-unit="gray-ai" data-state="down">.*?<span class="st-unit-ms" translate="no">—<\/span>/);
  const zhUp = ZH.t('unitActive'); const zhDown = ZH.t('unitFailed');
  assert.ok(h.includes('>' + zhUp + '<') && h.includes('>' + zhDown + '<'));
  const en = renderUnits([{ id: 'x', host: '<b>', state: 'flaky', ms: 5 }, { id: 'y', host: 'h', state: 'weird', ms: null }], EN);
  assert.ok(en.includes('>' + EN.t('unitFlaky') + '<'));
  assert.ok(en.includes('>' + EN.t('unitPending') + '<'), '不认识的状态按 pending 文案');
  assert.ok(!en.includes('<b>') && en.includes('&lt;b&gt;'), '转义');
  assert.equal(renderUnits([], ZH), '');
  assert.equal(renderUnits(/** @type {any} */ (null), ZH), '');
});
