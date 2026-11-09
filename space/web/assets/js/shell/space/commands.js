/**
 * @fileoverview 进站命令（进站 v3，SPACE-V3 §1.1 / §1.3「界面」/ §2.2）。纯函数，单测直接 import。
 *
 * 主机 `space` ↔ 账号 `account`；@ 左边是身份：唯一最高身份界面叫 `styrigx`、代码叫 `admin`（↔ 账号 `root`）。
 * `styrigx` 只出现在用户看得见的地方（命令、提示符、help）；命令字只在这里：ADMIN_COMMAND。
 *
 * 三个终端各有自己的提示符（不跟「环境提示符规则」）：
 * - 锁屏 `entry@space:~$`（↔ login@account:~$）：sudo styrigx [passkey|password|tempkey]、sudo styrigx reset
 * - 进站 reset `reset@space:~#`（↔ reset@account:~#）：passwd、passkey ls|add|rm <n>
 * - 盾牌 `styrigx@space:~#`（↔ root@account:~#）：sudo styrigx reauth [passkey|password]、lock、exit
 * 其余命令行 / 装饰提示符按账号登录状态：未登录 `styrigx@space:~$`、已登录 `root@account:~#`（envPrompt，见文件末尾）。
 */

/** `sudo styrigx` 的命令字（↔ shell/account/commands.js ROOT_COMMAND） */
export const ADMIN_COMMAND = 'styrigx';
/** 三条进站命令（用户看得见的写法） */
export const CMD = Object.freeze({
  session: 'sudo ' + ADMIN_COMMAND,
  reauth: 'sudo ' + ADMIN_COMMAND + ' reauth',
  reset: 'sudo ' + ADMIN_COMMAND + ' reset',
});
/** 锁屏（没进站）提示符 */
export const PS_ENTRY = 'entry@space:~$';
/** 盾牌命令行提示符（已进站，styrigx 身份） */
export const PS_ADMIN = ADMIN_COMMAND + '@space:~#';
/** 锁屏上 sudo styrigx reset 验过恢复钥匙之后 */
export const PS_RESET = 'reset@space:~#';
/** 输恢复钥匙 / 临时钥匙那一行（不回显） */
export const PS_RECOVERY_KEY = '[sudo] recovery key:';
export const PS_TEMPKEY = 'tempkey:';
/** 输解锁密码那一行：`[sudo] password for <名字>:`（名字 = 个人资料姓名的第一个词，小写；没有 → styrigx） @param {string} [name] */
export function psPassword(name) {
  const n = String(name || '').trim().split(/\s+/)[0].toLowerCase() || ADMIN_COMMAND;
  return '[sudo] password for ' + n + ':';
}
/** 一轮最多输错几次（同账号 O19） */
export const MAX_TRIES = 3;
export const TRIES_OVER = 'sudo: ' + MAX_TRIES + ' incorrect password attempts';
export const TRY_AGAIN = 'Sorry, try again.';
/** 进站方式（锁屏 sudo styrigx 的 [pick] 顺序：设了的 passkey、password，tempkey 一直在） */
export const SESSION_KINDS = Object.freeze(['passkey', 'password', 'tempkey']);
/** 再验证只认这两种（reauth 只认解锁密码 / 通行密钥，Gray C） */
export const REAUTH_KINDS = Object.freeze(['passkey', 'password']);
/** 盾牌里能进的层（行点进去；不是 cd 文本） */
export const SHIELD_LAYERS = Object.freeze(['home', 'keys', 'tempkeys', 'links']);
/** 要 reauth 才能进的层（Q3 定稿 08:00：进站凭证、临时钥匙「新建 + 管理」都 reauth；分享链接「管理」reauth） */
export const REAUTH_LAYERS = Object.freeze(['keys', 'tempkeys', 'links']);

/**
 * 命令行解析：小写、空白归一。
 * @param {string} s
 */
