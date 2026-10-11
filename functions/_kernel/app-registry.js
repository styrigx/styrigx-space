/**
 * 2.10.0：应用白名单（主站配置）。
 * 每个应用一行：aud、允许的 scope、允许的 return origin。
 * 新增应用只需加一行；book 和以后的 music 等共用此表。
 * book 不得读取此表之外的 aud；space 签发时 aud/scope/return 任一不在表内一律拒绝。
 */

/** @type {Array<{aud:string, scopes:Array<string>, origin:string}>} */
export const APP_WHITELIST = [
  { aud: 'book', scopes: ['upload'], origin: 'https://book.styrigx.com' },
];

/**
 * @param {string} aud
 * @returns {{aud:string, scopes:Array<string>, origin:string}|null}
 */
export function getApp(aud) {
  if (!aud || typeof aud !== 'string') return null;
  for (const a of APP_WHITELIST) {
    if (a.aud === aud) return a;
  }
  return null;
}

/**
 * @param {string} aud
 * @param {string} scope
 * @returns {boolean}
 */
export function isScopeAllowed(aud, scope) {
  const app = getApp(aud);
  return !!app && app.scopes.includes(scope);
}

/**
 * 校验 return URL：origin 必须严格等于该 aud 登记的 origin。
 * @param {string} aud
 * @param {string} returnUrl
 * @returns {string|null} 合法则返回原 URL，否则 null
 */
export function validateAppReturn(aud, returnUrl) {
  const app = getApp(aud);
  if (!app || !returnUrl) return null;
  try {
    const u = new URL(returnUrl);
    if (u.origin !== app.origin) return null;
    return returnUrl;
  } catch (e) {
    return null;
  }
}

/** 默认 return（该 aud 的 origin 根路径） */
export function defaultAppReturn(aud) {
  const app = getApp(aud);
  return app ? app.origin + '/' : null;
}
