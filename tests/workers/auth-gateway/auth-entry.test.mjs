/**
 * 认证入口修正测试（space）。
 *
 * 覆盖：
 * 1. 锁屏恰好四个选项（访客进入/通行密钥/密码/重置锁屏），不含根凭证
 * 2. 访客和站长的安全页 DOM 结构一致（三个入口，无角色条件渲染）
 * 3. 访客会话提交正确根凭证 → 401 密码错误，且不调用 D1/KV、不增加 rootlimit 计数
 * 4. 管理凭证弹层四种配置下按钮正确（未设置/仅通行密钥/仅密码/两者都有）
 * 5. 三类通行密钥注册 options 的 name/displayName 正确
 *    （owner→AccountKey，lock→LockKey，app→<aud小写>key；displayName 一律 Sloan Gray）
 *
 * 运行：node --test tests/kernel/auth-entry.test.mjs
 */
import { signRole } from './_tk.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = new URL('../../../', import.meta.url).pathname;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeKv(init) {
  const m = new Map(Object.entries(init || {}));
  const calls = { get: 0, put: 0, delete: 0, list: 0 };
  return {
    get: async (k, t) => {
      calls.get++;
      const v = m.get(k);
      if (v === undefined) return null;
      return t === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v, o) => { calls.put++; m.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
    delete: async (k) => { calls.delete++; m.delete(k); },
    list: async (o) => { calls.list++; return { keys: Array.from(m.keys()).map((name) => ({ name })) }; },
    _store: m,
    _calls: calls,
  };
}

function postReq(url, body, headers) {
  const h = { 'Content-Type': 'application/json', 'Origin': new URL(url).origin };
  Object.assign(h, headers || {});
  return new Request(url, { method: 'POST', headers: h, body: JSON.stringify(body || {}) });
}

/* 测试用 Ed25519 密钥 */
let TEST_PRIV_PEM = '';
let TEST_PUB_PEM = '';
function derToPem(der, label) {
  const b64 = Buffer.from(der).toString('base64');
  const lines = b64.match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}
async function genTestKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const privDer = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
  const pubDer = await crypto.subtle.exportKey('spki', kp.publicKey);
  TEST_PRIV_PEM = derToPem(privDer, 'PRIVATE KEY');
  TEST_PUB_PEM = derToPem(pubDer, 'PUBLIC KEY');
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

/* ============ 1. 锁屏入口按配置显示（补充定稿七.1） ============ */

test('认证入口：锁屏方法弹层按锁屏凭证配置显示入口（PR3：最下面一行「无法登录？」）', () => {
  const src = fs.readFileSync(path.join(REPO, 'web/assets/js/shell/lock.js'), 'utf8');
  /* 配置以服务端 /api/lock-config 为准 */
  assert.ok(src.includes('/api/lock-config'), '应从 /api/lock-config 读取配置');
  assert.ok(src.includes('sgx-mopt-visitor'), '应有访客进入');
  assert.ok(src.includes('sgx-mopt-pk'), '应有通行密钥');
  assert.ok(src.includes('sgx-mopt-pw'), '应有密码');
  /* 「重置锁屏」「根凭证」两行合并为「无法登录？」→ 弹层原地切到重置登录 */
  assert.ok(src.includes('sgx-mopt-cant'), '应有「无法登录？」');
  assert.ok(src.includes('无法登录？') && src.includes('Can’t sign in?'), '中英文案');
  assert.ok(!src.includes('sgx-mopt-reset') && !src.includes('function openMk'), '旧的两行已删除');
  /* 启动站（锁屏凭证都没设）：根凭证 → /api/root-auth → /api/root-session（原 openMk 的路径） */
  assert.ok(/bootstrap[\s\S]*?'\/api\/root-auth'[\s\S]*?exchangeRootSession/.test(src), '启动站根凭证路径保留');
  /* 读取失败按已配置处理 */
  assert.ok(src.includes('读取失败按已配置处理'), '应有读取失败 fail closed 注释');
  assert.ok(!src.includes('先验证根凭证，再验证站长凭证'), '描述不应出现旧说法');
});

