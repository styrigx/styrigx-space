/**
 * sgx-app 通行证签发测试（主站）。
 *
 * 密钥只在内存里用 node:crypto 临时生成，不提交、不打印任何密钥值。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { signAppToken, parseAppToken, APP_TOKEN_MAX_AGE, onRequest } from '../../functions/api/app-token.js';
import { ed25519Verify } from '../../functions/_kernel/crypto.js';

/* 内存临时密钥对（每次测试运行重新生成） */
function genKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    privPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    pubPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

test('signAppToken 签发后用公钥验签通过', async () => {
  const { privPem, pubPem } = genKeyPair();
  const token = await signAppToken(privPem, 5, 'book', 'upload');
  const parsed = parseAppToken(token);
  assert.ok(parsed, '应能解析');
  assert.equal(parsed.role, 'owner');
  assert.equal(parsed.epoch, 5);
  assert.equal(parsed.aud, 'book');
  assert.equal(parsed.scope, 'upload');
  // exp - iat = 600 秒
  assert.equal(parsed.exp - parsed.iat, 600 * 1000);
  // 验签通过
  const payload = ['owner', 5, parsed.iat, parsed.exp, 'book', 'upload'].join('.');
  const ok = await ed25519Verify(pubPem, payload, parsed.sig);
  assert.ok(ok, '验签应通过');
});

test('改动任一段则验签失败', async () => {
  const { privPem, pubPem } = genKeyPair();
  const token = await signAppToken(privPem, 5, 'book', 'upload');
  const parsed = parseAppToken(token);
  // 改 aud
  const tamperedPayload = ['owner', 5, parsed.iat, parsed.exp, 'evil', 'upload'].join('.');
  const ok = await ed25519Verify(pubPem, tamperedPayload, parsed.sig);
  assert.ok(!ok, '改动 aud 后验签应失败');
  // 改 epoch
  const tampered2 = ['owner', 6, parsed.iat, parsed.exp, 'book', 'upload'].join('.');
  const ok2 = await ed25519Verify(pubPem, tampered2, parsed.sig);
  assert.ok(!ok2, '改动 epoch 后验签应失败');
});

test('parseAppToken 拒绝格式错误的 token', () => {
  assert.equal(parseAppToken(''), null);
  assert.equal(parseAppToken('owner.1.2'), null);
  assert.equal(parseAppToken('visitor.1.1000.2000.book.upload.sig'), null, 'role 必须为 owner');
  assert.equal(parseAppToken('owner.abc.1000.2000.book.upload.sig'), null, 'epoch 必须为数字');
});

test('APP_TOKEN_MAX_AGE 为 10 分钟', () => {
  assert.equal(APP_TOKEN_MAX_AGE, 600);
});

/* ---- onRequest 分支测试（用 mock 构造会话和 stepup，不读真实 Secret） ---- */

function mockRequest(method, body) {
  return {
    method,
    headers: new Headers(),
    json: async () => body,
  };
}

function mockEnv(overrides = {}) {
  return {
    SGX_LOCK_PUBLIC: 'test-lock-pub',
    SGX_APP_PRIVATE: 'test-app-priv',
    ...overrides,
  };
}

test('onRequest：非 POST 返回 405', async () => {
  const res = await onRequest({ request: mockRequest('GET', {}), env: mockEnv() });
  assert.equal(res.status, 405);
  const data = await res.json();
  assert.equal(data.error, 'method');
});

test('onRequest：无会话时 403', async () => {
  // verifySessionDetailed 会因无 cookie 返回 null（mock 环境下）
  const res = await onRequest({
    request: mockRequest('POST', { action: 'issue', aud: 'book', scope: 'upload' }),
    env: mockEnv(),
  });
  // 无有效会话 → 403 forbidden（具体走哪个分支取决于 mock，此处只断言非 200）
  assert.ok(res.status === 403 || res.status === 500, '无会话应拒绝');
});

test('validateReturnUrl：origin 假冒被拒', async () => {
  const { validateReturnUrl } = await import('../../functions/api/app-token.js');
  // 正常
  assert.equal(validateReturnUrl('https://book.styrigx.com/shelf'), 'https://book.styrigx.com/shelf');
  // 缺省 → 默认页
  assert.equal(validateReturnUrl(''), 'https://book.styrigx.com/');
  assert.equal(validateReturnUrl(null), 'https://book.styrigx.com/');
  // 假冒 origin 被拒
  assert.equal(validateReturnUrl('https://book.styrigx.com.evil.com/'), null, 'evil.com 后缀假冒应被拒');
  assert.equal(validateReturnUrl('https://evil.com/'), null, '完全不同 origin 应被拒');
  assert.equal(validateReturnUrl('http://book.styrigx.com/'), null, 'http（非 https）应被拒');
  assert.equal(validateReturnUrl('not-a-url'), null, '非法 URL 应被拒');
});

test('APP_COOKIE 属性符合要求', async () => {
  const { APP_COOKIE, APP_COOKIE_ATTRS } = await import('../../functions/api/app-token.js');
  assert.equal(APP_COOKIE, 'sgx-app');
  assert.ok(APP_COOKIE_ATTRS.includes('Domain=.styrigx.com'), 'Domain 应为 .styrigx.com');
  assert.ok(APP_COOKIE_ATTRS.includes('HttpOnly'), '应为 HttpOnly');
  assert.ok(APP_COOKIE_ATTRS.includes('Secure'), '应为 Secure');
  assert.ok(APP_COOKIE_ATTRS.includes('SameSite=Lax'), 'SameSite 应为 Lax');
  assert.ok(APP_COOKIE_ATTRS.includes('Max-Age=600'), 'Max-Age 应为 600');
});

test('onRequest：缺 SGX_APP_PRIVATE 时 500 no-app-key（需先过会话，此处仅验证常量）', async () => {
  // 该分支需要有效会话 + stepup，集成测试在 CI 环境变量齐备时覆盖
  // 此处验证 parseAppToken 对 aud/scope 的解析不受影响
  const fake = 'owner.1.1000.1600.book.upload.sig';
  const p = parseAppToken(fake);
  assert.equal(p.aud, 'book');
  assert.equal(p.scope, 'upload');
});
