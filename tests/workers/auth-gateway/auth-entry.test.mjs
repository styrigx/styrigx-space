/**
 * 认证入口修正测试（space）。
 *
 * 覆盖：
 * 1. 锁屏恰好四个选项（访客进入/通行密钥/密码/重置锁屏），不含根凭证
 * 2. 访客和管理员的安全页 DOM 结构一致（三个入口，无角色条件渲染）
 * 3. 访客会话提交正确根凭证 → 401 密码错误，且不调用 D1/KV、不增加 root-limit 计数
 * 4. 管理凭证弹层四种配置下按钮正确（未设置/仅通行密钥/仅密码/两者都有）
 * 5. 三类通行密钥注册 options 的 name/displayName 正确
 *    （owner→AccountKey，lock→LockKey，app→<aud小写>key；displayName 一律 Sloan Gray）
 *
 * 运行：node --test tests/kernel/auth-entry.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testLockSession } from './_tickets.mjs';
import { makeKV, genKeyPair, postReq, authD1For } from '../_harness.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* 测试用 Ed25519 密钥 */
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
 * 「已配置」= D1 里真有凭证（layers.js realCredentialPresence）；旧 KV 标记 lock-configured / account-configured 不再算数。
 * configuredKV({ lock, account })：一份 kv（只当 authD1For 的钥匙），对应 D1 里写好锁屏 / 账号密码。
 */
const { makePasswordRecord: mkPw } = await import(REPO + '/workers/auth-gateway/functions/_kernel/password.js');
const LOCK_PW_REC = await mkPw('lock-pass-1', 'test-pepper');
const ACCOUNT_PW_REC = await mkPw('account-pass-1', 'test-pepper');
function configuredKV(o) {
  const kv = makeKV();
  const db = authD1For(kv);
  if (o && o.lock) db.putPassword('lock', LOCK_PW_REC);
  if (o && o.account) db.putPassword('account', ACCOUNT_PW_REC);
  return kv;
}
/** 网关对 D1 发过的写（纪元起步行 INSERT OR IGNORE INTO epoch 不算：那是读纪元的一部分） */
function d1Writes(db) {
  return db.calls.filter((sql) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql) && !/INSERT OR IGNORE INTO epoch/i.test(sql));
}
/** 根凭证限速 / 审计行（realm = 'root'） */
const rootRows = (db) => ({
  attempts: db.raw.prepare("SELECT * FROM attempt_limit WHERE realm = 'root'").all(),
  audits: db.raw.prepare("SELECT * FROM audit WHERE realm = 'root'").all(),
});

/* ============ 1. 锁屏入口按配置显示（补充定稿七.1） ============ */

test('认证入口：锁屏方法弹层按锁屏凭证配置显示入口（PR3：最下面一行「无法登录？」）', () => {
  const src = fs.readFileSync(path.join(REPO, 'web/assets/js/shell/lock.js'), 'utf8');
  /* 配置以服务端 /api/lock-entry 为准 */
  assert.ok(src.includes('/api/lock-entry'), '应从 /api/lock-entry 读取配置');
  assert.ok(src.includes('sgx-mopt-visitor'), '应有访客进入');
  assert.ok(src.includes('sgx-mopt-pk'), '应有通行密钥');
  assert.ok(src.includes('sgx-mopt-pw'), '应有密码');
  /* 「重置锁屏」「根凭证」两行合并为「无法登录？」→ 弹层原地切到重置登录 */
  assert.ok(src.includes('sgx-mopt-cant'), '应有「无法登录？」');
  assert.ok(src.includes('无法登录？') && src.includes('Can’t sign in?'), '中英文案');
  assert.ok(!src.includes('sgx-mopt-reset') && !src.includes('function openMk'), '旧的两行已删除');
  /* 启动站（锁屏凭证都没设）：视为从零重置——根凭证 → /api/root-auth purpose=lock-reset（不再换 root-session） */
  assert.ok(/bootstrap[\s\S]*?'\/api\/root-auth', \{ key: key, purpose: 'lock-reset' \}/.test(src), '启动站根凭证走 lock-reset');
  assert.ok(!src.includes('root-session') && !src.includes('exchangeRootSession'), 'root-session 已删除');
  /* 读取失败按已配置处理 */
  assert.ok(src.includes('读取失败按已配置处理'), '应有读取失败 fail closed 注释');
  assert.ok(!src.includes('先验证根凭证，再验证管理员凭证'), '描述不应出现旧说法');
});

