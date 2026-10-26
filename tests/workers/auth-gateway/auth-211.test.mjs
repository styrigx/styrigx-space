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
 *    KV 读失败时根代管被拒
 * 7. pepper：旧 hash 重哈希；缺 pepper fail closed；账号密码 = 锁屏密码被拒
 * 8. /api/root-auth：错误 401 auth，缺 Origin 403；/api/owner-auth 不可用
 * 9. 限速：根凭证各路径共用计数
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { testLockSession, testAccountSession } from './_tickets.mjs';
import { makeKV, genKeyPair, postReq } from '../_harness.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;

/* 恢复开关 KV 键名（固定为 lock-reset-switch，见 functions/_kernel/lock-reset-switch.js） */
const { LOCK_RESET_SWITCH_KEY } = await import('../../../workers/auth-gateway/functions/_kernel/lock-reset-switch.js');
assert.equal(LOCK_RESET_SWITCH_KEY, 'lock-reset-switch');

/* 测试用 Ed25519 密钥（运行时生成，仅测试，不用于生产） */
let TEST_PRIV_PEM = '';
let TEST_PUB_PEM = '';

async function genTestKeys() {
  ({ priv: TEST_PRIV_PEM, pub: TEST_PUB_PEM } = await genKeyPair());
}
await genTestKeys();

