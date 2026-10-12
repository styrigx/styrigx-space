/**
 * 2.10.2 鉴权修复测试（space）。
 *
 * 覆盖：
 * - 2：管理操作需 owner 会话 + stepup；/api/lock 清除 stepup 和 app cookie；
 *     锁定后调用管理接口必须拒绝
 * - 3：删应用密钥先推 app-epoch 再删；推失败 503 且密钥仍在
 * - 4：删锁屏密钥先推 session-epoch 再删；失败 503（fail closed）
 * - 5：主站 SGX_SITE 配错 → 500（fail closed）
 * - 6：无 OWNER_KV 时 epoch 检查 fail closed（kv-error）
 * - 7：密码限速 KV 出错 → 503（fail closed）
 * - 8：管理密钥审计写入失败 → 不签发会话，503
 * - 9：Origin 缺失/解析失败 → 403
 * - 1：锁屏/升级弹层的管理密钥入口（静态检查：按钮和 handler 存在）
 *
 * 运行：node --test tests/kernel/auth-2102.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');

/* ---- 简易 KV mock ---- */
function makeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  const kv = {
    get: async (k, fmt) => {
      if (kv._fail) throw new Error('kv-fail');
      const v = m.has(k) ? m.get(k) : null;
      if (v === null || v === undefined) return null;
      return fmt === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v, opts) => {
      if (kv._fail) throw new Error('kv-fail');
      m.set(k, v);
    },
    delete: async (k) => { m.delete(k); },
    list: async () => ({ keys: [...m.keys()].map((name) => ({ name })) }),
    _map: m,
    _fail: false,
  };
  return kv;
}

function postReq(url, body, headers = {}) {
  /* 真实浏览器 POST 必带 Origin；传 Origin: null 可测缺失场景 */
  const h = { 'Content-Type': 'application/json', 'Origin': 'https://styrigx.com', ...headers };
  if (headers.Origin === null) delete h['Origin'];
  return new Request(url, {
    method: 'POST',
    headers: h,
    body: JSON.stringify(body),
  });
}

function derToPem(der, label) {
  const b64 = Buffer.from(der).toString('base64');
  const lines = b64.match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

let LOCK_PRIV = '', LOCK_PUB = '', STEPUP_PRIV = '', STEPUP_PUB = '';
async function genKeys() {
  const mk = async () => {
    const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    return {
      priv: derToPem(await crypto.subtle.exportKey('pkcs8', kp.privateKey), 'PRIVATE KEY'),
      pub: derToPem(await crypto.subtle.exportKey('spki', kp.publicKey), 'PUBLIC KEY'),
    };
  };
  const l = await mk(); LOCK_PRIV = l.priv; LOCK_PUB = l.pub;
  const s = await mk(); STEPUP_PRIV = s.priv; STEPUP_PUB = s.pub;
}

const SGX_ROOT_KEY = 'test-owner-key-2102';

function baseEnv(kv, overrides = {}) {
  return {
    OWNER_KV: kv,
    SGX_ROOT_KEY,
    SGX_LOCK_PRIVATE: LOCK_PRIV,
    SGX_LOCK_PUBLIC: LOCK_PUB,
    SGX_STEPUP_PRIVATE: STEPUP_PRIV,
    SGX_STEPUP_PUBLIC: STEPUP_PUB,
    SGX_RP_ID: 'styrigx.com',
    SGX_ORIGIN: 'https://styrigx.com',
    SGX_SITE: 'space',
    ...overrides,
  };
}

/* 签一个有效的 owner 会话 cookie（role.epoch.exp.sig） */
async function makeSessionCookie(env, role = 'owner') {
  const { signSessionCookie } = await import('../../functions/_kernel/session.js');
  const epoch = 0;
  return await signSessionCookie(env.SGX_LOCK_PRIVATE, epoch, role);
}

/* 签一个有效的 sgx-stepup cookie */
async function makeStepupCookie(env) {
  const { signStepupCookie } = await import('../../functions/api/stepup.js');
  return await signStepupCookie(env.SGX_STEPUP_PRIVATE, 'owner', 'keys', 0);
}

function reqWithCookies(url, body, cookies, headers = {}) {
  const h = { ...headers };
  if (cookies) h['Cookie'] = cookies;
  return postReq(url, body, h);
}

test('setup: 生成测试密钥', async () => {
  await genKeys();
  assert.ok(LOCK_PRIV && STEPUP_PRIV);
});

/* ============ 2：管理操作需 owner 会话 + stepup ============ */

test('2a：owner-passkey list 只有 stepup 没有会话 → 401', async () => {
  const { onRequestPost } = await import('../../functions/api/owner-passkey.js');
  const kv = makeKV();
  const env = baseEnv(kv);
  const stepup = await makeStepupCookie(env);
  const req = reqWithCookies('https://styrigx.com/api/owner-passkey', { action: 'list' }, `sgx-stepup=${stepup}`);
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401, '无 owner 会话时 list 应 401');
  assert.equal((await res.json()).error, 'session');
});

