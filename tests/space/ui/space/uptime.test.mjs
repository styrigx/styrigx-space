/**
 * 主页首屏 neofetch Uptime（Gray 2026-11-09：自 2026-10-07 起算，北京时间整天）。lib/uptime.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uptimeDays, uptimeText } from '../../../../space/web/assets/shell/js/status/uptime.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

test('按北京时间数整天：2026-10-07 当天 0 天，次日 0 点 1 天', () => {
  assert.equal(uptimeDays('2026-10-07', Date.parse('2026-10-07T00:00:00+08:00')), 0);
  assert.equal(uptimeDays('2026-10-07', Date.parse('2026-10-07T23:59:59+08:00')), 0);
  assert.equal(uptimeDays('2026-10-07', Date.parse('2026-10-08T00:00:00+08:00')), 1);
  assert.equal(uptimeDays('2026-10-07', Date.parse('2026-11-09T11:45:00+08:00')), 33);
  /* UTC 的 10-07 16:30 已是北京 10-08 00:30 */
  assert.equal(uptimeDays('2026-10-07', Date.parse('2026-10-07T16:30:00Z')), 1);
});

test('写错 / 未来 → 0；单复数', () => {
  assert.equal(uptimeDays('', Date.now()), 0);
  assert.equal(uptimeDays('2026/10/07', Date.now()), 0);
  assert.equal(uptimeDays('2099-01-01', Date.parse('2026-11-09T00:00:00Z')), 0);
  assert.equal(uptimeText(1), '1 day');
  assert.equal(uptimeText(33), '33 days');
  assert.equal(uptimeText(0), '0 days');
});

test('主页首屏 neofetch（v5 S7，原旷野页 about 卡）有 Uptime 行，起点 2026-10-07；状态页没有 about 卡', () => {
  assert.doesNotMatch(readFileSync(path.join(REPO, 'space/web/layouts/_default/status.html'), 'utf8'), /id="about"|data-about=/, '状态页没有 about 卡');
  const src = readFileSync(path.join(REPO, 'space/web/layouts/index.html'), 'utf8');
  assert.match(src, /\$since := "2026-10-07"/);
  assert.match(src, /<dt title="\{\{ \$W\.uptime \}\}">Uptime<\/dt><dd data-about="uptime" data-since="\{\{ \$since \}\}">/);
});
