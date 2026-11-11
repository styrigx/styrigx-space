/**
 * 2026-11-09 页末结束标记（feat/wild-eof；2026-11-12 起在状态页 /status/ 和 /zh/status/，旷野删除）：页末「› more soon_」下面一行「-- EOF --」，
 * 用博客列表同一个 .sgx-eof 终端文字样式；装饰（aria-hidden、translate=no）。
 * 有 public/（跑过 hugo）时也验真实构建。运行：node --test tests/space/ui/space/status-eof.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const rd = (p) => readFileSync(new URL('../../../../' + p, import.meta.url), 'utf8');

test('status.html：more soon 之后紧跟 -- EOF --（.sgx-eof，读屏不念）', () => {
  const s = rd('space/web/layouts/_default/status.html');
  const more = s.indexOf('› more soon');
  const eof = s.indexOf('<p class="sgx-eof status-eof-end" data-status-eof aria-hidden="true" translate="no">-- EOF --</p>');
  assert.ok(more > 0, 'more soon 还在');
  assert.ok(eof > more, 'EOF 在 more soon 后面');
  assert.ok(eof < s.indexOf('</div>', more), 'EOF 在 .status-wrap 里');
});

test('input.css：EOF 用 .sgx-eof 的终端文字样式，只收上边距', () => {
  const s = rd('space/web/assets/css/input.css');
  assert.match(s, /\.sgx-eof \{ margin: 28px 0 0; font-family: var\(--sgx-font-mono\);/);
  assert.match(s, /\.sgx-eof\.status-eof-end \{ margin-top: 6px; \}/);
});

for (const p of ['space/web/public/status/index.html', 'space/web/public/zh/status/index.html']) {
  test(`真实构建 ${p}：页末有 -- EOF --`, { skip: !existsSync(new URL('../../../../' + p, import.meta.url)) }, () => {
    const h = rd(p);
    assert.match(h, /data-status-eof[^>]*>-- EOF --<\/p>/);
  });
}