export function normCmd(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * 锁屏命令 → 动作（SPACE-V3 §2.2 A）。旧别名（password / pw / passkey / pk / tempkey / key / reset / forgot、sudo spacekey …、
 * sudo password / sudo passkey / sudo tempkey / sudo reset、cd .. / cd /）一律不认（command not found）。
 * @param {string} line 已 normCmd
 * @returns {{cmd: string, arg?: string}}
 */
export function parseEntryCmd(line) {
  if (!line) return { cmd: '' };
  if (line === 'help' || line === '?' || line === 'ls') return { cmd: 'help' };
  if (line === 'man ' + ADMIN_COMMAND || line === 'man') return { cmd: 'man' };
  if (line === 'clear' || line === 'cls') return { cmd: 'clear' };
  if (line === CMD.session) return { cmd: 'session' };
  if (line === CMD.reset) return { cmd: 'reset' };
  const m = /^sudo styrigx (passkey|password|tempkey)$/.exec(line);
  if (m) return { cmd: 'session', arg: m[1] };
  return { cmd: 'unknown' };
}

/**
 * reset 终端命令 → 动作（SPACE-V3 §2.2 B）。
 * @param {string} line 已 normCmd
 * @returns {{cmd: string, arg?: string}}
 */
export function parseResetCmd(line) {
  if (!line) return { cmd: '' };
  if (line === 'help' || line === '?' || line === 'ls') return { cmd: 'help' };
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
 * 盾牌命令行 → 动作（SPACE-V3 §2.2 C）。
 * @param {string} line 已 normCmd
 * @returns {{cmd: string, arg?: string}}
 */
export function parseShieldCmd(line) {
  if (!line) return { cmd: '' };
  if (line === 'help' || line === '?' || line === 'ls' || line === 'man ' + ADMIN_COMMAND || line === 'man') return { cmd: 'help' };
  if (line === 'clear' || line === 'cls') return { cmd: 'clear' };
  if (line === CMD.reauth) return { cmd: 'reauth' };
  const m = /^sudo styrigx reauth (passkey|password)$/.exec(line);
  if (m) return { cmd: 'reauth', arg: m[1] };
  if (line === 'lock') return { cmd: 'lock' };
  if (line === 'exit') return { cmd: 'exit' };
  if (line === 'passwd') return { cmd: 'passwd' };
  if (line === 'passkey add') return { cmd: 'passkey-add' };
  return { cmd: 'unknown' };
}

/**
 * 能用的方式（固定顺序）。cfg 读不到（null）→ 解锁密码 / 通行密钥都列（fail closed，同 /api/lock-entry）。
 * @param {{password: boolean, passkey: boolean}|null} cfg
 * @param {boolean} pkSupported 本机支持通行密钥（window.PublicKeyCredential）
 * @param {boolean} withTempkey 锁屏 sudo styrigx（临时钥匙一直在）；reauth 不给
 * @returns {string[]}
 */
export function availableKinds(cfg, pkSupported, withTempkey) {
  const c = cfg || { password: true, passkey: true };
  const ks = [];
  if (c.passkey && pkSupported) ks.push('passkey');
  if (c.password) ks.push('password');
  if (withTempkey) ks.push('tempkey');
  return ks;
}

/**
 * 盾牌入口给的名字（旧地址 /security/* → /#sec[=<层>]；页面上的 [data-sec-open]）→ 层。
 * @param {string} name
 * @returns {string} home / keys / tempkeys / links
 */
export function shieldLayerFrom(name) {
  const n = String(name || '').toLowerCase();
  if (n === 'keys' || n === 'lock' || n === 'credentials') return 'keys';
  if (n === 'tempkeys' || n === 'links') return n;
  return 'home';
}

/* ---------- 环境提示符规则（Gray 2026-11-08 21:57 定、2026-11-09 08:14 确认；SPACE-V3「环境提示符规则」） ---------- */

/** 账号没登录 / 已登录时，全站命令行 / 装饰提示符的身份与主机 */
export const ENV_GUEST = 'styrigx@space';
export const ENV_ROOT = 'root@account';

/**
 * 按账号登录状态给提示符：没登录 `styrigx@space:<路径>$`，已登录 `root@account:<路径>#`。
 * 状态读 <html data-sgx-account-session="in|out">（首帧由 layout-mode.js __sgxAccountPs 按登录标记 cookie 写好，账号终端登录 / 退出时改）。
 * @param {boolean} signedIn @param {string} [path] 默认 ~
 */
export function envPrompt(signedIn, path) {
  return (signedIn ? ENV_ROOT : ENV_GUEST) + ':' + (path || '~') + (signedIn ? '#' : '$');
}

/** h:mm（进站会话剩余） @param {number} ms */
export function hmm(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  return Math.floor(m / 60) + ':' + ((m % 60) < 10 ? '0' : '') + (m % 60);
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
