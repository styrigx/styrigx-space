/**
 * 代理订阅 sub v3.1：账号终端 sub 指令的解析和参数检查（shell/account/proxy.js）。
 * 运行：node --test tests/space/ui/account/proxy.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const P = await import('../../../../space/web/assets/shell/js/account/proxy.js');

test('parseSub：一条 sub + 子命令；子命令不分大小写，名字原样（来源名大小写敏感）；别的 → null', () => {
  assert.deepEqual([...P.SUB_ARGS], ['show', 'add', 'upload', 'mv', 'rm', 'enable', 'disable', 'key', 'token']);
  assert.deepEqual(P.parseSub('  SUB  MV  Linkcube  LinkCube2 '), { sub: 'mv', args: ['Linkcube', 'LinkCube2'] });
  assert.deepEqual(P.parseSub('sub'), { sub: '', args: [] });
  assert.deepEqual(P.parseSub('sub show Linkcube'), { sub: 'show', args: ['Linkcube'] });
  for (const no of ['sudo root', 'subx', 'sub-key', 'sub-link', 'sub-refresh', '']) assert.equal(P.parseSub(no), null, no);
});

test('checkSub：参数个数、名字格式在一处查；sub-refresh 没了，refresh / link 不是子命令', () => {
  const c = (l) => P.checkSub(P.parseSub(l));
  for (const ok of ['sub', 'sub show', 'sub show A', 'sub add A', 'sub upload F', 'sub mv A B', 'sub rm A', 'sub enable A', 'sub disable A', 'sub key', 'sub token reset', 'sub TOKEN Reset']) assert.equal(c(ok), null, ok);
  assert.deepEqual(c('sub show A B'), { usage: 'sub show [name]' });
  assert.deepEqual(c('sub add'), { usage: 'sub add <name>' });
  assert.deepEqual(c('sub mv A'), { usage: 'sub mv <old> <new>' });
  /* S9：sub token → sub token reset（同 sudo root reset）；单 sub token 给用法；on / off → enable / disable，旧名没有兼容 */
  assert.deepEqual(c('sub token'), { usage: 'sub token reset' });
  assert.deepEqual(c('sub token now'), { usage: 'sub token reset' });
  assert.deepEqual(c('sub token reset x'), { usage: 'sub token reset' });
  for (const gone of ['sub on A', 'sub off A']) assert.match(c(gone).usage, /sub enable <name> \| sub disable <name>/, gone);
  assert.deepEqual(c('sub key x'), { usage: 'sub key' });
  assert.deepEqual(c('sub add a/b'), { badName: true });
  for (const gone of ['sub refresh', 'sub link', 'sub url']) assert.match(c(gone).usage, /^sub show \[name\] \| sub add <name> \|/, gone);
});

test('名称 / 公钥格式（同服务端）', () => {
  for (const ok of ['A', 'Linkcube', 'a_b-1', 'x'.repeat(32)]) assert.ok(P.NAME_RE.test(ok), ok);
  for (const bad of ['', 'has space', 'a/b', 'x'.repeat(33), '中文']) assert.ok(!P.NAME_RE.test(bad), bad);
  assert.ok(P.AGE_RE.test('age1' + 'q'.repeat(58)));
  assert.ok(!P.AGE_RE.test('age1pq1' + 'q'.repeat(55) + 'x'));
  assert.ok(!P.AGE_RE.test('AGE-SECRET-KEY-1' + 'Q'.repeat(58)));
  assert.equal(P.USAGE.mv, 'sub mv <old> <new>');
});
