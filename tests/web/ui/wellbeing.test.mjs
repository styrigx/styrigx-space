/**
 * B2-7 网站数字健康：接口校验 / 汇总、计时器拆包、区域映射、时长格式。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReport, summarize, dayOk, sectionOf, onRequestPost, onRequestGet } from '../../../workers/auth-gateway/functions/api/wellbeing.js';
import { buildBody, localDay } from '../../../web/assets/js/lib/wb-track.js';
import { wbAreaOf } from '../../../web/assets/js/lib/wb-area.js';
import { fmtDur } from '../../../web/assets/js/lib/wb-view.js';

const NOW = Date.parse('2026-10-17T09:00:00Z');

test('dayOk：只接受 UTC 今天前后 1 天', () => {
  assert.ok(dayOk('2026-10-17', NOW));
  assert.ok(dayOk('2026-10-16', NOW));
  assert.ok(dayOk('2026-10-18', NOW));
  assert.ok(!dayOk('2026-10-15', NOW));
  assert.ok(!dayOk('2026-10-19', NOW));
  assert.ok(!dayOk('2026/10/17', NOW));
  assert.ok(!dayOk('', NOW));
});

test('parseReport：合法上报规整、同键合并', () => {
  const r = parseReport({ d: '2026-10-17', s: [
    { k: 'home', sec: 30 },
    { k: 'book:abc-1', t: '  三体\n ', sec: 100.4 },
    { k: 'home', sec: 20 },
  ] }, NOW);
  assert.deepEqual(r, { d: '2026-10-17', s: [
    { k: 'home', t: '', sec: 50 },
    { k: 'book:abc-1', t: '三体', sec: 100 },
  ] });
});

test('parseReport：非法上报全部拒绝', () => {
  const bad = [
    null, {}, { d: '2026-10-17' }, { d: '2026-10-17', s: [] },
    { d: '2020-01-01', s: [{ k: 'home', sec: 5 }] },
    { d: '2026-10-17', s: [{ k: 'evil', sec: 5 }] },
    { d: '2026-10-17', s: [{ k: 'post:<script>', sec: 5 }] },
    { d: '2026-10-17', s: [{ k: 'home', sec: 0 }] },
    { d: '2026-10-17', s: [{ k: 'home', sec: 901 }] },
    { d: '2026-10-17', s: [{ k: 'home', sec: 'x' }] },
    { d: '2026-10-17', s: Array.from({ length: 13 }, () => ({ k: 'home', sec: 1 })) },
  ];
  for (const b of bad) assert.equal(parseReport(b, NOW), null, JSON.stringify(b));
});

test('summarize：按区域合计；书名只给 owner', () => {
  const rows = [
    { k: 'home', t: '', sec: 120 },
    { k: 'book:a', t: '三体', sec: 600 },
    { k: 'book:b', t: '活着', sec: 300 },
    { k: 'post:hello', t: 'Hello', sec: 90 },
  ];
  const o = summarize(rows, true);
  assert.equal(o.total, 1110);
  assert.deepEqual(o.sections, [{ k: 'book', sec: 900 }, { k: 'home', sec: 120 }, { k: 'blog', sec: 90 }]);
  assert.equal(o.items[0].t, '三体');
  const v = summarize(rows, false);
  assert.deepEqual(v.items, []);
  assert.equal(v.total, 1110);
  assert.equal(sectionOf('post:x'), 'blog');
});

test('POST / GET：无会话 401，不碰数据库', async () => {
  let touched = false;
  const env = { SGX_D1: { prepare() { touched = true; } } };
  const post = await onRequestPost({ request: new Request('https://styrigx.com/api/wellbeing', { method: 'POST', body: '{}' }), env });
  assert.equal(post.status, 401);
  const get = await onRequestGet({ request: new Request('https://styrigx.com/api/wellbeing'), env });
  assert.equal(get.status, 401);
  assert.equal(touched, false);
});

test('buildBody：每条最多 900 秒，余量留下次；不足 1 秒不发', () => {
  const { body, rest } = buildBody({ d: '2026-10-17', s: {
    home: { t: '', sec: 1000.5 },
    files: { t: '', sec: 0.4 },
    'book:a': { t: '三体', sec: 61.9 },
  } });
  const b = JSON.parse(body);
  assert.deepEqual(b, { d: '2026-10-17', s: [{ k: 'home', sec: 900 }, { k: 'book:a', sec: 61, t: '三体' }] });
  assert.ok(Math.abs(rest.s.home.sec - 100.5) < 1e-9);
  assert.ok(Math.abs(rest.s.files.sec - 0.4) < 1e-9);
  assert.ok(Math.abs(rest.s['book:a'].sec - 0.9) < 1e-9);
  assert.equal(buildBody({ d: '2026-10-17', s: { home: { t: '', sec: 0.2 } } }).body, '');
});

test('localDay：本机日期补零', () => {
  assert.equal(localDay(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('wbAreaOf：主站页面映射', () => {
  assert.equal(wbAreaOf('/'), 'home');
  assert.equal(wbAreaOf('/en/'), 'home');
  assert.equal(wbAreaOf('/files/'), 'files');
  assert.equal(wbAreaOf('/en/browser/'), 'browser');
  assert.equal(wbAreaOf('/bookmarks/'), null); /* 2026-10-21 主站书签下线 */
  assert.equal(wbAreaOf('/en/search/'), 'browser');
  assert.equal(wbAreaOf('/settings/theme/'), 'settings');
  assert.equal(wbAreaOf('/account/'), 'settings'); /* 账号页挪到 /account/，时长仍记在设置 */
  assert.equal(wbAreaOf('/en/account/devices/'), 'settings');
  assert.equal(wbAreaOf('/app-verify/'), null);
  assert.equal(wbAreaOf('/404.html'), null);
});

test('fmtDur：中英文时长', () => {
  assert.equal(fmtDur(30, false), '不到 1 分钟');
  assert.equal(fmtDur(65 * 60, false), '1 小时 5 分钟');
  assert.equal(fmtDur(120 * 60, false), '2 小时');
  assert.equal(fmtDur(5 * 60, true), '5 min');
  assert.equal(fmtDur(150 * 60, true, true), '2 hrs 30 min');
});
