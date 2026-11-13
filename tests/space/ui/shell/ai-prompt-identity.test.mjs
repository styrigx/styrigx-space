/**
 * 2026-11-09 AI 窗口提示符身份（fix/ai-prompt-identity）：用户那一行 = 提问者提示符 + --ask，回答前一行 = grayai 提示符 + --reply；
 * 没登录 styrigx@space:~$ / grayai@space:~$，已登录 root@account:~# / grayai@account:~#；原来的「gray --reply」里的 gray 去掉。只改文字，样式不变。
 * 2026-11-09 fix/ai-greet-prompt：空态欢迎语（data-greet）的回显也改成 grayai … --reply（原 styrigx@space:~$ ask --help / root@account:~# ask --help）。
 * 2026-11-11 Gray 22:46（定稿 §十三「AI 窗口标签改读 v6 登录状态」）：提问行谁登录显示谁，和终端提示符一致——访客 nobody@space:~$ --ask，
 * 普通用户 / 站长 <名>@space:~$ --ask，root root@space:~# --ask；回答行始终 grayai@space:~$ --reply。
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
  const m = body.match(/content: ((?:var\(--sgx-ps-user, "[^"]*"\) )?"[^"]*") \/ "";/);
  assert.ok(m, sel + ' 带读屏空替代的 content');
  return m[1].replace(/^var\(--sgx-ps-user, "([^"]*)"\) "([^"]*)"$/, '<$1>$2').replace(/^"([^"]*)"$/, '$1');
}

for (const f of ['space/web/assets/common/css/input.css', 'space/web/assets/common/css/frame.css']) {
  test(`${f}：AI 窗口提问行谁登录显示谁（访客 nobody / <名> / root #），回答行始终 grayai@space:~$ --reply`, () => {
    const s = read(f);
    assert.equal(contentOf(s, '.sgx-ai-msg[data-role="user"]::before'), 'nobody@space:~$ --ask');
    assert.equal(contentOf(s, 'html[data-sgx-account-session="out"] .sgx-ai-msg[data-role="user"]::before'), '<styrigx>@space:~$ --ask', '名字读 --sgx-ps-user（缺省 styrigx）');
    assert.equal(contentOf(s, 'html[data-sgx-account-session="in"] .sgx-ai-msg[data-role="user"]::before'), 'root@space:~# --ask');
    assert.equal(contentOf(s, '.sgx-ai-msg[data-role="assistant"]::before'), 'grayai@space:~$ --reply');
    assert.doesNotMatch(s, /\.sgx-ai-msg\[data-role="assistant"\]::before \{ content: "grayai@account/);
    assert.doesNotMatch(s, /@account:~# --/, 'root@account / grayai@account 两组删了');
    assert.doesNotMatch(s, /gray --reply/);
  });
  test(`${f}：空态欢迎语是 AI 说的话 → 回显 grayai@space:~$ --reply（与普通回答行一致），不再是提问者的 ask --help`, () => {
    const s = read(f);
    assert.equal(contentOf(s, '.sgx-ai-msg[data-greet]::before'), 'grayai@space:~$ --reply');
    assert.equal(contentOf(s, '.sgx-ai-msg[data-greet]::before'), contentOf(s, '.sgx-ai-msg[data-role="assistant"]::before'));
    assert.doesNotMatch(s, /html\[data-sgx-account-session="in"\] \.sgx-ai-msg\[data-greet\]/);
    assert.doesNotMatch(s, /content: "[^"]*ask --help/);
  });
}

test('<html data-sgx-account-session>：首帧没有登录标记 nobody、有标记 out；whoami 后访客 nobody / <名> out（名字写 --sgx-ps-user 与 .sgx-envps-u）/ root in', () => {
  const lm = read('space/web/assets/common/js/ui/layout-mode.js');
  assert.doesNotMatch(lm, /sgx-account-signed-in=1\(/, '旧标记的正则没了');
  assert.match(lm, /setAttribute\('data-sgx-account-session',\/\(\?:\^\|;\\s\*\)sgx-id=1\(\?:;\|\$\)\/\.test\(document\.cookie\|\|''\)\?'out':'nobody'\)/);
  const tp = read('space/web/assets/common/js/frame/topbar/panel.js');
  assert.match(tp, /de\.setAttribute\('data-sgx-account-session', !nm \? 'nobody' : nm === 'root' \? 'in' : 'out'\);/);
  assert.match(tp, /de\.style\.setProperty\('--sgx-ps-user', '"' \+ nm \+ '"'\);/);
  assert.match(tp, /querySelectorAll\('\.sgx-envps-u'\)/);
  assert.match(tp, /who\.on\(paintEnvPs\);\n\s+if \(who\.v6Hinted\(\)\) who\.refresh\(\)\.then\(function \(\) \{ paintEnvPs\(who\.get\(\)\); \}/);
});
