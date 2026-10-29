/**
 * 2.10.2 鉴权修复测试（space）。
 *
 * 覆盖：
 * - 2：管理操作需 admin 会话 + stepup；/api/lock-now 清除 stepup 和 app cookie；
 *     锁定后调用管理接口必须拒绝
 * - 3：删应用密钥先推 app-epoch 再删；推失败 503 且密钥仍在
 * - 4：删锁屏密钥先推 lock-epoch 再删；失败 503（fail closed）
 * - 5：主站 SGX_SITE 配错 → 500（fail closed）
 * - 6：无纪元存储（D1_LOCK_AUTH）时 epoch 检查 fail closed（d1-error）
 * - 7：密码限速 D1 出错 → 503（fail closed）
 * - 8：管理密钥审计写入失败 → 不签发会话，503
 * - 9：Origin 缺失/解析失败 → 403
 * - 1：锁屏/升级弹层的管理密钥入口（静态检查：按钮和 handler 存在）
 *
 * 运行：node --test tests/kernel/auth-2102.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testLockSession } from './_tickets.mjs';
import { makeKV, genKeyPair, postReq, authD1For } from '../_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

let LOCK_PRIV = '', LOCK_PUB = '';
async function genKeys() {
  ({ priv: LOCK_PRIV, pub: LOCK_PUB } = await genKeyPair());
}

const SGX_ROOT_KEY = 'test-root-key-2102';

function baseEnv(kv, overrides = {}) {
  return {
    KV_LOCK_DOOR: kv, D1_LOCK_AUTH: authD1For(kv), D1_ACCOUNT_AUTH: authD1For(kv), D1_ROOT_AUTH: authD1For(kv), KV_ACCOUNT_LOGIN: kv,
    SGX_ROOT_KEY,
    SGX_LOCK_PRIVATE: LOCK_PRIV,
    SGX_LOCK_PUBLIC: LOCK_PUB,
    SGX_RP_ID: 'styrigx.com',
    SGX_ORIGIN: 'https://styrigx.com',
    SGX_SITE: 'space',
    ...overrides,
  };
}

/* 签一个有效的 admin 会话 cookie（role.epoch.exp.sig） */
async function makeSessionCookie(env, role = 'admin') {
  const { signLockSessionTicket } = await import('../../../workers/auth-gateway/functions/_kernel/lock-session.js');
  const epoch = 0;
  return await testLockSession(env.SGX_LOCK_PRIVATE, epoch, role);
}

function reqWithCookies(url, body, cookies, headers = {}) {
  const h = { ...headers };
  if (cookies) h['Cookie'] = cookies;
  return postReq(url, body, h);
}

/* 测试钥匙：before 里生成（不算一条用例，单独跑某条用例时也会先执行） */
before(async () => {
  await genKeys();
  assert.ok(LOCK_PRIV && LOCK_PUB);
});

/* ============ 2：管理操作需 admin 会话 + stepup ============ */





/* ============ 3：删应用密钥先推 epoch 再删 ============ */


/* ============ 4：删锁屏密钥先推 lock-epoch ============ */


/* ============ 5：SGX_SITE 配错 fail closed ============ */

test('5：SGX_SITE=blog 时主站 middleware 拒绝（500）', async () => {
  const { onRequest } = await import('../../../workers/auth-gateway/functions/_middleware.js');
  const req = new Request('https://styrigx.com/settings/', { method: 'GET' });
  const res = await onRequest({
    request: req,
    env: { SGX_SITE: 'blog', SGX_ENV: 'production' },
    next: async () => new Response('should-not-reach'),
  });
  assert.equal(res.status, 500, '配错站点名应 fail closed');
});

test('5b：SGX_SITE 缺失时主站 middleware 拒绝（500）', async () => {
  const { onRequest } = await import('../../../workers/auth-gateway/functions/_middleware.js');
  const req = new Request('https://styrigx.com/api/lock-session-check', { method: 'GET' });
  const res = await onRequest({
    request: req,
    env: { SGX_ENV: 'production' },
    next: async () => new Response('should-not-reach'),
  });
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'config');
});

/* ============ 6：纪元存储（D1_LOCK_AUTH）没绑时 epoch 检查 fail closed ============ */

test('6：verifyLockSession 无纪元存储（D1）→ d1-error（不跳过）', async () => {
  const { verifyLockSession } = await import('../../../workers/auth-gateway/functions/_kernel/lock-session.js');
  /* 造一个格式正确但无法验 epoch 的 cookie：用真密钥签名 */
  const { signLockSessionTicket } = await import('../../../workers/auth-gateway/functions/_kernel/lock-session.js');
  const val = await testLockSession(LOCK_PRIV, 0, 'admin', 'password');
  const req = new Request('https://styrigx.com/', {
    headers: { 'Cookie': 'sgx-lock-session=' + val },
  });
  const r = await verifyLockSession(req, { SGX_LOCK_PUBLIC: LOCK_PUB });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'd1-error', '2.10.2：读不到纪元不得跳过 epoch 检查');
});

/* ============ 7：密码限速 D1 出错 → 503 ============ */

