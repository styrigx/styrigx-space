/**
 * 2.11 定稿测试：根凭证 / 管理员凭证鉴权拆分。
 *
 * 九组（定稿第十节）：
 * 1. 越权：scope 不匹配 403；lock passkey 开 stepup 被拒；已配置层拒 by=root
 * 2. 无 lock 会话：单用管理员凭证进入口 2、单用根凭证进入口 1 均被拒
 * 3. 重置锁屏：只管理员或只根（开关关闭）被拒；两者都过拿到 lockreset；
 *    lockreset 访问主页面/APP/会话/入口1/2 均 403 且不产生 sgx-verified；
 *    完成后旧会话失效；账号未配置时被拒
 * 4. 开关：缺失/过期/超 24 小时/格式错误时单根被拒；有效时单根拿到 lockreset；
 *    有效时单管理员仍被拒
 * 5. 假入口：访客提交正确 SGX_ROOT_KEY 返回 401 auth，与错误密钥响应逐字节相同
 * 6. 接管：未配时根可代管；配置后失效；接管后旧 root 票/会话被拒；
 *    D1 读失败时根代管被拒
 * 7. pepper：旧 hash 重哈希；缺 pepper fail closed；账号密码 = 锁屏密码被拒
 * 8. /api/root-auth：错误 401 auth，缺 Origin 403；/api/owner-auth 不可用
 * 9. 限速：根凭证各路径共用计数
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { testLockSession, testAccountSession } from './_tickets.mjs';
import { makeKV, genKeyPair, postReq, authD1For } from '../_harness.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;

/* 恢复开关：2026-10-27 起在 D1 recovery_switch 表（D1_LOCK_AUTH），不再有 KV 键（模块不再导出键名） */
const SWITCH_MOD = await import('../../../workers/auth-gateway/functions/_kernel/lock-reset-switch.js');
assert.equal('LOCK_RESET_SWITCH_KEY' in SWITCH_MOD, false, '开关不再是 KV 键');

/* 测试用 Ed25519 密钥（运行时生成，仅测试，不用于生产） */
let TEST_PRIV_PEM = '';
let TEST_PUB_PEM = '';

async function genTestKeys() {
  ({ priv: TEST_PRIV_PEM, pub: TEST_PUB_PEM } = await genKeyPair());
}
await genTestKeys();

function baseEnv(kv, overrides) {
  return Object.assign({
    KV_LOCK_DOOR: kv, D1_LOCK_AUTH: authD1For(kv), D1_ACCOUNT_AUTH: authD1For(kv), D1_ROOT_AUTH: authD1For(kv), KV_ACCOUNT_LOGIN: kv,
    SGX_ROOT_KEY: 'test-root-key-12345',
    SGX_LOCK_PRIVATE: TEST_PRIV_PEM,
    SGX_LOCK_PUBLIC: TEST_PUB_PEM,
    SGX_ACCOUNT_PRIVATE: TEST_PRIV_PEM,
    SGX_ACCOUNT_PUBLIC: TEST_PUB_PEM,
    SGX_PW_PEPPER: 'test-pepper',
    SGX_RP_ID: 'test.example.com',
    SGX_ORIGIN: 'https://test.example.com',
  }, overrides || {});
}

/*
 * 「已配置」= D1 里真有凭证（layers.js realCredentialPresence）：旧的 KV 标记 lock-configured / account-configured 不再算数。
 * configuredKV({ lock, account })：一份 kv（只当 authD1For 的钥匙），对应的 D1 里写好锁屏 / 账号密码。
 * 账号密码固定 'account-pass-1'，锁屏密码 'lock-pass-1'（pepper = baseEnv 的 test-pepper）。
 */
const { makePasswordRecord: mkPw } = await import(REPO + '/workers/auth-gateway/functions/_kernel/password.js');
const ACCOUNT_PW_REC = await mkPw('account-pass-1', 'test-pepper');
const LOCK_PW_REC = await mkPw('lock-pass-1', 'test-pepper');
function configuredKV(o) {
  const kv = makeKV();
  const db = authD1For(kv);
  if (o && o.lock) db.putPassword('lock', LOCK_PW_REC);
  if (o && o.account) db.putPassword('account', ACCOUNT_PW_REC);
  return kv;
}

/* ============ 1. 越权 ============ */



/* ============ 2. 无 lock 会话 ============ */


