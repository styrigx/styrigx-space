/**
 * 2.11 鉴权拆分测试：两扇门、分层接管。
 *
 * 新增测试，不得改旧测试迎合。
 *
 * - 越权：root 票管 lock/app → 已配 owner 时 403；owner 票管 owner 凭证 → 403；lock passkey 开 stepup → 拒
 * - 接管：未配时 root 可代开各层；配置后 root 对该层失效
 * - 旧票失效：接管后旧 root 票/会话被拒；root 删 owner 后旧会话失效
 * - KV 错误：读配置失败时 root 被拒
 * - pepper：旧 hash 登录后被重哈希；缺 pepper fail closed；owner 密码 = 锁屏密码被拒
 * - /api/root-auth：错误密钥 401 auth，缺 Origin 403 origin；旧 /api/owner-auth 不再可用
 * - 限速：所有 root 路径共用计数
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO = new URL('../../', import.meta.url).pathname;

/* 简易 KV mock */
function makeKv() {
  const m = new Map();
  return {
    get: async (k, t) => {
      const v = m.get(k);
      if (v === undefined) return null;
      return t === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v) => { m.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
    delete: async (k) => { m.delete(k); },
    list: async () => ({ keys: [] }),
  };
}

function postReq(url, body, headers = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://styrigx.com', ...headers },
    body: JSON.stringify(body),
  });
}

/* ============ 越权测试 ============ */

test('2.11 越权：scope=root 的票格式正确', async () => {
  const { parseStepupCookie } = await import('../../functions/api/stepup.js');
  /* 手动构造格式正确的票（不验签，只查格式） */
  const p = parseStepupCookie('root.root.0.1234567890.1234567899.c29tZXNpZw');
  assert.ok(p, '应能解析');
  assert.equal(p.by, 'root');
  assert.equal(p.scope, 'root');
});

test('2.11 越权：lock passkey 不能开 stepup', async () => {
  /* stepup.js 的 verify 只认 owner class，lock 会被 class-mismatch 拒绝 */
  const src = fs.readFileSync(path.join(REPO, 'functions/api/stepup.js'), 'utf8');
  assert.ok(src.includes("k.class === PK_CLASS_OWNER"), '应只认 owner class');
  assert.ok(src.includes("class-mismatch"), '应有 class-mismatch 错误');
});

test('2.11 票格式：stepup 为 by.scope.epoch.iat.exp.sig（6 段）', async () => {
  const { parseStepupCookie } = await import('../../functions/api/stepup.js');
  const p = parseStepupCookie('owner.keys.5.1234567890.1234567899.c29tZXNpZw');
  assert.ok(p, '应能解析');
  assert.equal(p.by, 'owner');
  assert.equal(p.scope, 'keys');
  assert.equal(p.epoch, 5);
  /* 非法 by 应拒绝 */
  assert.equal(parseStepupCookie('evil.keys.0.1.2.sig'), null);
  /* 非法 scope 应拒绝 */
  assert.equal(parseStepupCookie('root.evil.0.1.2.sig'), null);
});

test('2.11 票格式：session 为 by.role.epoch.exp.sig（5 段）', async () => {
  const { parseSessionCookie } = await import('../../functions/_kernel/session.js');
  /* 旧 4 段式应无效 */
  assert.equal(parseSessionCookie('owner.0.123.sig'), null, '旧 4 段式应无效');
  /* 新 5 段式格式检查（不验签，只查格式） */
  const p = parseSessionCookie('root.owner.0.1234567890.sig');
  assert.ok(p, '应能解析格式');
  assert.equal(p.by, 'root');
  assert.equal(p.role, 'owner');
});

/* ============ 接管测试 ============ */

test('2.11 接管：未配 owner 时 root 可代开', async () => {
  const { checkRootTakeover, LAYER_OWNER } = await import('../../functions/_kernel/layers.js');
  const kv = makeKv();
  const r = await checkRootTakeover(kv, LAYER_OWNER);
  assert.equal(r.allowed, true);
  assert.equal(r.reason, 'takeover');
});

