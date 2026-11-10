/**
 * @fileoverview 钥匙层的命令字与小工具（进站 v3 → v5 S5 终端合一）。纯函数，单测直接 import。
 *
 * 主机 `space` ↔ 账号 `account`；@ 左边是身份：唯一最高身份界面叫 `styrigx`、代码叫 `admin`（↔ 账号 `root`）。
 * v5 S5 起只有一个终端（shell/terminal.js），提示符按身份（shell/term/core/who.js）：nobody@space:~$ / nobody@space:~#（分享链接）/ styrigx@space:~# / root@account:~#。
 * 钥匙层的命令（sudo styrigx、sudo -v、lock …、share …）在 shell/term/cmds/keys/，这里只剩 reset 层（reset@space:~#，层不变）的解析和几样共用的东西。
 * 终端统一 T1：ADMIN_COMMAND、ENV_GUEST / ENV_ROOT、normCmd 定义在 shell/term/core/parse.js（和终端共用一份），这里转出。
 */
import { ADMIN_COMMAND, ENV_GUEST, ENV_ROOT, normCmd } from '../term/core/parse.js';

/** `sudo styrigx` 的命令字（↔ shell/account/commands.js ROOT_COMMAND） */
export { ADMIN_COMMAND };
/** 进站相关的命令（用户看得见的写法）：进站、再验证（sudo -v）、reset */
export const CMD = Object.freeze({
  session: 'sudo ' + ADMIN_COMMAND,
  reauth: 'sudo -v',
  reset: 'sudo ' + ADMIN_COMMAND + ' reset',
});
/** sudo styrigx reset 验过恢复钥匙之后（reset 层，不变） */
export const PS_RESET = 'reset@space:~#';
/** 输恢复钥匙那一行（不回显） */
export const PS_RECOVERY_KEY = '[sudo] recovery key:';
/** 输解锁密码那一行：`[sudo] password for <名字>:`（名字 = 个人资料姓名的第一个词，小写；没有 → styrigx） @param {string} [name] */
export function psPassword(name) {
  const n = String(name || '').trim().split(/\s+/)[0].toLowerCase() || ADMIN_COMMAND;
  return '[sudo] password for ' + n + ':';
}
/** 一轮最多输错几次（同账号 O19） */
export const MAX_TRIES = 3;
export const TRIES_OVER = 'sudo: ' + MAX_TRIES + ' incorrect password attempts';
export const TRY_AGAIN = 'Sorry, try again.';
/** 进站 / 再验证的方式（[pick] 顺序：设了的 passkey、password；v5 S5 起没有临时钥匙） */
export const SESSION_KINDS = Object.freeze(['passkey', 'password']);
/** reset 层的补全表 */
export const RESET_TABLE = Object.freeze({
  names: ['man', 'passwd', 'passkey', 'exit', 'clear'],
  args: { passkey: ['ls', 'add', 'rm'] },
});

/** 命令行解析（小写、空白归一）：终端统一 T1 起在 shell/term/core/parse.js，这里转出 */
export { normCmd };

/**
 * reset 层命令 → 动作（SPACE-V3 §2.2 B；v5：help 换成 man）。
 * @param {string} line 已 normCmd
 * @returns {{cmd: string, arg?: string}}
 */
export function parseResetCmd(line) {
  if (!line) return { cmd: '' };
  if (line === 'man' || line === '?' || line === 'ls') return { cmd: 'man' };
  if (line === 'clear' || line === 'cls') return { cmd: 'clear' };
  if (line === 'exit' || line === 'logout') return { cmd: 'exit' };
  if (line === 'passwd') return { cmd: 'passwd' };
  if (line === 'passkey ls' || line === 'passkey list') return { cmd: 'passkey-ls' };
  if (line === 'passkey add') return { cmd: 'passkey-add' };
  const m = /^passkey rm (\d{1,2})$/.exec(line);
  if (m) return { cmd: 'passkey-rm', arg: m[1] };
  if (line === 'passkey rm') return { cmd: 'passkey-rm', arg: '' };
  return { cmd: 'unknown' };
}

/**
 * 能用的方式（固定顺序）。cfg 读不到（null）→ 解锁密码 / 通行密钥都列（fail closed，同 /api/lock-entry）。
 * @param {{password: boolean, passkey: boolean}|null} cfg
 * @param {boolean} pkSupported 本机支持通行密钥（window.PublicKeyCredential）
 * @returns {string[]}
 */
export function availableKinds(cfg, pkSupported) {
  const c = cfg || { password: true, passkey: true };
  const ks = [];
  if (c.passkey && pkSupported) ks.push('passkey');
  if (c.password) ks.push('password');
  return ks;
}

/* ---------- 环境提示符规则（Gray 2026-11-08 21:57 定、2026-11-09 08:14 确认；SPACE-V3「环境提示符规则」） ---------- */

/** 账号没登录 / 已登录时，全站命令行 / 装饰提示符的身份与主机 */
export { ENV_GUEST, ENV_ROOT };

/**
 * 按账号登录状态给提示符：没登录 `styrigx@space:<路径>$`，已登录 `root@account:<路径>#`。
 * 状态读 <html data-sgx-account-session="in|out">（首帧由 layout-mode.js __sgxAccountPs 按登录标记 cookie 写好，账号终端登录 / 退出时改）。
 * @param {boolean} signedIn @param {string} [path] 默认 ~
 */
export function envPrompt(signedIn, path) {
  return (signedIn ? ENV_ROOT : ENV_GUEST) + ':' + (path || '~') + (signedIn ? '#' : '$');
}

/** m:ss（reauth 剩余） @param {number} ms */
export function mmss(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(s / 60) + ':' + ((s % 60) < 10 ? '0' : '') + (s % 60);
}

/** MM-DD @param {number} ts */
export function mmdd(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = function (/** @type {number} */ n) { return (n < 10 ? '0' : '') + n; };
  return p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/**
 * 通行密钥那一行的名字：自己起的名字 → 提供方 → 「进站通行密钥」
 * @param {any} key @param {(k: string) => string} t
 */
export function passkeyName(key, t) {
  const prov = key.provider && /^[a-z0-9-]+$/.test(key.provider) ? t('keys.provider.' + key.provider.replace(/-/g, '_')) : '';
  return key.name || prov || t('keys.unnamed');
}