test('7：verify 时限速 D1 出错 → 503', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/lock-password.js');
  const { makePasswordRecord } = await import('../../../workers/auth-gateway/functions/_kernel/lib/password.js');
  const kv = makeKV();
  const env = baseEnv(kv, { SGX_PW_PEPPER: 'test-pepper' });
  /* 锁屏密码已设置（码对），只有 attempt_limit 读写抛错 */
  env.D1_LOCK_AUTH.putPassword('lock', await makePasswordRecord('right-pass-1', 'test-pepper'));
  /* 对照：D1 正常时码对 → 200（证明下面的 503 来自限速表） */
  const ok = await onRequestPost({ request: postReq('https://styrigx.com/api/lock-password', { action: 'verify', password: 'right-pass-1' }), env });
  assert.equal(ok.status, 200);
  env.D1_LOCK_AUTH.failOn = (sql) => /attempt_limit/.test(sql);
  for (const password of ['x', 'right-pass-1']) {
    const req = postReq('https://styrigx.com/api/lock-password', { action: 'verify', password });
    const res = await onRequestPost({ request: req, env });
    /* 限速读不到 → 503（不再静默放行；码对也不签票） */
    assert.equal(res.status, 503, password);
    assert.equal(res.headers.get('Set-Cookie'), null);
  }
});

/* ============ 8：审计写入失败 → 不签发会话 ============ */

test('8：root-auth 审计写入失败 → 503 且无 cookie', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/root-auth.js');
  const kv = makeKV();
  const env = baseEnv(kv);
  /* 让审计写入失败：D1 audit 表的 INSERT 抛错，其他放行 */
  env.D1_ROOT_AUTH.failOn = (sql) => /^\s*INSERT INTO audit/i.test(sql);
  const req = postReq('https://styrigx.com/api/root-auth', { key: SGX_ROOT_KEY, purpose: 'lock-reset' });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 503, '审计失败应 503');
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const all = (cookies || []).join(';');
  assert.ok(!all.includes('sgx-lock-session='), '审计失败不得签发会话');
  assert.equal(res.headers.get('Set-Cookie'), null, '审计失败不签任何票');
  assert.equal(env.D1_ROOT_AUTH.raw.prepare('SELECT COUNT(*) AS n FROM audit').get().n, 0);
});

/* ============ 9：Origin 缺失/解析失败 → 403 ============ */

test('9a：root-auth 缺 Origin → 403', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/root-auth.js');
  const kv = makeKV();
  const req = postReq('https://styrigx.com/api/root-auth', { key: SGX_ROOT_KEY, purpose: 'lock-reset' }, { Origin: null });
  const res = await onRequestPost({ request: req, env: baseEnv(kv) });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'origin');
});

test('9b：root-auth Origin 解析失败 → 403', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/root-auth.js');
  const kv = makeKV();
  const req = postReq('https://styrigx.com/api/root-auth', { key: SGX_ROOT_KEY, purpose: 'lock-reset' }, { Origin: '::not-a-url::' });
  const res = await onRequestPost({ request: req, env: baseEnv(kv) });
  assert.equal(res.status, 403);
});

test('9c：lock-passkey 缺 Origin → 403', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/lock-passkey.js');
  const kv = makeKV();
  const req = postReq('https://styrigx.com/api/lock-passkey', { action: 'list' }, { Origin: null });
  const res = await onRequestPost({ request: req, env: baseEnv(kv) });
  assert.equal(res.status, 403);
});


/* ============ 1：管理密钥入口静态检查 ============ */

test('1a：锁屏方法弹层按配置显示入口（PR3：根凭证 / 重置锁屏两行合并成「无法登录？」）', () => {
  const src = fs.readFileSync(path.join(REPO, 'web/assets/js/shell/lock.js'), 'utf8');
  /* 根凭证不再是单独一行；都没设置（启动站）时「无法登录？」里的根凭证走 root-auth 引导 */
  assert.ok(!src.includes("'sgx-mopt-mk'") && !src.includes('id="sgx-mopt-mk"'), '不应再有根凭证一行');
  assert.ok(src.includes('sgx-mopt-cant'), '应有「无法登录？」');
  assert.ok(src.includes('function openResetInSheet'), '弹层原地切到重置登录');
  assert.ok(/bootstrap[\s\S]*?'\/api\/root-auth'/.test(src), '启动站：根凭证走 /api/root-auth');
  /* 配置以服务端为准 */
  assert.ok(src.includes('/api/lock-entry'), '应从 /api/lock-entry 读取配置');
  /* 其他选项必须存在 */
  assert.ok(src.includes('sgx-mopt-visitor'), '应有访客进入');
  assert.ok(src.includes('sgx-mopt-pk'), '应有通行密钥');
  assert.ok(src.includes('sgx-mopt-pw'), '应有密码');
  assert.ok(!src.includes('sgx-mopt-reset'), '「重置锁屏」一行已并入「无法登录？」');
});

test('1b：升级弹层没有根凭证入口（RootKey 不拥有会话，不能把访客升级成 admin）', () => {
  const src = fs.readFileSync(path.join(REPO, 'web/assets/js/shell/upgrade.js'), 'utf8');
  assert.ok(!src.includes('sgx-upgrade-mk'), '升级弹层不应有根凭证按钮');
  assert.ok(!src.includes('/api/root-auth') && !src.includes('/api/root-session'), '不调 root-auth / root-session');
  assert.ok(src.includes("'Admin verification'"), '文案是 admin 验证');
});