test('2b：owner-passkey list 有会话没有 stepup → 403 stepup-required', async () => {
  const { onRequestPost } = await import('../../functions/api/owner-passkey.js');
  const kv = makeKV();
  const env = baseEnv(kv);
  const sess = await makeSessionCookie(env);
  const req = reqWithCookies('https://styrigx.com/api/owner-passkey', { action: 'list' }, `sgx-verified=${sess}`);
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'stepup-required');
});

test('2c：owner-password change 只有 stepup 没有会话 → 401（2.11：需 kind=lock）', async () => {
  const { onRequestPost } = await import('../../functions/api/owner-password.js');
  const kv = makeKV();
  const env = baseEnv(kv);
  const stepup = await makeStepupCookie(env);
  const req = reqWithCookies('https://styrigx.com/api/owner-password', { action: 'change', kind: 'lock', newPassword: 'newpass123' }, `sgx-stepup=${stepup}`);
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401, '无 owner 会话时 change 应 401');
});

test('2d：/api/lock 清除 sgx-stepup 和 sgx-app', async () => {
  const { onRequestPost } = await import('../../functions/api/lock.js');
  const req = postReq('https://styrigx.com/api/lock', {});
  const res = await onRequestPost({ request: req, env: {} });
  assert.equal(res.status, 200);
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('Set-Cookie')];
  const all = cookies.join(';');
  assert.ok(all.includes('sgx-verified=;'), '应清除 sgx-verified');
  assert.ok(all.includes('sgx-stepup=;'), '2.10.2：应清除 sgx-stepup');
  assert.ok(all.includes('sgx-app=;'), '2.10.2：应清除 sgx-app');
});

/* ============ 3：删应用密钥先推 epoch 再删 ============ */

test('3：bumpAppEpoch 失败 → 503 且密钥仍在', async () => {
  const { onRequestPost } = await import('../../functions/api/owner-passkey.js');
  const kv = makeKV();
  const env = baseEnv(kv);
  /* 预置一把 app 类密钥 */
  const credId = 'testcredid12';
  await kv.put('owner-passkey:' + credId.slice(0, 12), JSON.stringify({
    credId, name: 'book', class: 'app', aud: 'book', publicKey: {}, signCount: 0,
  }));
  await kv.put('owner-passkey-index', JSON.stringify([credId]));
  const sess = await makeSessionCookie(env);
  const stepup = await makeStepupCookie(env);
  /* 让 bumpAppEpoch 的 put 失败：第一次 put（bump）时抛错 */
  let puts = 0;
  const origPut = kv.put.bind(kv);
  kv.put = async (k, v, o) => {
    puts++;
    if (k === 'app-epoch:book') throw new Error('kv-fail');
    return origPut(k, v, o);
  };
  const req = reqWithCookies('https://styrigx.com/api/owner-passkey',
    { action: 'delete', credId }, `sgx-verified=${sess}; sgx-stepup=${stepup}`);
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 503, 'epoch 推进失败应 503');
  /* 密钥必须还在 */
  const still = await kv.get('owner-passkey:' + credId.slice(0, 12), 'json');
  assert.ok(still && still.credId === credId, '2.10.2/B9：epoch 失败时密钥不得被删');
});