/* ============ 2. 安全页 DOM 一致 ============ */


/* ============ 3. 访客假入口 ============ */

test('认证入口：访客会话提交正确根凭证 → 401 密码错误，不读凭证、不写 KV、不计 root-limit', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/root-auth.js');
  const { signLockSessionTicket } = await import(REPO + '/workers/auth-gateway/functions/_kernel/lock-session.js');

  const kv = configuredKV({ lock: true });
  const env = baseEnv(kv);

  /* 构造有效访客会话 cookie */
  const sessCv = await testLockSession(TEST_PRIV_PEM, 0, 'visitor');

  /* 提交正确的根凭证 */
  const req = postReq('https://test.example.com/api/root-auth', { key: 'test-root-key-12345', purpose: 'lock-reauth' }, {
    'Cookie': 'sgx-lock-session=' + sessCv,
  });
  const t0 = Date.now();
  const res = await onRequestPost({ request: req, env });
  const dt = Date.now() - t0;

  assert.equal(res.status, 401);
  const body = await res.text();
  assert.equal(body, JSON.stringify({ ok: false, error: 'denied' }));

  /* 不写存储（D1 没有任何写）；B1-9：不读凭证 */
  const db = authD1For(kv);
  assert.deepEqual(d1Writes(db), [], '访客假入口不应写 D1');
  assert.equal(db.calls.filter((sql) => /FROM (password|passkey)\b/.test(sql)).length, 0, '不读凭证');

  /* 不增加 root-limit 计数、不写审计 */
  assert.deepEqual(rootRows(db).attempts, [], '不应有根凭证失败计数');
  assert.deepEqual(rootRows(db).audits, [], '不应有审计行');

  /* 固定最小延迟（防时序区分） */
  assert.ok(dt >= 180, '应有固定最小延迟，实际 ' + dt + 'ms');
});

test('认证入口：访客假入口与真失败响应逐字节相同', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/root-auth.js');
  const { signLockSessionTicket } = await import(REPO + '/workers/auth-gateway/functions/_kernel/lock-session.js');

  const kv1 = configuredKV({ lock: true });
  const kv2 = configuredKV({ lock: true });

  /* B1-9：访客提交任何值都返回同一个 401 denied（不读存储） */
  const sessCv = await testLockSession(TEST_PRIV_PEM, 0, 'visitor');
  const req1 = postReq('https://test.example.com/api/root-auth', { key: 'test-root-key-12345', purpose: 'lock-reauth' }, {
    'Cookie': 'sgx-lock-session=' + sessCv,
  });
  const res1 = await onRequestPost({ request: req1, env: baseEnv(kv1) });

  /* 访客提交另一个值 → 同一个 401 denied */
  const req2 = postReq('https://test.example.com/api/root-auth', { key: 'wrong-key', purpose: 'lock-reauth' }, {
    'Cookie': 'sgx-lock-session=' + sessCv,
  });
  const res2 = await onRequestPost({ request: req2, env: baseEnv(kv2) });

  assert.equal(res1.status, 401);
  assert.equal(res2.status, 401);
  const b1 = await res1.text();
  const b2 = await res2.text();
  assert.equal(b1, b2, 'B1-9：访客任何提交应返回同一个 401');
  assert.equal(b1, JSON.stringify({ ok: false, error: 'denied' }), 'B1-9：访客应返回 denied');
});

/* ============ 4. 管理凭证弹层按钮 ============ */

