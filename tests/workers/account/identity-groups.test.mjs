/**
 * v6 组模型与集中权限判断（workers/account/src/core/groups.js）：
 * - 组、特权组、写组、styrigx 默认组钉死（定稿 §三）
 * - permits 顺序固定（P2，定稿 v4 §三）：救援 → root → 路由档；public 谁都行；访客只有 public；user = 任一已登录身份；
 *   root 只有 uid 0；owner = 站长 styrigx（root 由第 2 步放行）；组名：root 全过、普通用户要在组里；不认识的档拒绝
 * - 救援会话：只放标了 rescue 的路由，其余一律拒绝（即使是 root、即使是 public）
 * - canJoinGroup：普通用户（uid 1001 起，含临时用户；定稿 v5.5 §四）进不了 wheel / sudoers / 写组；站长不受限；root 不进组；不认识的组拒绝
 * - 档的取值不和组名重名
 *
 * 运行：node --test tests/workers/account/identity-groups.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groups as G } from './_identity.mjs';

const styrigx = { uid: 1000, name: 'styrigx', groups: [...G.STYRIGX_DEFAULT_GROUPS], rescue: false };
const alice = { uid: 1001, name: 'alice', groups: ['listen'], rescue: false };
const nobody = { uid: 1002, name: 'temp', groups: [], rescue: false };
const root = { uid: 0, name: 'root', groups: [], rescue: false };
const rescue = { uid: 0, name: 'root', groups: [], rescue: true };

test('组与默认组钉死', () => {
  assert.equal(G.ROOT_UID, 0);
  assert.equal(G.STYRIGX_UID, 1000);
  assert.equal(G.FIRST_USER_UID, 1001);
  assert.deepEqual([...G.GROUPS], ['wheel', 'sudoers', 'listen', 'ai', 'status', 'curio-write', 'daymark-write']);
  assert.deepEqual([...G.PRIVILEGED_GROUPS], ['wheel', 'sudoers']);
  assert.deepEqual([...G.WRITE_GROUPS], ['curio-write', 'daymark-write']);
  assert.deepEqual([...G.STYRIGX_DEFAULT_GROUPS], ['wheel', 'sudoers', 'listen', 'ai', 'status', 'curio-write', 'daymark-write']);
  assert.ok(Object.isFrozen(G.GROUPS) && Object.isFrozen(G.ACCESS_LEVELS));
  for (const v of Object.values(G.ACCESS)) assert.ok(!G.GROUPS.includes(v), v + ' 不许是组名');
  assert.ok(!G.GROUPS.includes('delete'), '删除不做组');
});

test('permits：public / 访客 / user / root / 组', () => {
  for (const id of [null, undefined, styrigx, alice, root]) assert.equal(G.permits(id, 'public'), true);
  for (const lv of ['user', 'root', 'ai', 'wheel']) assert.equal(G.permits(null, lv), false, '访客 ' + lv);
  assert.equal(G.permits({ uid: '1000', groups: ['ai'] }, 'ai'), false, 'uid 不是整数 = 不是身份');
  assert.equal(G.permits(nobody, 'user'), true, '无组的临时用户也是已登录身份');
  assert.equal(G.permits(nobody, 'listen'), false);
  assert.equal(G.permits(alice, 'listen'), true);
  assert.equal(G.permits(alice, 'ai'), false);
  for (const g of G.GROUPS) assert.equal(G.permits(styrigx, g), true, 'styrigx ' + g);
  assert.equal(G.permits(styrigx, 'root'), false, 'styrigx 不是 root（要 su / sudo）');
  assert.equal(G.permits(styrigx, 'owner'), true, '站长 = styrigx');
  assert.equal(G.permits(root, 'owner'), true, 'root 由第 2 步放行');
  assert.equal(G.permits(alice, 'owner'), false, '别的普通用户不是站长');
  assert.equal(G.permits({ ...alice, groups: [...G.GROUPS] }, 'owner'), false, '组再全也不是站长（按 uid，不按组）');
  assert.equal(G.permits(null, 'owner'), false);
  for (const lv of G.ACCESS_LEVELS) assert.equal(G.permits(root, lv), true, 'root ' + lv);
  for (const bad of ['entry', 'music', 'admin', '', 'ROOT', 'curio.write']) assert.equal(G.permits(root, bad), false, '不认识的档 ' + bad);
});

test('救援会话：只放 rescue 路由；不是 rescue 的路由一律拒绝（即使 root 档）', () => {
  assert.equal(G.permits(rescue, 'root'), false);
  assert.equal(G.permits(rescue, 'curio-write'), false);
  assert.equal(G.permits(rescue, 'user'), false);
  assert.equal(G.permits(rescue, 'root', { rescue: true }), true);
  assert.equal(G.permits(rescue, 'public'), false, '救援先判：public 路由不在白名单也拒（不往下走）');
  assert.equal(G.permits(rescue, 'owner'), false);
  assert.equal(G.permits(rescue, 'public', { rescue: true }), true);
  assert.equal(G.permits(root, 'root', { rescue: true }), true, '普通 root 会话不受 rescue 标记影响');
  assert.deepEqual([...G.RESCUE_COMMANDS], ['passwd', 'passkey', 'whoami', 'groups', 'exit', 'lock'], '不含换钥匙（定稿 v4 §九）');
  assert.ok(!G.RESCUE_COMMANDS.includes('recovery-key'));
  for (const c of ['useradd', 'usermod', 'userdel', 'sudo', 'su']) assert.ok(!G.RESCUE_COMMANDS.includes(c), '救援不建用户不改组 ' + c);
});

test('isTemporary：有期限 = 临时用户', () => {
  assert.equal(G.isTemporary({ expiresAt: 1 }), true);
  assert.equal(G.isTemporary({ expiresAt: 0 }), false);
  assert.equal(G.isTemporary(null), false);
});

test('canJoinGroup：普通用户（uid 1001 起）不进特权组 / 写组（有期限 → temporary，无期限 → action 找不到命令，Gray 11-11 22:36）；站长不受限；root 不进组；不认识的组拒绝', () => {
  const temp = { uid: 1001, expiresAt: Date.now() + 86400000 };
  const perm = { uid: 1001, expiresAt: 0 };
  const owner = { uid: 1000, expiresAt: 0 };
  for (const u of [temp, perm, { uid: 1042, expiresAt: 0 }]) {
    for (const g of ['wheel', 'sudoers', 'curio-write', 'daymark-write']) assert.deepEqual(G.canJoinGroup(u, g), { ok: false, reason: u.expiresAt > 0 ? 'temporary' : 'action' }, u.uid + ' ' + g);
    for (const g of ['listen', 'ai', 'status']) assert.deepEqual(G.canJoinGroup(u, g), { ok: true }, u.uid + ' ' + g);
  }
  for (const g of G.GROUPS) assert.deepEqual(G.canJoinGroup(owner, g), { ok: true }, g);
  assert.deepEqual(G.canJoinGroup({ uid: 0, expiresAt: 0 }, 'wheel'), { ok: false, reason: 'root' });
  assert.deepEqual(G.canJoinGroup(perm, 'admin'), { ok: false, reason: 'unknown-group' });
  assert.deepEqual(G.canJoinGroup(perm, 'root'), { ok: false, reason: 'unknown-group' });
});

test('用户名规则', () => {
  for (const ok of ['styrigx', 'alice', 'a1', 'guest-2026']) assert.match(ok, G.USER_NAME_RE);
  for (const bad of ['', 'A', 'Alice', '1abc', 'a', 'a_b', 'a'.repeat(33), 'root ']) assert.doesNotMatch(bad, G.USER_NAME_RE);
});

test('Muse v5 注意点 2：「救援 → root」只写一处——precedence() 是唯一实现，permits 与 admit 的 root 快速放行都调它', async () => {
  const { readFileSync } = await import('node:fs');
  const SRC = new URL('../../../workers/account/src/core/', import.meta.url).pathname;
  assert.equal(G.precedence(rescue, { rescue: true }), true);
  assert.equal(G.precedence(rescue, {}), false, '救援先判');
  assert.equal(G.precedence(root, {}), true);
  assert.equal(G.precedence(root, { rescue: true }), true);
  assert.equal(G.precedence(styrigx, {}), null);
  assert.equal(G.precedence(null, {}), null);
  const groupsSrc = readFileSync(SRC + 'groups.js', 'utf8');
  const permitsBody = groupsSrc.slice(groupsSrc.indexOf('export function permits('));
  assert.match(permitsBody.slice(0, permitsBody.indexOf('\n}\n')), /precedence\(id, opts\)/, 'permits 调 precedence');
  assert.doesNotMatch(permitsBody.slice(0, permitsBody.indexOf('\n}\n')), /\.rescue === true|uid === ROOT_UID/, 'permits 里不再自写救援 / root 判断');
  const admitSrc = readFileSync(SRC + 'admit.js', 'utf8');
  assert.match(admitSrc, /precedence\(identity, ropts\)/, 'admit 的 root 快速放行调同一个函数');
  assert.doesNotMatch(admitSrc, /rescue === true|uid === ROOT_UID \?|=== ROOT_UID\)\s*return/, 'admit 里没有自写的救援 / root 放行');
  /* 两条路结论一致：每种身份 × 每一档 × 救援标记 */
  for (const id of [null, styrigx, alice, nobody, root, rescue]) {
    for (const lv of G.ACCESS_LEVELS) {
      for (const rs of [false, true]) {
        const pre = G.precedence(id, { rescue: rs });
        const viaFast = pre !== null ? pre : G.permits(id, lv, { rescue: rs });
        assert.equal(viaFast, G.permits(id, lv, { rescue: rs }), JSON.stringify([id && id.name, lv, rs]));
      }
    }
  }
});
