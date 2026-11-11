import { layer, notHere, nth, v6RootGate, v6SelfGate, FLOW } from '../keys/gate.js';

/**
 * 账号命令（v6，v6-commands「自己的账号（普通用户与 root 各管各的）」「授权与订阅（root，或 sudo）」）：
 * - passwd：改自己的密码（先输当前密码）/ passwd <名>：root 发一次性密码（身份层 shell/identity/layer.js）
 * - passkey [ls | add | rm <n>]：自己的通行密钥（POST /api/identity passkey-*，user 档）
 * - device [rm <n> | rm --all]：自己的登录会话（POST /api/account/devices，user 档；v6 不要复验）
 * - app [allow <n> | deny <n>]：应用授权（root 档）
 * - profile [set name | nick | sign | email <值> | avatar]：个人资料（PUT /api/profile 站长 + root；头像按 uid）
 * 流程在账号层（shell/account/cmd/*）；这里只把门、查参数。v6 P4 起旧账号会话（sudo root）与 reset 层删除，一律按 v6 身份。
 */

const V6 = /** @type {any} */ (['user', 'root6']);

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
  audience: V6,
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const a = p.args.map(function (s) { return s.toLowerCase(); });
    const v6 = v6SelfGate(x);
    if ('out' in v6) return v6;
    const A = layer(x, 'acct');
    if (!A) return notHere(x, 'passkey');
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
  return A ? { A: A, no: null } : { A: null, no: notHere(x, name) };
}

const device = {
  name: 'device',
  args: ['rm'],
  audience: V6,
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const a = p.args.map(function (s) { return s.toLowerCase(); });
    const r = acct(x, 'device');
    if (r.no) return r.no;
    if (!a.length) { r.A.deviceList(); return FLOW; }
    if (a[0] === 'rm' && a.length === 2 && nth(a[1])) { r.A.deviceRm(nth(a[1])); return FLOW; }
    if (a[0] === 'rm' && a.length === 2 && a[1] === '--all') { r.A.deviceRmAll(); return FLOW; }
    return { out: [x.k.plain(x.S.usageDevice)] };
  },
};

/** app（v6-commands「授权与订阅（root，或 sudo）」；路由表 POST /api/account/grants = root 档）：v6 root 直接做，普通用户提示先 su root，访客先 su <用户> */
const app = {
  name: 'app',
  args: ['allow', 'deny'],
  audience: /** @type {any} */ (['root6']),
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const a = p.args.map(function (s) { return s.toLowerCase(); });
    const v6 = v6RootGate(x);
    if ('out' in v6) return v6;
    const A = layer(x, 'acct');
    if (!A) return notHere(x, 'app');
    const o = { direct: true };
    if (!a.length) { A.appList(o); return FLOW; }
    if (a[0] === 'allow' && a.length === 2 && nth(a[1])) { A.appAllow(nth(a[1]), o); return FLOW; }
    if (a[0] === 'deny' && a.length === 2 && nth(a[1])) { A.appDeny(nth(a[1]), o); return FLOW; }
    return { out: [x.k.plain(x.S.usageApp)] };
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

export const ACCOUNT_CMDS = [passwd, passkey, device, app, profile];
