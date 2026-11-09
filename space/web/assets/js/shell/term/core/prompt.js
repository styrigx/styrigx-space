/**
 * @fileoverview 提示符规则（终端统一 T3）：环境提示符（账号没登录 styrigx@space、已登录 root@account），字符串不变。
 */
import { ENV_GUEST, ENV_ROOT } from './parse.js';

/** 提示符里的路径 @param {string} cwd */
export function cwdPath(cwd) {
  return !cwd || cwd === '~' ? '~' : '~/' + cwd;
}
/** styrigx@space:~/blog$ / root@account:~/blog# @param {boolean} signedIn @param {string} cwd */
export function envPs1(signedIn, cwd) {
  return (signedIn ? ENV_ROOT : ENV_GUEST) + ':' + cwdPath(cwd) + (signedIn ? '#' : '$');
}
/** 标题栏：styrigx@space: ~ @param {boolean} signedIn @param {string} cwd */
export function envTitle(signedIn, cwd) {
  return (signedIn ? ENV_ROOT : ENV_GUEST) + ': ' + cwdPath(cwd);
}