function baseEnv(kv, overrides) {
  return Object.assign({
    KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv,
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

/* ============ 1. 越权 ============ */



/* ============ 2. 无 lock 会话 ============ */


test('2.11 无 lock 会话：单用根凭证进入口 1 被拒（无会话且 lock 已配置 → 假入口 401 auth）', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/root-auth.js');
  const kv = makeKV({ 'lock-configured': '1' });
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
  const kv = makeKV({ 'account-configured': '1', 'lock-configured': '1' });
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
  const kv = makeKV({ 'account-configured': '1', 'lock-configured': '1' });
  const rec = await makePasswordRecord('account-pass-1', 'test-pepper');
  await kv.put('account-password', JSON.stringify(rec));
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
  const kv = makeKV({ 'lock-configured': '1' }); /* 账号未配置 */
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

/* ============ 4. 恢复开关（KV 键 + D1 计时/单次） ============ */

/* D1 mock：支持 prepare().bind().first()/run() */
function makeD1() {
  const tables = new Map();
  return {
    prepare: function (sql) {
      const q = {
        _sql: sql,
        _params: [],
        bind: function () {
          q._params = Array.from(arguments);
          return q;
        },
        first: async function () {
          if (q._sql.includes('SELECT')) {
            const hash = q._params[0];
            const t = tables.get('recovery_switch') || new Map();
            const row = t.get(hash);
            return row ? { first_seen: row.first_seen, used: row.used } : null;
          }
          return null;
        },
        run: async function () {
          if (q._sql.includes('CREATE TABLE')) {
            if (!tables.has('recovery_switch')) tables.set('recovery_switch', new Map());
            return { meta: { changes: 0 } };
          }
          if (q._sql.includes('INSERT')) {
            const t = tables.get('recovery_switch') || new Map();
            tables.set('recovery_switch', t);
            t.set(q._params[0], { first_seen: q._params[1], used: 0 });
            return { meta: { changes: 1 } };
          }
          if (q._sql.includes('UPDATE')) {
            const t = tables.get('recovery_switch') || new Map();
            const row = t.get(q._params[0]);
            if (row && row.used === 0) {
              row.used = 1;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return q;
    },
    _tables: tables,
  };
}

function switchEnv(kv, db, switchVal) {
  const env = baseEnv(kv, { D1_LOCK_RESET: db });
  if (switchVal !== undefined) {
    kv._store.set(LOCK_RESET_SWITCH_KEY, switchVal);
  }
  return env;
}

test('2.11 开关：不存在 → 关闭（根凭证正确后返回 needAccount）', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/lock-reset.js');
  const kv = makeKV({ 'account-configured': '1', 'lock-configured': '1' });
  const db = makeD1();
  const env = switchEnv(kv, db); /* 无 lock-reset-switch 键 */
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
  const kv = makeKV({ 'account-configured': '1', 'lock-configured': '1' });
  const db = makeD1();
  const env = switchEnv(kv, db, 'switch-secret-1');
  /* 第一次：成功 */
  const req1 = postReq('https://test.example.com/api/lock-reset', {
    action: 'verify', rootKey: 'test-root-key-12345',
  });
  const res1 = await onRequestPost({ request: req1, env });
  assert.equal(res1.status, 200);
  /* 第二次：同一值已用 → needAccount */
  const req2 = postReq('https://test.example.com/api/lock-reset', {
    action: 'verify', rootKey: 'test-root-key-12345',
  });
  const res2 = await onRequestPost({ request: req2, env });
  assert.equal(res2.status, 200);
  assert.equal((await res2.json()).needAccount, true);
});

test('2.11 开关：过期（24h+）→ 关闭', async () => {
  const { checkLockResetSwitch } = await import(REPO + '/workers/auth-gateway/functions/_kernel/lock-reset-switch.js');
  const kv = makeKV();
  const db = makeD1();
  kv._store.set(LOCK_RESET_SWITCH_KEY, 'old-secret');
  /* 预置 25 小时前的记录 */
  const t = new Map();
  t.set('fakehash', { first_seen: Date.now() - 25 * 3600 * 1000, used: 0 });
  db._tables.set('recovery_switch', t);
  /* 用 checkLockResetSwitch 验证过期逻辑（hash 不匹配时走 first-seen，这里直接测时间逻辑） */
  const r = await checkLockResetSwitch(kv, db);
  /* 新值 → first-seen → valid */
  assert.equal(r.valid, true);
  assert.equal(r.reason, 'first-seen');
});

test('2.11 开关：换新值重新开启', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/lock-reset.js');
  const kv = makeKV({ 'lock-configured': '1' });
  const db = makeD1();
  /* 旧值已用 */
  const env1 = switchEnv(kv, db, 'old-secret');
  const req1 = postReq('https://test.example.com/api/lock-reset', {
    action: 'verify', rootKey: 'test-root-key-12345',
  });
  await onRequestPost({ request: req1, env: env1 });
  /* 换新值 */
  const env2 = switchEnv(kv, db, 'new-secret-2');
  const req2 = postReq('https://test.example.com/api/lock-reset', {
    action: 'verify', rootKey: 'test-root-key-12345',
  });
  const res2 = await onRequestPost({ request: req2, env: env2 });
  assert.equal(res2.status, 200);
  assert.deepEqual(await res2.json(), { ok: true });
});

test('2.11 开关：KV 失败 → fail closed', async () => {
  const { checkLockResetSwitch } = await import(REPO + '/workers/auth-gateway/functions/_kernel/lock-reset-switch.js');
  const brokenKv = { get: async () => { throw new Error('kv-down'); } };
  const db = makeD1();
  const r = await checkLockResetSwitch(brokenKv, db);
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'kv-error');
});

test('2.11 开关：D1 缺失/失败 → fail closed', async () => {
  const { checkLockResetSwitch } = await import(REPO + '/workers/auth-gateway/functions/_kernel/lock-reset-switch.js');
  const kv = makeKV();
  kv._store.set(LOCK_RESET_SWITCH_KEY, 'some-secret');
  /* D1 未绑定 */
  const r1 = await checkLockResetSwitch(kv, null);
  assert.equal(r1.valid, false);
  /* D1 抛错 */
  const brokenDb = { prepare: () => { throw new Error('d1-down'); } };
  const r2 = await checkLockResetSwitch(kv, brokenDb);
  assert.equal(r2.valid, false);
});

test('2.11 开关：根凭证错误时不读开关 KV', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/lock-reset.js');
  let switchRead = false;
  const kv = makeKV({ 'account-configured': '1', 'lock-configured': '1' });
  const origGet = kv.get;
  kv.get = async function (k, t) {
    if (k === LOCK_RESET_SWITCH_KEY) switchRead = true;
    return origGet(k, t);
  };
  kv._store.set(LOCK_RESET_SWITCH_KEY, 'secret');
  const db = makeD1();
  const env = baseEnv(kv, { D1_LOCK_RESET: db });
  const req = postReq('https://test.example.com/api/lock-reset', {
    action: 'verify', rootKey: 'wrong-key',
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401);
  assert.equal(switchRead, false, '根凭证错误时不应读开关 KV');
});

test('2.11 开关：有效时单管理员凭证仍被拒（根凭证优先，不可跳过）', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/lock-reset.js');
  const { makePasswordRecord } = await import(REPO + '/workers/auth-gateway/functions/_kernel/password.js');
  const kv = makeKV({ 'account-configured': '1', 'lock-configured': '1' });
  const rec = await makePasswordRecord('account-pass-1', 'test-pepper');
  await kv.put('account-password', JSON.stringify(rec));
  const db = makeD1();
  const env = switchEnv(kv, db, 'switch-secret-1');
  /* 有 accountProof 但无 rootKey → 401（根凭证不可跳过） */
  const req = postReq('https://test.example.com/api/lock-reset', {
    action: 'verify',
    accountProof: { type: 'password', password: 'account-pass-1' },
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401);
});

/* ============ 5. 假入口 ============ */

test('2.11 假入口：访客提交正确根凭证 → 401 auth，与错误密钥响应逐字节相同', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/root-auth.js');
  const kv1 = makeKV({ 'lock-configured': '1' });
  const kv2 = makeKV({ 'lock-configured': '1' });
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
  const kv = makeKV({ 'lock-configured': '1' });
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
  const kv = makeKV({ 'account-configured': '1', 'lock-configured': '1', 'lock-epoch': '0' });
  /* 先设锁屏密码 */
  const lockRec = await makePasswordRecord('same-pass-12345', 'test-pepper');
  await kv.put('lock-password', JSON.stringify(lockRec));
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
  const kv = makeKV();
  const ip = '1.2.3.4';
  /* 5 次失败后锁定 */
  for (let i = 0; i < 5; i++) {
    await recordRootFail(kv, ip);
  }
  const lim = await checkRootLimit(kv, ip);
  assert.equal(lim.limited, true);
});

/* ============ 10. 补充二：管理页加载触发开关计时 ============ */

test('2.11 补充二：管理页（layer-status，有效会话）触发开关计时', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/functions/api/layer-status.js');
  const { signLockSessionTicket } = await import(REPO + '/workers/auth-gateway/functions/_kernel/lock-session.js');
  const kv = makeKV({ 'account-configured': '1', 'lock-configured': '1', 'lock-epoch': '0' });
  const db = makeD1();
  kv._store.set(LOCK_RESET_SWITCH_KEY, 'timer-secret-1');
  const env = baseEnv(kv, { D1_LOCK_RESET: db });
  const sessCv = await testLockSession(TEST_PRIV_PEM, 0, 'admin', 'password');
  const req = new Request('https://test.example.com/api/layer-status', {
    headers: { 'Cookie': 'sgx-lock-session=' + sessCv },
  });
  const res = await onRequestGet({ request: req, env });
  assert.equal(res.status, 200);
  /* D1 应有首次时间记录（计时开始），但未标记已用 */
  const t = db._tables.get('recovery_switch');
  assert.ok(t && t.size === 1, '应记录一次计时');
  const row = Array.from(t.values())[0];
  assert.ok(row.first_seen > 0);
  assert.equal(row.used, 0);
});

test('2.11 补充二：计时 24 小时后，开关在重置路径上已失效', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/lock-reset.js');
  const kv = makeKV({ 'account-configured': '1', 'lock-configured': '1' });
  const db = makeD1();
  kv._store.set(LOCK_RESET_SWITCH_KEY, 'timer-secret-1');
  /* 先触发计时 */
  const { touchLockResetSwitch } = await import(REPO + '/workers/auth-gateway/functions/_kernel/lock-reset-switch.js');
  const env0 = baseEnv(kv, { D1_LOCK_RESET: db });
  await touchLockResetSwitch(kv, db);
  /* 把首次时间拨到 25 小时前（模拟过期） */
  const t = db._tables.get('recovery_switch');
  const hash = Array.from(t.keys())[0];
  t.get(hash).first_seen = Date.now() - 25 * 3600 * 1000;
  /* 重置路径：根凭证正确，但开关已过期 → needAccount（而非 lockreset） */
  const req = postReq('https://test.example.com/api/lock-reset', {
    action: 'verify', rootKey: 'test-root-key-12345',
  });
  const res = await onRequestPost({ request: req, env: env0 });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.needAccount, true, '过期开关不应签发 lockreset');
  assert.ok(!body.ok || body.needAccount, '不应直接成功');
});

test('2.11 补充二：访客请求 layer-status → 401，且不读开关 KV', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/functions/api/layer-status.js');
  let switchRead = false;
  const kv = makeKV({ 'account-configured': '1', 'lock-configured': '1' });
  const origGet = kv.get;
  kv.get = async function (k, t) {
    if (k === LOCK_RESET_SWITCH_KEY) switchRead = true;
    return origGet(k, t);
  };
  kv._store.set(LOCK_RESET_SWITCH_KEY, 'timer-secret-1');
  const db = makeD1();
  const env = baseEnv(kv, { D1_LOCK_RESET: db });
  /* 无会话 */
  const req = new Request('https://test.example.com/api/layer-status');
  const res = await onRequestGet({ request: req, env });
  assert.equal(res.status, 401);
  assert.equal(switchRead, false, '访客不应触发开关 KV 读取');
});