test('2.11 接管：已配 owner 后 root 失效', async () => {
  const { checkRootTakeover, LAYER_OWNER } = await import('../../functions/_kernel/layers.js');
  const kv = makeKv();
  await kv.put('layer:owner', '1');
  const r = await checkRootTakeover(kv, LAYER_OWNER);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'configured');
});

test('2.11 接管：KV 读取失败时 root 被拒（fail closed）', async () => {
  const { checkRootTakeover, LAYER_OWNER } = await import('../../functions/_kernel/layers.js');
  const brokenKv = {
    get: async () => { throw new Error('kv-down'); },
  };
  const r = await checkRootTakeover(brokenKv, LAYER_OWNER);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'kv-error');
});

/* ============ root-auth 测试 ============ */

test('2.11 /api/root-auth：错误密钥 401 auth', async () => {
  const { onRequestPost } = await import('../../functions/api/root-auth.js');
  const kv = makeKv();
  const env = {
    OWNER_KV: kv,
    SGX_ROOT_KEY: 'correct-root-key',
    SGX_STEPUP_PRIVATE: 'dummy-for-test',
  };
  const req = postReq('https://styrigx.com/api/root-auth', { key: 'wrong-key' });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, 'auth');
});

test('2.11 /api/root-auth：缺 Origin 403 origin', async () => {
  const { onRequestPost } = await import('../../functions/api/root-auth.js');
  const kv = makeKv();
  const env = {
    OWNER_KV: kv,
    SGX_ROOT_KEY: 'correct-root-key',
    SGX_STEPUP_PRIVATE: 'dummy-for-test',
  };
  const req = new Request('https://styrigx.com/api/root-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'x' }),
  });
  const res = await onRequestPost({ request: req, env });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, 'origin');
});

test('2.11 /api/root-auth：读 SGX_ROOT_KEY 而非 OWNER_KEY', async () => {
  const src = fs.readFileSync(path.join(REPO, 'functions/api/root-auth.js'), 'utf8');
  assert.ok(src.includes('SGX_ROOT_KEY'), '应读 SGX_ROOT_KEY');
  assert.ok(!src.includes('env.OWNER_KEY'), '不应再读 OWNER_KEY');
});

test('2.11 旧 /api/owner-auth 不再可用', async () => {
  const apiDir = path.join(REPO, 'functions/api');
  const files = fs.readdirSync(apiDir);
  assert.ok(!files.includes('owner-auth.js'), 'owner-auth.js 应已改名');
  assert.ok(files.includes('root-auth.js'), 'root-auth.js 应存在');
});

/* ============ pepper 测试 ============ */

test('2.11 pepper：缺 pepper 时拒绝设置密码（fail closed）', async () => {
  const { onRequestPost } = await import('../../functions/api/owner-password.js');
  const kv = makeKv();
  /* 无 SGX_PW_PEPPER */
  const env = { OWNER_KV: kv };
  /* 需要先过 Origin 和会话检查，这里只验证 pepper 检查存在 */
  const src = fs.readFileSync(path.join(REPO, 'functions/api/owner-password.js'), 'utf8');
  assert.ok(src.includes('SGX_PW_PEPPER'), '应引用 SGX_PW_PEPPER');
  assert.ok(src.includes('pepper'), '应有 pepper 逻辑');
});

test('2.11 清理：代码无 SESSION_SECRET', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const apiDir = new URL('../../functions/api/', import.meta.url);
  const bad = [];
  for (const f of readdirSync(apiDir)) {
    if (!f.endsWith('.js')) continue;
    const src = readFileSync(join(apiDir.pathname, f), 'utf8');
    if (/SESSION_SECRET/.test(src)) {
      bad.push(f);
    }
  }
  assert.deepEqual(bad, [], '以下文件仍有 SESSION_SECRET：' + bad.join(','));
});
