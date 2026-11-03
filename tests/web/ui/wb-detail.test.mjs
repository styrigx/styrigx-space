/**
 * P2-2：设置 › 数字健康的根卡按 /api/wellbeing 的 detail 显示（lib/wb-view.js wbFits），不再看 data-sgx-role。
 * - 带 data-wb-detail 的容器：detail:true 才画服务端数据，否则保持本机记录
 * - 不带的（首页小组件）：照画区域合计
 * 运行：node --test tests/web/ui/wb-detail.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wbFits } from '../../../web/atlas/assets/js/lib/wb-view.js';

const el = (attrs) => ({ hasAttribute: (n) => attrs.includes(n) });

test('wbFits：根卡（data-wb-detail）只在 detail:true 时画；首页小组件总是画', () => {
  const card = el(['data-wb-root', 'data-wb-detail']);
  const widget = el(['data-wb-root']);
  assert.equal(wbFits(card, { ok: true, detail: true }), true);
  assert.equal(wbFits(card, { ok: true, detail: false }), false);
  assert.equal(wbFits(card, { ok: true }), false, '旧形状（没有 detail）当作没明细');
  assert.equal(wbFits(widget, { ok: true, detail: false }), true);
  assert.equal(wbFits(widget, { ok: true, detail: true }), true);
});

test('模板和脚本：根卡带 data-wb-detail；settings.js 不再按 data-sgx-role 去掉 data-wb-root', () => {
  const tpl = readFileSync(new URL('../../../web/atlas/layouts/partials/setcat-wellbeing.html', import.meta.url), 'utf8');
  assert.match(tpl, /id="wb-card" data-wb-root data-wb-detail/);
  const js = readFileSync(new URL('../../../web/atlas/assets/js/apps/settings.js', import.meta.url), 'utf8');
  assert.doesNotMatch(js, /getAttribute\('data-sgx-role'\)/);
});
