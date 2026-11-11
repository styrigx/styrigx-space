import { layer, notHere, nth, v6SelfGate, line, canSudo, FLOW } from '../keys/gate.js';
import { v6Root } from '../../core/who.js';

/**
 * 账号命令（v6；P4-3 按定稿 v5.5 §四 / §五 / §七 / §八收紧）：
 * - passwd：改自己的密码（先输当前密码）/ passwd <名>：root 发一次性密码（身份层 shell/identity/layer.js）；普通用户层
 * - passkey [ls | add | rm <n>]：站长与 root 自己的通行密钥（POST /api/identity passkey-*，owner 档；普通用户不能管通行密钥，§八）
 * - device：设备列表（POST /api/account/devices list，owner 档，全站视图）；device rm <n> | rm --all：踢出（root 档）——
 *   root 直接做；站长提示 sudo device rm …（keys/sudo.js 借 root 跑）
 * - profile [set name | nick | sign | email <值> | avatar]：个人资料（PUT /api/profile 站长 + root；头像一份，归站长）；普通用户只能看
 * 流程在账号层（shell/account/cmd/*）；这里只把门、查参数。v6 P4 起旧账号会话（sudo root）与 reset 层删除，一律按 v6 身份。
 */

const V6 = /** @type {any} */ (['user', 'root6']);
/** 站长层（定稿 v5.5 §四 man 分段：root → 站长 → 普通用户 → 访客；core/who.js tierOf 取最低一层） */
const OWNER = /** @type {any} */ (['owner', 'root6']);

const passwd = {
  name: 'passwd',
  audience: V6,
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    if (p.args.length > 1) return { out: [x.k.plain(x.S.usagePasswd)] };
    const I = layer(x, /** @type {any} */ ('ident'));
    if (!I) return notHere(x, 'passwd');
    I.cmdPasswd(p.args[0] || '');
    return FLOW;
  },
};

/**
 * passkey（定稿 §八「普通用户用 passwd、passkey 改自己的凭据；通行密钥自带 WebAuthn 验证」；§九 救援白名单含 passkey）：
 * 有 v6 会话（普通用户 / su root / 救援）→ 管栈顶那个用户自己的（POST /api/identity passkey-*，user 档）；访客 → 先 su <用户>。
 * sudo passkey（借 root 改 root 的通行密钥）在 keys/sudo.js 拒（定稿 §十）。
 */
const passkey = {
  name: 'passkey',
  args: ['add', 'rm'],
  audience: OWNER,
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const a = p.args.map(function (s) { return s.toLowerCase(); });
    const v6 = v6SelfGate(x);
    if ('out' in v6) return v6;
    const A = layer(x, 'acct');
    if (!A) return notHere(x, 'passkey');
    if (typeof A.sudo === 'function') A.sudo(null);
    if (!a.length || (a[0] === 'ls' && a.length === 1)) { A.passkeyList(v6); return FLOW; }
    if (a[0] === 'add' && a.length === 1) { A.cmdPasskeyAdd(true, v6); return FLOW; }
    if (a[0] === 'rm' && a.length === 2 && nth(a[1])) { A.passkeyRm(nth(a[1]), v6); return FLOW; }
    return { out: [x.k.plain(x.S.usagePasskey6)] };
  },
};

/** 账号层命令的共同开头：有 v6 会话、要在终端窗口里 @param {any} x @param {string} name @returns {{ A: any, no: any }} */
function acct(x, name) {
  const v6 = v6SelfGate(x);
  if ('out' in v6) return { A: null, no: v6 };
  const A = layer(x, 'acct');
  if (A && typeof A.sudo === 'function') A.sudo(null); /* 不是 sudo 的一条：直接调（keys/sudo.js 才给证明来源） */
  return A ? { A: A, no: null } : { A: null, no: notHere(x, name) };
}

const device = {
  name: 'device',
  args: ['rm'],
  audience: OWNER,
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const a = p.args.map(function (s) { return s.toLowerCase(); });
    const r = acct(x, 'device');
    if (r.no) return r.no;
    if (!a.length) { r.A.deviceList(); return FLOW; }
    /* 踢出是 root 档（定稿 v5.5 §五）：不是 root → 先 sudo device rm …（站长用 sudo 提权，§四） */
    if (a[0] === 'rm' && a.length === 2 && (nth(a[1]) || a[1] === '--all') && !v6Root(x.who())) return { out: [line(x, 'needRoot6', canSudo(x) ? 'sudo device rm ' + a[1] : 'su root')] };
    if (a[0] === 'rm' && a.length === 2 && nth(a[1])) { r.A.deviceRm(nth(a[1])); return FLOW; }
    if (a[0] === 'rm' && a.length === 2 && a[1] === '--all') { r.A.deviceRmAll(); return FLOW; }
    return { out: [x.k.plain(x.S.usageDevice)] };
  },
};

/** profile set 的字段名（= shell/account/cmd/profile.js PROFILE_KEYS 的键） */
const PROFILE_SET = ['name', 'nick', 'sign', 'email'];

const profile = {
  name: 'profile',
  args: ['set', 'avatar'],
  subArgs: function (/** @type {string} */ a) { return a === 'set' ? PROFILE_SET.slice() : []; },
  audience: V6,
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const a0 = (p.args[0] || '').toLowerCase();
    const a1 = (p.args[1] || '').toLowerCase();
    const r = acct(x, 'profile');
    if (r.no) return r.no;
    if (!p.args.length) { r.A.profileShow(); return FLOW; }
    if (a0 === 'avatar' && p.args.length === 1) { r.A.profileAvatar(); return FLOW; }
    /* 值原样（大小写、中间的空格；邮箱可以为空以外的任何写法，检查在账号层） */
    if (a0 === 'set' && PROFILE_SET.indexOf(a1) >= 0 && p.args.length >= 3) {
      r.A.profileSet(a1, p.rest.replace(/^\S+\s+\S+\s+/, ''));
      return FLOW;
    }
    return { out: [x.k.plain(x.S.usageProfile)] };
  },
};

export const ACCOUNT_CMDS = [passwd, passkey, device, profile];