test('2.11 无 lock 会话：单用根凭证进入口 1 被拒（无会话且 lock 已配置 → 假入口 401 auth）', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/root-auth.js');
  const kv = configuredKV({ lock: true });
  const env = baseEnv(kv);
  const req = postReq('https://test.example.com/api/root-auth', { key: 'test-root-key-12345', purpose: 'lock-reauth' });
  const res = await onRequestPost({ request: req, env });
  /* 无会话 + lock 已配置 → 假入口，即使密钥正确也 401 auth */
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { ok: false, error: 'auth' });
});

/* ============ 3. 重置锁屏 ============ */

test('2.11 重置锁屏：开关关闭时只根凭证 → 返回 needAccount（需管理员凭证）', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/lock-reset.js');
  const kv = configuredKV({ lock: true, account: true });
  const env = baseEnv(kv); /* 无开关 → 关闭 */
  const req = postReq('https://test.example.com/api/lock-reset', {
    action: 'verify', rootKey: 'test-root-key-12345',
    /* 无 accountProof */
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).needAccount, true);
});

test('2.11 重置锁屏：开关关闭时只管理员凭证被拒（缺根凭证 → 401）', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/lock-reset.js');
  const { makePasswordRecord } = await import(REPO + '/workers/auth-gateway/functions/_kernel/password.js');
  const kv = configuredKV({ lock: true, account: true });
  const rec = await makePasswordRecord('account-pass-1', 'test-pepper');
  authD1For(kv).putPassword('account', rec);
  const env = baseEnv(kv);
  const req = postReq('https://test.example.com/api/lock-reset', {
    action: 'verify',
    accountProof: { type: 'password', password: 'account-pass-1' },
    /* 无 rootKey */
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401);
});

test('2.11 重置锁屏：账号未配置且开关关闭 → status 始终可用，verify 通用 401 auth（不泄露 not-set）', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/lock-reset.js');
  const kv = configuredKV({ lock: true }); /* 账号未配置 */
  const env = baseEnv(kv);
  const st = postReq('https://test.example.com/api/lock-reset', { action: 'status' });
  const stRes = await onRequestPost({ request: st, env });
  const stBody = await stRes.json();
  /* status 不再按管理员凭证配置返回 available，始终允许进入第一步 */
  assert.equal(stBody.available, true);
  assert.ok(!('skippable' in stBody), 'status 不再返回 skippable');
  const req = postReq('https://test.example.com/api/lock-reset', {
    action: 'verify', rootKey: 'test-root-key-12345',
  });
  const res = await onRequestPost({ request: req, env });
  /* 审查意见：管理员凭证未配置不再返回 403 not-set，改为通用 401 auth */
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, 'auth');
});

/* ============ 4. 恢复开关（D1 recovery_switch：计时 / 单次） ============ */

const DAY_MS = 24 * 3600 * 1000;
/** 某份 kv 对应的那个 D1（baseEnv 里三个绑定都是它） */
const switchDb = (kv) => authD1For(kv);
/** 模拟 Sloan 在 D1 控制台插一行「还没见过」的开关（firstSeen = 0），或摆一行已计时 / 已用的 */
function openSwitch(db, hash, firstSeen = 0, used = 0) {
  db.raw.prepare('INSERT INTO recovery_switch (hash, first_seen, used) VALUES (?, ?, ?)').run(hash, firstSeen, used);
}
const switchRows = (db) => db.raw.prepare('SELECT * FROM recovery_switch ORDER BY hash').all().map((r) => Object.assign({}, r));
/** 读过 / 写过开关表没有（看执行过的 SQL） */
const touchedSwitch = (db) => db.calls.some((sql) => /recovery_switch/.test(sql));

function switchEnv(kv, hash) {
  const env = baseEnv(kv);
  if (hash !== undefined) openSwitch(switchDb(kv), hash);
  return env;
}

test('2.11 开关：不存在 → 关闭（根凭证正确后返回 needAccount）', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/lock-reset.js');
  const kv = configuredKV({ lock: true, account: true });
  const env = switchEnv(kv); /* recovery_switch 没有行 */
  const req = postReq('https://test.example.com/api/lock-reset', {
    action: 'verify', rootKey: 'test-root-key-12345',
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.needAccount, true);
});


