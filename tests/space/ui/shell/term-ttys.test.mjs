/**
 * 终端统一 T4（设计稿 v1.5 §2.3 / §5 / §6）：tty1 / tty3 / tty5 的 Tab 补全表、历史键；锁屏只带白名单（不 import fs / ui / account / sub 命令和别的 tty 的表）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { completerOf } from '../../../../space/web/assets/js/shell/term/core/complete.js';
import { createHistory } from '../../../../space/web/assets/js/shell/term/core/history.js';
import { TTY1_TABLE, TTY1_RESET_TABLE } from '../../../../space/web/assets/js/shell/term/cmds/index-tty1.js';
import { TTY3_TABLE } from '../../../../space/web/assets/js/shell/term/cmds/index-tty3.js';
import { TTY5_TABLE } from '../../../../space/web/assets/js/shell/term/cmds/index-tty5.js';
import { parseEntryCmd, parseResetCmd, parseShieldCmd } from '../../../../space/web/assets/js/shell/space/commands.js';
import { parseCmd } from '../../../../space/web/assets/js/shell/account/commands.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SHELL = path.join(REPO, 'space/web/assets/js/shell');

test('tty1 补全：只补白名单；sudo s → sudo styrigx；reset 层 passkey a → passkey add', () => {
  const c = completerOf(TTY1_TABLE);
  assert.deepEqual(c('su'), { line: 'sudo ', options: [] });
  assert.deepEqual(c('sudo s'), { line: 'sudo styrigx', options: [] });
  assert.deepEqual(c('l'), { line: 'l', options: [] }, 'lock / ls 不在锁屏补全里');
  assert.deepEqual(c('c'), { line: 'clear', options: [] });
  const r = completerOf(TTY1_RESET_TABLE);
  assert.deepEqual(r('passkey a'), { line: 'passkey add', options: [] });
  assert.deepEqual(r('pass'), { line: 'pass', options: ['passwd', 'passkey'] });
});

test('tty3 / tty5 补全', () => {
  assert.deepEqual(completerOf(TTY3_TABLE)('lo'), { line: 'lock', options: [] });
  const a = completerOf(TTY5_TABLE);
  assert.deepEqual(a('sudo r'), { line: 'sudo root', options: [] });
  assert.deepEqual(a('cd s'), { line: 'cd security', options: [] });
  assert.deepEqual(a('l'), { line: 'login', options: [] });
});

test('补全出来的每条命令名分发都认得（表和 parse*Cmd 一致）', () => {
  for (const n of TTY1_TABLE.names) assert.notEqual(parseEntryCmd(n === 'sudo' ? 'sudo styrigx' : n).cmd, 'unknown', 'tty1 ' + n);
  for (const n of TTY1_RESET_TABLE.names) assert.notEqual(parseResetCmd(n === 'passkey' ? 'passkey ls' : n).cmd, 'unknown', 'reset ' + n);
  for (const n of TTY3_TABLE.names) assert.notEqual(parseShieldCmd(n === 'sudo' ? 'sudo styrigx reauth' : n === 'passkey' ? 'passkey add' : n).cmd, 'unknown', 'tty3 ' + n);
  for (const n of TTY5_TABLE.names) assert.notEqual(parseCmd(n === 'sudo' ? 'sudo root' : n === 'passkey' ? 'passkey add' : n === 'cd' ? 'cd' : n).cmd, 'unknown', 'tty5 ' + n);
});

test('历史：落盘键、草稿、只在内存', () => {
  const m = new Map();
  const st = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) };
  const h = createHistory({ storage: st, key: 'sgx-term-hist-3' });
  h.push('lock'); h.push('lock'); h.push('help');
  assert.deepEqual(JSON.parse(m.get('sgx-term-hist-3')), ['lock', 'help']);
  assert.equal(h.prev('dra'), 'help');
  assert.equal(h.prev(''), 'lock');
  assert.equal(h.next(), 'help');
  assert.equal(h.next(), 'dra');
  const mem = createHistory();
  mem.push('help');
  assert.deepEqual(mem.list(), ['help']);
  assert.equal(m.size, 1);
});

test('宿主接上：锁屏无 histKey（只在内存）、盾牌 sgx-term-hist-3、账号 sgx-term-hist-5', () => {
  const rd = (f) => readFileSync(path.join(SHELL, f), 'utf8');
  assert.doesNotMatch(rd('space/entry.js'), /histKey/);
  assert.match(rd('space/entry.js'), /complete: function \(line\)/);
  assert.match(rd('space/shield.js'), /histKey: 'sgx-term-hist-3'/);
  assert.match(rd('account/term.js'), /histKey: 'sgx-term-hist-5'/);
});

/** 一个文件静态 import 到的所有文件（相对路径，递归） */
function graph(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of code.matchAll(/^\s*import\s[^;]*?from\s+'(\.[^']+)';/gm)) graph(path.resolve(path.dirname(file), m[1]), seen);
  return seen;
}

test('锁屏（tty1）只带白名单：静态 import 图里没有 term/cmds 下 fs / ui / base / account / sub，也没有别的 tty 的表', () => {
  const g = [...graph(path.join(SHELL, 'space/entry.js'))].map((f) => path.relative(SHELL, f));
  const bad = g.filter((f) => /^term\/cmds\/(fs|ui|base|account|sub)\//.test(f) || /^term\/cmds\/index-tty[2-5]\.js$/.test(f));
  assert.deepEqual(bad, []);
  assert.ok(g.includes('term/cmds/index-tty1.js'));
});
