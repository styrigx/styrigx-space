/**
 * @fileoverview v6 身份命令的后端（P2b）：POST /api/identity（账号 Worker api/identity.js；网关 public 入口，每个 action 的档在服务端判）。
 * 只有这一个文件发请求；终端里的流程在 ./layer.js。
 *
 * 只 import auth/、lib/（check-layers 规则 3）。
 */
import { postJSON } from '../auth/post-json.js';
import { getPasskeyAssertion, assertionOptions, assertionToJSON, isPasskeyCancel } from '../auth/passkey-assert.js';

/** 接口地址 */
export const IDENTITY_API = '/api/identity';

/**
 * @param {string} action @param {Record<string, any>} [fields]
 * @returns {Promise<{s: number, j: any}>}
 */
export function post(action, fields) {
  return postJSON(IDENTITY_API, Object.assign({ action: action }, fields || {}));
}

/** 当前 v6 身份：user（对象）/ null（访客）/ undefined（没问到，网络错） @returns {Promise<any>} */
export function whoami() {
  return post('whoami').then(function (r) { return r && r.j && r.j.ok ? (r.j.user || null) : undefined; }, function () { return undefined; });
}

/** 页面上有没有 v6 登录标记 @param {Document} [d] */
export function hasMarker(d) {
  try { return /(?:^|;\s*)sgx-id=1(?:;|$)/.test((d || document).cookie || ''); } catch (e) { return false; }
}

/**
 * 通行密钥断言（su / sudo 用）：challengeAction = su-challenge | sudo-challenge；回 { cid, credential } 交给下一步。
 * 取消 → reject { cancelled: true }；别的失败 → reject { message }。
 * @param {'su-challenge'|'sudo-challenge'} challengeAction
 */
export function passkeyProof(challengeAction) {
  return post(challengeAction).then(function (r) {
    if (!r.j || !r.j.ok) throw { message: '', res: r };
    return getPasskeyAssertion(assertionOptions(r.j)).then(function (cred) {
      return { cid: r.j.cid, credential: assertionToJSON(cred) };
    }, function (e) {
      throw isPasskeyCancel(e) ? { cancelled: true } : { message: '' };
    });
  });
}