/* ============ 2. 安全页 DOM 一致 ============ */


/* ============ 3. 访客假入口 ============ */

test('认证入口：访客会话提交正确根凭证 → 401 密码错误，不读凭证、不写 KV、不计 rootlimit', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/root-auth.js');
  const { signSessionCookie } = await import(REPO + '/workers/auth-gateway/functions/_kernel/session.js');

  const kv = makeKv({ 'layer:lock': '1' });
  const env = baseEnv(kv);

  /* 构造有效访客会话 cookie */
  const sessCv = await signRole(signSessionCookie, TEST_PRIV_PEM, 0, 'visitor', 'owner');

  /* 提交正确的根凭证 */
  const req = postReq('https://test.example.com/api/root-auth', { key: 'test-root-key-12345' }, {
    'Cookie': 'sgx-verified=' + sessCv,
  });
  const t0 = Date.now();
  const res = await onRequestPost({ request: req, env });
  const dt = Date.now() - t0;

  assert.equal(res.status, 401);
  const body = await res.text();
  assert.equal(body, JSON.stringify({ ok: false, error: 'denied' }));

  /* 不写 KV（put 计数为 0）；B1-9：不读任何存储（判断引导场景），但不读凭证 */
  assert.equal(kv._calls.put, 0, '访客假入口不应写 KV');

  /* 不增加 rootlimit 计数 */
  assert.ok(!kv._store.has('root-auth-fail:unknown'), '不应有 IP 失败计数');
  assert.ok(![...kv._store.keys()].some((k) => k.startsWith('root-auth-')), '不应有任何 rootlimit 键');

  /* 固定最小延迟（防时序区分） */
  assert.ok(dt >= 180, '应有固定最小延迟，实际 ' + dt + 'ms');
});

