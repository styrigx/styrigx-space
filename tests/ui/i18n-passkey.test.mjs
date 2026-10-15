/**
 * B1-2 i18n key 测试：pkCancelled/pkTimeout/pkNoKey/pkFailed 在 zh 和 en 里都存在且非空。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const baseofHtml = readFileSync(join(root, 'layouts/_default/baseof.html'), 'utf8');

const keys = ['pkCancelled', 'pkTimeout', 'pkNoKey', 'pkFailed'];

for (const key of keys) {
  test(`${key} 在 baseof.html 的 $coreI18n 里存在`, () => {
    assert.ok(baseofHtml.includes(`"${key}"`), `${key} 不存在`);
  });
  
  test(`${key} 有 zh 文案且非空`, () => {
    const re = new RegExp(`"${key}" \\(dict "zh" "([^"]+)"`);
    const m = baseofHtml.match(re);
    assert.ok(m, `${key} 缺少 zh`);
    assert.ok(m[1].length > 0, `${key} 的 zh 为空`);
  });
  
  test(`${key} 有 en 文案且非空`, () => {
    const re = new RegExp(`"${key}" \\(dict "zh" "[^"]+" "en" "([^"]+)"`);
    const m = baseofHtml.match(re);
    assert.ok(m, `${key} 缺少 en`);
    assert.ok(m[1].length > 0, `${key} 的 en 为空`);
  });
}