/* ============ 4：删锁屏密钥先推 session-epoch ============ */

test('4：session-epoch 推进失败 → 503 且密钥仍在（fail closed）', async () => {
  const { onRequestPost } = await import('../../functions/api/owner-passkey.js');
  const kv = makeKV();
  const env = baseEnv(kv);
  const credId = 'lockcredid12';
  await kv.put('owner-passkey:' + credId.slice(0, 12), JSON.stringify({
    credId, name: 'lock1', class: 'lock', publicKey: {}, signCount: 0,
  }));
  await kv.put('owner-passkey:' + 'lockcredid34'.slice(0, 12), JSON.stringify({
    credId: 'lockcredid34', name: 'lock2', class: 'lock', publicKey: {}, signCount: 0,
  }));
  await kv.put('owner-passkey-index', JSON.stringify([credId, 'lockcredid34']));
  await kv.put('owner-pw', JSON.stringify({ hash: 'x' })); /* 有密码，不触发 last-key */
  const sess = await makeSessionCookie(env);
  const stepup = await makeStepupCookie(env);
  const origPut = kv.put.bind(kv);
  kv.put = async (k, v, o) => {
    if (k === 'session-epoch') throw new Error('kv-fail');
    return origPut(k, v, o);
  };
  const req = reqWithCookies('https://styrigx.com/api/owner-passkey',
    { action: 'delete', credId }, `sgx-verified=${sess}; sgx-stepup=${stepup}`);
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 503, 'session-epoch 失败应 503');
  const still = await kv.get('owner-passkey:' + credId.slice(0, 12), 'json');
  assert.ok(still && still.credId === credId, 'epoch 失败时密钥不得被删');
});

/* ============ 5：SGX_SITE 配错 fail closed ============ */

test('5：SGX_SITE=blog 时主站 middleware 拒绝（500）', async () => {
  const { onRequest } = await import('../../functions/_middleware.js');
  const req = new Request('https://styrigx.com/settings/', { method: 'GET' });
  const res = await onRequest({
    request: req,
    env: { SGX_SITE: 'blog', SGX_ENV: 'production' },
    next: async () => new Response('should-not-reach'),
  });
  assert.equal(res.status, 500, '配错站点名应 fail closed');
});

test('5b：SGX_SITE 缺失时主站 middleware 拒绝（500）', async () => {
  const { onRequest } = await import('../../functions/_middleware.js');
  const req = new Request('https://styrigx.com/api/session-check', { method: 'GET' });
  const res = await onRequest({
    request: req,
    env: { SGX_ENV: 'production' },
    next: async () => new Response('should-not-reach'),
  });
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'config');
});

/* ============ 6：无 OWNER_KV 时 epoch 检查 fail closed ============ */

test('6：verifySessionDetailed 无 KV → kv-error（不跳过）', async () => {
  const { verifySessionDetailed } = await import('../../functions/_middleware.js');
  /* 造一个格式正确但无法验 epoch 的 cookie：用真密钥签名 */
  const { signSessionCookie } = await import('../../functions/_kernel/session.js');
  const val = await signSessionCookie(LOCK_PRIV, 0, 'owner', 'owner');
  const req = new Request('https://styrigx.com/', {
    headers: { 'Cookie': 'sgx-verified=' + val },
  });
  const r = await verifySessionDetailed(req, { SGX_LOCK_PUBLIC: LOCK_PUB });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'kv-error', '2.10.2：无 KV 不得跳过 epoch 检查');
});

/* ============ 7：密码限速 KV 出错 → 503 ============ */

test('7：verify 时限速 KV 出错 → 503', async () => {
  const { onRequestPost } = await import('../../functions/api/owner-password.js');
  const kv = makeKV();
  kv._fail = true; /* 所有 KV 操作抛错 */
  const env = baseEnv(kv);
  const req = postReq('https://styrigx.com/api/owner-password', { action: 'verify', password: 'x' });
  const res = await onRequestPost({ request: req, env });
  /* isLocked 的 KV 出错 → 503（不再静默放行） */
  assert.equal(res.status, 503);
});

