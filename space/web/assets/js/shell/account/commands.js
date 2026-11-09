/**
 * @fileoverview 账号终端的命令（设计稿 acct-sec-redraw OPEN.md「账号命令体系 v3」）。纯函数，单测直接 import。
 *
 * root 只出现在用户看得见的地方（命令、提示符、help）；内部代码用 session / reauth / reset（NAMING-V2 §1「root 的规则」）。
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
/** 提示符：未登录 / 登录后（Gray 17:45 / 17:18）；reauth 期间不变（仍是 PS_ROOT） */
export const PS_GUEST = 'login@account:~$';
export const PS_ROOT = ROOT_COMMAND + '@account:~#';
/** sudo root reset 验过恢复密钥、在 reset 里时的提示符（未登录从 sudo root 进、已登录进都一样；Gray 2026-11-08 22:10）；reset 结束回 PS_GUEST / PS_ROOT */
export const PS_RESET = 'reset@account:~#';
/** 输密码 / 恢复密钥那一行（同锁屏 L4，不回显） */
export const PS_PASSWORD = '[sudo] password for ' + ROOT_COMMAND + ':';
export const PS_RECOVERY_KEY = '[sudo] recovery key:';
/** 一轮最多输错几次（O19） */
export const MAX_TRIES = 3;
export const TRIES_OVER = 'sudo: ' + MAX_TRIES + ' incorrect password attempts';
export const TRY_AGAIN = 'Sorry, try again.';
/** 面板里能 cd 进去的层 */
export const LAYERS = Object.freeze(['home', 'profile', 'devices', 'keys', 'grants']);
/** cd 用的目录名（用户看得见；~/account/<目录>） → 层 */
const CD_DIRS = Object.freeze({ profile: 'profile', devices: 'devices', security: 'keys', apps: 'grants' });
/** 层 → 头部右边的路径 */
export const LAYER_PATH = Object.freeze({ profile: '~/account/profile', devices: '~/account/devices', keys: '~/account/security', grants: '~/account/apps' });

/** 命令行解析（小写、空白归一）：终端统一 T1 起在 shell/term/core/parse.js，这里转出 */
export { normCmd };

/**
 * 命令 → 动作。
 * @param {string} line 已 normCmd
 * @returns {{cmd: string, arg?: string}}
 */
export function parseCmd(line) {
  if (!line) return { cmd: '' };
  if (line === 'help' || line === '?' || line === 'man' || line === 'ls') return { cmd: 'help' };
  if (line === 'clear' || line === 'cls') return { cmd: 'clear' };
  if (line === CMD.session || line === 'sudo -i' || line === 'su' || line === 'login') return { cmd: 'session' };
  if (line === CMD.reauth || line === 'sudo -v') return { cmd: 'reauth' };
  if (line === CMD.reset) return { cmd: 'reset' };
  if (line === 'exit' || line === 'logout') return { cmd: 'exit' };
  if (line === 'passwd') return { cmd: 'passwd' };
  if (line === 'passkey add') return { cmd: 'passkey-add' };
  if (line === 'cd' || line === 'cd ~' || line === 'cd ..' || line === 'cd /') return { cmd: 'cd', arg: 'home' };
  const m = /^cd (?:~\/)?(?:account\/)?(profile|devices|security|apps)\/?$/.exec(line);
  if (m) return { cmd: 'cd', arg: /** @type {any} */ (CD_DIRS)[m[1]] };
  return { cmd: 'unknown' };
}

/**
 * 入口给的名字（旧地址 /account/<子页>/ → #acct=<子页>，O1；页面上的 [data-acct-open="<名字>"]）→ 面板怎么开。
 * reset = 直接 sudo root reset；reauth = 只做 sudo root reauth（奇趣导入书签要复验）：验过发 sgx-account-reauthed 让页面当场做完，关面板后结束 reauth（term.js onlyReauth）。
 * @param {string} name
 * @returns {{layer: string, reset: boolean, reauth: boolean}}
 */
export function layerFromPath(name) {
  const n = String(name || '').toLowerCase();
  const r = { layer: '', reset: false, reauth: false };
  if (n === 'reset') r.reset = true;
  else if (n === 'reauth') r.reauth = true;
  else if (n === 'security' || n === 'keys') r.layer = 'keys';
  else if (n === 'apps' || n === 'grants') r.layer = 'grants';
  else if (n === 'profile' || n === 'devices') r.layer = n;
  return r;
}
