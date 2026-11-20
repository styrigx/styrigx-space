/**
 * v6 组模型与集中权限判断（workers/account/src/core/groups.js）：
 * - 组：特殊组、use 组、manage 组三类，styrigx 默认组钉死（组权限重设计 v1.1 §五）；manage 包含 use（permits 第 3 步）
 * - permits 顺序固定（P2，定稿 v4 §三）：救援 → root → 路由档；public 谁都行；访客只有 public；user = 任一已登录身份；
 *   root 只有 uid 0；webmaster = 站长 styrigx（root 由第 2 步放行）；组名：root 全过、普通用户要在组里；不认识的档拒绝
 * - 救援会话：只放标了 rescue 的路由，其余一律拒绝（即使是 root、即使是 public）
 * - canJoinGroup：普通用户（uid 1001 起，含临时用户；定稿 v5.5 §四）进不了 wheel / sudoers / manage 组；站长不受限；root 不进组；不认识的组拒绝
 * - 档的取值不和组名重名
 *
 * 运行：node --test tests/workers/account/identity-groups.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groups as G } from './_identity.mjs';

const styrigx = { uid: 1000, name: 'styrigx', groups: [...G.STYRIGX_DEFAULT_GROUPS], rescue: false };
const alice = { uid: 1001, name: 'alice', groups: ['music-use'], rescue: false };
const nobody = { uid: 1002, name: 'temp', groups: [], rescue: false };
const root = { uid: 0, name: 'root', groups: [], rescue: false };
const rescue = { uid: 0, name: 'root', groups: [], rescue: true };

test('组与默认组钉死', () => {
  assert.equal(G.ROOT_UID, 0);
  assert.equal(G.STYRIGX_UID, 1000);
  assert.equal(G.FIRST_USER_UID, 1001);
  assert.deepEqual([...G.GROUPS], ['wheel', 'sudoers', 'music-use', 'curio-use', 'daymark-use', 'status-use', 'ai-use', 'music-manage', 'curio-manage', 'daymark-manage']);
  assert.deepEqual([...G.SPECIAL_GROUPS], ['wheel', 'sudoers']);
  assert.deepEqual([...G.USE_GROUPS], ['music-use', 'curio-use', 'daymark-use', 'status-use', 'ai-use']);
  assert.deepEqual([...G.MANAGE_GROUPS], ['music-manage', 'curio-manage', 'daymark-manage']);
  assert.equal(G.PRIVILEGED_GROUPS, undefined, '旧名 PRIVILEGED_GROUPS 改名 SPECIAL_GROUPS');
  assert.equal(G.WRITE_GROUPS, undefined, '旧名 WRITE_GROUPS 改名 MANAGE_GROUPS');
  assert.deepEqual([...G.STYRIGX_DEFAULT_GROUPS], ['wheel', 'sudoers', 'music-use', 'curio-use', 'daymark-use', 'status-use', 'ai-use', 'music-manage', 'curio-manage', 'daymark-manage']);
  assert.ok(Object.isFrozen(G.GROUPS) && Object.isFrozen(G.ACCESS_LEVELS));
  for (const v of Object.values(G.ACCESS)) assert.ok(!G.GROUPS.includes(v), v + ' 不许是组名');
  assert.ok(!G.GROUPS.includes('delete'), '删除不做组');
});

test('permits：public / 访客 / user / root / 组', () => {
  for (const id of [null, undefined, styrigx, alice, root]) assert.equal(G.permits(id, 'public'), true);
  for (const lv of ['user', 'root', 'ai-use', 'wheel']) assert.equal(G.permits(null, lv), false, '访客 ' + lv);
  assert.equal(G.permits({ uid: '1000', groups: ['ai-use'] }, 'ai-use'), false, 'uid 不是整数 = 不是身份');
  assert.equal(G.permits(nobody, 'user'), true, '无组的临时用户也是已登录身份');
  assert.equal(G.permits(nobody, 'music-use'), false);
  assert.equal(G.permits(alice, 'music-use'), true);
  assert.equal(G.permits(alice, 'ai-use'), false);
  assert.equal(G.permits(alice, 'music-manage'), false, 'use 不含 manage');
  for (const g of G.GROUPS) assert.equal(G.permits(styrigx, g), true, 'styrigx ' + g);
  assert.equal(G.permits(styrigx, 'root'), false, 'styrigx 不是 root（要 su / sudo）');
  assert.equal(G.permits(styrigx, 'webmaster'), true, '站长 = styrigx');
  assert.equal(G.permits(root, 'webmaster'), true, 'root 由第 2 步放行');
  assert.equal(G.permits(alice, 'webmaster'), false, '别的普通用户不是站长');
  assert.equal(G.permits({ ...alice, groups: [...G.GROUPS] }, 'webmaster'), false, '组再全也不是站长（按 uid，不按组）');
  assert.equal(G.permits(null, 'webmaster'), false);
  for (const lv of G.ACCESS_LEVELS) assert.equal(G.permits(root, lv), true, 'root ' + lv);
  for (const bad of ['entry', 'music', 'admin', '', 'ROOT', 'curio.write', 'listen', 'ai', 'status', 'curio-write', 'daymark-write']) assert.equal(G.permits(root, bad), false, '不认识的档 ' + bad);
});

test('救援会话：只放 rescue 路由；不是 rescue 的路由一律拒绝（即使 root 档）', () => {
  assert.equal(G.permits(rescue, 'root'), false);
  assert.equal(G.permits(rescue, 'curio-manage'), false);
  assert.equal(G.permits(rescue, 'user'), false);
  assert.equal(G.permits(rescue, 'root', { rescue: true }), true);
  assert.equal(G.permits(rescue, 'public'), false, '救援先判：public 路由不在白名单也拒（不往下走）');
  assert.equal(G.permits(rescue, 'webmaster'), false);
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

test('canJoinGroup：普通用户（uid 1001 起）不进特殊组 / manage 组（有期限 → temporary，无期限 → action 找不到命令，Gray 11-11 22:36）；站长不受限；root 不进组；不认识的组拒绝', () => {
  const temp = { uid: 1001, expiresAt: Date.now() + 86400000 };
  const perm = { uid: 1001, expiresAt: 0 };
  const webmaster = { uid: 1000, expiresAt: 0 };
  for (const u of [temp, perm, { uid: 1042, expiresAt: 0 }]) {
    for (const g of ['wheel', 'sudoers', ...G.MANAGE_GROUPS]) assert.deepEqual(G.canJoinGroup(u, g), { ok: false, reason: u.expiresAt > 0 ? 'temporary' : 'action' }, u.uid + ' ' + g);
    for (const g of G.USE_GROUPS) assert.deepEqual(G.canJoinGroup(u, g), { ok: true }, u.uid + ' ' + g);
  }
  for (const g of G.GROUPS) assert.deepEqual(G.canJoinGroup(webmaster, g), { ok: true }, g);
  assert.deepEqual(G.canJoinGroup({ uid: 0, expiresAt: 0 }, 'wheel'), { ok: false, reason: 'root' });
  assert.deepEqual(G.canJoinGroup(perm, 'admin'), { ok: false, reason: 'unknown-group' });
  assert.deepEqual(G.canJoinGroup(perm, 'root'), { ok: false, reason: 'unknown-group' });
  for (const old of ['listen', 'ai', 'status', 'curio-write', 'daymark-write']) assert.deepEqual(G.canJoinGroup(webmaster, old), { ok: false, reason: 'unknown-group' }, '旧组名不再认 ' + old);
});

test('组权限 v1.1 §五：三类不重叠、拼起来正好等于 GROUPS；每个 -manage 都有同名 -use；组名都是 <产品>-use|manage 或特殊组', () => {
  const all = [...G.SPECIAL_GROUPS, ...G.USE_GROUPS, ...G.MANAGE_GROUPS];
  assert.deepEqual(all, [...G.GROUPS]);
  assert.equal(new Set(all).size, all.length, '三类不重叠');
  assert.equal(G.STYRIGX_DEFAULT_GROUPS, G.GROUPS, '站长默认 = 全部组');
  for (const m of G.MANAGE_GROUPS) assert.ok(G.USE_GROUPS.includes(m.replace(/-manage$/, '-use')), m + ' 有同名 -use');
  for (const g of G.GROUPS) assert.ok(G.SPECIAL_GROUPS.includes(g) || G.PRODUCT_GROUP_RE.test(g), g);
  for (const g of G.USE_GROUPS) assert.match(g, /-use$/);
  for (const g of G.MANAGE_GROUPS) assert.match(g, /-manage$/);
  assert.deepEqual([...G.PRODUCTS], ['music', 'curio', 'daymark', 'status', 'ai']);
  assert.equal(G.useGroupOf('music'), 'music-use');
  assert.equal(G.manageGroupOf('music'), 'music-manage');
  assert.equal(G.manageGroupOf('ai'), null, 'ai 没有 manage 组');
  assert.equal(G.useGroupOf('nope'), null);
  for (const g of G.GROUPS) assert.equal(G.isGuardedGroup(g), !G.USE_GROUPS.includes(g), g);
});

test('permits：manage 包含 use（档是 X-use 且身份在 X-manage → 放行）；反过来不行；只认表里的产品', () => {
  const mgr = { uid: 1000, name: 'styrigx', groups: ['curio-manage'], rescue: false };
  assert.equal(G.permits(mgr, 'curio-use'), true, 'curio-manage ⊇ curio-use');
  assert.equal(G.permits(mgr, 'curio-manage'), true);
  assert.equal(G.permits(mgr, 'music-use'), false, '别的产品不放');
  assert.equal(G.permits(mgr, 'daymark-use'), false);
  const user = { uid: 1001, name: 'alice', groups: ['curio-use'], rescue: false };
  assert.equal(G.permits(user, 'curio-use'), true);
  assert.equal(G.permits(user, 'curio-manage'), false, 'use 不含 manage');
  assert.equal(G.permits({ ...mgr, groups: ['ai-manage'] }, 'ai-use'), false, '不存在的 ai-manage 不放行');
  assert.equal(G.permits({ ...mgr, rescue: true, uid: 0 }, 'curio-use'), false, '救援先判，不受 manage ⊇ use 影响');
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
