/**
 * sgx-app 通行证签发测试（主站）。2.10.0 三域拆分版。
 *
 * 格式：owner.epoch.appEpoch.iat.exp.aud.scope.sig（8 段）
 * 密钥只在内存里用 node:crypto 临时生成，不提交、不打印任何密钥值。
 * 另有 tests/fixtures/app-token-vectors.json（与 book 完全相同的测试向量），
 * 本文件断言签发逻辑与向量一致。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { signAppToken, parseAppToken, APP_TOKEN_MAX_AGE, getAppEpoch, onRequest } from '../../functions/api/app-token.js';
import { ed25519Verify } from '../../functions/_kernel/crypto.js';

/* 内存临时密钥对（每次测试运行重新生成） */
function genKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    privPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    pubPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

test('signAppToken 签发 8 段格式并用公钥验签通过', async () => {
  const { privPem, pubPem } = genKeyPair();
  const token = await signAppToken(privPem, 5, 3, 'book', 'upload');
  const parts = token.split('.');
  assert.equal(parts.length, 8, '应为 8 段');
  const parsed = parseAppToken(token);
  assert.ok(parsed, '应能解析');
  assert.equal(parsed.role, 'owner');
  assert.equal(parsed.epoch, 5);
  assert.equal(parsed.appEpoch, 3);
  assert.equal(parsed.aud, 'book');
  assert.equal(parsed.scope, 'upload');
  // exp - iat = 600 秒
  assert.equal(parsed.exp - parsed.iat, 600 * 1000);
  // 验签通过（签名覆盖 sig 之前的完整字符串）
  const payload = ['owner', 5, 3, parsed.iat, parsed.exp, 'book', 'upload'].join('.');
  const ok = await ed25519Verify(pubPem, payload, parsed.sig);
  assert.ok(ok, '验签应通过');
});

test('改动任一段则验签失败', async () => {
  const { privPem, pubPem } = genKeyPair();
  const token = await signAppToken(privPem, 5, 3, 'book', 'upload');
  const parsed = parseAppToken(token);
  // 改 aud
  const tamperedPayload = ['owner', 5, 3, parsed.iat, parsed.exp, 'evil', 'upload'].join('.');
  const ok = await ed25519Verify(pubPem, tamperedPayload, parsed.sig);
  assert.ok(!ok, '改动 aud 后验签应失败');
  // 改 appEpoch
  const tampered2 = ['owner', 5, 9, parsed.iat, parsed.exp, 'book', 'upload'].join('.');
  const ok2 = await ed25519Verify(pubPem, tampered2, parsed.sig);
  assert.ok(!ok2, '改动 appEpoch 后验签应失败');
});

test('parseAppToken 拒绝格式错误的 token', () => {
  assert.equal(parseAppToken(''), null);
  assert.equal(parseAppToken('owner.1.2'), null);
  // 旧 7 段格式不再接受
  assert.equal(parseAppToken('owner.5.1000.1600.book.upload.sig'), null, '旧 7 段格式应被拒');
  assert.equal(parseAppToken('visitor.1.0.1000.2000.book.upload.sig'), null, 'role 必须为 owner');
  assert.equal(parseAppToken('owner.abc.0.1000.2000.book.upload.sig'), null, 'epoch 必须为数字');
});

test('APP_TOKEN_MAX_AGE 为 10 分钟', () => {
  assert.equal(APP_TOKEN_MAX_AGE, 600);
});

test('getAppEpoch：缺失视为 0，KV 出错时抛错', async () => {
  assert.equal(await getAppEpoch({ get: async () => null }, 'book'), 0);
  assert.equal(await getAppEpoch({ get: async () => '3' }, 'book'), 3);
  let threw = false;
  try {
    await getAppEpoch({ get: async () => { throw new Error('kv'); } }, 'book');
  } catch (e) { threw = true; }
  assert.ok(threw, 'KV 出错应抛错（调用方 fail closed）');
});

/* ---- 测试向量一致性（与 book 完全相同的文件） ---- */
/* fixture 里是 base64 DER，转成 PEM 给 crypto 用 */
function derToPem(derB64, label) {
  const b64 = derB64.replace(/\s/g, '');
  const lines = b64.match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}
test('测试向量：有效 token 能解析且字段一致', async () => {
  const vectors = JSON.parse(readFileSync(new URL('../fixtures/app-token-vectors.json', import.meta.url), 'utf8'));
  const privPem = derToPem(vectors.keypair.private, 'PRIVATE KEY');
  const pubPem = derToPem(vectors.keypair.public, 'PUBLIC KEY');
  assert.ok(privPem.includes('PRIVATE KEY'), '应含测试私钥');
  assert.equal(vectors.valid.length, 3);
  for (const token of vectors.valid) {
    const p = parseAppToken(token);
    assert.ok(p, '有效向量应能解析');
    // 用向量自带的公钥验签
    const payload = [p.role, p.epoch, p.appEpoch, p.iat, p.exp, p.aud, p.scope].join('.');
    assert.ok(await ed25519Verify(pubPem, payload, p.sig), '向量签名应通过');
  }
});