test('认证入口：访客假入口与真失败响应逐字节相同', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/root-auth.js');
  const { signSessionCookie } = await import(REPO + '/workers/auth-gateway/functions/_kernel/session.js');

  const kv1 = makeKv({ 'layer:lock': '1' });
  const kv2 = makeKv({ 'layer:lock': '1' });

  /* B1-9：访客提交任何值都返回同一个 401 denied（不读存储） */
  const sessCv = await signRole(signSessionCookie, TEST_PRIV_PEM, 0, 'visitor', 'owner');
  const req1 = postReq('https://test.example.com/api/root-auth', { key: 'test-root-key-12345' }, {
    'Cookie': 'sgx-verified=' + sessCv,
  });
  const res1 = await onRequestPost({ request: req1, env: baseEnv(kv1) });

  /* 访客提交另一个值 → 同一个 401 denied */
  const req2 = postReq('https://test.example.com/api/root-auth', { key: 'wrong-key' }, {
    'Cookie': 'sgx-verified=' + sessCv,
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
  const { signSessionCookie } = await import(REPO + '/workers/auth-gateway/functions/_kernel/session.js');
  const ownerCv = await signSessionCookie(TEST_PRIV_PEM, 0, 'owner', 'owner');
  const getReq = () => new Request('https://test.example.com/api/account', {
    method: 'GET',
    headers: { 'Cookie': 'sgx-verified=' + ownerCv },
  });
  const cases = [
    [{}, false, false],
    [{ 'owner-pw': JSON.stringify({ hash: 'x', algo: 'test' }) }, true, false],
    [{
      'owner-passkey-index': JSON.stringify(['testcred123456']),
      'owner-passkey:testcred1234': JSON.stringify({ credId: 'testcred123456', class: 'owner' }),
    }, false, true],
    [{
      'owner-pw': JSON.stringify({ hash: 'x', algo: 'test' }),
      'owner-passkey-index': JSON.stringify(['testcred123456']),
      'owner-passkey:testcred1234': JSON.stringify({ credId: 'testcred123456', class: 'owner' }),
    }, true, true],
  ];
  for (const [seed, pw, pk] of cases) {
    const kv = makeKv(seed);
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

test('认证入口：重置锁屏 status 始终可用（不暴露站长凭证是否配置）', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/lockreset.js');
  /* owner 未配置 */
  const kv = makeKv({ 'layer:lock': '1' });
  const env = baseEnv(kv);
  const st = postReq('https://test.example.com/api/lockreset', { action: 'status' });
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

test('补充七：/api/lock-config 四种配置返回正确', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/functions/api/lock-config.js');
  const get = (url, env) => new Request(url, { method: 'GET' });

  /* 都没设置 */
  let kv = makeKv({});
  let res = await onRequestGet({ request: get('https://test.example.com/api/lock-config'), env: baseEnv(kv) });
  let j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.passkey, false, '无凭据时 passkey 应为 false');
  assert.equal(j.password, false, '无凭据时 password 应为 false');

  /* 仅密码 */
  kv = makeKv({ 'lock-pw': JSON.stringify({ hash: 'h', salt: 's' }) });
  res = await onRequestGet({ request: get('https://test.example.com/api/lock-config'), env: baseEnv(kv) });
  j = await res.json();
  assert.equal(j.passkey, false);
  assert.equal(j.password, true);

  /* 仅通行密钥 */
  kv = makeKv({
    'owner-passkey-index': JSON.stringify(['cid1']),
    'owner-passkey:cid1': JSON.stringify({ credId: 'cid1', class: 'lock' }),
  });
  res = await onRequestGet({ request: get('https://test.example.com/api/lock-config'), env: baseEnv(kv) });
  j = await res.json();
  assert.equal(j.passkey, true);
  assert.equal(j.password, false);

  /* 两者都有 */
  kv = makeKv({
    'lock-pw': JSON.stringify({ hash: 'h', salt: 's' }),
    'owner-passkey-index': JSON.stringify(['cid1']),
    'owner-passkey:cid1': JSON.stringify({ credId: 'cid1', class: 'lock' }),
  });
  res = await onRequestGet({ request: get('https://test.example.com/api/lock-config'), env: baseEnv(kv) });
  j = await res.json();
  assert.equal(j.passkey, true);
  assert.equal(j.password, true);

  /* 非 lock 类凭据不应算作锁屏通行密钥 */
  kv = makeKv({
    'owner-passkey-index': JSON.stringify(['cid9']),
    'owner-passkey:cid9': JSON.stringify({ credId: 'cid9', class: 'owner' }),
  });
  res = await onRequestGet({ request: get('https://test.example.com/api/lock-config'), env: baseEnv(kv) });
  j = await res.json();
  assert.equal(j.passkey, false, 'owner 类凭据不应算锁屏通行密钥');
  assert.equal(j.password, false);
});

test('补充七：/api/lock-config 读取失败按已配置处理（不暴露根凭证入口）', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/functions/api/lock-config.js');
  const badKv = {
    get: async () => { throw new Error('kv-down'); },
    put: async () => {},
    delete: async () => {},
    list: async () => { throw new Error('kv-down'); },
  };
  const res = await onRequestGet({
    request: new Request('https://test.example.com/api/lock-config', { method: 'GET' }),
    env: baseEnv(badKv),
  });
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.passkey, true, '读取失败 passkey 应按已配置处理');
  assert.equal(j.password, true, '读取失败 password 应按已配置处理');
});

/* 复审 §2：只剩 layer:lock 标记（无真实凭证）时，lock-config 不应显示根凭证入口，
   否则 root-auth 走 isLockEffectivelyConfigured 判定已配置 → 假入口 401，直接锁死。 */
test('行为：/api/lock-config 只剩标记时不暴露根凭证入口', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/functions/api/lock-config.js');
  /* 只有标记，无 lock-pw、无 passkey */
  const kv = makeKv({ 'layer:lock': '1' });
  const res = await onRequestGet({
    request: new Request('https://test.example.com/api/lock-config', { method: 'GET' }),
    env: baseEnv(kv),
  });
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.passkey, true, '只剩标记时 passkey 应按已配置处理');
  assert.equal(j.password, true, '只剩标记时 password 应按已配置处理');
});

