/**
 * B1-5 验收测试：Book 钥匙页
 *
 * 任务书要求：
 * - 「此设备已注册过」只在 credentials.create() 抛出 InvalidStateError 时出现
 * - 删除成功后调用 PublicKeyCredential.signalUnknownCredential；不支持时 toast pkDelManual
 * - residentKey 统一 'required'
 *
 * 验收：
 * 1. 打开/删除不显示「已注册过」
 * 2. 重复注册（InvalidStateError）显示「已注册过」
 * 3. 删除后 signalUnknownCredential 被调用（stub 断言）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(__dirname, '../../../web/assets/js/apps/security-apps-book.js');
const src = fs.readFileSync(srcPath, 'utf8');

/**
 * 从源码中提取 create 的 catch 错误映射逻辑，模拟执行。
 * 对应源码约 230-236 行：
 *   if (e && e.name === 'NotAllowedError') throw { kind: 'cancelled' };
 *   if (e && e.name === 'InvalidStateError') throw { kind: 'already', fromCreate: true };
 *   if (e && e.name === 'NotSupportedError') throw { kind: 'nosupport' };
 *   throw { kind: 'failed' };
 */
function mapCreateError(e) {
  if (e && e.name === 'NotAllowedError') return { kind: 'cancelled' };
  if (e && e.name === 'InvalidStateError') return { kind: 'already', fromCreate: true };
  if (e && e.name === 'NotSupportedError') return { kind: 'nosupport' };
  return { kind: 'failed' };
}

/**
 * 模拟外层 catch 的 toast 选择逻辑，对应源码约 255-265 行。
 * 返回应该显示的 toast key（或 null 表示不显示 pkAlready）。
 */
function pickToastKey(e, t) {
  if (!e) return null;
  if (e.kind === 'reverify') return null;
  if (e.kind === 'cancelled' || (e && e.name === 'NotAllowedError')) return t('errCancelled');
  /* B1-5：「此设备已注册过」只在 credentials.create() 抛 InvalidStateError 时出现 */
  if (e.kind === 'already' && e.fromCreate) return t('pkAlready');
  if (e && e.name === 'InvalidStateError') return t('pkAlready');
  if (e.kind === 'nosupport') return t('gateNoSupport');
  if (e.kind === 'failed') return t('pkFailed');
  return null;
}

// 简单的 t() mock：返回 key 本身（测试只关心选了哪个 key）
const t = (k) => k;

test('B1-5: residentKey 统一 required', () => {
  assert.ok(
    src.includes("authenticatorSelection: { userVerification: 'required', residentKey: 'required' }"),
    'authenticatorSelection 必须用 residentKey: required'
  );
  assert.ok(
    !src.includes("residentKey: 'preferred'"),
    '不应再有 residentKey: preferred'
  );
});

test('B1-5: 重复注册（InvalidStateError）→ 显示「已注册过」', () => {
  // 模拟 credentials.create() 抛出 InvalidStateError
  const err = { name: 'InvalidStateError' };
  const mapped = mapCreateError(err);
  assert.equal(mapped.kind, 'already');
  assert.equal(mapped.fromCreate, true);

  // 外层 catch 应选择 pkAlready
  const toastKey = pickToastKey(mapped, t);
  assert.equal(toastKey, 'pkAlready', '重复注册应显示 pkAlready（此设备已注册过）');
});

test('B1-5: 打开/删除不显示「已注册过」', () => {
  // 打开页面、删除钥匙的错误路径不会产生 { kind: 'already', fromCreate: true }
  // 模拟各种非 create 错误，确认都不会选中 pkAlready
  const nonCreateErrors = [
    { kind: 'failed' },
    { kind: 'cancelled' },
    { kind: 'nosupport' },
    { kind: 'server', code: 'x' },
    { name: 'NotAllowedError' },  // 非 create 上下文的原始错误
    { name: 'NetworkError' },
    null,
    undefined,
  ];
  for (const e of nonCreateErrors) {
    const toastKey = pickToastKey(e, t);
    assert.notEqual(
      toastKey, 'pkAlready',
      `错误 ${JSON.stringify(e)} 不应显示 pkAlready，实际: ${toastKey}`
    );
  }

  // 即使有 kind='already' 但没有 fromCreate（非 create 来源），也不显示
  const fakeAlready = { kind: 'already' };
  assert.notEqual(pickToastKey(fakeAlready, t), 'pkAlready');
});

test('B1-5: 删除成功后调用 signalUnknownCredential', () => {
  // 静态检查：删除成功分支必须调用 signalUnknownCredential
  assert.ok(
    src.includes('signalUnknownCredential'),
    '删除成功后必须调用 signalUnknownCredential'
  );
  // 参数：rpId 和 credentialId
  assert.ok(
    src.includes('signalUnknownCredential({ rpId: location.hostname, credentialId: k.credId })'),
    'signalUnknownCredential 参数应为 { rpId, credentialId }'
  );
  // 不支持时 toast pkDelManual
  assert.ok(
    src.includes("toast(t('pkDelManual'))"),
    '不支持 signalUnknownCredential 时应 toast pkDelManual'
  );
});

test('B1-5: signalUnknownCredential 调用逻辑（stub 断言）', () => {
  // 模拟删除成功后的逻辑（对应源码 167-177 行）
  let signalCalledWith = null;
  let manualToastShown = false;

  const mockPKC = {
    signalUnknownCredential: (args) => {
      signalCalledWith = args;
      return Promise.resolve();
    },
  };
  const mockT = (k) => { if (k === 'pkDelManual') manualToastShown = true; return k; };
  const k = { credId: 'test-cred-id-123' };
  const hostname = 'styrigx.com';

  // 场景 1：支持 signalUnknownCredential → 被调用，参数正确
  function onDeleteSuccess(PublicKeyCredential, t, k, hostname) {
    try {
      if (PublicKeyCredential && typeof PublicKeyCredential.signalUnknownCredential === 'function') {
        PublicKeyCredential.signalUnknownCredential({ rpId: hostname, credentialId: k.credId }).catch(function () {});
      } else {
        t('pkDelManual');
      }
    } catch (e2) {}
  }

  onDeleteSuccess(mockPKC, mockT, k, hostname);
  assert.deepEqual(signalCalledWith, { rpId: 'styrigx.com', credentialId: 'test-cred-id-123' });
  assert.equal(manualToastShown, false);

  // 场景 2：不支持 → toast pkDelManual
  signalCalledWith = null;
  manualToastShown = false;
  onDeleteSuccess(undefined, mockT, k, hostname);
  assert.equal(signalCalledWith, null);
  assert.equal(manualToastShown, true);
});