test('2.11 开关：已用后再用 → 关闭（返回 needAccount）', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/lock-reset.js');
  const kv = configuredKV({ lock: true, account: true });
  const env = switchEnv(kv, 'switch-1');
  /* 第一次：成功（单根拿到 lockreset），开关标记已用 */
  const req1 = postReq('https://test.example.com/api/lock-reset', {
    action: 'verify', rootKey: 'test-root-key-12345',
  });
  const res1 = await onRequestPost({ request: req1, env });
  assert.equal(res1.status, 200);
  assert.deepEqual(await res1.json(), { ok: true });
  assert.equal(switchRows(switchDb(kv))[0].used, 1);
  /* 第二次：同一行已用 → needAccount */
  const req2 = postReq('https://test.example.com/api/lock-reset', {
    action: 'verify', rootKey: 'test-root-key-12345',
  });
  const res2 = await onRequestPost({ request: req2, env });
  assert.equal(res2.status, 200);
  assert.equal((await res2.json()).needAccount, true);
});

test('2.11 开关：过期（24h+）→ 关闭；同时还有一行没见过的 → 那一行开始计时、有效', async () => {
  const { checkLockResetSwitch } = SWITCH_MOD;
  const db = switchDb(makeKV());
  openSwitch(db, 'old', Date.now() - 25 * 3600 * 1000);
  const r = await checkLockResetSwitch(db);
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'expired');
  openSwitch(db, 'fresh');
  const r2 = await checkLockResetSwitch(db);
  assert.equal(r2.valid, true);
  assert.equal(r2.reason, 'first-seen');
  assert.equal(r2.hash, 'fresh');
  assert.ok(switchRows(db).find((x) => x.hash === 'fresh').first_seen > 0, '开始计时');
  /* 再查：计时中 */
  const r3 = await checkLockResetSwitch(db);
  assert.equal(r3.reason, 'within-window');
});

test('2.11 开关：插新行重新开启', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/lock-reset.js');
  const kv = configuredKV({ lock: true });
  /* 旧行已用 */
  const env1 = switchEnv(kv, 'old');
  const req1 = postReq('https://test.example.com/api/lock-reset', {
    action: 'verify', rootKey: 'test-root-key-12345',
  });
  await onRequestPost({ request: req1, env: env1 });
  assert.equal(switchRows(switchDb(kv)).find((x) => x.hash === 'old').used, 1);
  /* 插一行新的 */
  const env2 = switchEnv(kv, 'new-2');
  const req2 = postReq('https://test.example.com/api/lock-reset', {
    action: 'verify', rootKey: 'test-root-key-12345',
  });
  const res2 = await onRequestPost({ request: req2, env: env2 });
  assert.equal(res2.status, 200);
  assert.deepEqual(await res2.json(), { ok: true });
});

test('2.11 开关：D1 缺失/失败 → fail closed', async () => {
  const { checkLockResetSwitch, claimLockResetSwitch } = SWITCH_MOD;
  /* D1 未绑定 */
  const r1 = await checkLockResetSwitch(null);
  assert.equal(r1.valid, false);
  assert.equal(r1.reason, 'unavailable');
  /* D1 抛错（即使有可用的行） */
  const db = switchDb(makeKV());
  openSwitch(db, 'some');
  db.failOn = (sql) => /recovery_switch/.test(sql);
  const r2 = await checkLockResetSwitch(db);
  assert.equal(r2.valid, false);
  assert.equal(r2.reason, 'd1-error');
  assert.equal(await claimLockResetSwitch(db, 'some'), false, '标记已用失败 → 不签');
  const brokenDb = { prepare: () => { throw new Error('d1-down'); } };
  assert.equal((await checkLockResetSwitch(brokenDb)).valid, false);
});

test('2.11 开关：D1 出错时重置路径不签 lockreset（单根）', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/lock-reset.js');
  const kv = configuredKV({ lock: true, account: true });
  const env = switchEnv(kv, 'switch-1');
  switchDb(kv).failOn = (sql) => /recovery_switch/.test(sql);
  const res = await onRequestPost({ request: postReq('https://test.example.com/api/lock-reset', { action: 'verify', rootKey: 'test-root-key-12345' }), env });
  const body = await res.json();
  assert.notDeepEqual(body, { ok: true }, '开关读不到不能当打开');
  assert.equal(res.headers.get('Set-Cookie'), null);
});