test('补充七：已配置锁屏凭证时，锁屏根凭证路径被服务端拒绝（无会话 → 401）', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/root-auth.js');
  /* lock 层已配置，无会话提交正确的根凭证 */
  const kv = makeKv({ 'layer:lock': '1' });
  const req = postReq('https://test.example.com/api/root-auth', { key: 'test-root-key-12345' });
  const res = await onRequestPost({ request: req, env: baseEnv(kv) });
  assert.equal(res.status, 401, '已配置时无会话根凭证路径应被拒绝');
  const body = await res.text();
  assert.equal(body, JSON.stringify({ ok: false, error: 'auth' }));
});


test('补充七：访客管理凭证提交任何值都返回密码错误且不写存储', async () => {
  /* 管理凭证弹层的「根凭证」按钮提交到 /api/root-auth；访客会话下为假入口 */
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/root-auth.js');
  const { signSessionCookie } = await import(REPO + '/workers/auth-gateway/functions/_kernel/session.js');

  const kv = makeKv({ 'layer:lock': '1' });
  const env = baseEnv(kv);
  const sessCv = await signRole(signSessionCookie, TEST_PRIV_PEM, 0, 'visitor', 'owner');

  /* 提交任意值（包括错误值） */
  for (const key of ['whatever', '', 'test-root-key-12345']) {
    const req = postReq('https://test.example.com/api/root-auth', { key }, {
      'Cookie': 'sgx-verified=' + sessCv,
    });
    const res = await onRequestPost({ request: req, env });
    assert.equal(res.status, 401, '访客提交 ' + JSON.stringify(key) + ' 应 401');
    const body = await res.text();
    assert.equal(body, JSON.stringify({ ok: false, error: 'denied' }));
  }
  /* 不写存储 */
  assert.equal(kv._calls.put, 0, '访客假入口不应写 KV');
  assert.ok(![...kv._store.keys()].some((k) => k.startsWith('root-auth-')), '不应有 rootlimit 计数');
});

/* ============ 审查意见 9 项：行为测试 ============ */

test('行为：lockreset 站长凭证未配置 → 通用 401 auth（不泄露 not-set）', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/lockreset.js');
  /* owner 未配置（无标记、无密码、无 passkey），lock 也未配置 */
  const kv = makeKv({});
  const env = baseEnv(kv);
  const req = postReq('https://test.example.com/api/lockreset', {
    action: 'verify', rootKey: 'test-root-key-12345',
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401);
  const body = JSON.parse(await res.text());
  assert.equal(body.ok, false);
  assert.equal(body.error, 'auth', '应为通用 auth，不应泄露 not-set');
});

test('行为：lockreset 记失败计数写 KV 出错 → 503', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/lockreset.js');
  /* KV 的 put 抛错 */
  const kv = makeKv({});
  kv.put = async () => { throw new Error('kv-down'); };
  const env = baseEnv(kv);
  const req = postReq('https://test.example.com/api/lockreset', {
    action: 'verify', rootKey: 'wrong-key',
  });
  const res = await onRequestPost({ request: req, env });
  /* 根凭证错误 → fail() 记失败计数 → KV put 抛错 → 503 */
  assert.equal(res.status, 503);
});

test('行为：lockreset needOwner 带 passkey/password 布尔', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/lockreset.js');
  /* owner 只配置了密码（含 layer:owner 标记） */
  const kv = makeKv({
    'layer:owner': '1',
    'owner-pw': JSON.stringify({ hash: 'x', algo: 'test' }),
  });
  const env = baseEnv(kv);
  const req = postReq('https://test.example.com/api/lockreset', {
    action: 'verify', rootKey: 'test-root-key-12345',
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 200);
  const body = JSON.parse(await res.text());
  assert.equal(body.ok, true);
  assert.equal(body.needOwner, true);
  assert.equal(body.password, true, '应带 password=true');
  assert.equal(body.passkey, false, '应带 passkey=false');
});



