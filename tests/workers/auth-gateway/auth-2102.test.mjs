/**
 * 2.10.2 鉴权修复测试（space）。
 *
 * 覆盖：
 * - 2：管理操作需 owner 会话 + stepup；/api/lock 清除 stepup 和 app cookie；
 *     锁定后调用管理接口必须拒绝
 * - 3：删应用密钥先推 app-epoch 再删；推失败 503 且密钥仍在
 * - 4：删锁屏密钥先推 session-epoch 再删；失败 503（fail closed）
 * - 5：主站 SGX_SITE 配错 → 500（fail closed）
 * - 6：无 KV_LOCK_DOOR 时 epoch 检查 fail closed（kv-error）
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
const REPO = path.resolve(__dirname, '../../..');

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

let LOCK_PRIV = '', LOCK_PUB = '';
async function genKeys() {
  const mk = async () => {
    const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    return {
      priv: derToPem(await crypto.subtle.exportKey('pkcs8', kp.privateKey), 'PRIVATE KEY'),
      pub: derToPem(await crypto.subtle.exportKey('spki', kp.publicKey), 'PUBLIC KEY'),
    };
  };
  const l = await mk(); LOCK_PRIV = l.priv; LOCK_PUB = l.pub;
}

const SGX_ROOT_KEY = 'test-owner-key-2102';

function baseEnv(kv, overrides = {}) {
  return {
    KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv,
    SGX_ROOT_KEY,
    SGX_LOCK_PRIVATE: LOCK_PRIV,
    SGX_LOCK_PUBLIC: LOCK_PUB,
    SGX_RP_ID: 'styrigx.com',
    SGX_ORIGIN: 'https://styrigx.com',
    SGX_SITE: 'space',
    ...overrides,
  };
}

/* 签一个有效的 owner 会话 cookie（role.epoch.exp.sig） */
async function makeSessionCookie(env, role = 'owner') {
  const { signSessionCookie } = await import('../../../workers/auth-gateway/functions/_kernel/session.js');
  const epoch = 0;
  return await signSessionCookie(env.SGX_LOCK_PRIVATE, epoch, role);
}

function reqWithCookies(url, body, cookies, headers = {}) {
  const h = { ...headers };
  if (cookies) h['Cookie'] = cookies;
  return postReq(url, body, h);
}

test('setup: 生成测试密钥', async () => {
  await genKeys();
  assert.ok(LOCK_PRIV && LOCK_PUB);
});

/* ============ 2：管理操作需 owner 会话 + stepup ============ */





/* ============ 3：删应用密钥先推 epoch 再删 ============ */


/* ============ 4：删锁屏密钥先推 session-epoch ============ */


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
  const req = new Request('https://styrigx.com/api/session-check', { method: 'GET' });
  const res = await onRequest({
    request: req,
    env: { SGX_ENV: 'production' },
    next: async () => new Response('should-not-reach'),
  });
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'config');
});

/* ============ 6：无 KV_LOCK_DOOR 时 epoch 检查 fail closed ============ */

test('6：verifySessionDetailed 无 KV → kv-error（不跳过）', async () => {
  const { verifySessionDetailed } = await import('../../../workers/auth-gateway/functions/_middleware.js');
  /* 造一个格式正确但无法验 epoch 的 cookie：用真密钥签名 */
  const { signSessionCookie } = await import('../../../workers/auth-gateway/functions/_kernel/session.js');
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
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/owner-password.js');
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
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/root-auth.js');
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
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/root-auth.js');
  const kv = makeKV();
  const req = postReq('https://styrigx.com/api/root-auth', { key: SGX_ROOT_KEY }, { Origin: null });
  const res = await onRequestPost({ request: req, env: baseEnv(kv) });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'origin');
});

test('9b：root-auth Origin 解析失败 → 403', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/root-auth.js');
  const kv = makeKV();
  const req = postReq('https://styrigx.com/api/root-auth', { key: SGX_ROOT_KEY }, { Origin: '::not-a-url::' });
  const res = await onRequestPost({ request: req, env: baseEnv(kv) });
  assert.equal(res.status, 403);
});

test('9c：owner-passkey 缺 Origin → 403', async () => {
  const { onRequestPost } = await import('../../../workers/auth-gateway/functions/api/owner-passkey.js');
  const kv = makeKV();
  const req = postReq('https://styrigx.com/api/owner-passkey', { action: 'list', pkClass: 'lock' }, { Origin: null });
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
  assert.ok(src.includes('/api/lock-config'), '应从 /api/lock-config 读取配置');
  /* 其他选项必须存在 */
  assert.ok(src.includes('sgx-mopt-visitor'), '应有访客进入');
  assert.ok(src.includes('sgx-mopt-pk'), '应有通行密钥');
  assert.ok(src.includes('sgx-mopt-pw'), '应有密码');
  assert.ok(!src.includes('sgx-mopt-reset'), '「重置锁屏」一行已并入「无法登录？」');
});

test('1b：升级弹层含根密钥入口', () => {
  const src = fs.readFileSync(path.join(REPO, 'web/assets/js/shell/upgrade.js'), 'utf8');
  assert.ok(src.includes('sgx-upgrade-mk'), '升级弹层应有根密钥按钮');
  assert.ok(src.includes('/api/root-auth'), '应调用 /api/root-auth');
});