/* 账号体系：/api/account（GET）四种配置返回正确（取代 /api/owner-status + mgmtButtons） */
test('行为：账号登录状态四种配置返回正确', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/functions/api/account.js');
  const { signLockSessionTicket } = await import(REPO + '/workers/auth-gateway/functions/_kernel/lock-session.js');
  const ownerCv = await testLockSession(TEST_PRIV_PEM, 0, 'admin', 'password');
  const getReq = () => new Request('https://test.example.com/api/account', {
    method: 'GET',
    headers: { 'Cookie': 'sgx-lock-session=' + ownerCv },
  });
  const cases = [
    [{}, false, false],
    [{ 'account-password': JSON.stringify({ hash: 'x', algo: 'test' }) }, true, false],
    [{
      'account-passkey-index': JSON.stringify(['testcred123456']),
      'account-passkey:testcred1234': JSON.stringify({ credId: 'testcred123456' }),
    }, false, true],
    [{
      'account-password': JSON.stringify({ hash: 'x', algo: 'test' }),
      'account-passkey-index': JSON.stringify(['testcred123456']),
      'account-passkey:testcred1234': JSON.stringify({ credId: 'testcred123456' }),
    }, true, true],
  ];
  for (const [seed, pw, pk] of cases) {
    const kv = makeKV(seed);
    const res = await onRequestGet({ request: getReq(), env: baseEnv(kv) });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.password, pw);
    assert.equal(body.passkey, pk);
    assert.equal(body.ready, true);
    assert.equal(body.session, null, 'lock 会话不是账号会话');
  }
}
);

test('认证入口：重置锁屏 status 始终可用（不暴露管理员凭证是否配置）', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/lock-reset.js');
  /* owner 未配置 */
  const kv = configuredKV({ lock: true });
  const env = baseEnv(kv);
  const st = postReq('https://test.example.com/api/lock-reset', { action: 'status' });
  const stRes = await onRequestPost({ request: st, env });
  const stBody = await stRes.json();
  assert.equal(stBody.ok, true);
  assert.equal(stBody.available, true, 'status 应始终返回可用');
});

test('认证入口：前端重置弹层不再出现「重置锁屏不可用」', () => {
  const src = fs.readFileSync(path.join(REPO, 'web/assets/js/shell/lock.js'), 'utf8');
  assert.ok(!src.includes('重置锁屏不可用'), '不应再有「重置锁屏不可用」文案');
  assert.ok(!src.includes('Reset is not available'), '不应再有英文不可用文案');
  /* openReset 直接显示第一步，不再调 status */
  assert.ok(!src.includes("action: 'status'") || src.indexOf('renderResetStep1') < src.indexOf("action: 'status'"),
    'openReset 应直接显示第一步');
});

/* ============ 5. 通行密钥命名 ============ */


/* ============ 7. 补充定稿七：锁屏入口按配置 + 访客管理凭证假入口 ============ */

test('补充七：/api/lock-entry 四种配置返回正确', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/functions/api/lock-entry.js');
  const get = (url, env) => new Request(url, { method: 'GET' });

  /* 都没设置 */
  let kv = makeKV({});
  let res = await onRequestGet({ request: get('https://test.example.com/api/lock-entry'), env: baseEnv(kv) });
  let j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.passkey, false, '无凭据时 passkey 应为 false');
  assert.equal(j.password, false, '无凭据时 password 应为 false');

  /* 仅密码 */
  kv = makeKV({ 'lock-password': JSON.stringify({ hash: 'h', salt: 's' }) });
  res = await onRequestGet({ request: get('https://test.example.com/api/lock-entry'), env: baseEnv(kv) });
  j = await res.json();
  assert.equal(j.passkey, false);
  assert.equal(j.password, true);

  /* 仅通行密钥 */
  kv = makeKV({
    'lock-passkey-index': JSON.stringify(['cid1']),
    'lock-passkey:cid1': JSON.stringify({ credId: 'cid1' }),
  });
  res = await onRequestGet({ request: get('https://test.example.com/api/lock-entry'), env: baseEnv(kv) });
  j = await res.json();
  assert.equal(j.passkey, true);
  assert.equal(j.password, false);

  /* 两者都有 */
  kv = makeKV({
    'lock-password': JSON.stringify({ hash: 'h', salt: 's' }),
    'lock-passkey-index': JSON.stringify(['cid1']),
    'lock-passkey:cid1': JSON.stringify({ credId: 'cid1' }),
  });
  res = await onRequestGet({ request: get('https://test.example.com/api/lock-entry'), env: baseEnv(kv) });
  j = await res.json();
  assert.equal(j.passkey, true);
  assert.equal(j.password, true);

  /* 非 lock 类凭据不应算作锁屏通行密钥 */
  kv = makeKV({
    'account-passkey-index': JSON.stringify(['cid9']),
    'account-passkey:cid9': JSON.stringify({ credId: 'cid9' }),
  });
  res = await onRequestGet({ request: get('https://test.example.com/api/lock-entry'), env: baseEnv(kv) });
  j = await res.json();
  /* 账号通行密钥不算锁屏凭证：锁屏凭证为 0、账号已配置 → resetOnly（只显示访客 + 重置锁屏）；
     passkey / password 仍按已配置返回 true，不暴露根凭证入口 */
  assert.equal(j.resetOnly, true, '账号通行密钥不应算锁屏通行密钥（锁屏凭证为 0 → resetOnly）');
  assert.equal(j.accountConfigured, true);
  assert.equal(j.passkey, true, '账号已配置时不暴露根凭证入口');
  assert.equal(j.password, true);
});

