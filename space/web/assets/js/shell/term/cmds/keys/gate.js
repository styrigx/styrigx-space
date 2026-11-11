import { fill } from '../../core/out.js';
import { ROOT_COMMAND } from '../../core/parse.js';
import { isV6, v6Root } from '../../core/who.js';

/**
 * 命令的门槛（v5 S5）：按终端身份（core/who.js，服务端说了算）拦一下、给一句该先做什么。只是提示，真正的拦截在服务端（401 / 403 link）。
 * - entered：进站了（nobody 不行）
 * - keys：进站了、且不是分享链接进来的（link 不能发 / 管分享、不能动解锁凭据、不能 reauth，v5 S1）
 * - root：sudo root 登录了账号
 * 过了回 null，没过回一条 Result。
 * 割接（v6-commands「谁能用」：访客 = su 登录；定稿 §七 访客入口预填 su）：访客一律提示先 su <用户>（同身份层 notSignedIn），不再指向旧进站命令。
 * @param {any} x @param {'entered'|'keys'|'root'} level
 */
export function gate(x, level) {
  const w = x.who();
  if (w === 'nobody') return { out: [needSu(x)] };
  if (level === 'keys' && w === 'link') return { out: [x.k.plain(x.S.linkDenied, 'err')] };
  if (level === 'root' && w !== 'root') return { out: [line(x, 'needRoot', 'sudo ' + ROOT_COMMAND)] };
  return null;
}

/** 访客：先 su <用户>（命令写法里的 <用户> 跟语言） @param {any} x */
export function needSu(x) {
  return line(x, 'needSu', 'su ' + (x.S.suUser || '<user>'));
}

/**
 * v6 的 root 档命令（v6-commands「授权与订阅（root，或 sudo）」；路由表 /api/account/proxy、/grants 是 root 档）：
 * v6 root → { direct: true }（不跑旧的 sudo root 登录 / reauth：v6 的每次重验就是 su root，同 #402 share）；
 * v6 普通用户 → 一条「当前用户没有这个权限 · 先 su root」（同 share 的 needRoot6）；没有 v6 会话 → null（照旧走 gate(x, 'root')）。
 * @param {any} x @returns {{direct: true}|{out: any[]}|null}
 */
export function v6RootGate(x) {
  const w = x.who();
  if (!isV6(w)) return null;
  if (!v6Root(w)) return { out: [line(x, 'needRoot6', 'su root')] };
  return { direct: true };
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
