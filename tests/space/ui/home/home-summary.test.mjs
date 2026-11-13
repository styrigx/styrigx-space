/**
 * 2026-11 对齐 PR-B（设计稿 tb4.html）：主页的纯函数（[04] 旷野小卡 2026-11-12 删除，statusSummary 只给首屏状态胶囊用）。
 * （lib/wb-view.js 的 fmtShort / charBar / termRows / renderWbTerm 用例 v6 P4 随数字健康整套删除，定稿 v5.5 §四）
 * - apps/index.js：curioSummary（[02] 奇趣三个目录卡的计数和那一条）、statusSummary（外壳六格状态的摘要：up/n、平均延迟、检查时间；首屏胶囊用 up/n）
 * 运行：node --test tests/space/ui/home/home-summary.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installI18nDom } from '../../../fixtures/i18n-dom.mjs';

installI18nDom('zh');
const { curioSummary, statusSummary } = await import('../../../../space/web/assets/common/js/apps/index.js');

test('curioSummary：finds = 全部链接数 + id 最大的那条（按语言取名，缺了回退 / 域名）；devices 在用 = 第一台没退役；games 在玩 = 第一个 playing', () => {
  const links = { ok: true, cats: [
    { links: [{ id: 3, name: { zh: '三', en: 'Three' }, url: 'https://a.com' }, { id: 9, name: { en: 'Nine' }, url: 'https://b.com' }] },
    { links: [{ id: 5, name: '', url: 'https://c.example.org/x' }, null] },
    null,
  ] };
  const items = { ok: true,
    devices: [{ name: 'Old', retired_at: '2024-01-01' }, { name: 'Galaxy S26', retired_at: null }, { name: 'Tab' }],
    games: [{ title: 'Zelda', status: 'done' }, { title: 'Hades II', status: 'playing' }] };
  const zh = curioSummary(links, items, 'zh');
  assert.deepEqual(zh.finds, { n: 3, latest: 'Nine' }, '缺中文回退英文');
  assert.deepEqual(zh.devices, { n: 3, latest: 'Galaxy S26' });
  assert.deepEqual(zh.games, { n: 2, latest: 'Hades II' });
  assert.deepEqual(curioSummary({ ok: true, cats: [{ links: [{ id: 1, name: null, url: 'https://c.example.org/x' }] }] }, null, 'en').finds, { n: 1, latest: 'c.example.org' }, '没名字用域名');
  assert.deepEqual(curioSummary({ ok: true, cats: [{ links: [{ id: 1, url: 'not a url' }] }] }, null, 'en').finds, { n: 1, latest: '' });
});

test('curioSummary：取不到 / ok:false → 对应项 null；空列表 → n 0 且那一条为空', () => {
  assert.deepEqual(curioSummary(null, null, 'zh'), { finds: null, devices: null, games: null });
  assert.deepEqual(curioSummary({ ok: false }, { ok: false }, 'zh'), { finds: null, devices: null, games: null });
  assert.deepEqual(curioSummary({ ok: true, cats: [] }, { ok: true }, 'en'), { finds: { n: 0, latest: '' }, devices: { n: 0, latest: '' }, games: { n: 0, latest: '' } });
  const all = curioSummary(null, { ok: true, devices: [{ name: 'A', retired_at: 'x' }], games: [{ title: 'B', status: 'done' }] }, 'en');
  assert.deepEqual([all.devices, all.games], [{ n: 1, latest: '' }, { n: 1, latest: '' }], '全退役 / 没在玩 → 那一条为空');
});

test('statusSummary：up / n、有数格子的平均延迟（四舍五入）、检查时间按北京时间 HH:MM', () => {
  const t = Date.parse('2026-11-08T04:05:00Z'); /* 北京 12:05 */
  const v = { t, cells: { space: { up: true, ms: 100 }, blog: { up: true, ms: 101 }, ai: { up: false, ms: null }, auth: { up: true, ms: 50 } } };
  assert.deepEqual(statusSummary(v), { up: 3, n: 4, avg: 84, at: '12:05' });
  const late = Date.parse('2026-11-08T16:30:00Z'); /* 北京次日 00:30 */
  assert.equal(statusSummary({ t: late, cells: {} }).at, '00:30');
  assert.deepEqual(statusSummary({ t: 0, cells: { a: { up: false, ms: null } } }), { up: 0, n: 1, avg: null, at: '' });
  assert.deepEqual(statusSummary(/** @type {any} */ (null)), { up: 0, n: 0, avg: null, at: '' });
});