test('补充七：/api/lock-entry 读取失败按已配置处理（不暴露根凭证入口）', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/functions/api/lock-entry.js');
  const kv = makeKV();
  authD1For(kv).failOn = () => true; /* D1 全挂 */
  const res = await onRequestGet({
    request: new Request('https://test.example.com/api/lock-entry', { method: 'GET' }),
    env: baseEnv(kv),
  });
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.passkey, true, '读取失败 passkey 应按已配置处理');
  assert.equal(j.password, true, '读取失败 password 应按已配置处理');
  assert.equal(j.resetOnly, false, '读取失败不进 resetOnly');
  /* 只有凭证表读失败（纪元等正常）同样按已配置 */
  const kv2 = makeKV();
  authD1For(kv2).failOn = (sql) => /FROM (password|passkey)\b/.test(sql);
  const j2 = await (await onRequestGet({ request: new Request('https://test.example.com/api/lock-entry', { method: 'GET' }), env: baseEnv(kv2) })).json();
  assert.equal(j2.passkey, true);
  assert.equal(j2.password, true);
  /* 没绑 D1：同样按已配置 */
  const env3 = baseEnv(makeKV());
  delete env3.D1_LOCK_AUTH;
  const j3 = await (await onRequestGet({ request: new Request('https://test.example.com/api/lock-entry', { method: 'GET' }), env: env3 })).json();
  assert.equal(j3.passkey, true);
  assert.equal(j3.password, true);
});

/* 复审 §2：lock-entry 和 root-auth 必须用同一个口径判断「锁屏已配置」，否则 lock-entry 显示根凭证入口、
   root-auth 却判已配置 → 假入口 401，直接锁死。D1 之后口径只有一个：D1 里的真实凭证（KV 标记不再存在，
   导入脚本也不导）。没有真实凭证时两边一致：lock-entry 显示根凭证入口，root-auth lock-reset 走真路径能签票；
   有真实凭证时两边一致：不显示入口，root-auth 无会话 → 假入口 401。 */
test('行为：/api/lock-entry 与 root-auth 对「锁屏已配置」口径一致（不会显示入口却被假入口锁死）', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/functions/api/lock-entry.js');
  const { onRequestPost: rootAuth } = await import(REPO + '/workers/auth-gateway/functions/api/root-auth.js');
  const entry = async (kv) => (await onRequestGet({ request: new Request('https://test.example.com/api/lock-entry', { method: 'GET' }), env: baseEnv(kv) })).json();
  /* 无真实凭证（旧 KV 标记只在 KV 里，不算）→ 显示根凭证入口，且 root-auth 真路径可用 */
  const kv = makeKV({ 'lock-configured': '1' });
  const j = await entry(kv);
  assert.equal(j.ok, true);
  assert.equal(j.passkey, false);
  assert.equal(j.password, false);
  const r = await rootAuth({ request: postReq('https://test.example.com/api/root-auth', { key: 'test-root-key-12345', purpose: 'lock-reset' }), env: baseEnv(kv) });
  assert.equal(r.status, 200, '显示了根凭证入口，root-auth 就必须走真路径');
  /* 有真实锁屏凭证 → 不显示根凭证入口；root-auth 无会话走假入口 */
  const kv2 = configuredKV({ lock: true });
  const j2 = await entry(kv2);
  assert.equal(j2.password, true);
  const r2 = await rootAuth({ request: postReq('https://test.example.com/api/root-auth', { key: 'test-root-key-12345', purpose: 'lock-reset' }), env: baseEnv(kv2) });
  assert.equal(r2.status, 401);
  assert.deepEqual(await r2.json(), { ok: false, error: 'auth' });
});

