/**
 * 读请求 Cookie 头的唯一实现（锁屏会话、账号会话、短票、root-auth 的访客 / 管理员快速判断都用它）。
 *
 * 规则（和以前各处手写的解析逐字一致）：
 * - 按 ';' 切开，每段去首尾空白，第一个 '=' 前是名字，后面整段是值（值里再有 '=' 原样保留）
 * - 名字区分大小写、精确相等；不做 URL 解码、不去引号
 * - 只有名字没有 '=' 的段，值是空串
 * - 同名 cookie 可能并存（Domain 的和 host-only 的），浏览器都会发：readAllCookies 按出现顺序全给，
 *   readCookie 只给第一个；没有就是空串
 * 只读不验：拿到值以后由各自的 parse / verify 判断格式和签名。
 */

/** RPC 转来的 Cookie 头的长度上限（src/verifier.js；账号 / 分享 Worker 同一个值） */
export const MAX_COOKIE_HEADER = 8192;

/** @param {any} request */
function headerOf(request) {
  return (request && request.headers && request.headers.get('Cookie')) || '';
}

/**
 * 某个名字的全部值（按出现顺序）。
 * @param {any} request
 * @param {string} name
 * @returns {string[]}
 */
export function readAllCookies(request, name) {
  const out = [];
  for (const part of headerOf(request).split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) out.push(v.join('='));
  }
  return out;
}

/**
 * 某个名字的第一个值；没有返回空串。
 * @param {any} request
 * @param {string} name
 * @returns {string}
 */
export function readCookie(request, name) {
  for (const part of headerOf(request).split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}
