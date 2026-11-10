import { fill } from '../../core/out.js';
import { ROOT_COMMAND, ADMIN_COMMAND } from '../../core/parse.js';

/**
 * 命令的门槛（v5 S5）：按终端身份（core/who.js，服务端说了算）拦一下、给一句该先做什么。只是提示，真正的拦截在服务端（401 / 403 link）。
 * - entered：进站了（nobody 不行）
 * - keys：进站了、且不是分享链接进来的（link 不能发 / 管分享、不能动解锁凭据、不能 reauth，v5 S1）
 * - root：sudo root 登录了账号
 * 过了回 null，没过回一条 Result。
 * @param {any} x @param {'entered'|'keys'|'root'} level
 */
export function gate(x, level) {
  const w = x.who();
  if (w === 'nobody') return { out: [line(x, 'needEntry', 'sudo ' + ADMIN_COMMAND)] };
  if (level === 'keys' && w === 'link') return { out: [x.k.plain(x.S.linkDenied, 'err')] };
  if (level === 'root' && w !== 'root') return { out: [line(x, 'needRoot', 'sudo ' + ROOT_COMMAND)] };
  return null;
}

/** 这一行得在终端窗口里跑（要输入 / 选择 / 验证；AI 窗口里的 $ 命令没有这些）：拿那一层，拿不到 → null @param {any} x @param {'space'|'acct'} which */
export function layer(x, which) {
  return x.v && x.v[which] ? x.v[which] : null;
}
/** @param {any} x @param {string} cmd */
export function notHere(x, cmd) {
  return { out: [{ t: 'line', seg: fill(x.S.notHere, { x: ['k', cmd] }), cls: 'o' }] };
}

/** 一行红字（{x} = 黄色命令） @param {any} x @param {string} key @param {string} cmd */
export function line(x, key, cmd) {
  return { t: 'line', seg: fill(x.S[key], { x: ['k', cmd] }), cls: 'err' };
}

/** 交给那一层去跑（它自己打输出、换输入模式）：视图看到 flow 就不再动输入行 */
export const FLOW = Object.freeze({ out: [], flow: true });

/** 第 n 个（1 起）；不是正整数 → 0 @param {string} [s] */
export function nth(s) {
  return /^\d{1,3}$/.test(String(s || '')) ? Number(s) : 0;
}