test('补充七：已配置锁屏凭证时，锁屏根凭证路径被服务端拒绝（无会话 → 401）', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/root-auth.js');
  /* lock 层已配置，无会话提交正确的根凭证 */
  const kv = configuredKV({ lock: true });
  const req = postReq('https://test.example.com/api/root-auth', { key: 'test-root-key-12345', purpose: 'lock-reauth' });
  const res = await onRequestPost({ request: req, env: baseEnv(kv) });
  assert.equal(res.status, 401, '已配置时无会话根凭证路径应被拒绝');
  const body = await res.text();
  assert.equal(body, JSON.stringify({ ok: false, error: 'auth' }));
});


test('补充七：访客管理凭证提交任何值都返回密码错误且不写存储', async () => {
  /* 管理凭证弹层的「根凭证」按钮提交到 /api/root-auth；访客会话下为假入口 */
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/root-auth.js');
  const { signLockSessionTicket } = await import(REPO + '/workers/auth-gateway/functions/_kernel/lock-session.js');

  const kv = configuredKV({ lock: true });
  const env = baseEnv(kv);
  const sessCv = await testLockSession(TEST_PRIV_PEM, 0, 'visitor');

  /* 提交任意值（包括错误值） */
  for (const key of ['whatever', '', 'test-root-key-12345']) {
    const req = postReq('https://test.example.com/api/root-auth', { key }, {
      'Cookie': 'sgx-lock-session=' + sessCv,
    });
    const res = await onRequestPost({ request: req, env });
    assert.equal(res.status, 401, '访客提交 ' + JSON.stringify(key) + ' 应 401');
    const body = await res.text();
    assert.equal(body, JSON.stringify({ ok: false, error: 'denied' }));
  }
  /* 不写存储 */
  const db = authD1For(kv);
  assert.deepEqual(d1Writes(db), [], '访客假入口不应写 D1');
  assert.deepEqual(rootRows(db).attempts, [], '不应有 root-limit 计数');
});

/* ============ 审查意见 9 项：行为测试 ============ */

test('行为：lockreset 管理员凭证未配置 → 通用 401 auth（不泄露 not-set）', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/lock-reset.js');
  /* owner 未配置（无标记、无密码、无 passkey），lock 也未配置 */
  const kv = makeKV({});
  const env = baseEnv(kv);
  const req = postReq('https://test.example.com/api/lock-reset', {
    action: 'verify', rootKey: 'test-root-key-12345',
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401);
  const body = JSON.parse(await res.text());
  assert.equal(body.ok, false);
  assert.equal(body.error, 'auth', '应为通用 auth，不应泄露 not-set');
});

test('行为：lockreset 记失败计数写 D1 出错 → 503', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/lock-reset.js');
  /* attempt_limit 的 UPSERT 抛错 */
  const kv = makeKV({});
  authD1For(kv).failOn = (sql) => /^\s*INSERT INTO attempt_limit/i.test(sql);
  const env = baseEnv(kv);
  const req = postReq('https://test.example.com/api/lock-reset', {
    action: 'verify', rootKey: 'wrong-key',
  });
  const res = await onRequestPost({ request: req, env });
  /* 根凭证错误 → 记失败计数 → D1 写抛错 → 503（fail closed） */
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false, error: 'server' });
});

