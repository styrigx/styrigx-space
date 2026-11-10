/**
 * 一个终端（v5 S5 终端合一，term-design-v5）：原 tty1 / tty3 / tty5 的表和宿主没有了，只剩全站终端（shell/terminal.js）+ 两层上下文；
 * S9：账号卡片（头像，shell/account/window.js）只展示，没有自己的命令行 / 补全表 / 历史了。
 * - reset 层（钥匙 sudo styrigx reset）的补全表和分发一致；help 换成 man
 * - 历史：落盘键、草稿、只在内存
 * - 宿主：全站终端一份历史 sgx-term-hist；没有 index-tty* / space/entry.js / shield.js / term.js
 * 运行：node --test tests/space/ui/shell/term-one.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { completerOf } from '../../../../space/web/assets/js/shell/term/core/complete.js';
import { createHistory } from '../../../../space/web/assets/js/shell/term/core/history.js';
import { RESET_TABLE, parseResetCmd } from '../../../../space/web/assets/js/shell/space/commands.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SHELL = path.join(REPO, 'space/web/assets/js/shell');
const rd = (f) => readFileSync(path.join(SHELL, f), 'utf8');

test('钥匙 reset 层：补全只补 reset 里的命令；passkey a → passkey add；补出来的每条分发都认得；help 换成 man', () => {
  const r = completerOf(RESET_TABLE);
  assert.deepEqual(r('passkey a'), { line: 'passkey add', options: [] });
  assert.deepEqual(r('pass'), { line: 'pass', options: ['passwd', 'passkey'] });
  assert.deepEqual(r('l'), { line: 'l', options: [] }, 'lock / ls 不在 reset 补全里');
  for (const n of RESET_TABLE.names) assert.notEqual(parseResetCmd(n === 'passkey' ? 'passkey ls' : n).cmd, 'unknown', n);
  assert.equal(parseResetCmd('help').cmd, 'unknown');
  assert.deepEqual(parseResetCmd('passkey rm 2'), { cmd: 'passkey-rm', arg: '2' });
});

test('历史：落盘键、草稿、只在内存', () => {
  const m = new Map();
  const st = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) };
  const h = createHistory({ storage: st, key: 'sgx-term-hist' });
  h.push('lock'); h.push('lock'); h.push('man');
  assert.deepEqual(JSON.parse(m.get('sgx-term-hist')), ['lock', 'man']);
  assert.equal(h.prev('dra'), 'man');
  assert.equal(h.prev(''), 'lock');
  assert.equal(h.next(), 'man');
  assert.equal(h.next(), 'dra');
  const mem = createHistory();
  mem.push('man');
  assert.deepEqual(mem.list(), ['man']);
  assert.equal(m.size, 1);
});

test('宿主：只剩全站终端（一份历史 sgx-term-hist）；tty1 / tty3 / tty5 的表和宿主删了；S9 账号卡片没有自己的历史', () => {
  for (const f of ['term/cmds/index-tty1.js', 'term/cmds/index-tty2.js', 'term/cmds/index-tty3.js', 'term/cmds/index-tty5.js', 'space/entry.js', 'space/shield.js', 'space/term.js', 'space/tempkeys.js', 'account/term.js']) {
    assert.ok(!existsSync(path.join(SHELL, f)), f + ' 删了');
  }
  assert.match(rd('terminal.js'), /const HIST_KEY = 'sgx-term-hist';/);
  assert.doesNotMatch(rd('account/window.js'), /histKey|createInputLine/);
  assert.doesNotMatch(rd('space/layer.js'), /histKey/, '钥匙层没有自己的输入行 / 历史');
  assert.doesNotMatch(rd('account/cmd/layer.js'), /histKey|createInputLine/, '终端里的账号层没有自己的输入行 / 历史');
});

test('两层上下文共用终端的输入行（layer-ctx.js）：输入行状态落在原型上，其余各管各', async () => {
  const { layerCtx } = await import('../../../../space/web/assets/js/shell/term/view/layer-ctx.js');
  const line = { mode: 'cmd', onSecret: null, out: () => 'out' };
  const a = layerCtx(line, { t: 'a' });
  const b = layerCtx(line, { t: 'b' });
  a.mode = 'pw';
  assert.equal(line.mode, 'pw');
  assert.equal(b.mode, 'pw');
  a.reauthExp = 5;
  assert.equal(b.reauthExp, undefined);
  assert.equal(a.t + b.t, 'ab');
  assert.equal(a.out(), 'out');
});
