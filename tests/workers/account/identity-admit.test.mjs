/**
 * v6 新路径的放行结论（workers/account/src/core/admit.js admitRoute、rpc/account-verifier.js AccountVerifier.admit）与身份审计（core/user-audit.js）：
 * - 不在表里 → not-listed（不查库）；public 不要会话
 * - styrigx：组档放行、root 档拒（need-root）；su root 层：root 档放行、via = styrigx
 * - 临时用户只有给的组；救援会话只走 rescue 路由
 * - 旧会话 cookie（sgx-space-session / sgx-account-session）对新路径不算数
 * - RPC：参数不是字符串当空、永不抛错；只读（不写库）
 * - 身份审计：命令字白名单、90 天、IP 前缀、uid 可为 null、出错返回 false
 *
 * 运行：node --test tests/workers/account/identity-admit.test.mjs
 */
import './_cf-workers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admit as A, userAudit as UA, identityEnv, seedBase, seedUser, seedSession, pushRoot, NOW, reqWithToken, all } from './_identity.mjs';

const { AccountVerifier, checkAdmit } = await import('../../../workers/account/src/rpc/account-verifier.js');
const writes = (env) => env.D1_ACCOUNT.statements.filter((s) => /^\s*(INSERT|UPDATE|DELETE)/i.test(s));

test('不在表里 → not-listed，不查库；public 不要会话', async () => {
  const env = identityEnv();
  const r = await A.admitRoute(env, reqWithToken(''), 'GET', '/api/nope', NOW);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'not-listed');
  assert.equal(env.D1_ACCOUNT.statements.length, 0);
  const p = await A.admitRoute(env, reqWithToken(''), 'GET', '/api/find', NOW);
  assert.equal(p.allowed, true);
  assert.equal(p.level, 'public');
  const g = await A.admitRoute(env, reqWithToken(''), 'GET', '/api/status', NOW);
  assert.deepEqual([g.allowed, g.reason], [false, 'no-cookie']);
});

test('styrigx：组档放行、root 档 need-root；su root 后 root 档放行（via styrigx）', async () => {
  const env = identityEnv();
  seedBase(env);
  const s = await seedSession(env, { uid: 1000 });
  const req = reqWithToken(s.token);
  for (const [m, p] of [['GET', '/api/status'], ['POST', '/api/ai'], ['POST', '/curio/api/music-play'], ['DELETE', '/daymark/api/quotes'], ['PUT', '/api/avatar']]) {
    const r = await A.admitRoute(env, req, m, p, NOW);
    assert.equal(r.allowed, true, m + ' ' + p);
    assert.equal(r.uid, 1000);
  }
  const no = await A.admitRoute(env, req, 'POST', '/curio/api/import', NOW);
  assert.deepEqual([no.allowed, no.reason, no.root], [false, 'need-root', false]);
  pushRoot(env, s.id);
  const yes = await A.admitRoute(env, req, 'POST', '/curio/api/import', NOW);
  assert.deepEqual([yes.allowed, yes.uid, yes.root, yes.via], [true, 0, true, 'styrigx']);
  assert.deepEqual(writes(env), [], '只读');
});

test('临时用户：只有给的组；救援会话只走 rescue 路由', async () => {
  const env = identityEnv();
  seedBase(env);
  seedUser(env, { uid: 1001, name: 'guest', expiresAt: NOW + 86400000, groups: ['listen'] });
  const t = await seedSession(env, { uid: 1001 });
  assert.equal((await A.admitRoute(env, reqWithToken(t.token), 'POST', '/curio/api/music-play', NOW)).allowed, true);
  const ai = await A.admitRoute(env, reqWithToken(t.token), 'POST', '/api/ai', NOW);
  assert.deepEqual([ai.allowed, ai.reason], [false, 'need-ai']);
  const r = await seedSession(env, { uid: 0, rescue: true, expiresAt: NOW + 600000 });
  assert.equal((await A.admitRoute(env, reqWithToken(r.token), 'POST', '/api/account/keys', NOW)).allowed, true, 'keys 标了 rescue');
  assert.equal((await A.admitRoute(env, reqWithToken(r.token), 'POST', '/curio/api/import', NOW)).allowed, false, '救援不做日常 root 操作');
  assert.equal((await A.admitRoute(env, reqWithToken(r.token), 'GET', '/api/status', NOW)).allowed, false);
});

