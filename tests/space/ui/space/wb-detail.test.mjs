/**
 * P2-2：旷野 · 屏幕时间的根卡（原数字健康页，对齐 PR-B 起在 /wild/#screen-time）按 /api/wellbeing 的 detail 显示（lib/wb-view.js wbFits），不再看旧等级标记。
 * - 带 data-wb-detail 的容器：detail:true 才画服务端数据，否则保持本机记录
 * - 不带的（首页小组件）：照画区域合计
 * 运行：node --test tests/space/ui/space/wb-detail.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wbFits } from '../../../../space/web/assets/js/lib/wb-view.js';

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

test('模板和脚本：根卡带 data-wb-detail；space.js 不再按旧等级标记去掉 data-wb-root', () => {
  /* 对齐 PR-B：数字健康并进旷野页 #screen-time（_default/wild.html），主页 [04] 小卡不带 data-wb-detail（区域合计照画） */
  const tpl = readFileSync(new URL('../../../../space/web/layouts/_default/wild.html', import.meta.url), 'utf8');
  assert.match(tpl, /id="wb-card" data-wb-root data-wb-detail/);
  const home = readFileSync(new URL('../../../../space/web/layouts/index.html', import.meta.url), 'utf8');
  const mini = (home.match(/<a [^>]*id="w-screen"[^>]*>/) || [''])[0];
  assert.match(mini, /data-wb-root/);
  assert.doesNotMatch(mini, /data-wb-detail/);
  const js = readFileSync(new URL('../../../../space/web/assets/js/apps/space.js', import.meta.url), 'utf8');
  assert.doesNotMatch(js, /getAttribute\('data-sgx-role'\)/); // old-name guard
});
