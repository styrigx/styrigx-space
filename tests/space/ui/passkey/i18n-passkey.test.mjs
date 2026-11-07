/**
 * B1-2 i18n key 测试：pkCancelled/pkTimeout/pkNoKey/pkFailed 在 zh 和 en 里都存在且非空。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { jsDict } from '../../../fixtures/strings.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const baseofHtml = readFileSync(join(root, 'space/web/layouts/_default/baseof.html'), 'utf8');
/* 语言包化（2026-11-07）：$coreI18n 来自主站字符串表 js.core */
const core = jsDict('core');

const keys = ['pkCancelled', 'pkTimeout', 'pkNoKey', 'pkFailed'];

test('baseof.html 的 $coreI18n 取字符串表 js.core', () => {
  assert.match(baseofHtml, /\{\{ \$coreI18n := \$tr\.js\.core \}\}/);
});

for (const key of keys) {
  test(`${key} 有 zh 文案且非空`, () => {
    assert.ok(core[key] && core[key].zh, `${key} 缺少 zh`);
  });
  test(`${key} 有 en 文案且非空`, () => {
    assert.ok(core[key] && core[key].en, `${key} 缺少 en`);
  });
}
