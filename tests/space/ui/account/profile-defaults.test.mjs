/**
 * 个人资料的默认值回退（2026-11-08 修，Gray 截图：子站上账号下拉头部大字是写死的 Styrigx、个人资料层四项「未填写」）：
 * - lib/profile.js cleanProfile / effectiveProfile：空串（含只有空白）当没设置，回退站点默认值（data/profile.yaml）
 * - 四站都输出 #sgx-profile-default（以前只有主站 baseof）：主站 / 奇趣 / 日刻 baseof、博客 topnav 都用 partials/sgx-profile-default.html
 * - shell/account/term.js 头部不再写死 'Styrigx' 回退
 * 运行：node --test tests/space/ui/account/profile-defaults.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL('../../../../' + p, import.meta.url), 'utf8');
const P = await import('../../../../space/web/assets/js/lib/profile.js');

const DEF = { name: 'Sloan Gray', nickname: 'Styrigx', motto: 'To understand the world', email: 'me@styrigx.com' };

test('空串 / 只有空白 → 当没设置，回退默认值（四个字段都一样，含非必填的签名）', () => {
  assert.deepEqual(P.cleanProfile({ name: '', nickname: '  ', motto: '', email: '' }), {});
  assert.deepEqual(P.effectiveProfile({ name: '', nickname: '', motto: '', email: '' }, DEF), DEF);
  assert.deepEqual(P.effectiveProfile({ motto: ' ' }, DEF), DEF);
});

test('null / 缺字段 → 默认值；改过的值盖住默认值', () => {
  assert.deepEqual(P.effectiveProfile({ name: null, nickname: undefined }, DEF), DEF);
  assert.deepEqual(P.effectiveProfile({}, DEF), DEF);
  assert.deepEqual(P.effectiveProfile({ name: 'Test Name', motto: 'hi' }, DEF), Object.assign({}, DEF, { name: 'Test Name', motto: 'hi' }));
});

test('四站都输出 #sgx-profile-default（同一个片段，读 data/profile.yaml）', () => {
  const part = rd('space/web/layouts/partials/sgx-profile-default.html');
  assert.match(part, /id="sgx-profile-default"/);
  assert.match(part, /site\.Data\.profile/);
  for (const f of ['space/web/layouts/_default/baseof.html', 'space/web/layouts/curio/baseof.html', 'space/web/layouts/daymark/baseof.html', 'space/web/layouts/partials/blog/topnav.html']) {
    assert.match(rd(f), /partial "sgx-profile-default\.html"/, f);
    assert.doesNotMatch(rd(f), /<script id="sgx-profile-default"/, f + '：不再各写一份');
  }
});

test('账号下拉头部：姓名 / 昵称只取 effectiveProfile 的结果，不写死 Styrigx 回退', () => {
  const term = rd('space/web/assets/js/shell/account/term.js');
  assert.doesNotMatch(term, /p\.name \|\| 'Styrigx'|p\.nickname \|\| 'Styrigx'/);
  assert.match(term, /esc\(p\.name\)/);
});
