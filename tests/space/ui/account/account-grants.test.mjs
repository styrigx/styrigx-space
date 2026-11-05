/**
 * 应用授权前端纯函数（web/atlas/assets/js/apps/account-grants.js，P3-1）：
 * - appReturn：?return= 指向奇趣 / 日刻 → { app, ret }（回跳地址本身交给网关 safeReturn 校验）；别的一律 null（不走同意流程）
 * - filterGrants / countGrants：授权卡页的页内搜索（中英名）与过滤（全部 / 已授权 / 已取消授权）
 * - fmtGrantDate / deviceText / sensitiveText
 *
 * 运行：node --test tests/space/ui/account/account-grants.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const g = await import('../../../../web/atlas/assets/js/apps/account-grants.js');
const fx = createRequire(import.meta.url)('../../../fixtures/app-grants.cjs');

test('appReturn：只认奇趣 / 日刻的页面（站内路径或 https://styrigx.com/ 下），原样交出 ret', () => {
  assert.deepEqual(g.appReturn('/curio/'), { app: 'curio', ret: '/curio/' });
  assert.deepEqual(g.appReturn('/curio/#devices'), { app: 'curio', ret: '/curio/#devices' });
  assert.deepEqual(g.appReturn('/curio/en/?q=1'), { app: 'curio', ret: '/curio/en/?q=1' });
  assert.deepEqual(g.appReturn('/daymark'), { app: 'daymark', ret: '/daymark' });
  assert.deepEqual(g.appReturn('https://styrigx.com/daymark/#trove'), { app: 'daymark', ret: 'https://styrigx.com/daymark/#trove' });
  for (const bad of ['', '/', '/account/security/', '/curiosity/', '//evil.example/curio/', 'https://evil.example/curio/', 'https://styrigx.com.evil/curio/',
    'javascript:/curio/', '/settings/', null, undefined, 3, '/curio/' + 'x'.repeat(3000)]) {
    assert.equal(g.appReturn(bad), null, String(bad).slice(0, 40));
  }
});

test('filterGrants / countGrants：过滤 + 按名字搜（中英名、忽略大小写）', () => {
  const all = fx.grants({ curio: true });
  assert.deepEqual(g.countGrants(all), { all: 5, on: 4, off: 1 });
  assert.deepEqual(g.filterGrants(all, 'all', '').map((x) => x.app), ['curio', 'daymark', 'prefs', 'wellbeing', 'avatar']);
  assert.deepEqual(g.filterGrants(all, 'off', '').map((x) => x.app), ['curio']);
  assert.deepEqual(g.filterGrants(all, 'on', '').map((x) => x.app), ['daymark', 'prefs', 'wellbeing', 'avatar']);
  assert.deepEqual(g.filterGrants(all, 'all', '日刻').map((x) => x.app), ['daymark']);
  assert.deepEqual(g.filterGrants(all, 'all', ' SYNC ').map((x) => x.app), ['prefs']);
  assert.deepEqual(g.filterGrants(all, 'on', '奇趣'), []);
  assert.deepEqual(g.countGrants(null), { all: 0, on: 0, off: 0 });
});

test('fmtGrantDate / deviceText / sensitiveText', () => {
  assert.equal(g.fmtGrantDate(fx.AT, false), '2026年11月5日');
  assert.equal(g.fmtGrantDate(fx.AT, true), 'Nov 5, 2026');
  assert.equal(g.fmtGrantDate(0, false), '');
  const t = (k) => ({ gaDevGone: '已退出的设备', gaDevUnknown: '未知设备', gaSensitive: '{v}另要验证账号', 'gaSens-curio': '批量导入书签' })[k];
  assert.equal(g.deviceText(t, { device: { name: 'Galaxy S25 Ultra', gone: false } }), 'Galaxy S25 Ultra');
  assert.equal(g.deviceText(t, { device: { name: '', gone: false } }), '未知设备');
  assert.equal(g.deviceText(t, { device: { name: '', gone: true } }), '已退出的设备');
  assert.equal(g.deviceText(t, { device: null }), '已退出的设备');
  assert.equal(g.sensitiveText(t, { app: 'curio', sensitive: ['POST /curio/api/import'] }), '批量导入书签另要验证账号');
  assert.equal(g.sensitiveText(t, { app: 'daymark', sensitive: [] }), '');
});