test('2.11 开关：根凭证错误时不读开关', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/lock-reset.js');
  const kv = configuredKV({ lock: true, account: true });
  const env = switchEnv(kv, 'secret');
  const db = switchDb(kv);
  db.calls.length = 0;
  const req = postReq('https://test.example.com/api/lock-reset', {
    action: 'verify', rootKey: 'wrong-key',
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401);
  assert.equal(touchedSwitch(db), false, '根凭证错误时不应读开关');
  assert.equal(switchRows(db)[0].first_seen, 0, '不开始计时');
});

test('2.11 开关：有效时单管理员凭证仍被拒（根凭证优先，不可跳过）', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/lock-reset.js');
  const { makePasswordRecord } = await import(REPO + '/workers/auth-gateway/functions/_kernel/password.js');
  const kv = configuredKV({ lock: true, account: true });
  const rec = await makePasswordRecord('account-pass-1', 'test-pepper');
  authD1For(kv).putPassword('account', rec);
  const env = switchEnv(kv, 'switch-1');
  /* 有 accountProof 但无 rootKey → 401（根凭证不可跳过） */
  const req = postReq('https://test.example.com/api/lock-reset', {
    action: 'verify',
    accountProof: { type: 'password', password: 'account-pass-1' },
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401);
  assert.equal(switchRows(switchDb(kv))[0].used, 0, '开关没被用掉');
});

/* ============ 5. 假入口 ============ */

test('2.11 假入口：访客提交正确根凭证 → 401 auth，与错误密钥响应逐字节相同', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/root-auth.js');
  const kv1 = configuredKV({ lock: true });
  const kv2 = configuredKV({ lock: true });
  const env1 = baseEnv(kv1);
  const env2 = baseEnv(kv2);
  /* 正确密钥 */
  const req1 = postReq('https://test.example.com/api/root-auth', { key: 'test-root-key-12345', purpose: 'lock-reauth' });
  const res1 = await onRequestPost({ request: req1, env: env1 });
  /* 错误密钥 */
  const req2 = postReq('https://test.example.com/api/root-auth', { key: 'wrong-key', purpose: 'lock-reauth' });
  const res2 = await onRequestPost({ request: req2, env: env2 });
  assert.equal(res1.status, 401);
  assert.equal(res2.status, 401);
  const b1 = await res1.text();
  const b2 = await res2.text();
  assert.equal(b1, b2);
  assert.equal(b1, JSON.stringify({ ok: false, error: 'auth' }));
});

test('2.11 假入口：缺 Origin → 403（先于假入口）', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/root-auth.js');
  const kv = configuredKV({ lock: true });
  const env = baseEnv(kv);
  const req = new Request('https://test.example.com/api/root-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'test-root-key-12345' }),
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 403);
});

/* ============ 7. pepper ============ */


test('2.11 pepper：账号密码 = 锁屏密码被拒（双向；账号侧走 /api/account）', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/account.js');
  const { makePasswordRecord } = await import(REPO + '/workers/auth-gateway/functions/_kernel/password.js');
  const kv = configuredKV({ lock: true, account: true }); /* 纪元在 D1，没有 → 0 */
  /* 先设锁屏密码（D1） */
  const lockRec = await makePasswordRecord('same-pass-12345', 'test-pepper');
  authD1For(kv).putPassword('lock', lockRec);
  const env = baseEnv(kv);
  const acc = await testAccountSession(TEST_PRIV_PEM, 'password', 0, Date.now());
  const { signAccountReauthTicket } = await import(REPO + '/workers/auth-gateway/functions/_kernel/tickets.js');
  const reauth = await signAccountReauthTicket(TEST_PRIV_PEM, 'password', 0); /* 改账号密码要 AccountReauthTicket */
  const sessCv = await testLockSession(TEST_PRIV_PEM, 0, 'admin', 'password');
  const headers = { 'Cookie': 'sgx-lock-session=' + sessCv + '; sgx-account-session=' + acc + '; sgx-account-reauth=' + reauth };
  /* 设账号密码 = 锁屏密码 → 403 same-as-lock */
  const req = postReq('https://test.example.com/api/account',
    { action: 'password-change', password: 'same-pass-12345' }, headers);
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'same-as-lock');
  /* 锁屏密码接口只管锁屏：拿 AccountReauthTicket 去设密码 → 403 reauth（它不是 LockReauthTicket，账号密码不经这里） */
  const { onRequestPost: pwPost } = await import(REPO + '/workers/auth-gateway/functions/api/lock-password.js');
  const res2 = await pwPost({ request: postReq('https://test.example.com/api/lock-password',
    { action: 'set', password: 'another-pass-123' }, headers), env });
  assert.equal(res2.status, 403);
  assert.equal((await res2.json()).error, 'reauth');
});

