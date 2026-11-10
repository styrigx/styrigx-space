/**
 * 代理订阅 P2：账号终端 sub-* 的解析（shell/account/proxy.js）。
 * 运行：node --test tests/space/ui/account/proxy.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const P = await import('../../../../space/web/assets/js/shell/account/proxy.js');

test('parseSub：10 条命令；命令名不分大小写，参数原样（来源名大小写敏感）；别的 → null', () => {
  assert.equal(P.SUB_CMDS.length, 10);
  assert.deepEqual(P.parseSub('  SUB-MV  Linkcube  LinkCube2 '), { cmd: 'sub-mv', args: ['Linkcube', 'LinkCube2'] });
  assert.deepEqual(P.parseSub('sub'), { cmd: 'sub', args: [] });
  assert.equal(P.parseSub('sudo root'), null);
  assert.equal(P.parseSub('subx'), null);
  assert.equal(P.parseSub(''), null);
});

test('名称 / 公钥格式（同服务端）', () => {
  for (const ok of ['A', 'Linkcube', 'a_b-1', 'x'.repeat(32)]) assert.ok(P.NAME_RE.test(ok), ok);
  for (const bad of ['', 'has space', 'a/b', 'x'.repeat(33), '中文']) assert.ok(!P.NAME_RE.test(bad), bad);
  assert.ok(P.AGE_RE.test('age1' + 'q'.repeat(58)));
  assert.ok(!P.AGE_RE.test('age1pq1' + 'q'.repeat(55) + 'x'));
  assert.ok(!P.AGE_RE.test('AGE-SECRET-KEY-1' + 'Q'.repeat(58)));
  assert.equal(P.USAGE['sub-mv'], 'sub-mv <old> <new>');
});