test('测试向量：篡改/过期 token 解析后验签失败或过期', async () => {
  const vectors = JSON.parse(readFileSync(new URL('../fixtures/app-token-vectors.json', import.meta.url), 'utf8'));
  const pubPem = derToPem(vectors.keypair.public, 'PUBLIC KEY');
  const t = parseAppToken(vectors.tampered);
  assert.ok(t, '篡改向量应能解析出字段');
  const payload = [t.role, t.epoch, t.appEpoch, t.iat, t.exp, t.aud, t.scope].join('.');
  assert.ok(!(await ed25519Verify(pubPem, payload, t.sig)), '篡改后验签应失败');
  const e = parseAppToken(vectors.expired);
  assert.ok(e && e.exp < Date.now(), '过期向量应已过期');
});

/* ---- onRequest 分支测试 ---- */

function mockRequest(method, body, headers = {}) {
  const h = new Headers();
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return { method, headers: h, json: async () => body };
}

test('onRequest：非 POST 返回 405', async () => {
  const res = await onRequest({ request: mockRequest('GET', {}), env: {} });
  assert.equal(res.status, 405);
});

test('onRequest：Origin 不是主站时 403', async () => {
  const res = await onRequest({
    request: mockRequest('POST', {}, { Origin: 'https://evil.com', 'Content-Type': 'application/json' }),
    env: {},
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'origin');
});

test('onRequest：不在白名单的 aud 注册意图 → 400（需先过会话，此处仅验证白名单常量）', async () => {
  const { getApp } = await import('../../functions/_kernel/app-registry.js');
  assert.equal(getApp('evil'), null, '不在白名单的 aud 应返回 null');
  assert.ok(getApp('book'), 'book 应在白名单');
});

test('validateReturnUrl：origin 假冒被拒（经 app-registry）', async () => {
  const { validateAppReturn, defaultAppReturn } = await import('../../functions/_kernel/app-registry.js');
  assert.equal(validateAppReturn('book', 'https://book.styrigx.com/shelf'), 'https://book.styrigx.com/shelf');
  assert.equal(validateAppReturn('book', 'https://book.styrigx.com.evil.com/'), null);
  assert.equal(validateAppReturn('book', 'https://evil.com/'), null);
  assert.equal(validateAppReturn('book', 'not-a-url'), null);
  assert.equal(defaultAppReturn('book'), 'https://book.styrigx.com/');
  assert.equal(defaultAppReturn('evil'), null);
});

test('APP_COOKIE 属性符合要求', async () => {
  const { APP_COOKIE, APP_COOKIE_ATTRS } = await import('../../functions/api/app-token.js');
  assert.equal(APP_COOKIE, 'sgx-app');
  assert.ok(APP_COOKIE_ATTRS.includes('Domain=.styrigx.com'));
  assert.ok(APP_COOKIE_ATTRS.includes('HttpOnly'));
  assert.ok(APP_COOKIE_ATTRS.includes('Secure'));
  assert.ok(APP_COOKIE_ATTRS.includes('SameSite=Lax'));
  assert.ok(APP_COOKIE_ATTRS.includes('Max-Age=600'));
});

test('A-1：APP_COOKIE_ATTRS 的 Max-Age 拼 APP_TOKEN_MAX_AGE 常量（不硬编码）', async () => {
  const { APP_COOKIE_ATTRS, APP_TOKEN_MAX_AGE } = await import('../../functions/api/app-token.js');
  assert.equal(APP_TOKEN_MAX_AGE, 600);
  assert.ok(APP_COOKIE_ATTRS.includes('Max-Age=' + APP_TOKEN_MAX_AGE), '应拼常量，实际=' + APP_COOKIE_ATTRS);
  /* 源码层面不得再有硬编码的 Max-Age=600（去注释后检查） */
  const src = readFileSync(new URL('../../functions/api/app-token.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!code.includes('Max-Age=600'), '源码不得硬编码 Max-Age=600，应拼 APP_TOKEN_MAX_AGE');
});

test('CI 静态检查：app-token 链路无 stepup/SGX_STEPUP_ 引用', async () => {
  const src = readFileSync(new URL('../../functions/api/app-token.js', import.meta.url), 'utf8');
  // 去掉注释后检查（注释里提到 stepup 是为了解释解耦，不算引用）
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/stepup/i.test(code), 'app-token.js 代码不得出现 stepup');
  assert.ok(!/SGX_STEPUP_/.test(code), 'app-token.js 代码不得读 SGX_STEPUP_*');
});

test('CI 静态检查：app-token 链路不引用 OWNER_KEY（2.10.1：管理密钥不能签 sgx-app）', async () => {
  const src = readFileSync(new URL('../../functions/api/app-token.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/OWNER_KEY/.test(code), 'app-token.js 代码不得引用 OWNER_KEY');
});

test('onRequest：成功签发（2.10.1 B7：verifySessionDetailed 传 env）', async () => {
  // 生成 SGX_LOCK 密钥对（会话）+ SGX_APP 密钥对（签发）
  const { generateKeyPairSync } = await import('node:crypto');
  const lockKp = generateKeyPairSync('ed25519');
  const lockPrivPem = lockKp.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const lockPubPem = lockKp.publicKey.export({ type: 'spki', format: 'pem' });
  const appKp = generateKeyPairSync('ed25519');
  const appPrivPem = appKp.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const appPubPem = appKp.publicKey.export({ type: 'spki', format: 'pem' });

  // 用会话模块签一个合法的 owner 会话 cookie
  const { signSessionCookie } = await import('../../functions/_kernel/session.js');
  const sessVal = await signSessionCookie(lockPrivPem, 7, 'owner', 'owner');

  // mock KV：session-epoch=7，app-auth 记录有效
  const store = new Map();
  store.set('session-epoch', '7');
  store.set('app-auth:testcid123', JSON.stringify({ aud: 'book', exp: Date.now() + 60000 }));
  const kv = {
    get: async (k, fmt) => {
      const v = store.get(k);
      if (v === undefined) return null;
      return fmt === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v) => { store.set(k, v); },
    delete: async (k) => { store.delete(k); },
  };

  const h = new Headers();
  h.set('Origin', 'https://styrigx.com');
  h.set('Content-Type', 'application/json');
  h.set('Cookie', 'sgx-verified=' + sessVal);
  const req = {
    method: 'POST',
    headers: h,
    url: 'https://styrigx.com/api/app-token',
    json: async () => ({ action: 'issue', aud: 'book', scope: 'upload', appCid: 'testcid123' }),
  };
  const env = {
    OWNER_KV: kv,
    SGX_LOCK_PUBLIC: lockPubPem,
    SGX_APP_PRIVATE: appPrivPem,
  };
  const res = await onRequest({ request: req, env });
  assert.equal(res.status, 200, '合法会话 + 合法 app-auth 应签发成功（B7 修复前这里 403）');
  const j = await res.json();
  assert.ok(j.ok, '应返回 ok:true');
  const setCookie = res.headers.get('Set-Cookie') || '';
  assert.ok(setCookie.includes('sgx-app='), '应设置 sgx-app cookie');
  // 用 app 公钥验签 cookie 里的 token
  const m = setCookie.match(/sgx-app=([^;]+)/);
  assert.ok(m, '应能提取 token');
  const p = parseAppToken(m[1]);
  assert.ok(p, 'token 应能解析');
  assert.equal(p.aud, 'book');
  assert.equal(p.scope, 'upload');
  const payload = [p.role, p.epoch, p.appEpoch, p.iat, p.exp, p.aud, p.scope].join('.');
  assert.ok(await ed25519Verify(appPubPem, payload, p.sig), '签发 token 验签应通过');
});

test('onRequest：revoke 清除 sgx-app cookie（需 owner 会话，2.11）', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const lockKp = generateKeyPairSync('ed25519');
  const lockPrivPem = lockKp.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const lockPubPem = lockKp.publicKey.export({ type: 'spki', format: 'pem' });
  const { signSessionCookie } = await import('../../functions/_kernel/session.js');
  const sessVal = await signSessionCookie(lockPrivPem, 7, 'owner', 'owner');
  const store = new Map();
  store.set('session-epoch', '7');
  const kv = {
    get: async (k, fmt) => {
      const v = store.get(k);
      if (v === undefined) return null;
      return fmt === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v) => { store.set(k, v); },
    delete: async (k) => { store.delete(k); },
  };
  const h = new Headers();
  h.set('Origin', 'https://styrigx.com');
  h.set('Content-Type', 'application/json');
  h.set('Cookie', 'sgx-verified=' + sessVal);
  const req = {
    method: 'POST',
    headers: h,
    url: 'https://styrigx.com/api/app-token',
    json: async () => ({ action: 'revoke' }),
  };
  const env = { OWNER_KV: kv, SGX_LOCK_PUBLIC: lockPubPem };
  const res = await onRequest({ request: req, env });
  assert.equal(res.status, 200, '合法 owner 会话应允许 revoke');
  const j = await res.json();
  assert.ok(j.ok, '应返回 ok:true');
  const setCookie = res.headers.get('Set-Cookie') || '';
  assert.ok(setCookie.includes('sgx-app='), '应清除 sgx-app cookie');
  assert.ok(setCookie.includes('Max-Age=0'), '应立即过期');
  assert.ok(setCookie.includes('Domain=.styrigx.com'), 'Domain 与签发时一致');
  assert.ok(setCookie.includes('HttpOnly'), 'HttpOnly 与签发时一致');
});

test('onRequest：revoke 无会话 → 403', async () => {
  const res = await onRequest({
    request: mockRequest('POST', { action: 'revoke' }, { Origin: 'https://styrigx.com', 'Content-Type': 'application/json' }),
    env: {},
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'forbidden');
});