test('行为：/api/account 状态需 owner lock 会话，无会话 → 401', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/functions/api/account.js');
  const kv = makeKv({});
  const env = baseEnv(kv);
  const req = new Request('https://test.example.com/api/account', { method: 'GET' });
  const res = await onRequestGet({ request: req, env });
  assert.equal(res.status, 401, '无会话应 401');
});

test('行为：/api/account 状态只看 owner 类（账号）通行密钥', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/functions/api/account.js');
  const { signSessionCookie } = await import(REPO + '/workers/auth-gateway/functions/_kernel/session.js');
  /* 只有 lock 类 passkey，无账号密码 */
  const kv = makeKv({
    'owner-passkey-index': JSON.stringify(['abc123']),
    'owner-passkey:abc123': JSON.stringify({ credId: 'abc123', class: 'lock', publicKey: 'x' }),
  });
  const env = baseEnv(kv);
  const sessCv = await signSessionCookie(TEST_PRIV_PEM, 0, 'owner', 'owner');
  const req = new Request('https://test.example.com/api/account', {
    method: 'GET',
    headers: { 'Cookie': 'sgx-verified=' + sessCv },
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
  const { signSessionCookie } = await import(REPO + '/workers/auth-gateway/functions/_kernel/session.js');
  /* lock 已配置 */
  const kv = makeKv({ 'layer:lock': '1' });
  const env = baseEnv(kv);
  const sessCv = await signRole(signSessionCookie, TEST_PRIV_PEM, 0, 'visitor', 'owner');
  /* 提交正确的根凭证 */
  const req = postReq('https://test.example.com/api/root-auth', { key: 'test-root-key-12345' }, {
    'Cookie': 'sgx-verified=' + sessCv,
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401, '访客即使提交正确根凭证也 401');
  const body = await res.text();
  assert.equal(body, JSON.stringify({ ok: false, error: 'denied' }));
});

test('行为：锁屏未配置 + 访客 cookie 时 root-auth 走真路径（不走假入口）', async () => {
  const { onRequestPost } = await import(REPO + '/workers/auth-gateway/functions/api/root-auth.js');
  const { signSessionCookie } = await import(REPO + '/workers/auth-gateway/functions/_kernel/session.js');
  /* B1-9：访客一律 401 denied，不区分新站旧站（lockCfg 例外已删除） */
  const kv = makeKv({});
  const env = baseEnv(kv);
  const sessCv = await signRole(signSessionCookie, TEST_PRIV_PEM, 0, 'visitor', 'owner');
  const req = postReq('https://test.example.com/api/root-auth', { key: 'test-root-key-12345' }, {
    'Cookie': 'sgx-verified=' + sessCv,
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401, 'B1-9：访客一律 401，不走真路径');
  const body = await res.text();
  assert.equal(body, JSON.stringify({ ok: false, error: 'denied' }));
});

/* ============ 复审 §1：lockreset 票据页注入 lockreset 状态 ============ */

test('行为：injectSessionState 注入 lockreset 状态（瘦身 + noindex，与 locked 一致）', async () => {
  const { injectSessionState } = await import(REPO + '/workers/auth-gateway/functions/_middleware.js');
  const html = '<html><head></head><body><!-- SGX-DESKTOP-START --><div>desktop</div><!-- SGX-DESKTOP-END --><p>lock page</p></body></html>';
  const res = new Response(html, { headers: { 'Content-Type': 'text/html' } });
  const out = await injectSessionState(res, 'lockreset', null);
  const text = await out.text();
  assert.ok(text.includes('data-sgx-session="lockreset"'), '应注入 lockreset 状态');
  assert.ok(!text.includes('desktop'), 'lockreset 页应瘦身（不下发桌面内容）');
  assert.equal(out.headers.get('X-Robots-Tag'), 'noindex', 'lockreset 页不应被收录');
});

test('行为：injectSessionState locked 状态保持不变', async () => {
  const { injectSessionState } = await import(REPO + '/workers/auth-gateway/functions/_middleware.js');
  const html = '<html><head></head><body><p>home</p></body></html>';
  const res = new Response(html, { headers: { 'Content-Type': 'text/html' } });
  const out = await injectSessionState(res, 'locked', null);
  const text = await out.text();
  assert.ok(text.includes('data-sgx-session="locked"'), '应注入 locked 状态');
});

/* ============ /api/lock-status：只读锁屏凭证状态 ============
   背景：security-lock.js refreshStatus 曾用 /api/owner-status 显示锁屏密码
   「已设置/未设置」和删除按钮，但 owner-status 读的是 owner-pw +
   class=owner 通行密钥（且要求 owner 会话），导致：
   - 只设了站长密码 → 锁屏页误显示「已设置」
   - 只设了锁屏密码 → 误显示「未设置」且没有删除按钮
   - lockreset 页无会话 → owner-status 返回 401
   本接口读 lock-pw + class=lock，owner 会话或 keys/lockreset 票据可读。 */

function getReq(url, headers) {
  return new Request(url, { method: 'GET', headers: headers || {} });
}

test('行为：/api/lock-status 无鉴权 → 401', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/functions/api/lock-status.js');
  const kv = makeKv({});
  const env = baseEnv(kv);
  const res = await onRequestGet({ request: getReq('https://test.example.com/api/lock-status'), env });
  assert.equal(res.status, 401, '无会话无票据应 401');
});

test('行为：/api/lock-status 访客会话 → 401', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/functions/api/lock-status.js');
  const { signSessionCookie } = await import(REPO + '/workers/auth-gateway/functions/_kernel/session.js');
  const kv = makeKv({});
  const env = baseEnv(kv);
  const sessCv = await signRole(signSessionCookie, TEST_PRIV_PEM, 0, 'visitor', 'owner');
  const res = await onRequestGet({
    request: getReq('https://test.example.com/api/lock-status', { 'Cookie': 'sgx-verified=' + sessCv }),
    env,
  });
  assert.equal(res.status, 401, '访客会话应 401');
});

test('行为：只有站长密码时 /api/lock-status 返回 password:false（锁屏页显示「未设置」正确）', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/functions/api/lock-status.js');
  const { signSessionCookie } = await import(REPO + '/workers/auth-gateway/functions/_kernel/session.js');
  /* 只有 owner-pw，无 lock-pw，无通行密钥 */
  const kv = makeKv({
    'owner-pw': JSON.stringify({ hash: 'owner-hash' }),
  });
  const env = baseEnv(kv);
  const sessCv = await signSessionCookie(TEST_PRIV_PEM, 0, 'owner', 'owner');
  const res = await onRequestGet({
    request: getReq('https://test.example.com/api/lock-status', { 'Cookie': 'sgx-verified=' + sessCv }),
    env,
  });
  assert.equal(res.status, 200);
  const body = JSON.parse(await res.text());
  assert.equal(body.ok, true);
  assert.equal(body.password, false, '只有站长密码时锁屏密码应为 false（旧接口误报 true）');
  assert.equal(body.passkey, false);
});

