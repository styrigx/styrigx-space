/**
 * @fileoverview POST JSON（回 { s, j }）+ 服务端错误码 → 文案。账号终端（shell/account/api.js）和盾牌的临时钥匙 / 分享短链页共用。
 * 2026-11-08 按 NAMING-V2 §2.8 改名：原 auth/account-api.js；账号接口地址 ACCOUNT_API 搬进 shell/account/api.js（后端名只在那一处）。
 */

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
  'class-mismatch': 'errVerify',
  'uv-required': 'errUvRequired',
  cooldown: 'errLocked',
  config: 'errConfig',
  server: 'errServer',
  short: 'errShort',
  'not-found': 'errNotFound',
  session: 'sessExp',
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
