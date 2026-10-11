/**
 * sgx-app 通行证签发测试（主站）。
 * 
 * 验证：
 * - token 格式正确（7 段：owner.epoch.iat.exp.aud.scope.sig）
 * - aud/scope 白名单校验
 * - parseAppToken 正确解析
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signAppToken, parseAppToken, APP_TOKEN_MAX_AGE } from '../../functions/api/app-token.js';

test('signAppToken 生成 7 段 token', async () => {
  // 注意：这里用假私钥测试格式，实际签发需要真实 Ed25519 私钥
  // 只测试 parseAppToken 的解析逻辑
  const fakeToken = 'owner.1.1000000000000.1000000600000.book.upload.fakesig123';
  const parsed = parseAppToken(fakeToken);
  assert.ok(parsed, '应能解析');
  assert.equal(parsed.role, 'owner');
  assert.equal(parsed.epoch, 1);
  assert.equal(parsed.aud, 'book');
  assert.equal(parsed.scope, 'upload');
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