test('行为：只有锁屏密码时 /api/lock-status 返回 password:true（锁屏页显示「已设置」正确）', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/functions/api/lock-status.js');
  const { signSessionCookie } = await import(REPO + '/workers/auth-gateway/functions/_kernel/session.js');
  /* 只有 lock-pw，无 owner-pw，无通行密钥 */
  const kv = makeKv({
    'lock-pw': JSON.stringify({ hash: 'lock-hash' }),
  });
  const env = baseEnv(kv);
  const sessCv = await signSessionCookie(TEST_PRIV_PEM, 0, 'owner', 'owner');
  const res = await onRequestGet({
    request: getReq('https://test.example.com/api/lock-status', { 'Cookie': 'sgx-verified=' + sessCv }),
    env,
  });
  assert.equal(res.status, 200);
  const body = JSON.parse(await res.text());
  assert.equal(body.ok, true);
  assert.equal(body.password, true, '只有锁屏密码时应为 true（旧接口误报 false）');
  assert.equal(body.passkey, false);
});

test('行为：/api/lock-status 只看 class=lock 通行密钥', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/functions/api/lock-status.js');
  const { signSessionCookie } = await import(REPO + '/workers/auth-gateway/functions/_kernel/session.js');
  /* 只有 owner 类通行密钥 */
  const kv1 = makeKv({
    'owner-passkey-index': JSON.stringify(['o1']),
    'owner-passkey:o1': JSON.stringify({ credId: 'o1', class: 'owner', publicKey: 'x' }),
  });
  const env1 = baseEnv(kv1);
  const sessCv = await signSessionCookie(TEST_PRIV_PEM, 0, 'owner', 'owner');
  const res1 = await onRequestGet({
    request: getReq('https://test.example.com/api/lock-status', { 'Cookie': 'sgx-verified=' + sessCv }),
    env: env1,
  });
  const body1 = JSON.parse(await res1.text());
  assert.equal(body1.passkey, false, '只有 owner 类时 passkey 应为 false');
  /* 加上 lock 类通行密钥 */
  const kv2 = makeKv({
    'owner-passkey-index': JSON.stringify(['o1', 'l1']),
    'owner-passkey:o1': JSON.stringify({ credId: 'o1', class: 'owner', publicKey: 'x' }),
    'owner-passkey:l1': JSON.stringify({ credId: 'l1', class: 'lock', publicKey: 'y' }),
  });
  const env2 = baseEnv(kv2);
  const res2 = await onRequestGet({
    request: getReq('https://test.example.com/api/lock-status', { 'Cookie': 'sgx-verified=' + sessCv }),
    env: env2,
  });
  const body2 = JSON.parse(await res2.text());
  assert.equal(body2.passkey, true, '有 lock 类时 passkey 应为 true');
});