/* ============ 8：审计写入失败 → 不签发会话 ============ */

test('8：root-auth 审计写入失败 → 503 且无 cookie', async () => {
  const { onRequestPost } = await import('../../functions/api/root-auth.js');
  const kv = makeKV();
  const env = baseEnv(kv);
  /* 让审计 put 失败：root-auth-audit: 前缀抛错，其他放行 */
  const origPut = kv.put.bind(kv);
  kv.put = async (k, v, o) => {
    if (String(k).startsWith('root-auth-audit:')) throw new Error('audit-fail');
    return origPut(k, v, o);
  };
  const req = postReq('https://styrigx.com/api/root-auth', { key: SGX_ROOT_KEY });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 503, '审计失败应 503');
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const all = (cookies || []).join(';');
  assert.ok(!all.includes('sgx-verified='), '审计失败不得签发会话');
});

/* ============ 9：Origin 缺失/解析失败 → 403 ============ */

test('9a：root-auth 缺 Origin → 403', async () => {
  const { onRequestPost } = await import('../../functions/api/root-auth.js');
  const kv = makeKV();
  const req = postReq('https://styrigx.com/api/root-auth', { key: SGX_ROOT_KEY }, { Origin: null });
  const res = await onRequestPost({ request: req, env: baseEnv(kv) });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'origin');
});

test('9b：root-auth Origin 解析失败 → 403', async () => {
  const { onRequestPost } = await import('../../functions/api/root-auth.js');
  const kv = makeKV();
  const req = postReq('https://styrigx.com/api/root-auth', { key: SGX_ROOT_KEY }, { Origin: '::not-a-url::' });
  const res = await onRequestPost({ request: req, env: baseEnv(kv) });
  assert.equal(res.status, 403);
});

test('9c：owner-passkey 缺 Origin → 403', async () => {
  const { onRequestPost } = await import('../../functions/api/owner-passkey.js');
  const kv = makeKV();
  const req = postReq('https://styrigx.com/api/owner-passkey', { action: 'list' }, { Origin: null });
  const res = await onRequestPost({ request: req, env: baseEnv(kv) });
  assert.equal(res.status, 403);
});

test('9d：stepup 缺 Origin → 403', async () => {
  const { onRequestPost } = await import('../../functions/api/stepup.js');
  const kv = makeKV();
  const req = postReq('https://styrigx.com/api/stepup', { action: 'status' }, { Origin: null });
  const res = await onRequestPost({ request: req, env: baseEnv(kv) });
  assert.equal(res.status, 403);
});

/* ============ 1：管理密钥入口静态检查 ============ */

test('1a：锁屏方法弹层按配置显示入口（补充定稿七.1：都没设置时才有根凭证）', () => {
  const src = fs.readFileSync(path.join(REPO, 'assets/js/shell/lock.js'), 'utf8');
  /* 根凭证选项仅在锁屏凭证都没设置时显示 */
  assert.ok(src.includes('sgx-mopt-mk'), '应有根凭证选项按钮（条件显示）');
  assert.ok(src.includes('function openMk'), '应有 openMk 处理函数');
  assert.ok(src.includes('使用根凭证解锁站长模式'), '根凭证小字');
  /* 配置以服务端为准 */
  assert.ok(src.includes('/api/lock-config'), '应从 /api/lock-config 读取配置');
  /* 其他选项必须存在 */
  assert.ok(src.includes('sgx-mopt-visitor'), '应有访客进入');
  assert.ok(src.includes('sgx-mopt-pk'), '应有通行密钥');
  assert.ok(src.includes('sgx-mopt-pw'), '应有密码');
  assert.ok(src.includes('sgx-mopt-reset'), '应有重置锁屏');
});

test('1b：升级弹层含根密钥入口', () => {
  const src = fs.readFileSync(path.join(REPO, 'assets/js/shell/upgrade.js'), 'utf8');
  assert.ok(src.includes('sgx-upgrade-mk'), '升级弹层应有根密钥按钮');
  assert.ok(src.includes('/api/root-auth'), '应调用 /api/root-auth');
});