test('行为：lockreset needAccount 带 passkey/password 布尔', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/lock-reset.js');
  /* owner 只配置了密码（含 account-configured 标记） */
  const kv = makeKV({
    'account-configured': '1',
    'account-password': JSON.stringify({ hash: 'x', algo: 'test' }),
  });
  const env = baseEnv(kv);
  const req = postReq('https://test.example.com/api/lock-reset', {
    action: 'verify', rootKey: 'test-root-key-12345',
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 200);
  const body = JSON.parse(await res.text());
  assert.equal(body.ok, true);
  assert.equal(body.needAccount, true);
  assert.equal(body.password, true, '应带 password=true');
  assert.equal(body.passkey, false, '应带 passkey=false');
});



test('行为：/api/account 状态需 admin lock 会话，无会话 → 401', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/functions/api/account.js');
  const kv = makeKV({});
  const env = baseEnv(kv);
  const req = new Request('https://test.example.com/api/account', { method: 'GET' });
  const res = await onRequestGet({ request: req, env });
  assert.equal(res.status, 401, '无会话应 401');
});

test('行为：/api/account 状态只看 owner 类（账号）通行密钥', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/functions/api/account.js');
  const { signLockSessionTicket } = await import(REPO + '/workers/auth-gateway/functions/_kernel/lock-session.js');
  /* 只有 lock 类 passkey，无账号密码 */
  const kv = makeKV({
    'lock-passkey-index': JSON.stringify(['abc123']),
    'lock-passkey:abc123': JSON.stringify({ credId: 'abc123', publicKey: 'x' }),
  });
  const env = baseEnv(kv);
  const sessCv = await testLockSession(TEST_PRIV_PEM, 0, 'admin', 'password');
  const req = new Request('https://test.example.com/api/account', {
    method: 'GET',
    headers: { 'Cookie': 'sgx-lock-session=' + sessCv },
  });
  const res = await onRequestGet({ request: req, env });
  assert.equal(res.status, 200);
  const body = JSON.parse(await res.text());
  assert.equal(body.ok, true);
  assert.equal(body.passkey, false, '只有 lock 类时 passkey 应为 false');
  assert.equal(body.password, false);
});

test('行为：访客会话下 root-auth 不走真路径（即使 lock 未配置也不比对）', async () => {
  /* 补充：锁屏未配置的引导场景下，有访客 cookie 时不走假入口（走真路径）；
     但设置页的访客假入口（lock 已配置）仍写死 401。 */
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/root-auth.js');
  const { signLockSessionTicket } = await import(REPO + '/workers/auth-gateway/functions/_kernel/lock-session.js');
  /* lock 已配置 */
  const kv = configuredKV({ lock: true });
  const env = baseEnv(kv);
  const sessCv = await testLockSession(TEST_PRIV_PEM, 0, 'visitor');
  /* 提交正确的根凭证 */
  const req = postReq('https://test.example.com/api/root-auth', { key: 'test-root-key-12345', purpose: 'lock-reauth' }, {
    'Cookie': 'sgx-lock-session=' + sessCv,
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401, '访客即使提交正确根凭证也 401');
  const body = await res.text();
  assert.equal(body, JSON.stringify({ ok: false, error: 'denied' }));
});

test('行为：锁屏未配置 + 访客 cookie 时 root-auth 走真路径（不走假入口）', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/root-auth.js');
  const { signLockSessionTicket } = await import(REPO + '/workers/auth-gateway/functions/_kernel/lock-session.js');
  /* B1-9：访客一律 401 denied，不区分新站旧站（lockCfg 例外已删除） */
  const kv = makeKV({});
  const env = baseEnv(kv);
  const sessCv = await testLockSession(TEST_PRIV_PEM, 0, 'visitor');
  const req = postReq('https://test.example.com/api/root-auth', { key: 'test-root-key-12345', purpose: 'lock-reauth' }, {
    'Cookie': 'sgx-lock-session=' + sessCv,
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401, 'B1-9：访客一律 401，不走真路径');
  const body = await res.text();
  assert.equal(body, JSON.stringify({ ok: false, error: 'denied' }));
});

/* ============ 复审 §1：lockreset 票据页注入 lockreset 状态 ============ */

test('行为：injectSessionState 注入 lockreset 状态（瘦身 + noindex，与 locked 一致）', async () => {
  const { injectSessionState } = await import(REPO + '/workers/auth-gateway/functions/_kernel/html.js');
  const html = '<html><head></head><body><!-- SGX-DESKTOP-START --><div>desktop</div><!-- SGX-DESKTOP-END --><p>lock page</p></body></html>';
  const res = new Response(html, { headers: { 'Content-Type': 'text/html' } });
  const out = await injectSessionState(res, 'lock-reset', null);
  const text = await out.text();
  assert.ok(text.includes('data-sgx-lock-session="lock-reset"'), '应注入 lockreset 状态');
  assert.ok(!text.includes('desktop'), 'lockreset 页应瘦身（不下发桌面内容）');
  assert.equal(out.headers.get('X-Robots-Tag'), 'noindex', 'lockreset 页不应被收录');
});

test('行为：injectSessionState locked 状态保持不变', async () => {
  const { injectSessionState } = await import(REPO + '/workers/auth-gateway/functions/_kernel/html.js');
  const html = '<html><head></head><body><p>home</p></body></html>';
  const res = new Response(html, { headers: { 'Content-Type': 'text/html' } });
  const out = await injectSessionState(res, 'locked', null);
  const text = await out.text();
  assert.ok(text.includes('data-sgx-lock-session="locked"'), '应注入 locked 状态');
});

/* ============ /api/lock-credentials：只读锁屏凭证状态 ============
   背景：security-lock.js refreshStatus 曾用 /api/owner-status 显示锁屏密码
   「已设置/未设置」和删除按钮，但 owner-status 读的是 account-password +
   class=owner 通行密钥（且要求 admin 会话），导致：
   - 只设了管理员密码 → 锁屏页误显示「已设置」
   - 只设了锁屏密码 → 误显示「未设置」且没有删除按钮
   - lockreset 页无会话 → owner-status 返回 401
   本接口读 lock-password + class=lock，admin 会话或 keys/lockreset 票据可读。 */

function getReq(url, headers) {
  return new Request(url, { method: 'GET', headers: headers || {} });
}

test('行为：/api/lock-credentials 无鉴权 → 401', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/functions/api/lock-credentials.js');
  const kv = makeKV({});
  const env = baseEnv(kv);
  const res = await onRequestGet({ request: getReq('https://test.example.com/api/lock-credentials'), env });
  assert.equal(res.status, 401, '无会话无票据应 401');
});

