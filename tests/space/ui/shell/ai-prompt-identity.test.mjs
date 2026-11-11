/**
 * 2026-11-09 AI 窗口提示符身份（fix/ai-prompt-identity）：用户那一行 = 提问者提示符 + --ask，回答前一行 = grayai 提示符 + --reply；
 * 没登录 styrigx@space:~$ / grayai@space:~$，已登录 root@account:~# / grayai@account:~#；原来的「gray --reply」里的 gray 去掉。只改文字，样式不变。
 * 2026-11-09 fix/ai-greet-prompt：空态欢迎语（data-greet）的回显也改成 grayai … --reply（原 styrigx@space:~$ ask --help / root@account:~# ask --help）。
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
  test(`${f}：空态欢迎语是 AI 说的话 → 回显 grayai … --reply（与普通回答行一致），不再是提问者的 ask --help`, () => {
    const s = read(f);
    assert.equal(contentOf(s, '.sgx-ai-msg[data-greet]::before'), 'grayai@space:~$ --reply');
    assert.equal(contentOf(s, 'html[data-sgx-account-session="in"] .sgx-ai-msg[data-greet]::before'), 'grayai@account:~# --reply');
    assert.equal(contentOf(s, '.sgx-ai-msg[data-greet]::before'), contentOf(s, '.sgx-ai-msg[data-role="assistant"]::before'));
    assert.equal(contentOf(s, 'html[data-sgx-account-session="in"] .sgx-ai-msg[data-greet]::before'),
      contentOf(s, 'html[data-sgx-account-session="in"] .sgx-ai-msg[data-role="assistant"]::before'));
    assert.doesNotMatch(s, /content: "[^"]*ask --help/);
  });
}

test('v6 P4：<html data-sgx-account-session> 不再读旧标记 sgx-account-signed-in；首帧 out，whoami 说 root（u:root）才 in', () => {
  const lm = read('space/web/assets/js/lib/layout-mode.js');
  assert.doesNotMatch(lm, /\.test\(document\.cookie[^)]*\)\?'in'/, '首帧不按 cookie 判 in');
  assert.doesNotMatch(lm, /sgx-account-signed-in=1\(/, '旧标记的正则没了');
  assert.match(lm, /setAttribute\('data-sgx-account-session','out'\)/);
  const tp = read('space/web/assets/js/shell/topbar-panel.js');
  assert.match(tp, /who\.on\(function \(\/\*\* @type \{string\} \*\/ w\) \{\n\s+try \{ doc\.documentElement\.setAttribute\('data-sgx-account-session', w === 'u:root' \? 'in' : 'out'\); \} catch \(e\) \{\}/);
});
