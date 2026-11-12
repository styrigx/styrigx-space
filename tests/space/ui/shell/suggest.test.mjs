/**
 * 打错命令时给最近的真命令（Gray 2026-11-09）：space/web/assets/shell/js/shell/suggest.js，以及 shell/terminal.js 里抄的那一份。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { lev, suggest } from '../../../../space/web/assets/shell/js/shell/suggest.js';
import { createShell } from '../../../../space/web/assets/shell/js/shell/terminal.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (p) => readFileSync(path.join(REPO, p), 'utf8');

test('Levenshtein', () => {
  assert.equal(lev('', 'abc'), 3);
  assert.equal(lev('help', 'hepl'), 2);
  assert.equal(lev('kitten', 'sitting'), 3);
  assert.equal(lev('lock', 'lock'), 0);
});

test('最近的真命令：整行 / 第一个词；太远不猜', () => {
  const entry = ['help', 'man styrigx', 'clear', 'sudo styrigx', 'sudo styrigx reset'];
  assert.equal(suggest('hepl', entry), 'help');
  assert.equal(suggest('sudo stryigx', entry), 'sudo styrigx');
  assert.equal(suggest('sudo styrigx rest', entry), 'sudo styrigx reset');
  assert.equal(suggest('clera', entry), 'clear');
  assert.equal(suggest('whoami', entry), '');
  assert.equal(suggest('ls', ['help', 'lock']), '');
  assert.equal(suggest('', entry), '');
  assert.equal(suggest('lokc now', ['help', 'lock']), 'lock');
});

test('站内终端：hsitory → did you mean history（同一份算法）；不像就照旧 command not found · try man', () => {
  const act = { cd: () => null, sudo: () => ({}), theme: () => {}, lock: () => {}, ask: () => {}, today: () => Promise.resolve(null), daymarkHref: () => '/daymark/' };
  const sh = createShell({ act, storage: null });
  const txt = (o) => o.seg.map((s) => s[1]).join('');
  assert.equal(txt(sh.exec('hsitory').out[0]), 'command not found: hsitory — did you mean history?');
  assert.equal(sh.exec('hsitory').out[0].cls, 'err');
  /* v5 S5：help 删了（man 取代）；不像就照旧 · try man */
  assert.equal(txt(sh.exec('xyzzy').out[0]), 'command not found: xyzzy · try man');
  /* 终端统一 T1：只有一份实现（shell/term/core/suggest.js）；terminal.js 不再抄，shell/suggest.js 只转出 */
  const src = read('space/web/assets/shell/js/shell/terminal.js');
  assert.match(read('space/web/assets/shell/js/shell/term/core/engine.js'), /^import \{ suggest \} from '\.\/suggest\.js';$/m, '站内终端的引擎用公共件（T3）');
  assert.doesNotMatch(src, /function (lev|suggest)\(/, 'terminal.js 不再抄 lev / suggest');
  assert.match(read('space/web/assets/shell/js/shell/suggest.js'), /export \{ lev, suggest \} from '\.\/term\/core\/suggest\.js';/);
});

test('文案：term 有 didYouMean（en / zh）；space 节只剩输入行五句（P4-2）；锁屏 / 盾牌接上（S9：账号卡片没有命令行，account.common.didYouMean 删了）', () => {
  for (const l of ['en', 'zh']) {
    const y = yaml.load(read(`space/web/data/sgx-shell-i18n/${l}.yaml`));
    assert.match(y.term.didYouMean, /command not found: \{c\} — .*\{x\}/);
    assert.equal(y.space.common.didYouMean, undefined);
    assert.equal(y.account.common.didYouMean, undefined);
  }
  /* v5 S5：一个终端（引擎 engine.js 给 did you mean）；v6 P4 起钥匙的 reset 层删了 */
  for (const f of ['space/web/assets/shell/js/shell/term/core/engine.js']) assert.match(read(f), /notFoundLine\(|suggest\(/, f);
});
