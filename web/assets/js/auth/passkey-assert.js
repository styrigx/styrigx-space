/**
 * @fileoverview B1-2：通行密钥断言公共函数。
 * 调 credentials.get() 前临时隐藏验证弹层（不关闭、不重置状态），
 * 拿到结果或失败后再恢复。30 秒总超时（AbortController + WebAuthn timeout 双保险）。
 * 抛出带 kind 的错误：cancelled（已取消）/ timeout（超时）/ nokey（无匹配钥匙）/ failed（其他）。
 */
import { b64urlToBuf, bufToB64url } from '../lib/b64.js';
import { loadI18n } from '../lib/i18n.js';

/**
 * @param {object} options WebAuthn get options（publicKey 部分）
 * @param {object} [opts]
 * @param {HTMLElement} [opts.hideEl] 调用前临时隐藏的元素
 * @returns {Promise<PublicKeyCredential>}
 */
export async function getPasskeyAssertion(options, opts) {
  const hideEl = opts && opts.hideEl;
  const startTime = Date.now();
  let hidden = false;

  /* 临时隐藏弹层 */
  if (hideEl) {
    try {
      hideEl.style.visibility = 'hidden';
      hidden = true;
    } catch (e) {}
  }

  const ctrl = new AbortController();
  const timer = setTimeout(function () {
    try { ctrl.abort(); } catch (e) {}
  }, 30000);

  try {
    /* signal 只能放在 CredentialRequestOptions 顶层，放进 publicKey 里不生效 */
    const cred = await navigator.credentials.get({
      publicKey: Object.assign({}, options, { timeout: 30000 }),
      signal: ctrl.signal,
    });
    return cred;
  } catch (e) {
    const elapsed = Date.now() - startTime;
    const name = (e && e.name) || '';
    /* 超时：AbortError 或 30s 附近 */
    if (name === 'AbortError' || elapsed >= 29500) {
      throw { kind: 'timeout', cause: e };
    }
    /* 已取消 */
    if (name === 'NotAllowedError' && elapsed >= 2000) {
      throw { kind: 'cancelled', cause: e };
    }
    /* 无匹配钥匙：NotAllowedError 快速返回（<2s）或 InvalidStateError */
    if ((name === 'NotAllowedError' && elapsed < 2000) || name === 'InvalidStateError') {
      throw { kind: 'nokey', cause: e };
    }
    throw { kind: 'failed', cause: e };
  } finally {
    clearTimeout(timer);
    /* 恢复弹层 */
    if (hidden && hideEl) {
      try { hideEl.style.visibility = ''; } catch (e) {}
    }
  }
}

/**
 * B1-2：kind → 中文文案 key。
 * @param {string} kind
 * @param {boolean} en
 * @returns {string}
 */
export function passkeyErrorText(kind, en) {
  /* B1-2：文案走 i18n 表（sgx-i18n-core），无硬编码兜底 */
  const key = kind === 'cancelled' ? 'pkCancelled'
    : kind === 'timeout' ? 'pkTimeout'
    : kind === 'nokey' ? 'pkNoKey'
    : 'pkFailed';
  try {
    const T = loadI18n('sgx-i18n-core');
    const text = T.t(key);
    if (text) return text;
  } catch (e) {}
  console.warn('[i18n] missing key:', key);
  return key;
}

