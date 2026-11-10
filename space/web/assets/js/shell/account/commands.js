/**
 * @fileoverview 账号命令的命令字和提示文字（设计稿 acct-sec-redraw OPEN.md「账号命令体系 v3」）。纯函数，单测直接 import。
 *
 * root 只出现在用户看得见的地方（命令、提示符、man）；内部代码用 session / reauth / reset（NAMING-V2 §1「root 的规则」）。
 * 命令字只在这里：ROOT_COMMAND（终端统一 T1 起定义在 shell/term/core/parse.js，和站内终端共用一份，这里转出）。
 */
import { ROOT_COMMAND, normCmd } from '../term/core/parse.js';

/** `sudo root` 的命令字 */
export { ROOT_COMMAND };
/** 三条账号命令（用户看得见的写法） */
export const CMD = Object.freeze({
  session: 'sudo ' + ROOT_COMMAND,
  reauth: 'sudo ' + ROOT_COMMAND + ' reauth',
  reset: 'sudo ' + ROOT_COMMAND + ' reset',
});
/** 输密码 / 恢复密钥那一行（同锁屏 L4，不回显） */
export const PS_PASSWORD = '[sudo] password for ' + ROOT_COMMAND + ':';
export const PS_RECOVERY_KEY = '[sudo] recovery key:';
/** 一轮最多输错几次（O19） */
export const MAX_TRIES = 3;
export const TRIES_OVER = 'sudo: ' + MAX_TRIES + ' incorrect password attempts';
export const TRY_AGAIN = 'Sorry, try again.';
/** profile set 的字段名 → 资料字段（用户看得见的写法短一点；S9。term/cmds/acct 的补全表 PROFILE_SET 是这里的键） */
export const PROFILE_KEYS = Object.freeze({ name: 'name', nick: 'nickname', sign: 'motto', email: 'email' });
/** 命令行解析（小写、空白归一）：终端统一 T1 起在 shell/term/core/parse.js，这里转出 */
export { normCmd };

/**
 * 页面入口给的名字（旧地址 /account/<子页>/ → #acct=<子页>，O1；页面上的 [data-acct-open="<名字>"]）→ 在终端里怎么开（S9：账号卡片只展示，入口都去终端）。
 * reset = 跑 sudo root reset；reauth = 只做 sudo root reauth（奇趣导入书签要复验，cmd/layer.js entry）；
 * 子页名 = 输入行预填对应的命令（profile / device / passkey / app，同账号卡片的行）；其余（空）= 打开账号卡片。
 * @param {string} name
 * @returns {{cmd: string, reset: boolean, reauth: boolean}}
 */
export function layerFromPath(name) {
  const n = String(name || '').toLowerCase();
  const r = { cmd: '', reset: false, reauth: false };
  if (n === 'reset') r.reset = true;
  else if (n === 'reauth') r.reauth = true;
  else if (n === 'security' || n === 'keys') r.cmd = 'passkey';
  else if (n === 'apps' || n === 'grants') r.cmd = 'app';
  else if (n === 'devices') r.cmd = 'device';
  else if (n === 'profile') r.cmd = 'profile';
  return r;
}
