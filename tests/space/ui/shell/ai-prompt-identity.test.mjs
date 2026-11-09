/**
 * 2026-11-09 AI 窗口提示符身份（fix/ai-prompt-identity）：用户那一行 = 提问者提示符 + --ask，回答前一行 = grayai 提示符 + --reply；
 * 没登录 styrigx@space:~$ / grayai@space:~$，已登录 root@account:~# / grayai@account:~#；原来的「gray --reply」里的 gray 去掉。只改文字，样式不变。
 * 运行：node --test tests/space/ui/shell/ai-prompt-identity.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (p) => readFileSync(path.join(REPO, p), 'utf8');

/** @param {string} s @param {string} sel @returns {string} */
function contentOf(s, sel) {
  const i = s.indexOf(sel + ' {');
  assert.ok(i >= 0, sel);
  const body = s.slice(i, s.indexOf('}', i));
  const m = body.match(/content: "([^"]*)" \/ "";/);
  assert.ok(m, sel + ' 带读屏空替代的 content');
  return m[1];
}

for (const f of ['space/web/assets/css/input.css', 'space/web/assets/css/shell/shell.css']) {
  test(`${f}：AI 窗口提示符 --ask / grayai … --reply（登录前后两套）`, () => {
    const s = read(f);
    assert.equal(contentOf(s, '.sgx-ai-msg[data-role="user"]::before'), 'styrigx@space:~$ --ask');
    assert.equal(contentOf(s, 'html[data-sgx-account-session="in"] .sgx-ai-msg[data-role="user"]::before'), 'root@account:~# --ask');
    assert.equal(contentOf(s, '.sgx-ai-msg[data-role="assistant"]::before'), 'grayai@space:~$ --reply');
    assert.equal(contentOf(s, 'html[data-sgx-account-session="in"] .sgx-ai-msg[data-role="assistant"]::before'), 'grayai@account:~# --reply');
    assert.doesNotMatch(s, /gray --reply/);
  });
}
