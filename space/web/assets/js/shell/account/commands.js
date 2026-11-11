/**
 * @fileoverview 账号命令的常量（设计稿 acct-sec-redraw OPEN.md「账号命令体系 v3」）。纯函数，单测直接 import。
 * v6 P4 起旧账号会话的命令字（sudo root / sudo root reauth / sudo root reset）与它们的提示行删除（定稿 v5.2 §十三 P4）。
 */
import { normCmd } from '../term/core/parse.js';

/** profile set 的字段名 → 资料字段（用户看得见的写法短一点；S9。term/cmds/acct 的补全表 PROFILE_SET 是这里的键） */
export const PROFILE_KEYS = Object.freeze({ name: 'name', nick: 'nickname', sign: 'motto', email: 'email' });
/** 命令行解析（小写、空白归一）：终端统一 T1 起在 shell/term/core/parse.js，这里转出 */
export { normCmd };

/**
 * 页面入口给的名字（旧地址 /account/<子页>/ → #acct=<子页>，O1；页面上的 [data-acct-open="<名字>"]）→ 在终端里怎么开（账号卡片只展示，入口都去终端）。
 * 子页名 = 输入行预填对应的命令（profile / device / passkey / app，同账号卡片的行）；其余（空）= 打开账号卡片。
 * 旧的 reset / reauth 入口随旧账号会话删除（定稿 §十三 P4；旧地址 /account/reset/ 直接删，不跳转、不预填，Gray 11-11 17:47）。
 * @param {string} name
 * @returns {{cmd: string}}
 */
export function layerFromPath(name) {
  const n = String(name || '').toLowerCase();
  const r = { cmd: '' };
  if (n === 'security' || n === 'keys') r.cmd = 'passkey';
  else if (n === 'apps' || n === 'grants') r.cmd = 'app';
  else if (n === 'devices') r.cmd = 'device';
  else if (n === 'profile') r.cmd = 'profile';
  return r;
}
