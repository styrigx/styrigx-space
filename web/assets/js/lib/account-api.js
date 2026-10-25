/**
 * @fileoverview /api/account 调用与错误码 → 文案（账号页各页 + lib/account-methods.js 共用）。
 * 原在 apps/account-common.js；账号凭证验证行（lib/account-methods.js）也被锁屏凭证页用到，lib 不能 import apps，所以放在 lib。
 */

export const ACCOUNT_API = '/api/account';

/**
 * @param {string} url
 * @param {object} body
 * @returns {Promise<{s:number, j:any}>}
 */
export function postJSON(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  }).then(function (r) {
    return r.json().then(function (j) { return { s: r.status, j: j }; }, function () { return { s: r.status, j: null }; });
  });
}

const ERR_KEYS = {
  wrong: 'errWrongPw',
  'not-set': 'errNotSet',
  auth: 'errWrongRoot',
  denied: 'errWrongPw',
  role: 'errWrongPw',
  challenge: 'errVerify',
  verify: 'errVerify',
  'unknown-key': 'errVerify',
  'class-mismatch': 'errVerify',
  'uv-required': 'errUvRequired',
  cooldown: 'errLocked',
  config: 'errConfig',
  server: 'errServer',
  short: 'errShort',
  'same-as-lock': 'errSameAsLock',
  'not-found': 'errNotFound',
  session: 'sessExp',
  reauth: 'reauthExpired',
  current: 'devCurrent',
};

/**
 * 服务端错误码 → 文案
 * @param {function(string): string} t
 * @param {string} [code]
 * @param {number} [status]
 */
export function errText(t, code, status) {
  if (code && ERR_KEYS[code]) return t(ERR_KEYS[code]);
  if (status === 429) return t('errLocked');
  return t('errUnknown');
}