/* ============ 8. root-auth ============ */

test('2.11 root-auth：错误密钥 401 auth（引导模式）', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/root-auth.js');
  const kv = makeKV(); /* lock 未配置 → 引导模式 */
  const env = baseEnv(kv);
  const req = postReq('https://test.example.com/api/root-auth', { key: 'wrong-key', purpose: 'lock-reauth' });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { ok: false, error: 'auth' });
});

test('2.11 root-auth：缺 Origin 403 origin', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/root-auth.js');
  const kv = makeKV();
  const env = baseEnv(kv);
  const req = new Request('https://test.example.com/api/root-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'x' }),
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'origin');
});

test('2.11 root-auth：旧 /api/owner-auth 不再可用（文件不存在）', async () => {
  const fs = await import('node:fs');
  assert.equal(fs.existsSync(REPO + '/workers/auth-gateway/functions/api/owner-auth.js'), false);
});

/* ============ 9. 限速 ============ */

test('2.11 限速：根凭证各路径共用计数（root-auth 失败计入 lockreset 限速）', async () => {
  const { checkRootLimit, recordRootFail } = await import(REPO + '/workers/auth-gateway/functions/_kernel/root-limit.js');
  const { onRequestPost: rootAuth } = await import(REPO + '/workers/auth-gateway/functions/api/root-auth.js');
  const { onRequestPost: lockReset } = await import(REPO + '/workers/auth-gateway/functions/api/lock-reset.js');
  const kv = configuredKV({ lock: true, account: true });
  const env = baseEnv(kv);
  const ip = '1.2.3.4';
  /* 单元：5 次失败后锁定（D1 attempt_limit，realm=root） */
  for (let i = 0; i < 5; i++) {
    await recordRootFail(env, ip);
  }
  const lim = await checkRootLimit(env, ip);
  assert.equal(lim.limited, true);
  /* 跨路径：root-auth（无会话 lock-reauth 假入口）失败 3 次 + lock-reset 失败 2 次 → 同一行计到锁定 */
  const ip2 = '1.2.3.5';
  const h = { 'CF-Connecting-IP': ip2 };
  for (let i = 0; i < 3; i++) {
    assert.equal((await rootAuth({ request: postReq('https://test.example.com/api/root-auth', { key: 'wrong', purpose: 'lock-reauth' }, h), env })).status, 401);
  }
  for (let i = 0; i < 2; i++) {
    assert.equal((await lockReset({ request: postReq('https://test.example.com/api/lock-reset', { action: 'verify', rootKey: 'wrong' }, h), env })).status, 401);
  }
  const rows = switchDb(kv).raw.prepare("SELECT * FROM attempt_limit WHERE realm = 'root' AND kind = 'rootkey' AND bucket = ?").all(ip2);
  assert.equal(rows.length, 1, '各路径共用一行');
  assert.ok(rows[0].locked_until > Date.now(), '合计 5 次 → 锁定');
  const res = await lockReset({ request: postReq('https://test.example.com/api/lock-reset', { action: 'verify', rootKey: 'test-root-key-12345' }, h), env });
  assert.equal(res.status, 429, '锁定中 lock-reset 码对也 429');
});

/* ============ 10. 补充二：管理页加载触发开关计时 ============ */

test('2.11 补充二：管理页（layer-status，有效会话）触发开关计时', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/functions/api/layer-status.js');
  const kv = configuredKV({ lock: true, account: true }); /* 纪元在 D1，没有 → 0 */
  const env = switchEnv(kv, 'timer-1');
  const sessCv = await testLockSession(TEST_PRIV_PEM, 0, 'admin', 'password');
  const req = new Request('https://test.example.com/api/layer-status', {
    headers: { 'Cookie': 'sgx-lock-session=' + sessCv },
  });
  const res = await onRequestGet({ request: req, env });
  assert.equal(res.status, 200);
  /* D1 应有首次时间（计时开始），但未标记已用 */
  const rows = switchRows(switchDb(kv));
  assert.equal(rows.length, 1, '不插新行');
  assert.ok(rows[0].first_seen > 0, '开始计时');
  assert.equal(rows[0].used, 0);
});

