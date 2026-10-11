/**
 * Passkey 断言验证（owner-passkey 和 stepup 共用，安全逻辑只有一套）。
 *
 * - verifyPasskeyAssertion(kv, cred, chRec, opts): 验证 passkey 断言
 *   - chRec.type 必须匹配 opts.purpose（'auth' 或 'stepup'），防重放
 *   - 强制 UV=1
 *   - 返回 { ok: true, stored } 或 { ok: false, error }
 */
import { b64urlDec } from './crypto.js';

/**
 * 验证 clientData 和 authenticatorData（从 owner-passkey.js 抽取）。
 * @param {Uint8Array} authData
 * @param {Uint8Array} rpIdHash
 */
function checkAssertAuthData(authData, rpIdHash) {
  // 简化版：实际实现从 owner-passkey.js 复制
  // 这里只做占位，完整实现在抽取时填入
  return { uv: true, signCount: 0 };
}

/**
 * DER 转 raw（从 owner-passkey.js 抽取）。
 */
function derToRaw(der) {
  // 占位
  return der;
}

/**
 * 验证 passkey 断言。
 * @param {any} kv KV 绑定
 * @param {object} cred 前端传来的 credential
 * @param {object} chRec challenge 记录（含 type、challenge、exp）
 * @param {object} opts { purpose: 'auth'|'stepup', rpIdHash, expectedOrigin }
 * @returns {Promise<{ok:boolean, error?:string, stored?:object}>}
 */
export async function verifyPasskeyAssertion(kv, cred, chRec, opts) {
  const purpose = opts.purpose;
  // challenge 必须存在、未过期、用途匹配（防 login/stepup 互相重放）
  if (!chRec || chRec.exp < Date.now()) {
    return { ok: false, error: 'challenge' };
  }
  if (chRec.type !== purpose) {
    return { ok: false, error: 'purpose-mismatch' };
  }
  // TODO: 完整验证逻辑从 owner-passkey.js 迁移
  return { ok: false, error: 'not-implemented' };
}
