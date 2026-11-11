import { fill } from '../../core/out.js';
import { isV6, v6Root } from '../../core/who.js';

/**
 * 命令的门槛：按终端身份（core/who.js，服务端说了算）拦一下、给一句该先做什么。只是提示，真正的拦截在服务端（401 / 403）。
 * v6 P4 起只剩一种：signed = 有 v6 会话（访客提示先 su <用户>，同身份层 notSignedIn；定稿 §七 访客入口预填 su）。
 * 过了回 null，没过回一条 Result。
 * @param {any} x
 */
export function gate(x) {
  if (!isV6(x.who())) return { out: [needSu(x)] };
  return null;
}

/** 访客：先 su <用户>（命令写法里的 <用户> 跟语言） @param {any} x */
export function needSu(x) {
  return line(x, 'needSu', 'su ' + (x.S.suUser || '<user>'));
}

/**
 * v6 的 root 档命令（v6-commands「授权与订阅（root，或 sudo）」；路由表 /api/account/proxy 是 root 档）：
 * v6 root → { direct: true }；别的已登录身份 → 一条「当前用户没有这个权限 · 先 <how>」（P4-3：在 sudoers 里给 sudo <这一行>，
 * 定稿 v5.5 §四「站长用 sudo 提权」；不在 sudoers 照旧 su root）；访客 → 先 su <用户>。
 * @param {any} x @param {string} [how] @returns {{direct: true}|{out: any[]}}
 */
export function v6RootGate(x, how) {
  const w = x.who();
  if (!isV6(w)) return { out: [needSu(x)] };
  if (!v6Root(w)) return { out: [line(x, 'needRoot6', how && canSudo(x) ? how : 'su root')] };
  return { direct: true };
}

/** 当前身份在不在 sudoers（whoami 的 user；没问到 → false，照旧提示 su root） @param {any} x */
export function canSudo(x) {
  const u = typeof x.me === 'function' ? x.me() : null;
  return !!(u && u.sudoers === true);
}

/**
 * v6 的「自己的账号」命令（定稿 §八：普通用户用 passwd、passkey 改自己的凭据；v6-commands「自己的账号（普通用户与 root 各管各的）」）：
 * 有 v6 会话（普通用户 / root / 救援）→ { direct: true }；访客 → 先 su <用户>。
 * @param {any} x @returns {{direct: true}|{out: any[]}}
 */
export function v6SelfGate(x) {
  return isV6(x.who()) ? { direct: true } : { out: [needSu(x)] };
}

/** 这一行得在终端窗口里跑（要输入 / 选择 / 验证；AI 窗口里的 $ 命令没有这些）：拿那一层，拿不到 → null @param {any} x @param {'acct'|'ident'} which */
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