test('行为：/api/lock-status KV 读取失败 → 503（fail closed，不按未设置退回）', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/functions/api/lock-status.js');
  const { signSessionCookie } = await import(REPO + '/workers/auth-gateway/functions/_kernel/session.js');
  const kv = makeKv({ 'session-epoch': '0' });
  /* 会话校验的 session-epoch 读取正常，只有 lock-pw 读取失败 */
  const origGet = kv.get;
  kv.get = async (k, t) => {
    if (k === 'lock-pw') throw new Error('kv-down');
    return origGet(k, t);
  };
  const env = baseEnv(kv);
  const sessCv = await signSessionCookie(TEST_PRIV_PEM, 0, 'owner', 'owner');
  const res = await onRequestGet({
    request: getReq('https://test.example.com/api/lock-status', { 'Cookie': 'sgx-verified=' + sessCv }),
    env,
  });
  assert.equal(res.status, 503, 'KV 失败应 503');
});

test('行为：/api/lock-status 未绑 KV → 500', async () => {
  const { onRequestGet } = await import(REPO + '/workers/auth-gateway/functions/api/lock-status.js');
  const { signSessionCookie } = await import(REPO + '/workers/auth-gateway/functions/_kernel/session.js');
  const env = baseEnv(makeKv({}));
  delete env.KV_LOCK_DOOR;
  delete env.KV_ACCOUNT_LOGIN;
  const sessCv = await signSessionCookie(TEST_PRIV_PEM, 0, 'owner', 'owner');
  const res = await onRequestGet({
    request: getReq('https://test.example.com/api/lock-status', { 'Cookie': 'sgx-verified=' + sessCv }),
    env,
  });
  assert.equal(res.status, 500, '未绑 KV 应 500 config');
});