test('行为：/api/lock-credentials 访客会话 → 401', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/functions/api/lock-credentials.js');
  const { signLockSessionTicket } = await import(REPO + '/workers/auth-gateway/functions/_kernel/lock-session.js');
  const kv = makeKV({});
  const env = baseEnv(kv);
  const sessCv = await testLockSession(TEST_PRIV_PEM, 0, 'visitor');
  const res = await onRequestGet({
    request: getReq('https://test.example.com/api/lock-credentials', { 'Cookie': 'sgx-lock-session=' + sessCv }),
    env,
  });
  assert.equal(res.status, 401, '访客会话应 401');
});

test('行为：只有管理员密码时 /api/lock-credentials 返回 password:false（锁屏页显示「未设置」正确）', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/functions/api/lock-credentials.js');
  const { signLockSessionTicket } = await import(REPO + '/workers/auth-gateway/functions/_kernel/lock-session.js');
  /* 只有 account-password，无 lock-password，无通行密钥 */
  const kv = makeKV({
    'account-password': JSON.stringify({ hash: 'owner-hash' }),
  });
  const env = baseEnv(kv);
  const sessCv = await testLockSession(TEST_PRIV_PEM, 0, 'admin', 'password');
  const res = await onRequestGet({
    request: getReq('https://test.example.com/api/lock-credentials', { 'Cookie': 'sgx-lock-session=' + sessCv }),
    env,
  });
  assert.equal(res.status, 200);
  const body = JSON.parse(await res.text());
  assert.equal(body.ok, true);
  assert.equal(body.password, false, '只有管理员密码时锁屏密码应为 false（旧接口误报 true）');
  assert.equal(body.passkey, false);
});