test('旧会话 cookie 对新路径不算数', async () => {
  const env = identityEnv();
  seedBase(env);
  const req = new Request('https://internal.invalid/', { headers: { Cookie: 'sgx-space-session=x.y.z; sgx-account-session=a.b.c' } });
  const r = await A.admitRoute(env, req, 'GET', '/api/status', NOW);
  assert.deepEqual([r.allowed, r.reason], [false, 'no-cookie']);
});

test('RPC AccountVerifier.admit：参数不是字符串当空；永不抛错；出错 fail closed', async () => {
  const env = identityEnv();
  seedBase(env);
  const s = await seedSession(env, { uid: 1000, expiresAt: Date.now() + 86400000 * 20 });
  const v = new AccountVerifier({}, env);
  const ok = await v.admit('sgx-session=' + s.token, 'GET', '/api/status');
  assert.deepEqual([ok.allowed, ok.uid, ok.name], [true, 1000, 'styrigx']);
  const odd = await v.admit({ x: 1 }, 42, null);
  assert.equal(odd.allowed, false);
  const broken = await checkAdmit({ D1_ACCOUNT: { prepare() { throw new Error('boom'); } } }, 'sgx-session=' + s.token, 'GET', '/api/status');
  assert.deepEqual([broken.allowed, broken.reason], [false, 'error']);
});

test('身份审计：白名单、90 天、IP 前缀、uid 可空；不认识的命令 / 出错 → false', async () => {
  const env = identityEnv();
  assert.equal(UA.USER_AUDIT_TTL_MS, 90 * 86400000);
  assert.equal(await UA.writeUserAudit(env, { uid: 0, command: 'usermod -aG listen alice', ip: '203.0.113.9' }), true);
  assert.equal(await UA.writeUserAudit(env, { uid: null, command: 'login-fail su styrigx', ok: false, ip: '2001:db8:1:2:3::9' }), true);
  assert.equal(await UA.writeUserAudit(env, { uid: 0, command: 'rm -rf /' }), false);
  assert.equal(await UA.writeUserAudit(env, { uid: 0, command: '' }), false);
  const rows = all(env, 'SELECT uid, command, ok, ip_prefix, expires_at - ts AS ttl FROM account_user_audit ORDER BY ts, id');
  assert.deepEqual(rows.map((r) => [r.uid, r.command, r.ok, r.ip_prefix, r.ttl]), [
    [0, 'usermod -aG listen alice', 1, '203.0.113.x', 90 * 86400000],
    [null, 'login-fail su styrigx', 0, '2001:db8:1:2::x', 90 * 86400000],
  ]);
  assert.equal(await UA.writeUserAudit({}, { uid: 0, command: 'su root' }), false);
  const long = 'useradd ' + 'a'.repeat(500);
  assert.equal(await UA.writeUserAudit(env, { uid: 0, command: long }), true);
  assert.equal(all(env, "SELECT MAX(LENGTH(command)) AS n FROM account_user_audit")[0].n, 200);
});

test('P2c：admit 先拒不认识的档，再做 root 快速放行（同 permits 第 0 步）——root / 救援 / 访客碰到不认识的档一律拒', async () => {
  const root = { uid: 0, name: 'root', groups: [], rescue: false };
  const rescue = { uid: 0, name: 'root', groups: [], rescue: true };
  const sty = { uid: 1000, name: 'styrigx', groups: ['wheel', 'sudoers'], rescue: false };
  for (const lv of ['nope', '', null, undefined, 'ROOT', 'wheel ']) {
    for (const who of [root, rescue, sty, null]) {
      assert.equal(A.admitDecision(who, /** @type {any} */ (lv), { rescue: true }), false, String(lv) + ' ' + (who ? who.name : 'guest'));
    }
  }
  /* 认识的档：照旧救援 → root → 按档 */
  assert.equal(A.admitDecision(root, 'root', {}), true);
  assert.equal(A.admitDecision(rescue, 'public', { rescue: false }), false, '救援先判：不在白名单即使 public 也拒');
  assert.equal(A.admitDecision(rescue, 'root', { rescue: true }), true);
  assert.equal(A.admitDecision(sty, 'root', {}), false);
  assert.equal(A.admitDecision(sty, 'wheel', {}), true);
  assert.equal(A.admitDecision(null, 'public', {}), true);
});