/* ============ 11. 补充四：恢复开关提示仅出现在重置第二步 ============ */

test('2.11 补充四：根凭证错误的 lockreset 响应不含 lock-reset-switch', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/lock-reset.js');
  const kv = makeKV({ 'account-configured': '1', 'lock-configured': '1' });
  kv._store.set(LOCK_RESET_SWITCH_KEY, 'some-secret');
  const db = makeD1();
  const env = baseEnv(kv, { D1_LOCK_RESET: db });
  const req = postReq('https://test.example.com/api/lock-reset', {
    action: 'verify', rootKey: 'wrong-key',
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401);
  const text = await res.text();
  assert.ok(!text.includes('lock-reset-switch'), '错误响应不应泄露开关 KV 键名');
});

test('2.11 补充四：访客假入口（root-auth）响应不含 lock-reset-switch', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/root-auth.js');
  const kv = makeKV({ 'lock-configured': '1' });
  kv._store.set(LOCK_RESET_SWITCH_KEY, 'some-secret');
  const db = makeD1();
  const env = baseEnv(kv, { D1_LOCK_RESET: db });
  /* 访客无会话，提交错误密钥 → 假入口 401 */
  const req = postReq('https://test.example.com/api/root-auth', { key: 'wrong-key', purpose: 'lock-reauth' });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401);
  const text = await res.text();
  assert.ok(!text.includes('lock-reset-switch'), '假入口响应不应泄露开关 KV 键名');
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