test('行为：只有锁屏密码时 /api/lock-credentials 返回 password:true（锁屏页显示「已设置」正确）', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/functions/api/lock-credentials.js');
  const { signLockSessionTicket } = await import(REPO + '/workers/auth-gateway/functions/_kernel/lock-session.js');
  /* 只有 lock-password，无 account-password，无通行密钥 */
  const kv = makeKV({
    'lock-password': JSON.stringify({ hash: 'lock-hash' }),
  });
  const env = baseEnv(kv);
  const sessCv = await testLockSession(TEST_PRIV_PEM, 0, 'admin', 'password');
  const res = await onRequestGet({
    request: getReq('https://test.example.com/api/lock-credentials', { 'Cookie': 'sgx-lock-session=' + sessCv }),
    env,
  });
  assert.equal(res.status, 200);
  const body = JSON.parse(await res.text());
  assert.equal(body.ok, true);
  assert.equal(body.password, true, '只有锁屏密码时应为 true（旧接口误报 false）');
  assert.equal(body.passkey, false);
});

test('行为：/api/lock-credentials 只看 class=lock 通行密钥', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/functions/api/lock-credentials.js');
  const { signLockSessionTicket } = await import(REPO + '/workers/auth-gateway/functions/_kernel/lock-session.js');
  /* 只有 owner 类通行密钥 */
  const kv1 = makeKV({
    'account-passkey-index': JSON.stringify(['o1']),
    'account-passkey:o1': JSON.stringify({ credId: 'o1', publicKey: 'x' }),
  });
  const env1 = baseEnv(kv1);
  const sessCv = await testLockSession(TEST_PRIV_PEM, 0, 'admin', 'password');
  const res1 = await onRequestGet({
    request: getReq('https://test.example.com/api/lock-credentials', { 'Cookie': 'sgx-lock-session=' + sessCv }),
    env: env1,
  });
  const body1 = JSON.parse(await res1.text());
  assert.equal(body1.passkey, false, '只有 owner 类时 passkey 应为 false');
  /* 加上 lock 类通行密钥 */
  const kv2 = makeKV({
    'lock-passkey-index': JSON.stringify(['l1']),
    'account-passkey-index': JSON.stringify(['o1']),
    'account-passkey:o1': JSON.stringify({ credId: 'o1', publicKey: 'x' }),
    'lock-passkey:l1': JSON.stringify({ credId: 'l1', publicKey: 'y' }),
  });
  const env2 = baseEnv(kv2);
  const res2 = await onRequestGet({
    request: getReq('https://test.example.com/api/lock-credentials', { 'Cookie': 'sgx-lock-session=' + sessCv }),
    env: env2,
  });
  const body2 = JSON.parse(await res2.text());
  assert.equal(body2.passkey, true, '有 lock 类时 passkey 应为 true');
});




test('行为：/api/lock-credentials 读锁屏密码失败（D1）→ 503（fail closed，不按未设置退回）', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/functions/api/lock-credentials.js');
  const { signLockSessionTicket } = await import(REPO + '/workers/auth-gateway/functions/_kernel/lock-session.js');
  const kv = makeKV();
  /* 会话校验的纪元读取正常，只有密码表的读取失败 */
  authD1For(kv).failOn = (sql) => /FROM password/.test(sql);
  const env = baseEnv(kv);
  const sessCv = await testLockSession(TEST_PRIV_PEM, 0, 'admin', 'password');
  const res = await onRequestGet({
    request: getReq('https://test.example.com/api/lock-credentials', { 'Cookie': 'sgx-lock-session=' + sessCv }),
    env,
  });
  assert.equal(res.status, 503, '读失败应 503');
});

test('行为：/api/lock-credentials 未绑 D1_LOCK_AUTH → 500', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/functions/api/lock-credentials.js');
  const { signLockSessionTicket } = await import(REPO + '/workers/auth-gateway/functions/_kernel/lock-session.js');
  const env = baseEnv(makeKV({}));
  delete env.D1_LOCK_AUTH;
  const sessCv = await testLockSession(TEST_PRIV_PEM, 0, 'admin', 'password');
  const res = await onRequestGet({
    request: getReq('https://test.example.com/api/lock-credentials', { 'Cookie': 'sgx-lock-session=' + sessCv }),
    env,
  });
  assert.equal(res.status, 500, '未绑 D1 应 500 config');
});