test('2.11 补充二：计时 24 小时后，开关在重置路径上已失效', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/lock-reset.js');
  const { touchLockResetSwitch } = SWITCH_MOD;
  const kv = configuredKV({ lock: true, account: true });
  const env0 = switchEnv(kv, 'timer-1');
  const db = switchDb(kv);
  /* 先触发计时 */
  await touchLockResetSwitch(db);
  assert.ok(switchRows(db)[0].first_seen > 0);
  /* 把首次时间拨到 25 小时前（模拟过期） */
  db.raw.prepare('UPDATE recovery_switch SET first_seen = ? WHERE hash = ?').run(Date.now() - 25 * 3600 * 1000, 'timer-1');
  /* 重置路径：根凭证正确，但开关已过期 → needAccount（而非 lockreset） */
  const req = postReq('https://test.example.com/api/lock-reset', {
    action: 'verify', rootKey: 'test-root-key-12345',
  });
  const res = await onRequestPost({ request: req, env: env0 });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.needAccount, true, '过期开关不应签发 lockreset');
  assert.ok(!body.ok || body.needAccount, '不应直接成功');
  assert.equal(switchRows(db)[0].used, 0, '过期的行不被标记已用');
  void DAY_MS;
});

test('2.11 补充二：访客请求 layer-status → 401，且不读开关', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/functions/api/layer-status.js');
  const kv = configuredKV({ lock: true, account: true });
  const env = switchEnv(kv, 'timer-1');
  const db = switchDb(kv);
  db.calls.length = 0;
  /* 无会话 */
  const req = new Request('https://test.example.com/api/layer-status');
  const res = await onRequestGet({ request: req, env });
  assert.equal(res.status, 401);
  assert.equal(touchedSwitch(db), false, '访客不应触发开关读取');
  assert.equal(switchRows(db)[0].first_seen, 0, '不开始计时');
});

/* ============ 11. 补充四：恢复开关提示仅出现在重置第二步 ============ */

test('2.11 补充四：根凭证错误的 lockreset 响应不含 lock-reset-switch / recovery_switch', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/lock-reset.js');
  const kv = configuredKV({ lock: true, account: true });
  const env = switchEnv(kv, 'some-secret');
  const req = postReq('https://test.example.com/api/lock-reset', {
    action: 'verify', rootKey: 'wrong-key',
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401);
  const text = await res.text();
  assert.ok(!text.includes('lock-reset-switch') && !text.includes('recovery_switch') && !text.includes('some-secret'), '错误响应不应泄露开关');
});

test('2.11 补充四：访客假入口（root-auth）响应不含 lock-reset-switch / recovery_switch', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/root-auth.js');
  const kv = configuredKV({ lock: true });
  const env = switchEnv(kv, 'some-secret');
  /* 访客无会话，提交错误密钥 → 假入口 401 */
  const req = postReq('https://test.example.com/api/root-auth', { key: 'wrong-key', purpose: 'lock-reauth' });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401);
  const text = await res.text();
  assert.ok(!text.includes('lock-reset-switch') && !text.includes('recovery_switch') && !text.includes('some-secret'), '假入口响应不应泄露开关');
});

test('2.11 补充四：C2 重置第二步恢复提示（lock.js，无键名）', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(REPO + 'web/assets/js/shell/lock.js', 'utf8');
  /* C2：底部恢复提示改成新文案，不出现 lock-reset-switch 键名 */
  assert.ok(!src.includes('lock-reset-switch'), 'lock.js 不应再出现 lock-reset-switch 键名');
  assert.ok(!src.includes('sgx-reset-switch-hint'), '旧提示元素已删除');
  /* PR3：重置界面在 auth/reset-flow.js（锁屏与账号页共用），「管理员」统一改「账号」；恢复提示只在第二步 */
  const rf = fs.readFileSync(REPO + 'web/assets/js/auth/reset-flow.js', 'utf8');
  assert.ok(!src.includes('管理员') && !rf.includes('管理员'), '不再出现「管理员」字样');
  assert.ok(!rf.includes('lock-reset-switch'), 'reset-flow.js 不应出现开关键名');
  assert.ok(rf.includes('账号凭证也无法使用？'), '恢复提示用「账号」');
  const step2Idx = rf.indexOf('function step2');
  const step1Idx = rf.indexOf('function step1');
  const hintUse = rf.indexOf("t('recover')");
  assert.ok(step2Idx > 0 && hintUse > step2Idx, '恢复提示只在第二步');
  assert.ok(!rf.slice(step1Idx, step2Idx).includes("t('recover')"), '第一步（根凭证）不显示恢复提示');
});
